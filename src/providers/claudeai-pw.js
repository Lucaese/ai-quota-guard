/**
 * Claude.ai 订阅额度监控 — Playwright 方案
 *
 * 使用 Playwright 驱动本地真实 Chrome（带用户 Profile），
 * 导航到 claude.ai/settings/usage 页面，提取用量百分比。
 *
 * 优点：使用真实浏览器，完全绕过 Cloudflare Bot Protection
 * 缺点：每次探测会短暂启动 Chrome（约 3-8 秒）
 *
 * 安装 Playwright：npm install playwright
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// 共享数据文件（与 Native Host 写入的同一文件）
const DATA_FILE = path.join(os.homedir(), '.config', 'ai-quota-guard', 'claudeai-usage.json');

// macOS Chrome 可执行文件路径（按优先级）
const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Arc.app/Contents/MacOS/Arc',
];

// Chrome 用户数据目录（按优先级）
const PROFILE_DIRS = [
  path.join(os.homedir(), 'Library/Application Support/Google/Chrome'),
  path.join(os.homedir(), 'Library/Application Support/BraveSoftware/Brave-Browser'),
];

class ClaudeAIPlaywrightProvider {
  constructor(config) {
    this.name = 'claudeai-pw';
    this.displayName = 'Claude.ai (Playwright)';
    this.model = config.model || 'session';
    // profileDir / profileName 可在 config 中覆盖
    this.profileDir  = config.profileDir  || null;
    this.profileName = config.profileName || 'Default';
    this.chromePath  = config.chromePath  || null;

    this._cachedQuota = null;
    this._lastProbeTime = null;
    this._probeIntervalMs = 5 * 60 * 1000; // 5 分钟缓存（Playwright 启动较慢）
  }

  // ── 找到可用的 Chrome 路径 ─────────────────────────────────────────────────
  _findChrome() {
    if (this.chromePath && fs.existsSync(this.chromePath)) return this.chromePath;
    for (const p of CHROME_PATHS) {
      if (fs.existsSync(p)) return p;
    }
    throw new Error('找不到 Chrome/Chromium，请在配置中指定 chromePath');
  }

  // ── 找到用户 Profile 目录 ──────────────────────────────────────────────────
  _findProfileDir() {
    if (this.profileDir && fs.existsSync(this.profileDir)) {
      return path.join(this.profileDir, this.profileName);
    }
    for (const base of PROFILE_DIRS) {
      const full = path.join(base, this.profileName);
      if (fs.existsSync(full)) return full;
    }
    // 没找到具体 profile，用临时目录（会要求重新登录）
    return path.join(os.tmpdir(), 'quota-guard-chrome-profile');
  }

  // ── 用 Playwright 抓取 claude.ai 用量 ─────────────────────────────────────
  async _fetchWithPlaywright() {
    let playwright;
    try {
      playwright = require('playwright');
    } catch {
      throw new Error(
        'Playwright 未安装，请运行：npm install playwright\n' +
        '然后运行：npx playwright install chromium'
      );
    }

    const chromePath  = this._findChrome();
    // 使用临时目录复制 Profile（避免与正在运行的 Chrome 冲突）
    const tmpProfile  = path.join(os.tmpdir(), `quota-guard-profile-${Date.now()}`);

    // 从真实 Profile 复制 Cookies 和 Local State
    const srcProfile = this._findProfileDir();
    this._copyProfile(srcProfile, tmpProfile);

    const context = await playwright.chromium.launchPersistentContext(tmpProfile, {
      executablePath: chromePath,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
      ],
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    try {
      const page = await context.newPage();

      // 隐藏 webdriver 特征
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });

      await page.goto('https://claude.ai/settings/usage', {
        waitUntil: 'networkidle',
        timeout: 30000,
      });

      // 等待用量数据渲染
      await page.waitForSelector('text=used', { timeout: 15000 }).catch(() => {});

      // 提取用量数据
      const data = await page.evaluate(() => {
        // 方法1: 从 React props 或 Next.js 数据提取
        const nextData = window.__NEXT_DATA__;
        if (nextData) {
          const props = nextData?.props?.pageProps ?? {};
          const limits = props.usageLimits ?? props.usageData ?? props.limits ?? null;
          if (limits) return { source: 'next-data', limits };
        }

        // 方法2: 从页面文本提取百分比
        const text = document.body.innerText;
        const pcts = [...text.matchAll(/(\d+(?:\.\d+)?)\s*%\s*used/gi)].map(m => parseFloat(m[1]));
        const resets = [...text.matchAll(/Resets[^\n]{1,60}/gi)].map(m => m[0].trim());

        return {
          source: 'page-text',
          pcts,
          resets,
          text: text.slice(0, 500),
        };
      });

      return this._normalizePageData(data);
    } finally {
      await context.close().catch(() => {});
      // 清理临时 profile
      fs.rm(tmpProfile, { recursive: true, force: true }, () => {});
    }
  }

  // ── 复制必要的 Profile 文件（仅 Cookies 和认证数据）─────────────────────────
  _copyProfile(src, dest) {
    if (!fs.existsSync(src)) return;
    fs.mkdirSync(dest, { recursive: true });

    const filesToCopy = ['Cookies', 'Local State', 'Preferences'];
    for (const f of filesToCopy) {
      const srcFile = path.join(src, f);
      if (fs.existsSync(srcFile)) {
        try {
          fs.copyFileSync(srcFile, path.join(dest, f));
        } catch (_) {}
      }
    }
  }

  // ── 归一化页面数据 ─────────────────────────────────────────────────────────
  _normalizePageData(raw) {
    if (!raw) throw new Error('Playwright 未返回任何数据');

    let sessionPct = null, weeklyPct = null, sessionReset = null, weeklyReset = null;

    if (raw.source === 'next-data' && raw.limits) {
      const l = raw.limits;
      sessionPct   = l.sessionUsedPercent ?? l.session?.usedPercent ?? null;
      weeklyPct    = l.weeklyUsedPercent  ?? l.weekly?.usedPercent  ?? null;
      sessionReset = l.session?.resetAt   ?? null;
      weeklyReset  = l.weekly?.resetAt    ?? null;
    } else if (raw.pcts) {
      sessionPct = raw.pcts[0] ?? null;
      weeklyPct  = raw.pcts[1] ?? null;
      if (raw.resets?.[0]) sessionReset = raw.resets[0];
      if (raw.resets?.[1]) weeklyReset  = raw.resets[1];
    }

    if (sessionPct === null && weeklyPct === null) {
      throw new Error('Playwright 抓取到页面但无法解析用量数据，请检查 claude.ai 是否已登录');
    }

    const usedPct = this.model === 'weekly' ? weeklyPct : sessionPct;
    const resetAt = this.model === 'weekly' ? weeklyReset : sessionReset;

    return {
      provider: 'claudeai-pw',
      model: this.model,
      tokens: {
        limit: 100,
        used: usedPct,
        remaining: 100 - usedPct,
        usedPercent: usedPct,
        remainingPercent: 100 - usedPct,
        resetAt,
      },
      requests: {
        limit: 100,
        used: weeklyPct ?? 0,
        remaining: 100 - (weeklyPct ?? 0),
        resetAt: weeklyReset,
      },
      meta: { sessionUsedPercent: sessionPct, weeklyUsedPercent: weeklyPct, sessionResetAt: sessionReset, weeklyResetAt: weeklyReset },
      resetIntervalMinutes: this.model === 'weekly' ? 7 * 24 * 60 : 300,
      timestamp: new Date().toISOString(),
    };
  }

  async getQuota() {
    const now = Date.now();
    if (this._cachedQuota && this._lastProbeTime && now - this._lastProbeTime < this._probeIntervalMs) {
      return this._cachedQuota;
    }

    const quota = await this._fetchWithPlaywright();
    this._cachedQuota = quota;
    this._lastProbeTime = now;

    // 同步写入共享文件（供 claudeai.js 读取）
    const meta = quota.meta;
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify({
        sessionUsedPercent: meta.sessionUsedPercent,
        weeklyUsedPercent:  meta.weeklyUsedPercent,
        sessionResetAt:     meta.sessionResetAt,
        weeklyResetAt:      meta.weeklyResetAt,
        source: 'playwright',
        fetchedAt: quota.timestamp,
      }, null, 2));
    } catch (_) {}

    return quota;
  }

  async validateKey() {
    return { valid: true, status: 200 }; // Playwright 模式无需 API key 验证
  }

  getModels() {
    return ['session', 'weekly'];
  }

  getResetInfo() {
    return {
      intervalMinutes: 300,
      description: 'Session 约每 5 小时重置；Weekly 每周二重置（Playwright 模式）',
    };
  }
}

module.exports = ClaudeAIPlaywrightProvider;
