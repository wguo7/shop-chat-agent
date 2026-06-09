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
    minScore: 0.45,
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
    productSearchName: "search_shop_catalog",
    maxProductsToDisplay: 3
  }
};

export default AppConfig;
