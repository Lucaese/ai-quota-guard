/**
 * Anthropic (Claude) Quota Provider
 * 
 * Claude uses a token-based rate limit system that resets every 5 hours.
 * We track usage by monitoring the response headers from API calls,
 * and by calling the usage API endpoint.
 * 
 * Anthropic Rate Limit Headers (returned on each API response):
 *   x-ratelimit-limit-tokens        - total token limit per window
 *   x-ratelimit-remaining-tokens    - tokens remaining in current window
 *   x-ratelimit-reset-tokens        - ISO timestamp when tokens reset
 *   x-ratelimit-limit-requests      - total request limit per window
 *   x-ratelimit-remaining-requests  - requests remaining
 *   x-ratelimit-reset-requests      - ISO timestamp when requests reset
 */

const axios = require('axios');

class AnthropicProvider {
  constructor(config) {
    this.name = 'anthropic';
    this.displayName = 'Anthropic (Claude)';
    this.apiKey = config.apiKey;
    this.model = config.model || 'claude-opus-4-5';
    
    // Anthropic resets every 5 hours
    this.resetIntervalMinutes = 300;
    
    // Cached quota state from last API call headers
    this._cachedQuota = null;
    this._lastProbeTime = null;
    this._probeIntervalMs = 30000; // re-probe every 30s minimum
  }

  /**
   * Probe the API with a minimal request to get fresh rate-limit headers.
   * Uses a 1-token request to minimize actual token usage.
   */
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
        'https://api.anthropic.com/v1/messages',
        {
          model: this.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'Hi' }],
        },
        {
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          // Don't throw on 4xx so we can still read headers
          validateStatus: (status) => status < 500,
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
        provider: 'anthropic',
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
      throw new Error(`Anthropic quota probe failed: ${err.message}`);
    }
  }

  async getQuota() {
    return await this._probeQuota();
  }

  /**
   * Validate the API key by making a lightweight request
   */
  async validateKey() {
    try {
      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: this.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'test' }],
        },
        {
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          validateStatus: (s) => s < 500,
        }
      );
      if (response.status === 401) return { valid: false, error: 'Invalid API key' };
      if (response.status === 403) return { valid: false, error: 'Forbidden – check key permissions' };
      return { valid: true, status: response.status };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }

  getModels() {
    return [
      'claude-opus-4-5',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
    ];
  }

  getResetInfo() {
    return {
      intervalMinutes: 300,
      description: 'Anthropic resets token quota every 5 hours (300 minutes)',
    };
  }
}

module.exports = AnthropicProvider;
