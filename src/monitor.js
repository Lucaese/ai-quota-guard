/**
 * QuotaMonitor – core engine
 * 
 * Manages multiple provider watchers, evaluates stop/resume thresholds,
 * emits events, and maintains monitor state.
 */

const EventEmitter = require('events');
const { createProvider } = require('./providers');

const STATE = {
  ACTIVE: 'active',       // below stop threshold – calls allowed
  PAUSED: 'paused',       // above stop threshold – calls blocked
  UNKNOWN: 'unknown',     // not yet probed
  ERROR: 'error',         // probe failed
};

class QuotaMonitor extends EventEmitter {
  constructor(config = {}) {
    super();

    // config.models = [ { provider, apiKey, model, stopThreshold, resumeThreshold, ... }, ... ]
    this.models = config.models || [];
    
    // Poll interval in seconds (default 60s)
    this.pollIntervalSeconds = config.pollIntervalSeconds || 60;
    
    // Internal state per model
    this._states = {};     // modelId -> STATE
    this._quotas = {};     // modelId -> last quota object
    this._providers = {};  // modelId -> provider instance
    this._timers = {};     // modelId -> setInterval handle
    this._history = {};    // modelId -> array of quota snapshots

    // Initialize providers
    for (const modelCfg of this.models) {
      const id = this._modelId(modelCfg);
      this._states[id] = STATE.UNKNOWN;
      this._history[id] = [];
      this._providers[id] = createProvider(modelCfg.provider, {
        apiKey: modelCfg.apiKey,
        model: modelCfg.model,
        orgId: modelCfg.orgId,
        tokenLimit: modelCfg.tokenLimit,
        requestLimit: modelCfg.requestLimit,
      });
    }
  }

  _modelId(cfg) {
    return `${cfg.provider}:${cfg.model || 'default'}`;
  }

  /**
   * Start monitoring all configured models
   */
  start() {
    for (const modelCfg of this.models) {
      const id = this._modelId(modelCfg);
      this._startWatcher(id, modelCfg);
    }
    this.emit('started', { models: Object.keys(this._states) });
  }

  /**
   * Stop all watchers
   */
  stop() {
    for (const id of Object.keys(this._timers)) {
      clearInterval(this._timers[id]);
      delete this._timers[id];
    }
    this.emit('stopped');
  }

  /**
   * Start watcher loop for a single model
   */
  _startWatcher(id, modelCfg) {
    // Probe immediately, then on interval
    this._probe(id, modelCfg);
    this._timers[id] = setInterval(
      () => this._probe(id, modelCfg),
      this.pollIntervalSeconds * 1000
    );
  }

  async _probe(id, modelCfg) {
    const provider = this._providers[id];
    try {
      const quota = await provider.getQuota();
      this._quotas[id] = quota;

      // Keep last 100 snapshots
      this._history[id].push({ ...quota });
      if (this._history[id].length > 100) this._history[id].shift();

      // Evaluate thresholds
      const usedPct = quota.tokens.usedPercent;
      const stopAt = modelCfg.stopThreshold || 90;   // stop when used% >= this
      const resumeAt = modelCfg.resumeThreshold || 20; // resume when used% <= this (i.e. mostly reset)

      const prevState = this._states[id];

      if (usedPct >= stopAt && prevState !== STATE.PAUSED) {
        this._states[id] = STATE.PAUSED;
        this.emit('paused', {
          id,
          provider: modelCfg.provider,
          model: modelCfg.model,
          usedPercent: usedPct,
          stopThreshold: stopAt,
          quota,
        });
      } else if (usedPct <= resumeAt && prevState === STATE.PAUSED) {
        this._states[id] = STATE.ACTIVE;
        this.emit('resumed', {
          id,
          provider: modelCfg.provider,
          model: modelCfg.model,
          usedPercent: usedPct,
          resumeThreshold: resumeAt,
          quota,
        });
      } else if (prevState === STATE.UNKNOWN) {
        this._states[id] = usedPct < stopAt ? STATE.ACTIVE : STATE.PAUSED;
        this.emit('initialized', {
          id,
          state: this._states[id],
          quota,
        });
      }

      this.emit('quota', { id, quota, state: this._states[id] });
    } catch (err) {
      this._states[id] = STATE.ERROR;
      this.emit('error', { id, error: err.message });
    }
  }

  /**
   * Public API: check if a specific model is allowed to be called
   */
  isAllowed(provider, model) {
    const id = `${provider}:${model || 'default'}`;
    const state = this._states[id];
    return state === STATE.ACTIVE || state === STATE.UNKNOWN;
  }

  /**
   * Get current state snapshot for all models
   */
  getSnapshot() {
    return Object.keys(this._states).map((id) => ({
      id,
      state: this._states[id],
      quota: this._quotas[id] || null,
    }));
  }

  /**
   * Get history for a model
   */
  getHistory(id) {
    return this._history[id] || [];
  }

  /**
   * Force an immediate re-probe (useful for testing)
   */
  async forceProbe(provider, model) {
    const id = `${provider}:${model || 'default'}`;
    const modelCfg = this.models.find(
      (m) => m.provider === provider && (m.model || 'default') === (model || 'default')
    );
    if (!modelCfg) throw new Error(`Model not configured: ${id}`);
    await this._probe(id, modelCfg);
    return this._quotas[id];
  }
}

module.exports = { QuotaMonitor, STATE };
