/**
 * Config manager – persists settings using the `conf` package
 * (stores in ~/.config/ai-quota-guard/config.json on most systems)
 */

const Conf = require('conf');
const path = require('path');

const store = new Conf({
  projectName: 'ai-quota-guard',
  schema: {
    models: {
      type: 'array',
      default: [],
    },
    pollIntervalSeconds: {
      type: 'number',
      default: 60,
    },
    notifications: {
      type: 'boolean',
      default: true,
    },
  },
});

const ConfigManager = {
  /**
   * Get all configured models
   */
  getModels() {
    return store.get('models') || [];
  },

  /**
   * Add or update a model configuration
   */
  saveModel(modelCfg) {
    const models = this.getModels();
    const id = `${modelCfg.provider}:${modelCfg.model || 'default'}`;
    const idx = models.findIndex((m) => `${m.provider}:${m.model || 'default'}` === id);
    if (idx >= 0) {
      models[idx] = { ...models[idx], ...modelCfg };
    } else {
      models.push(modelCfg);
    }
    store.set('models', models);
    return id;
  },

  /**
   * Remove a model by id (provider:model)
   */
  removeModel(id) {
    const models = this.getModels();
    const filtered = models.filter((m) => `${m.provider}:${m.model || 'default'}` !== id);
    store.set('models', filtered);
  },

  /**
   * Get global settings
   */
  getSettings() {
    return {
      pollIntervalSeconds: store.get('pollIntervalSeconds'),
      notifications: store.get('notifications'),
    };
  },

  /**
   * Update a global setting
   */
  setSetting(key, value) {
    store.set(key, value);
  },

  /**
   * Get the config file path (for user reference)
   */
  getConfigPath() {
    return store.path;
  },

  /**
   * Export full config
   */
  export() {
    return {
      models: this.getModels(),
      ...this.getSettings(),
    };
  },

  /**
   * Import config (merge)
   */
  import(config) {
    if (config.models) store.set('models', config.models);
    if (config.pollIntervalSeconds) store.set('pollIntervalSeconds', config.pollIntervalSeconds);
    if (typeof config.notifications === 'boolean') store.set('notifications', config.notifications);
  },

  /**
   * Clear all config
   */
  clear() {
    store.clear();
  },
};

module.exports = ConfigManager;
