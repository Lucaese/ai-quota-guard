/**
 * OpenAI Quota Provider
 * 
 * OpenAI uses a credit/billing system + per-minute rate limits.
 * We read rate-limit headers from responses and query the usage API.
 * 
 * OpenAI Rate Limit Headers:
 *   x-ratelimit-limit-tokens
 *   x-ratelimit-remaining-tokens
 *   x-ratelimit-reset-tokens
 *   x-ratelimit-limit-requests
 *   x-ratelimit-remaining-requests
 *   x-ratelimit-reset-requests
 */

const axios = require('axios');

class OpenAIProvider {
  constructor(config) {
    this.name = 'openai';
    this.displayName = 'OpenAI (GPT)';
    this.apiKey = config.apiKey;
    this.model = config.model || 'gpt-4o';
    this.orgId = config.orgId || null;

    // OpenAI RPM windows are per-minute; daily billing resets at midnight UTC
    this.resetIntervalMinutes = 1440; // 24h for billing

    this._cachedQuota = null;
    this._lastProbeTime = null;
    this._probeIntervalMs = 30000;
  }

  _buildHeaders() {
    const h = {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
    if (this.orgId) h['OpenAI-Organization'] = this.orgId;
    return h;
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
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: this.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'Hi' }],
        },
        {
          headers: this._buildHeaders(),
          validateStatus: (s) => s < 500,
        }
      );

      const headers = response.headers;
      const limitTokens = parseInt(headers['x-ratelimit-limit-tokens'] || '0');
      const remainingTokens = parseInt(headers['x-ratelimit-remaining-tokens'] || '0');
      const resetTokensAt = headers['x-ratelimit-reset-tokens'] || null;
      const limitRequests = parseInt(headers['x-ratelimit-limit-requests'] || '0');
      const remainingRequests = parseInt(headers['x-ratelimit-remaining-requests'] || '0');
      const resetRequestsAt = headers['x-ratelimit-reset-requests'] || null;

      const usedTokens = limitTokens > 0 ? limitTokens - remainingTokens : 0;
      const usedPercent = limitTokens > 0 ? (usedTokens / limitTokens) * 100 : 0;

      this._cachedQuota = {
        provider: 'openai',
        model: this.model,
        tokens: {
          limit: limitTokens,
          used: usedTokens,
          remaining: remainingTokens,
          usedPercent: parseFloat(usedPercent.toFixed(2)),
          remainingPercent: parseFloat((100 - usedPercent).toFixed(2)),
          resetAt: resetTokensAt,
        },
        requests: {
          limit: limitRequests,
          used: limitRequests > 0 ? limitRequests - remainingRequests : 0,
          remaining: remainingRequests,
          resetAt: resetRequestsAt,
        },
        resetIntervalMinutes: this.resetIntervalMinutes,
        probeStatus: response.status,
        timestamp: new Date().toISOString(),
      };

      this._lastProbeTime = now;
      return this._cachedQuota;
    } catch (err) {
      throw new Error(`OpenAI quota probe failed: ${err.message}`);
    }
  }

  async getQuota() {
    return await this._probeQuota();
  }

  async validateKey() {
    try {
      const response = await axios.get('https://api.openai.com/v1/models', {
        headers: this._buildHeaders(),
        validateStatus: (s) => s < 500,
      });
      if (response.status === 401) return { valid: false, error: 'Invalid API key' };
      return { valid: true, status: response.status };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }

  getModels() {
    return [
      'gpt-4o',
      'gpt-4o-mini',
      'gpt-4-turbo',
      'gpt-4',
      'gpt-3.5-turbo',
      'o1-preview',
      'o1-mini',
    ];
  }

  getResetInfo() {
    return {
      intervalMinutes: 1,
      description: 'OpenAI rate limit windows are per-minute; billing resets daily',
    };
  }
}

module.exports = OpenAIProvider;
