/**
 * Google Gemini Quota Provider
 * 
 * Gemini uses per-minute RPM/TPM limits via Google AI Studio / Vertex AI.
 * Rate limit info is returned in response headers.
 */

const axios = require('axios');

class GeminiProvider {
  constructor(config) {
    this.name = 'gemini';
    this.displayName = 'Google Gemini';
    this.apiKey = config.apiKey;
    this.model = config.model || 'gemini-1.5-pro';
    this.resetIntervalMinutes = 1;

    this._cachedQuota = null;
    this._lastProbeTime = null;
    this._probeIntervalMs = 30000;
    
    // Internal counters (Gemini doesn't expose remaining in headers cleanly on all plans)
    this._windowStart = Date.now();
    this._requestsInWindow = 0;
    this._tokensInWindow = 0;
    
    // Default free-tier limits
    this._requestLimit = config.requestLimit || 15;  // RPM
    this._tokenLimit = config.tokenLimit || 1000000; // TPM
  }

  async _probeQuota() {
    const now = Date.now();
    if (
      this._cachedQuota &&
      this._lastProbeTime &&
      now - this._lastProbeTime < this._probeIntervalMs
    ) {
      return this._cachedQuota;
    }

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
      const response = await axios.post(
        url,
        {
          contents: [{ parts: [{ text: 'Hi' }] }],
          generationConfig: { maxOutputTokens: 1 },
        },
        { validateStatus: (s) => s < 500 }
      );

      const headers = response.headers;

      // Reset window if 1 minute has passed
      if (now - this._windowStart > 60000) {
        this._windowStart = now;
        this._requestsInWindow = 0;
        this._tokensInWindow = 0;
      }

      if (response.status < 300) {
        this._requestsInWindow++;
        const usage = response.data?.usageMetadata;
        if (usage) {
          this._tokensInWindow += (usage.promptTokenCount || 0) + (usage.candidatesTokenCount || 0);
        }
      }

      const usedRequests = this._requestsInWindow;
      const remainingRequests = Math.max(0, this._requestLimit - usedRequests);
      const usedTokens = this._tokensInWindow;
      const remainingTokens = Math.max(0, this._tokenLimit - usedTokens);

      const usedPercent = this._requestLimit > 0 ? (usedRequests / this._requestLimit) * 100 : 0;

      const windowResetAt = new Date(this._windowStart + 60000).toISOString();

      this._cachedQuota = {
        provider: 'gemini',
        model: this.model,
        tokens: {
          limit: this._tokenLimit,
          used: usedTokens,
          remaining: remainingTokens,
          usedPercent: parseFloat(((usedTokens / this._tokenLimit) * 100).toFixed(2)),
          remainingPercent: parseFloat(((remainingTokens / this._tokenLimit) * 100).toFixed(2)),
          resetAt: windowResetAt,
        },
        requests: {
          limit: this._requestLimit,
          used: usedRequests,
          remaining: remainingRequests,
          resetAt: windowResetAt,
        },
        resetIntervalMinutes: 1,
        probeStatus: response.status,
        timestamp: new Date().toISOString(),
      };

      this._lastProbeTime = now;
      return this._cachedQuota;
    } catch (err) {
      throw new Error(`Gemini quota probe failed: ${err.message}`);
    }
  }

  async getQuota() {
    return await this._probeQuota();
  }

  async validateKey() {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${this.apiKey}`;
      const response = await axios.get(url, { validateStatus: (s) => s < 500 });
      if (response.status === 400 || response.status === 403) {
        return { valid: false, error: 'Invalid API key or insufficient permissions' };
      }
      return { valid: true, status: response.status };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }

  getModels() {
    return [
      'gemini-1.5-pro',
      'gemini-1.5-flash',
      'gemini-1.0-pro',
      'gemini-2.0-flash',
    ];
  }

  getResetInfo() {
    return {
      intervalMinutes: 1,
      description: 'Gemini rate limits reset every minute (RPM/TPM)',
    };
  }
}

module.exports = GeminiProvider;
