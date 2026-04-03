/**
 * Claude.ai 订阅额度监控 — 文件读取方案
 *
 * 读取由以下任一方式写入的共享数据文件：
 *   A) Chrome 扩展 + Native Messaging Host → ~/.config/ai-quota-guard/claudeai-usage.json
 *   B) claudeai-pw.js (Playwright) → 同一文件
 *
 * 数据文件由扩展或 Playwright 实时更新，本 provider 仅负责读取和阈值判断。
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DATA_FILE = path.join(os.homedir(), '.config', 'ai-quota-guard', 'claudeai-usage.json');

// 数据文件最长有效期（超过则认为数据过期）
const MAX_STALE_MS = 10 * 60 * 1000; // 10 分钟

class ClaudeAIProvider {
  constructor(config) {
    this.name        = 'claudeai';
    this.displayName = 'Claude.ai (订阅套餐)';
    // model: 'session' | 'weekly'
    this.model = config.model || 'session';

    this._cachedQuota    = null;
    this._lastProbeTime  = null;
    this._probeIntervalMs = 30 * 1000; // 30 秒内复用缓存（文件读取很快）
  }

  // ── 读取共享数据文件 ──────────────────────────────────────────────────────
  _readDataFile() {
    if (!fs.existsSync(DATA_FILE)) {
      throw new Error(
        `数据文件不存在: ${DATA_FILE}\n\n` +
        '请先安装以下任一数据源：\n' +
        '  方案A（Chrome扩展）: 将 chrome-extension/ 目录加载到 Chrome，并运行 install.sh\n' +
        '  方案B（Playwright）: 配置 claudeai-pw 提供商，运行一次 quota-guard watch 触发抓取'
      );
    }

    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const data = JSON.parse(raw);

    // 检查数据是否过期
    if (data.fetchedAt) {
      const age = Date.now() - new Date(data.fetchedAt).getTime();
      if (age > MAX_STALE_MS) {
        const minutes = Math.round(age / 60000);
        throw new Error(
          `claude.ai 用量数据已过期（${minutes}分钟前更新）。\n` +
          '请确认 Chrome 扩展正在运行，或重新执行 quota-guard watch --provider claudeai-pw'
        );
      }
    }

    return data;
  }

  async getQuota() {
    const now = Date.now();
    if (this._cachedQuota && this._lastProbeTime && now - this._lastProbeTime < this._probeIntervalMs) {
      return this._cachedQuota;
    }

    const data = this._readDataFile();

    const sessionPct = data.sessionUsedPercent;
    const weeklyPct  = data.weeklyUsedPercent;

    if (sessionPct === null && weeklyPct === null) {
      throw new Error('数据文件中无有效的用量百分比，请检查数据源');
    }

    const usedPct = this.model === 'weekly' ? weeklyPct : sessionPct;
    const resetAt = this.model === 'weekly' ? data.weeklyResetAt : data.sessionResetAt;

    this._cachedQuota = {
      provider: 'claudeai',
      model: this.model,
      tokens: {
        limit:            100,
        used:             usedPct,
        remaining:        100 - usedPct,
        usedPercent:      usedPct,
        remainingPercent: 100 - usedPct,
        resetAt,
      },
      requests: {
        limit:     100,
        used:      weeklyPct ?? 0,
        remaining: 100 - (weeklyPct ?? 0),
        resetAt:   data.weeklyResetAt,
      },
      meta: {
        sessionUsedPercent: sessionPct,
        weeklyUsedPercent:  weeklyPct,
        sessionResetAt:     data.sessionResetAt,
        weeklyResetAt:      data.weeklyResetAt,
        dataSource:         data.source,
        dataAge:            data.fetchedAt ? `${Math.round((now - new Date(data.fetchedAt).getTime()) / 1000)}s ago` : null,
      },
      resetIntervalMinutes: this.model === 'weekly' ? 7 * 24 * 60 : 300,
      timestamp: new Date().toISOString(),
    };

    this._lastProbeTime = now;
    return this._cachedQuota;
  }

  async validateKey() {
    try {
      this._readDataFile();
      return { valid: true, status: 200 };
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
      description: 'Session 约每 5 小时重置；Weekly 用量每周二重置',
    };
  }
}

module.exports = ClaudeAIProvider;
