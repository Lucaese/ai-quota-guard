/**
 * AI Quota Guard Bridge — Background Service Worker
 *
 * 每分钟从 claude.ai 拉取用量数据，通过 Native Messaging 同步给 quota-guard。
 * 同时存入 chrome.storage.local 供 popup 显示。
 */

const NATIVE_HOST = 'com.ai_quota_guard.bridge';
const POLL_MINUTES = 1;

// ── 启动时立即拉一次，然后定时轮询 ──────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('fetchUsage', { periodInMinutes: POLL_MINUTES });
  fetchAndSync();
});

chrome.runtime.onStartup.addListener(() => {
  fetchAndSync();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'fetchUsage') fetchAndSync();
});

// ── 主流程 ───────────────────────────────────────────────────────────────────
async function fetchAndSync() {
  try {
    const usage = await fetchUsage();
    if (!usage) return;

    const payload = {
      ...usage,
      fetchedAt: new Date().toISOString(),
    };

    // 存入 chrome.storage 供 popup 读取
    await chrome.storage.local.set({ claudeaiUsage: payload });

    // 发送给 Native Messaging Host → 写入文件 → quota-guard 读取
    sendToNativeHost(payload);
  } catch (err) {
    console.error('[quota-guard] fetchAndSync error:', err);
    await chrome.storage.local.set({
      claudeaiUsage: { error: err.message, fetchedAt: new Date().toISOString() },
    });
  }
}

// ── 获取用量数据 ──────────────────────────────────────────────────────────────
async function fetchUsage() {
  // 1. 获取组织信息
  const orgsRes = await fetch('https://claude.ai/api/organizations', {
    credentials: 'include',
  });
  if (!orgsRes.ok) throw new Error(`organizations API failed: ${orgsRes.status}`);
  const orgs = await orgsRes.json();
  const orgId = orgs[0]?.uuid;
  if (!orgId) throw new Error('No organization found');

  // 2. 尝试多个可能的用量端点
  const candidates = [
    `/api/organizations/${orgId}/usage`,
    `/api/organizations/${orgId}/limits`,
    `/api/organizations/${orgId}/rate_limits`,
    `/api/account_usage`,
    `/api/usage_limits`,
    `/api/usage`,
  ];

  for (const path of candidates) {
    try {
      const res = await fetch(`https://claude.ai${path}`, { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        const normalized = normalizeApiData(data, path);
        if (normalized) return normalized;
      }
    } catch (_) {}
  }

  // 3. 最终回退：解析 settings/usage 页面 HTML
  return await fetchFromPage();
}

// ── 解析 JSON API 响应 ────────────────────────────────────────────────────────
function normalizeApiData(data, path) {
  // 尝试常见字段名
  const session =
    data.session?.used_percentage ??
    data.current_session?.percent_used ??
    data.sessionUsedPercent ??
    data.plan_usage?.session_percent ??
    null;

  const weekly =
    data.weekly?.used_percentage ??
    data.weekly_limits?.percent_used ??
    data.weeklyUsedPercent ??
    data.plan_usage?.weekly_percent ??
    null;

  if (session === null && weekly === null) return null;

  return {
    source: 'api:' + path,
    sessionUsedPercent: session,
    weeklyUsedPercent: weekly,
    sessionResetAt: data.session?.reset_at ?? data.current_session?.reset_at ?? null,
    weeklyResetAt: data.weekly?.reset_at ?? data.weekly_limits?.reset_at ?? null,
    raw: data,
  };
}

// ── 解析页面 HTML ─────────────────────────────────────────────────────────────
async function fetchFromPage() {
  const res = await fetch('https://claude.ai/settings/usage', { credentials: 'include' });
  if (!res.ok) throw new Error(`settings/usage page failed: ${res.status}`);

  const html = await res.text();

  // 从 __NEXT_DATA__ 提取
  const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextMatch) {
    try {
      const nextData = JSON.parse(nextMatch[1]);
      const props = nextData?.props?.pageProps ?? {};
      const limits = props.usageLimits ?? props.usageData ?? props.limits ?? null;
      if (limits) {
        return {
          source: 'next-data',
          sessionUsedPercent: limits.sessionUsedPercent ?? limits.session?.usedPercent ?? null,
          weeklyUsedPercent: limits.weeklyUsedPercent ?? limits.weekly?.usedPercent ?? null,
          sessionResetAt: limits.session?.resetAt ?? null,
          weeklyResetAt: limits.weekly?.resetAt ?? null,
          raw: limits,
        };
      }
    } catch (_) {}
  }

  // 正则提取百分比数字
  const pcts = [...html.matchAll(/(\d+(?:\.\d+)?)\s*%\s*used/gi)].map(m => parseFloat(m[1]));
  const sessionReset = html.match(/Resets\s+in\s+([\d\w\s]+?)(?:<|,)/i)?.[1]?.trim();
  const weeklyReset  = html.match(/Resets\s+((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^<,]{1,30})/i)?.[1]?.trim();

  if (pcts.length === 0) throw new Error('Could not parse any usage percentages from page');

  return {
    source: 'html-regex',
    sessionUsedPercent: pcts[0] ?? null,
    weeklyUsedPercent: pcts[1] ?? null,
    sessionResetAt: sessionReset ? `in ${sessionReset}` : null,
    weeklyResetAt: weeklyReset ?? null,
  };
}

// ── Native Messaging ──────────────────────────────────────────────────────────
function sendToNativeHost(payload) {
  try {
    chrome.runtime.sendNativeMessage(NATIVE_HOST, payload, (response) => {
      if (chrome.runtime.lastError) {
        // Native host 未安装时静默失败（不影响 popup 展示）
        console.warn('[quota-guard] native host not available:', chrome.runtime.lastError.message);
      }
    });
  } catch (err) {
    console.warn('[quota-guard] sendNativeMessage error:', err);
  }
}
