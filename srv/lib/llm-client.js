/**
 * Centralized LLM Client Configuration
 *
 * Single source of truth for LLM model configuration.
 * Switch models in ONE place instead of updating multiple files.
 *
 * USAGE:
 * const { createLLMClient } = require('./llm-client');
 * const client = createLLMClient();
 * const response = await client.chatCompletion({ messages: [...] });
 * const content = response.getContent();
 *
 * ARCHITECTURE:
 * - Uses OrchestrationClient for ALL models (OpenAI, Anthropic, Google)
 * - Single deployment (defaultOrchestrationConfig) provides access to all models
 * - No model-specific deployments needed
 *
 * SUPPORTED MODELS:
 * ✅ OpenAI: gpt-4, gpt-5
 * ✅ Anthropic: anthropic--claude-4-sonnet
 * ✅ Google: gemini-2.5-pro, gemini-2.5-flash
 */

const { OrchestrationClient } = require('@sap-ai-sdk/orchestration');

/**
 * LLM Model Configuration
 *
 * Change these values to switch models across the entire application.
 */
const LLM_CONFIG = {
  // PRIMARY MODEL: Used for company extraction, email summarization, etc.

  primary: {
    modelName: 'gpt-5',
    modelVersion: '2025-08-07',
    description: 'GPT-5 via OpenAI'
  },

  // ============ ALTERNATIVE MODELS (uncomment to switch) ============

  // Google Gemini 2.5 Flash (fastest, ~1.2s response time)
  // primary: {
  //   modelName: 'gemini-2.5-flash',
  //   modelVersion: '001',
  //   description: 'Gemini 2.5 Flash via Google'
  // },

  // Anthropic Claude 4 Sonnet (best reasoning, ~1.9s response time)
  // primary: {
  //   modelName: 'anthropic--claude-4-sonnet',
  //   modelVersion: '1',
  //   description: 'Claude 4 Sonnet via Anthropic'
  // },

  // Google Gemini 2.5 Pro (balanced, ~3.1s response time)
  // primary: {
  //   modelName: 'gemini-2.5-pro',
  //   modelVersion: '001',
  //   description: 'Gemini 2.5 Pro via Google'
  // }
};

/**
 * Get provider name from model name (for logging)
 */
function getProviderName(modelName) {
  if (modelName.startsWith('gpt-')) return 'OpenAI';
  if (modelName.startsWith('anthropic--')) return 'Anthropic';
  if (modelName.startsWith('gemini-')) return 'Google';
  return 'Unknown';
}

/**
 * Create LLM Client Instance
 *
 * Creates an OrchestrationClient configured with the specified model.
 * All models use the same client type - just the model name/version changes.
 *
 * @param {Object} options - Optional override settings
 * @returns {OrchestrationClient} Configured LLM client
 */
function createLLMClient(options = {}) {
  const config = options.model || LLM_CONFIG.primary;

  console.log(`🤖 Calling LLM (${config.modelName}) to extract company name...`);
  console.log(`🤖 Creating LLM client: ${config.description}`);
  console.log(`   Model: ${config.modelName} (v${config.modelVersion})`);
  console.log(`   Provider: ${getProviderName(config.modelName)}`);
  console.log(`   Using: OrchestrationClient`);

  return new OrchestrationClient({
    promptTemplating: {
      model: {
        name: config.modelName,
        version: config.modelVersion
      }
    }
  });
}

/**
 * Get Current Model Info
 *
 * Returns information about the currently configured model.
 * Useful for logging and debugging.
 *
 * @returns {Object} Model configuration info
 */
function getModelInfo() {
  return {
    ...LLM_CONFIG.primary,
    provider: getProviderName(LLM_CONFIG.primary.modelName)
  };
}

module.exports = {
  createLLMClient,
  getModelInfo,
  LLM_CONFIG
};
