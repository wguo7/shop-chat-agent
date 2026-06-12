/**
 * Claude Service
 * Manages interactions with the Claude API
 */
import { Anthropic } from "@anthropic-ai/sdk";
import AppConfig from "./config.server";
import systemPrompts from "../prompts/prompts.json";
import { getCatalogSummary } from "./retrieval.server";

/**
 * Return a copy of the messages with a prompt-cache breakpoint on the last
 * content block of the message at `index`. Non-destructive: the in-memory
 * conversation history is re-sent on each agentic-loop iteration, so mutating
 * it would accumulate breakpoints past Anthropic's limit of 4.
 */
function addCacheBreakpoint(messages, index) {
  const msg = messages[index];
  if (!msg) return messages;
  let content = msg.content;
  if (typeof content === "string") {
    content = [{ type: "text", text: content, cache_control: { type: "ephemeral" } }];
  } else if (Array.isArray(content) && content.length) {
    content = content.slice();
    content[content.length - 1] = { ...content[content.length - 1], cache_control: { type: "ephemeral" } };
  } else {
    return messages;
  }
  const out = messages.slice();
  out[index] = { ...msg, content };
  return out;
}

/**
 * Creates a Claude service instance
 * @param {string} apiKey - Claude API key
 * @returns {Object} Claude service with methods for interacting with Claude API
 */
export function createClaudeService(apiKey = process.env.CLAUDE_API_KEY) {
  // Initialize Claude client
  const anthropic = new Anthropic({ apiKey });

  /**
   * Streams a conversation with Claude
   * @param {Object} params - Stream parameters
   * @param {Array} params.messages - Conversation history
   * @param {string} params.promptType - The type of system prompt to use
   * @param {Array} params.tools - Available tools for Claude
   * @param {Object} streamHandlers - Stream event handlers
   * @param {Function} streamHandlers.onText - Handles text chunks
   * @param {Function} streamHandlers.onMessage - Handles complete messages
   * @param {Function} streamHandlers.onToolUse - Handles tool use requests
   * @returns {Promise<Object>} The final message
   */
  const streamConversation = async ({
    messages,
    promptType = AppConfig.api.defaultPromptType,
    tools
  }, streamHandlers) => {
    // Get system prompt from configuration or use default
    const systemInstruction = getSystemPrompt(promptType);

    // The catalog overview is stable per deployment, so it lives INSIDE the
    // cached system block (free after the first request) instead of being
    // re-sent as uncached per-request context on every message.
    const catalogSummary = getCatalogSummary();
    const systemText = catalogSummary
      ? `${systemInstruction}\n\nCatalog overview (all NextLED products):\n${catalogSummary}`
      : systemInstruction;

    // Cache breakpoints (max 4): one on the system block (caches tools+system),
    // one on the second-to-last message (caches the clean conversation history
    // across turns — the last user message carries per-question manual context
    // that varies, so history must be cached BEFORE it), and one on the last
    // message (caches the full current prefix, which makes the second Claude
    // round after a tool call hit cache for everything except the tool result).
    let cachedMessages = addCacheBreakpoint(messages, messages.length - 1);
    if (messages.length >= 2) {
      cachedMessages = addCacheBreakpoint(cachedMessages, messages.length - 2);
    }

    // Create stream
    const stream = await anthropic.messages.stream({
      model: AppConfig.api.defaultModel,
      max_tokens: AppConfig.api.maxTokens,
      system: [
        {
          type: "text",
          text: systemText,
          // Prefix render order is tools -> system -> messages, so this caches
          // tools + system + catalog while the user turn varies.
          cache_control: { type: "ephemeral" }
        }
      ],
      messages: cachedMessages,
      tools: tools && tools.length > 0 ? tools : undefined
    });

    // Set up event handlers
    if (streamHandlers.onText) {
      stream.on('text', streamHandlers.onText);
    }

    if (streamHandlers.onMessage) {
      stream.on('message', streamHandlers.onMessage);
    }

    if (streamHandlers.onContentBlock) {
      stream.on('contentBlock', streamHandlers.onContentBlock);
    }

    // Wait for final message
    const finalMessage = await stream.finalMessage();

    // Process tool use requests
    if (streamHandlers.onToolUse && finalMessage.content) {
      for (const content of finalMessage.content) {
        if (content.type === "tool_use") {
          await streamHandlers.onToolUse(content);
        }
      }
    }

    return finalMessage;
  };

  /**
   * Gets the system prompt content for a given prompt type
   * @param {string} promptType - The prompt type to retrieve
   * @returns {string} The system prompt content
   */
  const getSystemPrompt = (promptType) => {
    return systemPrompts.systemPrompts[promptType]?.content ||
      systemPrompts.systemPrompts[AppConfig.api.defaultPromptType].content;
  };

  return {
    streamConversation,
    getSystemPrompt
  };
}

export default {
  createClaudeService
};
