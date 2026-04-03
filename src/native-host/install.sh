#!/usr/bin/env bash
# AI Quota Guard — Native Messaging Host 安装脚本
# 用法：bash install.sh [chrome|chromium|brave|arc]
#
# 将 Native Messaging Host manifest 写入 Chrome 的 NativeMessagingHosts 目录，
# 让 Chrome 扩展能通过 sendNativeMessage 与 host.js 通信。

set -e

HOST_NAME="com.ai_quota_guard.bridge"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_PATH="$SCRIPT_DIR/host.js"

# 确保 host.js 可执行
chmod +x "$HOST_PATH"

# 根据浏览器选择 manifest 目录
BROWSER="${1:-chrome}"
case "$BROWSER" in
  chrome)
    MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    ;;
  chromium)
    MANIFEST_DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
    ;;
  brave)
    MANIFEST_DIR="$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts"
    ;;
  arc)
    MANIFEST_DIR="$HOME/Library/Application Support/Arc/User Data/NativeMessagingHosts"
    ;;
  *)
    echo "未知浏览器: $BROWSER"
    echo "支持: chrome | chromium | brave | arc"
    exit 1
    ;;
esac

mkdir -p "$MANIFEST_DIR"

# 写入 Native Messaging Host manifest
MANIFEST_FILE="$MANIFEST_DIR/$HOST_NAME.json"
cat > "$MANIFEST_FILE" <<EOF
{
  "name": "$HOST_NAME",
  "description": "AI Quota Guard Native Messaging Bridge",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://EXTENSION_ID_PLACEHOLDER/"
  ]
}
EOF

echo "✓ Native host manifest 已写入: $MANIFEST_FILE"
echo ""
echo "⚠️  还需要将 EXTENSION_ID_PLACEHOLDER 替换为扩展的真实 ID："
echo "   1. 打开 chrome://extensions"
echo "   2. 找到 'AI Quota Guard Bridge'，复制 ID"
echo "   3. 编辑 $MANIFEST_FILE 替换 ID"
echo ""
echo "完成后重启 Chrome 生效。"
