/**
 * Configuration Service
 * Centralizes all configuration values for the chat service
 */

export const AppConfig = {
  // API Configuration
  api: {
    defaultModel: 'claude-haiku-4-5',
    maxTokens: 768,
    defaultPromptType: 'standardAssistant',
  },

  // Retrieval (NextLED manual context) configuration
  retrieval: {
    // How many top-matching manual chunks to inject as context per question.
    topK: 6,
    // Minimum cosine score (0..1) a chunk must reach to be injected. Chunks below
    // this are dropped; if none clear it, no manual context is injected and the
    // model gives its honest not-sure-plus-human answer. Tune for precision/recall.
    // Tuned for Voyage voyage-3.5-lite, whose cosine scores run lower/compressed
    // vs MiniLM. On-topic questions top out ~0.42-0.70; this floor lets them
    // retrieve. Off-catalog queries can score similarly, so grounding (the prompt's
    // answer-only-from-context rule), not this floor, is what declines them.
    minScore: 0.40,
    // Hard cap on injected chunks (forced SKU chunks + semantic top-K combined).
    // Kept modest to limit per-request input tokens (faster, more consistent first token).
    maxChunks: 10,
  },

  // Error Message Templates
  errorMessages: {
    missingMessage: "Message is required",
    apiUnsupported: "This endpoint only supports server-sent events (SSE) requests or history requests.",
    authFailed: "Authentication failed with Claude API",
    apiKeyError: "Please check your API key in environment variables",
    rateLimitExceeded: "Rate limit exceeded",
    rateLimitDetails: "Please try again later",
    genericError: "Failed to get response from Claude"
  },

  // Tool Configuration
  tools: {
    // Tool names whose results render product cards. Shopify's storefront MCP has
    // served both names depending on store/API version; this store exposes
    // search_catalog (see the arg-wrapping in chat.jsx), so match either.
    productSearchNames: ["search_catalog", "search_shop_catalog"],
    maxProductsToDisplay: 3
  }
};

export default AppConfig;
