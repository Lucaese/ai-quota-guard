/**
 * Content Script — 运行在 claude.ai/settings/usage 页面
 *
 * 直接从页面 DOM 提取用量百分比，发送给 Background Service Worker。
 * 比 Service Worker 直接 fetch 更可靠（无 CORS/Cookie 问题）。
 */

(function () {
  'use strict';

  function extractUsage() {
    // 方法1: 从 __NEXT_DATA__ 提取结构化数据
    const nextDataEl = document.getElementById('__NEXT_DATA__');
    if (nextDataEl) {
      try {
        const nextData = JSON.parse(nextDataEl.textContent);
        const props = nextData?.props?.pageProps ?? {};
        const limits = props.usageLimits ?? props.usageData ?? props.limits ?? null;
        if (limits) {
          return {
            source: 'next-data',
            sessionUsedPercent: limits.sessionUsedPercent ?? limits.session?.usedPercent ?? null,
            weeklyUsedPercent:  limits.weeklyUsedPercent  ?? limits.weekly?.usedPercent  ?? null,
            sessionResetAt:     limits.session?.resetAt   ?? null,
            weeklyResetAt:      limits.weekly?.resetAt    ?? null,
          };
        }
      } catch (_) {}
    }

    // 方法2: 从页面可见文本提取百分比
    const bodyText = document.body.innerText || '';

    // 匹配 "60% used" 这样的格式
    const pctMatches = [...bodyText.matchAll(/(\d+(?:\.\d+)?)\s*%\s*used/gi)];
    const pcts = pctMatches.map(m => parseFloat(m[1]));

    // 匹配重置时间
    const sessionResetMatch = bodyText.match(/Resets\s+in\s+([\d\w\s]+?)(?:\n|$)/i);
    const weeklyResetMatch  = bodyText.match(/Resets\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^\n]{1,30})/i);

    // 方法3: 从进度条 aria 属性读取（更可靠）
    const progressBars = document.querySelectorAll('[role="progressbar"], progress, [aria-valuenow]');
    const barValues = [];
    progressBars.forEach(el => {
      const val = parseFloat(el.getAttribute('aria-valuenow') ?? el.getAttribute('value') ?? '');
      if (!isNaN(val)) barValues.push(val);
    });

    // 合并两种方式的结果
    const sessionPct = pcts[0] ?? barValues[0] ?? null;
    const weeklyPct  = pcts[1] ?? barValues[1] ?? null;

    if (sessionPct === null && weeklyPct === null) return null;

    return {
      source: 'content-dom',
      sessionUsedPercent: sessionPct,
      weeklyUsedPercent:  weeklyPct,
      sessionResetAt: sessionResetMatch?.[1]?.trim() ? `in ${sessionResetMatch[1].trim()}` : null,
      weeklyResetAt:  weeklyResetMatch?.[1]?.trim()  ?? null,
    };
  }

  function sendToBackground(data) {
    chrome.runtime.sendMessage({ type: 'USAGE_DATA', payload: data });
  }

  // 页面加载后立即提取一次
  function tryExtract() {
    const data = extractUsage();
    if (data && (data.sessionUsedPercent !== null || data.weeklyUsedPercent !== null)) {
      sendToBackground(data);
      return true;
    }
    return false;
  }

  // 立即尝试
  if (!tryExtract()) {
    // 等待 React/Next.js 渲染完成后重试
    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      if (tryExtract() || attempts >= 10) {
        clearInterval(timer);
      }
    }, 800);
  }

  // 用 MutationObserver 监听 DOM 变化（SPA 路由跳转时重新提取）
  const observer = new MutationObserver(() => {
    if (window.location.pathname.includes('/settings/usage')) {
      tryExtract();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
