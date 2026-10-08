import { generateAuthUrl } from "./auth.server";
import { getCustomerToken } from "./db.server";
import toolsSnapshot from "../data/mcp-tools.json";
import AppConfig from "./services/config.server";

// Shopify's UCP catalog endpoint requires the agent profile URL in every
// tools/call (and accepts it on tools/list). See AppConfig.ucp.
function ucpMeta() {
  return { "ucp-agent": { profile: AppConfig.ucp.agentProfileUrl } };
}

// Module-level cache of formatted tool lists per MCP endpoint. Tool definitions are
// store-wide and change rarely, so reuse them across requests (warm instances, via
// Fluid Compute) to skip a tools/list round-trip on every message. TTL bounds staleness.
const TOOLS_CACHE = new Map();
// Tool definitions essentially never change; a long TTL means warm instances
// almost never pay the tools/list round-trip.
const TOOLS_TTL_MS = 60 * 60 * 1000;

function getCachedTools(endpoint) {
  const hit = TOOLS_CACHE.get(endpoint);
  if (hit && Date.now() - hit.ts < TOOLS_TTL_MS) return hit.tools;
  return null;
}

function setCachedTools(endpoint, tools) {
  if (Array.isArray(tools) && tools.length) TOOLS_CACHE.set(endpoint, { tools, ts: Date.now() });
}

// Build-time snapshot of the tool lists (data/mcp-tools.json, already filtered
// of cart/checkout tools). New function instances use it instantly instead of
// paying a tools/list round-trip on their first message; a background refresh
// corrects any drift and populates the in-memory cache.
function getSnapshotTools(endpoint) {
  const tools = toolsSnapshot?.endpoints?.[endpoint];
  return Array.isArray(tools) && tools.length ? tools : null;
}

/**
 * Client for interacting with Model Context Protocol (MCP) API endpoints.
 * Manages connections to both customer and storefront MCP endpoints, and handles tool invocation.
 */
class MCPClient {
  /**
   * Creates a new MCPClient instance.
   *
   * @param {string} hostUrl - The base URL for the shop
   * @param {string} conversationId - ID for the current conversation
   * @param {string} shopId - ID of the Shopify shop
   */
  constructor(hostUrl, conversationId, shopId, customerMcpEndpoint) {
    this.tools = [];
    this.customerTools = [];
    this.storefrontTools = [];
    // Catalog tools (search_catalog, lookup_catalog, get_product) moved to the
    // UCP endpoint on 2026-08-31; the legacy endpoint still serves only
    // search_shop_policies_and_faqs. Both are loaded; each tool remembers
    // which endpoint it came from.
    this.storefrontMcpEndpoint = `${hostUrl}/api/ucp/mcp`;
    this.legacyStorefrontMcpEndpoint = `${hostUrl}/api/mcp`;
    this.storefrontToolEndpoints = new Map();

    const accountHostUrl = hostUrl.replace(/(\.myshopify\.com)$/, '.account$1');
    this.customerMcpEndpoint = customerMcpEndpoint || `${accountHostUrl}/customer/api/mcp`;
    this.customerAccessToken = "";
    this.conversationId = conversationId;
    this.shopId = shopId;
  }

  /**
   * Connects to the customer MCP server and retrieves available tools.
   * Attempts to use an existing token or will proceed without authentication.
   *
   * @returns {Promise<Array>} Array of available customer tools
   * @throws {Error} If connection to MCP server fails
   */
  async connectToCustomerServer() {
    try {
      const cached = getCachedTools(this.customerMcpEndpoint);
      if (cached) {
        this.customerTools = cached;
        this.tools = [...this.tools, ...cached];
        return cached;
      }

      const snapshot = getSnapshotTools(this.customerMcpEndpoint);
      if (snapshot) {
        this.customerTools = snapshot;
        this.tools = [...this.tools, ...snapshot];
        this._refreshToolsInBackground(this.customerMcpEndpoint);
        return snapshot;
      }

      console.log(`Connecting to MCP server at ${this.customerMcpEndpoint}`);

      if (this.conversationId) {
        const dbToken = await getCustomerToken(this.conversationId);

        if (dbToken && dbToken.accessToken) {
          this.customerAccessToken = dbToken.accessToken;
        } else {
          console.log("No token in database for conversation:", this.conversationId);
        }
      }

      // If we still don't have a token, we'll connect without one
      // and tools that require auth will prompt for it later
      const headers = {
        "Content-Type": "application/json",
        "Authorization": this.customerAccessToken || ""
      };

      const response = await this._makeJsonRpcRequest(
        this.customerMcpEndpoint,
        "tools/list",
        {},
        headers
      );

      // Extract tools from the JSON-RPC response format
      const toolsData = response.result && response.result.tools ? response.result.tools : [];
      const customerTools = this._formatToolsData(toolsData);

      setCachedTools(this.customerMcpEndpoint, customerTools);
      this.customerTools = customerTools;
      this.tools = [...this.tools, ...customerTools];

      return customerTools;
    } catch (e) {
      console.error("Failed to connect to MCP server: ", e);
      throw e;
    }
  }

  /**
   * Connects to the storefront MCP server and retrieves available tools.
   *
   * @returns {Promise<Array>} Array of available storefront tools
   * @throws {Error} If connection to MCP server fails
   */
  async connectToStorefrontServer() {
    // The legacy endpoint is optional: Shopify sunset it on 2026-08-31, so a
    // failure there must not take the catalog tools down with it.
    const [catalogTools, legacyTools] = await Promise.all([
      this._loadStorefrontTools(this.storefrontMcpEndpoint),
      this._loadStorefrontTools(this.legacyStorefrontMcpEndpoint).catch((e) => {
        console.warn("Legacy storefront MCP unavailable:", e.message);
        return [];
      }),
    ]);
    const storefrontTools = [...catalogTools, ...legacyTools];
    this.storefrontTools = storefrontTools;
    this.tools = [...this.tools, ...storefrontTools];
    return storefrontTools;
  }

  /**
   * Load one storefront endpoint's tools: in-memory cache, then build-time
   * snapshot (with background refresh), then a live tools/list.
   *
   * @private
   * @param {string} endpoint - The MCP endpoint URL
   * @returns {Promise<Array>} Formatted tools from that endpoint
   */
  async _loadStorefrontTools(endpoint) {
    const register = (tools) => {
      for (const tool of tools) this.storefrontToolEndpoints.set(tool.name, endpoint);
      return tools;
    };

    const cached = getCachedTools(endpoint);
    if (cached) return register(cached);

    const snapshot = getSnapshotTools(endpoint);
    if (snapshot) {
      this._refreshToolsInBackground(endpoint);
      return register(snapshot);
    }

    console.log(`Connecting to MCP server at ${endpoint}`);
    const response = await this._makeJsonRpcRequest(
      endpoint,
      "tools/list",
      endpoint === this.storefrontMcpEndpoint ? { meta: ucpMeta() } : {},
      { "Content-Type": "application/json" }
    );
    const toolsData = response.result && response.result.tools ? response.result.tools : [];
    const tools = this._formatToolsData(toolsData);
    setCachedTools(endpoint, tools);
    return register(tools);
  }

  /**
   * Dispatches a tool call to the appropriate MCP server based on the tool name.
   *
   * @param {string} toolName - Name of the tool to call
   * @param {Object} toolArgs - Arguments to pass to the tool
   * @returns {Promise<Object>} Result from the tool call
   * @throws {Error} If tool is not found or call fails
   */
  async callTool(toolName, toolArgs) {
    if (this.customerTools.some(tool => tool.name === toolName)) {
      return this.callCustomerTool(toolName, toolArgs);
    } else if (this.storefrontTools.some(tool => tool.name === toolName)) {
      return this.callStorefrontTool(toolName, toolArgs);
    } else {
      throw new Error(`Tool ${toolName} not found`);
    }
  }

  /**
   * Calls a tool on the storefront MCP server.
   *
   * @param {string} toolName - Name of the storefront tool to call
   * @param {Object} toolArgs - Arguments to pass to the tool
   * @returns {Promise<Object>} Result from the tool call
   * @throws {Error} If the tool call fails
   */
  async callStorefrontTool(toolName, toolArgs) {
    try {
      console.log("Calling storefront tool", toolName, toolArgs);

      const headers = {
        "Content-Type": "application/json"
      };

      // Route to the endpoint that advertised the tool. The UCP catalog
      // endpoint needs the agent profile; the model never sees that field
      // (stripped from the schema in _formatToolsData), so add it here.
      const endpoint = this.storefrontToolEndpoints.get(toolName) || this.storefrontMcpEndpoint;
      const args = endpoint === this.storefrontMcpEndpoint
        ? { ...(toolArgs || {}), meta: ucpMeta() }
        : toolArgs;

      const response = await this._makeJsonRpcRequest(
        endpoint,
        "tools/call",
        {
          name: toolName,
          arguments: args,
        },
        headers
      );

      return response.result || response;
    } catch (error) {
      console.error(`Error calling tool ${toolName}:`, error);
      throw error;
    }
  }

  /**
   * Calls a tool on the customer MCP server.
   * Handles authentication if needed.
   *
   * @param {string} toolName - Name of the customer tool to call
   * @param {Object} toolArgs - Arguments to pass to the tool
   * @returns {Promise<Object>} Result from the tool call or auth error
   * @throws {Error} If the tool call fails
   */
  async callCustomerTool(toolName, toolArgs) {
    try {
      console.log("Calling customer tool", toolName, toolArgs);
      // First try to get a token from the database for this conversation
      let accessToken = this.customerAccessToken;

      if (!accessToken || accessToken === "") {
        const dbToken = await getCustomerToken(this.conversationId);

        if (dbToken && dbToken.accessToken) {
          accessToken = dbToken.accessToken;
          this.customerAccessToken = accessToken; // Store it for later use
        } else {
          console.log("No token in database for conversation:", this.conversationId);
        }
      }

      const headers = {
        "Content-Type": "application/json",
        "Authorization": accessToken
      };

      try {
        const response = await this._makeJsonRpcRequest(
          this.customerMcpEndpoint,
          "tools/call",
          {
            name: toolName,
            arguments: toolArgs,
          },
          headers
        );

        return response.result || response;
      } catch (error) {
        // Handle 401 specifically to trigger authentication
        if (error.status === 401) {
          console.log("Unauthorized, generating authorization URL for customer");

          // Generate auth URL
          const authResponse = await generateAuthUrl(this.conversationId, this.shopId);

          // Instead of retrying, return the auth URL for the front-end
          return {
            error: {
              type: "auth_required",
              data: `You need to authorize the app to access your customer data. [Click here to authorize](${authResponse.url})`
            }
          };
        }

        // Re-throw other errors
        throw error;
      }
    } catch (error) {
      console.error(`Error calling tool ${toolName}:`, error);
      return {
        error: {
          type: "internal_error",
          data: `Error calling tool ${toolName}: ${error.message}`
        }
      };
    }
  }

  /**
   * Refresh an endpoint's tool list in the background (fire-and-forget) so the
   * snapshot can be served instantly while drift still self-corrects into the
   * in-memory cache for subsequent requests.
   *
   * @private
   * @param {string} endpoint - The MCP endpoint URL
   */
  _refreshToolsInBackground(endpoint) {
    this._makeJsonRpcRequest(endpoint, "tools/list", {}, { "Content-Type": "application/json" })
      .then((response) => {
        const toolsData = response.result?.tools || [];
        setCachedTools(endpoint, this._formatToolsData(toolsData));
      })
      .catch((error) => {
        console.warn(`Background tools refresh failed for ${endpoint}:`, error.message);
      });
  }

  /**
   * Makes a JSON-RPC request to the specified endpoint.
   *
   * @private
   * @param {string} endpoint - The endpoint URL
   * @param {string} method - The JSON-RPC method to call
   * @param {Object} params - Parameters for the method
   * @param {Object} headers - HTTP headers for the request
   * @returns {Promise<Object>} Parsed JSON response
   * @throws {Error} If the request fails
   */
  async _makeJsonRpcRequest(endpoint, method, params, headers) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: method,
        id: 1,
        params: params
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      const errorObj = new Error(`Request failed: ${response.status} ${error}`);
      errorObj.status = response.status;
      throw errorObj;
    }

    return await response.json();
  }

  /**
   * Formats raw tool data into a consistent format.
   *
   * Cart and checkout tools are filtered out entirely (owner decision): the chat
   * answers questions and points customers to the product page to buy — it never
   * builds carts or checkouts. Removing the tools (vs. prompting around them)
   * makes in-chat purchasing impossible rather than discouraged.
   *
   * @private
   * @param {Array} toolsData - Raw tools data from the API
   * @returns {Array} Formatted tools data
   */
  _formatToolsData(toolsData) {
    return toolsData
      .filter((tool) => !/cart|checkout|order/i.test(tool.name))
      .map((tool) => {
        // Drop the UCP `meta` (agent profile) field from what the model sees;
        // callStorefrontTool injects it. Otherwise the model has to invent a
        // profile URL for a required field.
        const raw = tool.inputSchema || tool.input_schema || {};
        let input_schema = raw;
        if (raw.properties && raw.properties.meta) {
          const properties = { ...raw.properties };
          delete properties.meta;
          input_schema = {
            ...raw,
            properties,
            ...(Array.isArray(raw.required)
              ? { required: raw.required.filter((r) => r !== "meta") }
              : {}),
          };
        }
        return {
          name: tool.name,
          description: tool.description,
          input_schema,
        };
      });
  }
}

export default MCPClient;
