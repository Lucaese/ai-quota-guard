/**
 * AI Quota Guard Bridge — Background Service Worker
 *
 * 接收来自 Content Script 的用量数据，通过 Native Messaging 同步给 quota-guard。
 * 同时存入 chrome.storage.local 供 popup 显示。
 * 每5分钟自动打开 claude.ai/settings/usage 刷新数据（后台静默）。
 */

'use strict';

const NATIVE_HOST  = 'com.ai_quota_guard.bridge';
const POLL_MINUTES = 5;
const USAGE_URL    = 'https://claude.ai/settings/usage';

// ── 监听来自 Content Script 的消息 ───────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'USAGE_DATA' && msg.payload) {
    handleUsageData(msg.payload);
    sendResponse({ ok: true });
  }
});

// ── 安装时启动定时任务 ────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('refreshUsage', { periodInMinutes: POLL_MINUTES });
  // 立即打开 usage 页触发 content script
  openUsagePage();
});

chrome.runtime.onStartup.addListener(() => {
  openUsagePage();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'refreshUsage') openUsagePage();
});

// ── 打开 claude.ai/settings/usage（静默，不影响用户） ─────────────────────────
async function openUsagePage() {
  // 如果已有该页面，刷新它；否则在后台新建 tab
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/settings/usage*' });
  if (tabs.length > 0) {
    chrome.tabs.reload(tabs[0].id);
  } else {
    // 在后台创建 tab（不激活，不影响用户当前操作）
    chrome.tabs.create({ url: USAGE_URL, active: false }, (tab) => {
      // 数据提取后自动关闭
      const closeTimer = setTimeout(() => {
        chrome.tabs.remove(tab.id).catch(() => {});
      }, 15000); // 15秒后关闭

      // 监听 content script 完成提取后关闭
      const listener = (msg, sender) => {
        if (msg.type === 'USAGE_DATA' && sender.tab?.id === tab.id) {
          clearTimeout(closeTimer);
          chrome.tabs.remove(tab.id).catch(() => {});
          chrome.runtime.onMessage.removeListener(listener);
        }
      };
      chrome.runtime.onMessage.addListener(listener);
    });
  }
}

// ── 处理用量数据 ──────────────────────────────────────────────────────────────
async function handleUsageData(data) {
  const payload = {
    sessionUsedPercent: data.sessionUsedPercent ?? null,
    weeklyUsedPercent:  data.weeklyUsedPercent  ?? null,
    sessionResetAt:     data.sessionResetAt     ?? null,
    weeklyResetAt:      data.weeklyResetAt      ?? null,
    source:             data.source             ?? 'extension',
    fetchedAt:          new Date().toISOString(),
  };

  // 存入 chrome.storage 供 popup 显示
  await chrome.storage.local.set({ claudeaiUsage: payload });

  // 发送给 Native Messaging Host → 写入文件
  sendToNativeHost(payload);
}

// ── Native Messaging ──────────────────────────────────────────────────────────
// 使用 connectNative（持久端口）而非 sendNativeMessage，
// 避免 MV3 Service Worker 在 Chrome 写入 stdin 前被终止导致消息丢失。
function sendToNativeHost(payload) {
  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST);

    port.onMessage.addListener((response) => {
      port.disconnect();
      chrome.storage.local.set({
        nativeHostOk: { response, at: new Date().toISOString() }
      });
    });

    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) {
        const errMsg = chrome.runtime.lastError.message;
        console.warn('[quota-guard] native host disconnect:', errMsg);
        chrome.storage.local.set({
          nativeHostError: { error: errMsg, at: new Date().toISOString() }
        });
      }
    });

    port.postMessage(payload);
  } catch (err) {
    console.warn('[quota-guard] connectNative failed:', err);
    chrome.storage.local.set({
      nativeHostError: { error: String(err), at: new Date().toISOString() }
    });
  }
}
