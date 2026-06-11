/**
 * Tool Service
 * Manages tool execution and processing
 */
import AppConfig from "./config.server";

/**
 * Creates a tool service instance
 * @returns {Object} Tool service with methods for managing tools
 */
export function createToolService() {
  /**
   * Handles a tool error response
   * @param {Object} toolUseResponse - The error response from the tool
   * @param {string} toolName - The name of the tool
   * @param {string} toolUseId - The ID of the tool use request
   * @param {Array} conversationHistory - The conversation history
   * @param {Function} sendMessage - Function to send messages to the client
   * @param {Function} persistMessage - Ordered persistence callback (role, content)
   */
  const handleToolError = async (toolUseResponse, toolName, toolUseId, conversationHistory, sendMessage, persistMessage) => {
    if (toolUseResponse.error.type === "auth_required") {
      console.log("Auth required for tool:", toolName);
      await addToolResultToHistory(conversationHistory, toolUseId, toolUseResponse.error.data, persistMessage);
      sendMessage({ type: 'auth_required' });
    } else {
      console.log("Tool use error", toolUseResponse.error);
      await addToolResultToHistory(conversationHistory, toolUseId, toolUseResponse.error.data, persistMessage);
    }
  };

  /**
   * Handles a successful tool response
   * @param {Object} toolUseResponse - The response from the tool
   * @param {string} toolName - The name of the tool
   * @param {string} toolUseId - The ID of the tool use request
   * @param {Array} conversationHistory - The conversation history
   * @param {Array} productsToDisplay - Array to add product results to
   * @param {Function} persistMessage - Ordered persistence callback (role, content)
   */
  const handleToolSuccess = async (toolUseResponse, toolName, toolUseId, conversationHistory, productsToDisplay, persistMessage) => {
    // Check if this is a product search result. Multiple searches in one turn
    // return overlapping results, so dedupe before display.
    if (AppConfig.tools.productSearchNames.includes(toolName)) {
      for (const product of processProductSearchResult(toolUseResponse)) {
        const isDuplicate = productsToDisplay.some(
          (existing) => existing.id === product.id || existing.title === product.title
        );
        if (!isDuplicate) productsToDisplay.push(product);
      }
    }

    await addToolResultToHistory(conversationHistory, toolUseId, toolUseResponse.content, persistMessage);
  };

  /**
   * Processes product search results
   * @param {Object} toolUseResponse - The response from the tool
   * @returns {Array} Processed product data
   */
  const processProductSearchResult = (toolUseResponse) => {
    try {
      console.log("Processing product search result");
      let products = [];

      if (toolUseResponse.content && toolUseResponse.content.length > 0) {
        const content = toolUseResponse.content[0].text;

        try {
          let responseData;
          if (typeof content === 'object') {
            responseData = content;
          } else if (typeof content === 'string') {
            responseData = JSON.parse(content);
          }

          if (responseData?.products && Array.isArray(responseData.products)) {
            products = responseData.products
              .slice(0, AppConfig.tools.maxProductsToDisplay)
              .map(formatProductData);

            console.log(`Found ${products.length} products to display`);
          }
        } catch (e) {
          console.error("Error parsing product data:", e);
        }
      }

      return products;
    } catch (error) {
      console.error("Error processing product search results:", error);
      return [];
    }
  };

  /**
   * Formats a display price. price_range.min varies by store/API version:
   * an { amount, currency } object in minor units, or a plain decimal.
   * @param {Object} product - Raw product data
   * @returns {string} Display price
   */
  const formatProductPrice = (product) => {
    const min = product.price_range?.min;
    if (min != null && typeof min === "object") {
      if (min.amount != null) {
        return `$${(Number(min.amount) / 100).toFixed(2)} ${min.currency || "USD"}`;
      }
    } else if (min != null) {
      const amount = Number(min);
      if (Number.isFinite(amount)) {
        return `$${amount.toFixed(2)} ${product.price_range.currency || "USD"}`;
      }
    }
    const variant = product.variants?.[0];
    if (variant && variant.price != null) {
      return `${variant.currency || "USD"} ${variant.price}`;
    }
    return 'Price not available';
  };

  /**
   * Formats a product data object
   * @param {Object} product - Raw product data
   * @returns {Object} Formatted product data
   */
  const formatProductData = (product) => {
    const price = formatProductPrice(product);

    return {
      id: product.product_id || `product-${Math.random().toString(36).substring(7)}`,
      title: product.title || 'Product',
      price: price,
      image_url: product.image_url || '',
      description: product.description || '',
      url: product.url || ''
    };
  };

  /**
   * Adds a tool result to the conversation history
   * @param {Array} conversationHistory - The conversation history
   * @param {string} toolUseId - The ID of the tool use request
   * @param {string} content - The content of the tool result
   * @param {Function} persistMessage - Ordered persistence callback (role, content)
   */
  const addToolResultToHistory = async (conversationHistory, toolUseId, content, persistMessage) => {
    const toolResultMessage = {
      role: 'user',
      content: [{
        type: "tool_result",
        tool_use_id: toolUseId,
        content: content
      }]
    };

    // Add to in-memory history
    conversationHistory.push(toolResultMessage);

    // Save to database with special format to indicate tool result
    if (persistMessage) {
      await persistMessage('user', JSON.stringify(toolResultMessage.content));
    }
  };

  return {
    handleToolError,
    handleToolSuccess,
    processProductSearchResult,
    addToolResultToHistory
  };
}

export default {
  createToolService
};
