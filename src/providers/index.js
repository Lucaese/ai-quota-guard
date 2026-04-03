'use strict';

const AnthropicProvider = require('./anthropic');
const OpenAIProvider    = require('./openai');
const GeminiProvider    = require('./gemini');
const ClaudeAIProvider  = require('./claudeai');

const REGISTRY = {
  anthropic: AnthropicProvider,
  openai:    OpenAIProvider,
  gemini:    GeminiProvider,
  claudeai:  ClaudeAIProvider,  // claude.ai 订阅套餐（用 sessionKey 认证）
};

/**
 * Create a provider instance by name.
 * @param {string} name - Provider key: 'anthropic' | 'openai' | 'gemini'
 * @param {object} config - { apiKey, model, ... }
 */
function createProvider(name, config) {
  const Cls = REGISTRY[name.toLowerCase()];
  if (!Cls) throw new Error(`Unknown provider: "${name}". Supported: ${Object.keys(REGISTRY).join(', ')}`);
  return new Cls(config);
}

/**
 * Return metadata for all supported providers (used by CLI wizard).
 * @returns {{ key, displayName, models, resetInfo }[]}
 */
function getSupportedProviders() {
  return Object.entries(REGISTRY).map(([key, Cls]) => {
    const instance = new Cls({ apiKey: '', model: '' });
    return {
      key,
      displayName: instance.displayName,
      models: instance.getModels(),
      resetInfo: instance.getResetInfo(),
    };
  });
}

module.exports = { createProvider, getSupportedProviders };
