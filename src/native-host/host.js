#!/usr/bin/env node
/**
 * AI Quota Guard — Native Messaging Host
 *
 * Chrome 扩展通过 Native Messaging 协议将 claude.ai 用量数据发送到此脚本，
 * 脚本将数据写入 ~/.config/ai-quota-guard/claudeai-usage.json，
 * quota-guard 的 claudeai 提供商从该文件读取数据。
 *
 * Chrome Native Messaging 协议：
 *   stdin:  4字节小端 uint32 长度 + JSON 消息体
 *   stdout: 4字节小端 uint32 长度 + JSON 响应体
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// 数据文件路径（与 ConfigManager 保持一致）
const DATA_DIR  = path.join(os.homedir(), '.config', 'ai-quota-guard');
const DATA_FILE = path.join(DATA_DIR, 'claudeai-usage.json');

// ── 确保目录存在 ──────────────────────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ── 日志（调试用） ────────────────────────────────────────────────────────────
const LOG_FILE = path.join(DATA_DIR, 'native-host.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(LOG_FILE, line);
}
log('native host started, pid=' + process.pid);
// Explicitly enable flowing mode
process.stdin.resume();

// ── Native Messaging 读取 ─────────────────────────────────────────────────────
let pendingLength = null;
const chunks = [];
let bytesRead = 0;

process.stdin.on('data', (chunk) => {
  chunks.push(chunk);
  bytesRead += chunk.length;
  processBuffer();
});

process.stdin.on('end', () => {
  log('stdin closed, bytesRead=' + bytesRead + ' chunks=' + chunks.length);
  // 不在这里 exit——等 sendResponse 写完 stdout 后再退出
  if (chunks.length > 0) processBuffer();
});

process.stdin.on('error', (err) => {
  log('stdin error: ' + err.message);
});

function processBuffer() {
  const buf = Buffer.concat(chunks);

  // 还没读到长度头
  if (buf.length < 4) return;

  if (pendingLength === null) {
    pendingLength = buf.readUInt32LE(0);
  }

  // 还没读到完整消息
  if (buf.length < 4 + pendingLength) return;

  // 读取消息体
  const messageStr = buf.slice(4, 4 + pendingLength).toString('utf-8');
  const remaining  = buf.slice(4 + pendingLength);

  // 重置 buffer
  chunks.length = 0;
  bytesRead = 0;
  pendingLength = null;
  if (remaining.length > 0) {
    chunks.push(remaining);
    bytesRead = remaining.length;
  }

  // 处理消息
  try {
    const message = JSON.parse(messageStr);
    log('received message: ' + messageStr.slice(0, 200));
    handleMessage(message);
  } catch (err) {
    log('parse error: ' + err.message);
    sendResponse({ ok: false, error: 'JSON parse error: ' + err.message });
  }

  // 处理可能的后续消息
  if (chunks.length > 0) processBuffer();
}

// ── 消息处理 ──────────────────────────────────────────────────────────────────
function handleMessage(msg) {
  try {
    // 写入数据文件
    const payload = {
      sessionUsedPercent: msg.sessionUsedPercent ?? null,
      weeklyUsedPercent:  msg.weeklyUsedPercent  ?? null,
      sessionResetAt:     msg.sessionResetAt     ?? null,
      weeklyResetAt:      msg.weeklyResetAt      ?? null,
      source:             msg.source             ?? 'extension',
      fetchedAt:          msg.fetchedAt          ?? new Date().toISOString(),
    };

    fs.writeFileSync(DATA_FILE, JSON.stringify(payload, null, 2), 'utf-8');
    log('wrote data file: session=' + payload.sessionUsedPercent + '% weekly=' + payload.weeklyUsedPercent + '%');
    sendResponse({ ok: true, file: DATA_FILE });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}

// ── 发送响应 ──────────────────────────────────────────────────────────────────
function sendResponse(obj) {
  const json = JSON.stringify(obj);
  const len  = Buffer.byteLength(json, 'utf-8');
  const buf  = Buffer.alloc(4 + len);
  buf.writeUInt32LE(len, 0);
  buf.write(json, 4, 'utf-8');
  // 等 stdout flush 后再退出，防止 Chrome 还没读到响应就进程已退出
  process.stdout.write(buf, () => {
    log('response sent, exiting');
    process.exit(0);
  });
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));
