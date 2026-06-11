/**
 * Chat API Route
 * Handles chat interactions with Claude API and tools
 */
import MCPClient from "../mcp-client";
import { saveMessage, getConversationHistory, storeCustomerAccountUrls, getCustomerAccountUrls as getCustomerAccountUrlsFromDb } from "../db.server";
import AppConfig from "../services/config.server";
import { createSseStream } from "../services/streaming.server";
import { createClaudeService } from "../services/claude.server";
import { createToolService } from "../services/tool.server";
import { getManualContext, detectProductSkus } from "../services/retrieval.server";
import { embedQuery } from "../services/voyage.server";

// Customer-account URLs (.well-known endpoints) are shop-wide, not per
// conversation. Cache them per shop hostname on warm instances so new
// conversations don't pay two .well-known fetches; the per-conversation DB row
// (which the OAuth callback reads) is written fire-and-forget, tracked here so
// it's written once per conversation, not on every message.
const SHOP_URLS_CACHE = new Map();
const SHOP_URLS_TTL_MS = 60 * 60 * 1000;
const URLS_STORED_FOR = new Set();


/**
 * React Router loader function for handling GET requests
 */
export async function loader({ request }) {
  // Handle OPTIONS requests (CORS preflight)
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: getCorsHeaders(request)
    });
  }

  if (!isOriginAllowed(request)) return forbidden(request);

  const url = new URL(request.url);

  // Handle history fetch requests - matches /chat?history=true&conversation_id=XYZ
  if (url.searchParams.has('history') && url.searchParams.has('conversation_id')) {
    return handleHistoryRequest(request, url.searchParams.get('conversation_id'));
  }

  // API-only: chat requests are POSTs (see action); reject everything else.
  return new Response(JSON.stringify({ error: AppConfig.errorMessages.apiUnsupported }), { status: 400, headers: getCorsHeaders(request) });
}

/**
 * React Router action function for handling POST requests
 */
export async function action({ request }) {
  if (!isOriginAllowed(request)) return forbidden(request);
  return handleChatRequest(request);
}

/**
 * Handle history fetch requests
 * @param {Request} request - The request object
 * @param {string} conversationId - The conversation ID
 * @returns {Response} JSON response with chat history
 */
async function handleHistoryRequest(request, conversationId) {
  const messages = await getConversationHistory(conversationId);

  return new Response(JSON.stringify({ messages }), { headers: getCorsHeaders(request) });
}

/**
 * Handle chat requests (both GET and POST)
 * @param {Request} request - The request object
 * @returns {Response} Server-sent events stream
 */
async function handleChatRequest(request) {
  try {
    // Get message data from request body
    const body = await request.json();
    const userMessage = body.message;

    // Validate required message (with a size cap — this is a public endpoint and
    // every character is paid model input).
    if (!userMessage || typeof userMessage !== "string" || userMessage.length > 4000) {
      return new Response(
        JSON.stringify({ error: AppConfig.errorMessages.missingMessage }),
        { status: 400, headers: getCorsHeaders(request) }
      );
    }

    // Generate or use existing conversation ID. Must be unguessable: the ID is the
    // only credential for reading history and for using any customer token bound
    // to the conversation. Reject oversized client-supplied IDs.
    const clientId = typeof body.conversation_id === "string" && body.conversation_id.length <= 64
      ? body.conversation_id
      : null;
    const conversationId = clientId || crypto.randomUUID();
    const promptType = body.prompt_type || AppConfig.api.defaultPromptType;

    // Create a stream for the response
    const responseStream = createSseStream(async (stream) => {
      await handleChatSession({
        request,
        userMessage,
        conversationId,
        promptType,
        stream
      });
    });

    return new Response(responseStream, {
      headers: getSseHeaders(request)
    });
  } catch (error) {
    console.error('Error in chat request handler:', error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: getCorsHeaders(request)
    });
  }
}

/**
 * Handle a complete chat session
 * @param {Object} params - Session parameters
 * @param {Request} params.request - The request object
 * @param {string} params.userMessage - The user's message
 * @param {string} params.conversationId - The conversation ID
 * @param {string} params.promptType - The prompt type
 * @param {Object} params.stream - Stream manager for sending responses
 */
async function handleChatSession({
  request,
  userMessage,
  conversationId,
  promptType,
  stream
}) {
  // Initialize services
  const claudeService = createClaudeService();
  const toolService = createToolService();

  // Initialize MCP client
  const shopId = request.headers.get("X-Shopify-Shop-Id");
  const shopDomain = request.headers.get("Origin");
  // Resolves to null on any failure (missing Origin, .well-known fetch error).
  // NOT awaited here: the result is only needed by the customer MCP connect, so
  // it runs concurrently with everything below instead of blocking the session.
  const urlsPromise = getCustomerAccountUrls(shopDomain, conversationId);

  const mcpClient = new MCPClient(
    shopDomain,
    conversationId,
    shopId,
    null,
  );

  // Persist messages through a serial chain so DB insert order always matches
  // conversation order. Fire-and-forget saves can interleave (e.g. a tool_result
  // committing before the assistant tool_use that requested it), which makes the
  // stored history invalid for the Claude API on every later turn.
  let saveChain = Promise.resolve();
  const persistMessage = (role, content) => {
    saveChain = saveChain
      .then(() => saveMessage(conversationId, role, content))
      .catch((error) => console.error("Error saving message to database:", error));
    return saveChain;
  };

  try {
    // Send conversation ID to client
    stream.sendMessage({ type: 'id', conversation_id: conversationId });

    // Connect to both MCP servers, but DON'T await yet — let this run concurrently
    // with the DB + retrieval work below, then await it just before the Claude call.
    // The customer endpoint override waits on the (also concurrent) URL lookup.
    const mcpConnectPromise = (async () => {
      const { mcpApiUrl } = (await urlsPromise) || {};
      if (mcpApiUrl) mcpClient.customerMcpEndpoint = mcpApiUrl;
      const [storefrontMcpTools, customerMcpTools] = await Promise.all([
        mcpClient.connectToStorefrontServer(),
        mcpClient.connectToCustomerServer(),
      ]);
      console.log(`Connected to MCP (${storefrontMcpTools.length} storefront + ${customerMcpTools.length} customer tools)`);
    })().catch((error) => {
      console.warn('Failed to connect to MCP servers, continuing without tools:', error.message);
    });

    // For price/availability questions, prefetch the live price via a direct
    // storefront search (no connect wait). Only search when we know WHICH
    // product: a generic query like "what is the price" returns an arbitrary
    // catalog item, which then gets confidently relayed as the wrong answer.
    // If the message names a product, start now (hides under the DB + retrieval
    // latency below); for follow-ups, resolve the product from recent
    // conversation once history is loaded (see below).
    const priceIntent = /\b(price|prices|cost|costs|how much|pricing|msrp|\$)\b/i.test(userMessage);
    const startPriceLookup = (term) =>
      fetchLivePrice(shopDomain, term).catch((error) => {
        console.warn("Price prefetch failed:", error.message);
        return null;
      });
    const messageRefs = priceIntent ? detectProductSkus(userMessage) : [];
    let pricePromise = messageRefs.length
      ? startPriceLookup(messageRefs[0])
      : Promise.resolve(null);

    // Prepare conversation state
    const productsToDisplay = [];

    // Start the query embedding now: it only needs the user's message, so the
    // Voyage round trip (~150-300ms) hides under the history fetch instead of
    // running after it. Retrieval awaits (and error-handles) it; the extra
    // handler here just prevents an unhandled rejection if retrieval bails first.
    const embeddingPromise = embedQuery(userMessage);
    embeddingPromise.catch(() => {});

    // Fetch prior messages (capped — old turns add tokens and latency every
    // turn forever), then queue the current user message for persistence.
    // The save chain keeps insert order correct, and appending in memory avoids
    // a serialized save + full re-read of the conversation on the hot path.
    const dbMessages = await getConversationHistory(conversationId, AppConfig.api.historyLimit);
    persistMessage('user', userMessage);

    // Format messages for Claude API
    const conversationHistory = dbMessages.map(dbMessage => {
      let content;
      try {
        content = JSON.parse(dbMessage.content);
      } catch (e) {
        content = dbMessage.content;
      }
      return {
        role: dbMessage.role,
        content
      };
    });

    // The capped window can open mid tool exchange; a leading tool_result whose
    // tool_use fell outside the window (or a leading assistant message) is
    // invalid for the Claude API, so trim until the window starts on a plain
    // user message.
    while (conversationHistory.length) {
      const first = conversationHistory[0];
      const hasToolResult = Array.isArray(first.content) &&
        first.content.some((block) => block?.type === "tool_result");
      if (first.role === "user" && !hasToolResult) break;
      conversationHistory.shift();
    }

    conversationHistory.push({ role: 'user', content: userMessage });

    // Retrieve NextLED manual context for this question and prepend it to the
    // current user turn, so there is a single user message carrying context +
    // question. This sits in the messages (after the cached system block, never
    // inside the cached system prefix), so prompt caching stays valid. Graceful:
    // null on any failure, like the MCP tools. Ephemeral — the modified copy is
    // never written to the DB, so the stored question and later turns stay clean.
    // Recent conversation text (excluding the current message) so retrieval can
    // detect a product/SKU named earlier in the chat for follow-up questions.
    const toText = (content) =>
      Array.isArray(content)
        ? content.filter((b) => b && b.type === "text").map((b) => b.text).join(" ")
        : typeof content === "string"
          ? content
          : "";
    const recentText = conversationHistory.slice(-7, -1).map((m) => toText(m.content)).join(" ");

    // Follow-up price questions ("what is the price?") name no product; resolve
    // the most recently discussed product from the conversation and look that
    // up instead. The last explicit SKU in the transcript (usually from the
    // assistant's own answer) beats name/alias matches, which can hit sibling
    // models. Overlaps with the retrieval await below. If no product can be
    // identified at all, skip the prefetch — the model will use search_catalog
    // or ask, rather than relay an arbitrary product's price.
    if (priceIntent && !messageRefs.length) {
      const skuMentions = [...recentText.matchAll(/\bNT-[0-9A-Z]+(?:-[0-9A-Z]+)*\b/gi)].map((m) => m[0]);
      const contextRef = skuMentions[skuMentions.length - 1] || detectProductSkus(recentText)[0];
      if (contextRef) {
        pricePromise = startPriceLookup(contextRef);
      }
    }

    const manualContext = await getManualContext(userMessage, recentText, embeddingPromise);
    if (manualContext) {
      const labeled =
        `[NextLED manual context begins. Use this as your source of truth, and cite the SKU shown when you answer about a product.]\n\n` +
        `${manualContext}\n\n` +
        `[NextLED manual context ends.]`;
      const lastIndex = conversationHistory.length - 1;
      conversationHistory[lastIndex] = {
        ...conversationHistory[lastIndex],
        content: `${labeled}\n\n${userMessage}`,
      };
    }

    // Ensure MCP tools are connected before the Claude call (it ran concurrently
    // with the DB + retrieval work above).
    await mcpConnectPromise;

    // Inject the live price (looked up concurrently above, so it adds no real
    // latency). Falls back silently if it found nothing.
    const priceLine = await pricePromise;
    if (priceLine) {
      const last = conversationHistory.length - 1;
      conversationHistory[last] = {
        ...conversationHistory[last],
        content: `[Live Shopify pricing — best catalog match for this conversation. Only state this price if it is the product the customer is asking about; otherwise use search_catalog.]\n${priceLine}\n\n${conversationHistory[last].content}`,
      };
    }

    // Execute the conversation stream.
    // NOTE: `conversationHistory` (with the injected manual context above) is the
    // actual payload sent to Claude on every iteration below. `finalMessage` is
    // only a loop sentinel — its initial value is never sent; it is overwritten by
    // the assistant's returned message (which carries stop_reason) on the first
    // iteration. Seed it with just a stop_reason so it can't be mistaken for a
    // user payload carrying the bare question.
    let finalMessage = { stop_reason: null };

    // Cap the loop: tool_use round-trips are normal, but an unexpected stop_reason
    // (e.g. repeated max_tokens continuations) must never re-send the conversation
    // unboundedly on a public, per-token-billed endpoint.
    const maxIterations = 10;
    let iterations = 0;

    while (finalMessage.stop_reason !== "end_turn" && iterations++ < maxIterations) {
      finalMessage = await claudeService.streamConversation(
        {
          messages: conversationHistory,
          promptType,
          tools: mcpClient.tools
        },
        {
          // Handle text chunks
          onText: (textDelta) => {
            stream.sendMessage({
              type: 'chunk',
              chunk: textDelta
            });
          },

          // Handle complete messages
          onMessage: (message) => {
            conversationHistory.push({
              role: message.role,
              content: message.content
            });

            persistMessage(message.role, JSON.stringify(message.content));

            // Send a completion message
            stream.sendMessage({ type: 'message_complete' });
          },

          // Handle tool use requests
          onToolUse: async (content) => {
            const toolName = content.name;
            let toolArgs = content.input;
            // search_catalog expects the query nested under `catalog`; some models
            // emit it flat (e.g. { query }), which the tool silently ignores and
            // returns a default list. Wrap flat args so the search actually runs.
            if (toolName === "search_catalog" && toolArgs && typeof toolArgs === "object" && !toolArgs.catalog) {
              toolArgs = { catalog: toolArgs };
            }
            const toolUseId = content.id;

            const toolUseMessage = `Calling tool: ${toolName} with arguments: ${JSON.stringify(toolArgs)}`;

            stream.sendMessage({
              type: 'tool_use',
              tool_use_message: toolUseMessage
            });

            // Call the tool. Never let a failure escape: the assistant's tool_use
            // is already in the saved history, so throwing here would leave a
            // dangling tool_use that makes the conversation invalid for the
            // Claude API on every future turn.
            let toolUseResponse;
            try {
              toolUseResponse = await mcpClient.callTool(toolName, toolArgs);
            } catch (error) {
              toolUseResponse = {
                error: {
                  type: "tool_error",
                  data: `Tool ${toolName} failed: ${error.message}`
                }
              };
            }

            // Handle tool response based on success/error
            if (toolUseResponse.error) {
              await toolService.handleToolError(
                toolUseResponse,
                toolName,
                toolUseId,
                conversationHistory,
                stream.sendMessage,
                persistMessage
              );
            } else {
              await toolService.handleToolSuccess(
                toolUseResponse,
                toolName,
                toolUseId,
                conversationHistory,
                productsToDisplay,
                persistMessage
              );
            }

            // Signal new message to client
            stream.sendMessage({ type: 'new_message' });
          },

          // Handle content block completion
          onContentBlock: (contentBlock) => {
            if (contentBlock.type === 'text') {
              stream.sendMessage({
                type: 'content_block_complete',
                content_block: contentBlock
              });
            }
          }
        }
      );
    }

    // Signal end of turn
    stream.sendMessage({ type: 'end_turn' });

    // Send product results if available
    if (productsToDisplay.length > 0) {
      stream.sendMessage({
        type: 'product_results',
        products: productsToDisplay
      });
    }
  } finally {
    // Make sure all queued DB writes land before the invocation is released.
    await saveChain;
  }
}

/**
 * Get the customer MCP API URL for a shop
 * @param {string} shopDomain - The shop domain
 * @param {string} conversationId - The conversation ID
 * @returns {string} The customer MCP API URL
 */
async function getCustomerAccountUrls(shopDomain, conversationId) {
  try {
    const { hostname } = new URL(shopDomain);

    // Warm-instance shop cache: skips both the DB read and the .well-known
    // fetches. The OAuth callback later reads these by conversationId from the
    // DB, so keep that row populated (fire-and-forget, once per conversation).
    const hit = SHOP_URLS_CACHE.get(hostname);
    if (hit && Date.now() - hit.ts < SHOP_URLS_TTL_MS) {
      persistUrlsForConversation(conversationId, hit.urls);
      return hit.urls;
    }

    // Check if the customer account URLs exist in the DB for this conversation
    const existingUrls = await getCustomerAccountUrlsFromDb(conversationId);
    if (existingUrls) {
      const urls = {
        mcpApiUrl: existingUrls.mcpApiUrl,
        authorizationUrl: existingUrls.authorizationUrl,
        tokenUrl: existingUrls.tokenUrl,
      };
      SHOP_URLS_CACHE.set(hostname, { urls, ts: Date.now() });
      URLS_STORED_FOR.add(conversationId);
      return urls;
    }

    // If not, query the shop's .well-known endpoints
    const [mcpResponse, openidResponse] = await Promise.all([
      fetch(`https://${hostname}/.well-known/customer-account-api`).then(res => res.json()),
      fetch(`https://${hostname}/.well-known/openid-configuration`).then(res => res.json()),
    ]);

    const urls = {
      mcpApiUrl: mcpResponse.mcp_api,
      authorizationUrl: openidResponse.authorization_endpoint,
      tokenUrl: openidResponse.token_endpoint,
    };

    SHOP_URLS_CACHE.set(hostname, { urls, ts: Date.now() });
    persistUrlsForConversation(conversationId, urls);

    return urls;
  } catch (error) {
    console.error("Error getting customer MCP API URL:", error);
    return null;
  }
}

/**
 * Write the customer account URLs to the conversation's DB row (the OAuth
 * callback looks them up by conversationId). Fire-and-forget, once per
 * conversation per instance.
 * @param {string} conversationId
 * @param {Object} urls
 */
function persistUrlsForConversation(conversationId, urls) {
  if (URLS_STORED_FOR.has(conversationId)) return;
  URLS_STORED_FOR.add(conversationId);
  storeCustomerAccountUrls({ conversationId, ...urls }).catch((error) => {
    URLS_STORED_FOR.delete(conversationId);
    console.error("Error storing customer account URLs:", error);
  });
}

// Accessory listings (chargers, replacement parts) carry the main product's SKU
// in their titles, so a naive title match returns the $30 charger for a question
// about the $250 light. Demote them at every preference level.
const ACCESSORY_TITLE_RE = /\b(charger|adapter|cable|replacement|lamp head|battery|mount|bracket)\b/i;

/**
 * Pick the most likely intended product from search results: exact SKU token
 * beats substring (so NT-6926 doesn't silently mean NT-6926M), and main
 * products beat accessories at each level.
 * @param {Array} products
 * @param {string|null} sku
 * @returns {Object}
 */
function pickPricedProduct(products, sku) {
  const isAccessory = (p) => ACCESSORY_TITLE_RE.test(p.title || "");
  if (!sku) return products.find((p) => !isAccessory(p)) || products[0];
  const upper = sku.toUpperCase();
  const exact = new RegExp(`\\b${upper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  const rungs = [
    (p) => exact.test(p.title || "") && !isAccessory(p),
    (p) => (p.title || "").toUpperCase().includes(upper) && !isAccessory(p),
    (p) => exact.test(p.title || ""),
    (p) => (p.title || "").toUpperCase().includes(upper),
    (p) => !isAccessory(p),
  ];
  for (const matches of rungs) {
    const hit = products.find(matches);
    if (hit) return hit;
  }
  return products[0];
}

/**
 * Extract a "Title: $price CUR" line from a search_catalog result, preferring the
 * product whose title contains the given SKU. Amounts are in minor units.
 * @param {Object} res - search_catalog tool result
 * @param {string|null} sku
 * @returns {string|null}
 */
function extractPrice(res, sku) {
  try {
    const text = res?.content?.find((c) => c?.type === "text")?.text;
    if (!text) return null;
    const products = JSON.parse(text)?.products || [];
    if (!products.length) return null;
    const p = pickPricedProduct(products, sku);
    const min = p?.price_range?.min;
    if (min == null) return null;
    // Shape varies by store/API version: { amount, currency } in minor units,
    // or a plain decimal string/number in major units.
    if (typeof min === "object") {
      if (min.amount == null) return null;
      return `${p.title}: $${(Number(min.amount) / 100).toFixed(2)} ${min.currency || "USD"}`;
    }
    const amount = Number(min);
    if (!Number.isFinite(amount)) return null;
    return `${p.title}: $${amount.toFixed(2)} ${p.price_range.currency || "USD"}`;
  } catch {
    return null;
  }
}

/**
 * Fetch a live "Title: $price CUR" line for a price question by calling the
 * storefront MCP search_catalog endpoint directly (no tools/list connect), so it can
 * run concurrently with the rest of the request. Returns null if nothing is found.
 * @param {string} shopDomain - storefront origin (e.g. https://store.myshopify.com)
 * @param {string} message - the user message
 * @returns {Promise<string|null>}
 */
async function fetchLivePrice(shopDomain, message) {
  if (!shopDomain) return null;
  const sku = message.match(/\bNT-[0-9A-Z]+(?:-[0-9A-Z]+)*\b/i)?.[0] || null;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "search_catalog", arguments: { catalog: { query: sku || message } } },
  });
  const res = await fetch(`${shopDomain}/api/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) return null;
  const data = await res.json();
  return extractPrice(data?.result, sku);
}

/**
 * Parse the ALLOWED_ORIGINS env var into a list of origins. Entries are
 * normalized (scheme added if missing, path/trailing slash dropped, quotes
 * stripped) so common formatting slips — "nextool.myshopify.com/" vs
 * "https://nextool.myshopify.com" — don't silently break the whole widget.
 * @returns {string[]}
 */
function allowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
    .map((s) => {
      try {
        return new URL(s.includes("://") ? s : `https://${s}`).origin;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Whether the request's Origin is allowed. If ALLOWED_ORIGINS is unset, all
 * origins are allowed (so the endpoint isn't broken before it's configured).
 * Requests WITHOUT an Origin header are allowed: those are non-browser clients
 * (e.g. the keep-warm ping), and an Origin check only protects against
 * cross-site browser use — curl can fake any Origin regardless.
 * @param {Request} request
 * @returns {boolean}
 */
function isOriginAllowed(request) {
  const allowed = allowedOrigins();
  if (allowed.length === 0) return true;
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  return allowed.includes(origin);
}

/**
 * 403 response for a disallowed Origin.
 * @param {Request} request
 * @returns {Response}
 */
function forbidden(request) {
  return new Response(JSON.stringify({ error: "Origin not allowed" }), {
    status: 403,
    headers: getCorsHeaders(request),
  });
}

/**
 * Gets CORS headers for the response. Only reflects the Origin when it is in the
 * allowlist (or the allowlist is unset). No Allow-Credentials: nothing here uses
 * cookies, and reflecting arbitrary origins WITH credentials is a classic
 * cross-site data-leak misconfiguration.
 * @param {Request} request - The request object
 * @returns {Object} CORS headers object
 */
function getCorsHeaders(request) {
  const origin = request.headers.get("Origin");
  const allowed = allowedOrigins();
  const allowOrigin = !origin
    ? "*"
    : (allowed.length === 0 || allowed.includes(origin)) ? origin : "null";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, X-Shopify-Shop-Id",
    "Access-Control-Max-Age": "86400" // 24 hours
  };
}

/**
 * Get SSE headers for the response
 * @param {Request} request - The request object
 * @returns {Object} SSE headers object
 */
function getSseHeaders(request) {
  return {
    ...getCorsHeaders(request),
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive"
  };
}
