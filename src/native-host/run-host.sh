#!/bin/bash
# Chrome 调用 native host 时环境受限，手动设置必要变量
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
# 确保 HOME 有值，防止 os.homedir() 返回空字符串
if [ -z "$HOME" ]; then
  export HOME="$(eval echo ~"$USER")"
fi
exec /opt/homebrew/bin/node "$(dirname "$0")/host.js" "$@"
