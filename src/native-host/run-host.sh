#!/bin/bash
# Chrome 调用 native host 时环境受限，手动设置必要变量
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# 确保 HOME 有值，防止 os.homedir() 返回空字符串
if [ -z "$HOME" ]; then
  export HOME="$(eval echo ~"${USER:-long}")"
fi
# 调试：记录启动环境
DBGFILE="/Users/long/.config/ai-quota-guard/run-host-debug.log"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] run-host.sh started HOME=$HOME USER=$USER PWD=$PWD" >> "$DBGFILE" 2>/dev/null || true
exec /opt/homebrew/bin/node "$(dirname "$0")/host.js" "$@"
