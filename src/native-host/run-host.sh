#!/bin/bash
# Chrome 调用 native host 时 PATH 受限，用绝对路径调用 node
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
exec /opt/homebrew/bin/node "$(dirname "$0")/host.js" "$@"
