/**
 * Claude.ai 订阅套餐额度监控
 *
 * 读取 claude.ai 网页版的订阅用量：
 *   - Current session：当前 session 用量（约每5小时重置）
 *   - Weekly limits：每周总用量（周二重置）
 *
 * 认证方式：浏览器 Cookie 中的 sessionKey（sk-ant-sid03-...）
 */

const axios = require('axios');

class ClaudeAIProvider {
  constructor(config) {
    this.name = 'claudeai';
    this.displayName = 'Claude.ai (订阅套餐)';
    // sessionKey = 浏览器 Cookie 中 sessionKey 的值 (sk-ant-sid03-...)
    this.sessionKey = config.sessionKey || config.apiKey;
    // model 字段用于区分监控维度：session | weekly
    this.model = config.model || 'session';

    this._cachedQuota = null;
    this._lastProbeTime = null;
    this._probeIntervalMs = 60 * 1000; // 最小探测间隔 1 分钟（避免频繁请求）
  }

  _headers() {
    return {
      Cookie: `sessionKey=${this.sessionKey}`,
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://claude.ai/settings/usage',
    };
  }

  /**
   * 尝试从 API 端点读取数据，失败则解析 HTML 页面
   */
  async _fetchRaw() {
    // 先尝试 JSON API 端点
    const apiEndpoints = [
      'https://claude.ai/api/account_usage',
      'https://claude.ai/api/usage_limits',
      'https://claude.ai/api/rate_limits',
    ];

    for (const url of apiEndpoints) {
      try {
        const res = await axios.get(url, {
          headers: this._headers(),
          validateStatus: (s) => s < 500,
          timeout: 10000,
        });
        if (res.status === 200 && res.data && typeof res.data === 'object') {
          return { source: 'api', url, data: res.data };
        }
      } catch (_) {
        // 继续尝试下一个
      }
    }

    // 回退：解析 settings/usage 页面 HTML
    return await this._parseHtmlPage();
  }

  /**
   * 解析 claude.ai/settings/usage 页面，从 HTML 中提取用量百分比
   */
  async _parseHtmlPage() {
    const res = await axios.get('https://claude.ai/settings/usage', {
      headers: {
        ...this._headers(),
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      validateStatus: (s) => s < 500,
      timeout: 15000,
    });

    if (res.status === 401 || res.status === 403) {
      throw new Error('Session key 已失效，请重新从浏览器获取 sessionKey Cookie');
    }
    if (res.status !== 200) {
      throw new Error(`获取 claude.ai 用量页面失败：HTTP ${res.status}`);
    }

    const html = res.data;

    // 尝试从 __NEXT_DATA__ 提取结构化数据
    const nextDataMatch = html.match(
      /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
    );
    if (nextDataMatch) {
      try {
        const nextData = JSON.parse(nextDataMatch[1]);
        const pageProps = nextData?.props?.pageProps;
        if (pageProps?.usageLimits || pageProps?.usageData) {
          return { source: 'next-data', data: pageProps };
        }
      } catch (_) {
        // JSON 解析失败，继续用正则
      }
    }

    // 最终回退：用正则从页面文本中匹配百分比数字
    // 页面格式：  "60% used"  "33% used"
    const percentMatches = [...html.matchAll(/(\d+(?:\.\d+)?)\s*%\s*used/g)].map(
      (m) => parseFloat(m[1])
    );

    // 匹配重置时间
    const sessionResetMatch = html.match(/Resets\s+in\s+([\d]+\s*hr\s*[\d]*\s*min)/i);
    const weeklyResetMatch = html.match(/Resets\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[\d:]+\s*(?:AM|PM)?)/i);

    return {
      source: 'html-regex',
      data: {
        sessionUsedPercent: percentMatches[0] ?? null,
        weeklyUsedPercent: percentMatches[1] ?? null,
        sessionResetIn: sessionResetMatch?.[1] ?? null,
        weeklyResetAt: weeklyResetMatch?.[1] ?? null,
      },
    };
  }

  /**
   * 将原始数据归一化为标准 quota 格式
   */
  _normalize(raw) {
    let sessionPct = null;
    let weeklyPct = null;
    let sessionReset = null;
    let weeklyReset = null;

    const { source, data } = raw;

    if (source === 'api') {
      // 处理 JSON API 响应（结构待确认，按常见模式处理）
      sessionPct =
        data.session?.used_percentage ??
        data.current_session?.percent_used ??
        data.sessionUsedPercent ??
        null;
      weeklyPct =
        data.weekly?.used_percentage ??
        data.weekly_limits?.percent_used ??
        data.weeklyUsedPercent ??
        null;
      sessionReset = data.session?.reset_at ?? data.current_session?.reset_at ?? null;
      weeklyReset = data.weekly?.reset_at ?? data.weekly_limits?.reset_at ?? null;
    } else if (source === 'next-data') {
      const u = data.usageLimits || data.usageData || {};
      sessionPct = u.sessionUsedPercent ?? u.session?.usedPercent ?? null;
      weeklyPct = u.weeklyUsedPercent ?? u.weekly?.usedPercent ?? null;
      sessionReset = u.session?.resetAt ?? null;
      weeklyReset = u.weekly?.resetAt ?? null;
    } else {
      // html-regex
      sessionPct = data.sessionUsedPercent;
      weeklyPct = data.weeklyUsedPercent;
      sessionReset = data.sessionResetIn ? `in ${data.sessionResetIn}` : null;
      weeklyReset = data.weeklyResetAt;
    }

    // 根据 model 配置选择监控维度
    const usedPct = this.model === 'weekly' ? weeklyPct : sessionPct;
    const resetAt = this.model === 'weekly' ? weeklyReset : sessionReset;

    if (usedPct === null) {
      throw new Error(
        `无法解析 claude.ai 用量数据（source=${source}）。` +
          '请确认 sessionKey 有效，或提交 issue 反馈。'
      );
    }

    return {
      provider: 'claudeai',
      model: this.model,
      tokens: {
        // claude.ai 以百分比为单位，limit 固定 100 便于统一处理
        limit: 100,
        used: parseFloat(usedPct.toFixed(1)),
        remaining: parseFloat((100 - usedPct).toFixed(1)),
        usedPercent: parseFloat(usedPct.toFixed(1)),
        remainingPercent: parseFloat((100 - usedPct).toFixed(1)),
        resetAt: resetAt,
      },
      requests: {
        // 同时记录另一个维度作为参考
        limit: 100,
        used: weeklyPct ?? 0,
        remaining: 100 - (weeklyPct ?? 0),
        resetAt: weeklyReset,
      },
      meta: {
        sessionUsedPercent: sessionPct,
        weeklyUsedPercent: weeklyPct,
        sessionResetAt: sessionReset,
        weeklyResetAt: weeklyReset,
        dataSource: source,
      },
      resetIntervalMinutes: this.model === 'weekly' ? 7 * 24 * 60 : 300,
      timestamp: new Date().toISOString(),
    };
  }

  async getQuota() {
    const now = Date.now();
    if (
      this._cachedQuota &&
      this._lastProbeTime &&
      now - this._lastProbeTime < this._probeIntervalMs
    ) {
      return this._cachedQuota;
    }

    const raw = await this._fetchRaw();
    this._cachedQuota = this._normalize(raw);
    this._lastProbeTime = now;
    return this._cachedQuota;
  }

  async validateKey() {
    try {
      const res = await axios.get('https://claude.ai/api/organizations', {
        headers: this._headers(),
        validateStatus: (s) => s < 500,
        timeout: 10000,
      });
      if (res.status === 401 || res.status === 403) {
        return { valid: false, error: 'sessionKey 无效或已过期，请重新从浏览器获取' };
      }
      // 即使不是 200，只要不是认证错误都算通过验证（避免误杀）
      return { valid: true, status: res.status };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }

  getModels() {
    return ['session', 'weekly'];
  }

  getResetInfo() {
    return {
      intervalMinutes: 300,
      description: 'Session 用量约每 5 小时重置；Weekly 用量每周二重置',
    };
  }
}

module.exports = ClaudeAIProvider;
