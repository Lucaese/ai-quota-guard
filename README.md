# AI Quota Guard

监控 AI 模型 API 的 Token 使用额度，在额度不足时自动暂停 Agent 调用，额度恢复后自动重新激活。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## 功能特性

- **实时额度监控** — 通过 API 响应头实时轮询 Token 使用量
- **自动暂停** — 使用量超过阈值时自动停止 Agent 调用
- **自动恢复** — 额度重置后自动重新激活 Agent
- **多平台支持** — 支持 Anthropic（Claude）、OpenAI（GPT）、Google Gemini
- **独立阈值配置** — 每个模型可单独设置暂停/恢复百分比
- **CLI + SDK 双模式** — 命令行工具 或 代码库方式集成
- **MCP Server** — 原生支持 Claude Code 的 MCP 协议集成

---

## 支持的提供商

| 提供商 | 标识符 | 额度重置周期 |
|--------|--------|-------------|
| Anthropic (Claude) | `anthropic` | 每 **5 小时** 重置一次 |
| OpenAI (GPT) | `openai` | 每分钟重置（速率限制） |
| Google Gemini | `gemini` | 每分钟重置（速率限制） |

---

## 安装

```bash
# 从 GitHub 全局安装
npm install -g github:Lucaese/ai-quota-guard
```

或在项目中本地安装：

```bash
npm install github:Lucaese/ai-quota-guard
```

---

## CLI 命令说明

### 快速开始

```bash
# 第一步：添加要监控的模型
quota-guard add

# 第二步：查看当前额度状态
quota-guard status

# 第三步：启动持续监控
quota-guard watch
```

也可以使用简写别名 `aqg`：

```bash
aqg add
aqg watch
```

---

### `quota-guard add` — 添加监控模型

交互式向导，逐步引导完成配置：

```bash
quota-guard add
# 会依次提示选择：提供商 → 输入 API Key → 选择模型 → 设置阈值
```

或通过参数直接配置（跳过交互）：

```bash
# 配置 Claude，额度用到 90% 时暂停，重置后恢复
quota-guard add \
  --provider anthropic \          # 提供商：anthropic / openai / gemini
  --key sk-ant-...  \             # 你的 API Key
  --model claude-opus-4-5 \       # 模型名称
  --stop 90 \                     # 使用量达到 90% 时停止调用
  --resume 20                     # 使用量降回 20% 时恢复调用（即额度重置后）
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `-p, --provider` | 提供商（`anthropic` / `openai` / `gemini`） | 交互选择 |
| `-k, --key` | API Key | 交互输入 |
| `-m, --model` | 模型名称 | 交互选择 |
| `--stop <百分比>` | 使用量达到此 % 时暂停 | `90` |
| `--resume <百分比>` | 使用量降到此 % 时恢复 | `20` |
| `--poll <秒>` | 轮询间隔（秒） | `60` |

---

### `quota-guard list` — 查看已配置的模型

```bash
quota-guard list
# 别名：quota-guard ls

# 输出示例：
# ╔═══════════════════════════╤═══════════╤═════════════════╤════════╤══════════╗
# ║ ID                        │ Provider  │ Model           │ Stop % │ Resume % ║
# ╟───────────────────────────┼───────────┼─────────────────┼────────┼──────────╢
# ║ anthropic:claude-opus-4-5 │ anthropic │ claude-opus-4-5 │ 90%    │ 20%      ║
# ╚═══════════════════════════╧═══════════╧═════════════════╧════════╧══════════╝
```

---

### `quota-guard status` — 查看当前额度状态（单次）

```bash
quota-guard status
# 立即探测所有模型的最新额度，输出详情

# 以 JSON 格式输出（便于脚本处理）
quota-guard status --json

# 输出示例：
# anthropic:claude-opus-4-5
#   Status   : ● ACTIVE
#   Tokens   : ████████░░░░░░░░░░░░░░░░░░░░░░ 28.4% used
#   Used     : 284,000 / 1,000,000
#   Remaining: 716,000
#   Resets   : in 3 hours
#   Thresholds: stop at 90% | resume at 20%
```

---

### `quota-guard watch` — 持续监控（长期运行）

```bash
quota-guard watch
# 启动后持续运行，每隔 60 秒探测一次额度
# 达到 stop 阈值时打印 ⏸ PAUSED 提示
# 额度恢复后打印 ▶ RESUMED 提示

# 自定义轮询间隔（秒）
quota-guard watch --interval 30   # 每 30 秒检查一次

# 按 Ctrl+C 停止监控
```

---

### `quota-guard remove <id>` — 删除模型配置

```bash
quota-guard remove anthropic:claude-opus-4-5
# 别名：quota-guard rm anthropic:claude-opus-4-5
# ID 格式：<提供商>:<模型名>，可通过 quota-guard list 查看
```

---

### `quota-guard providers` — 查看支持的提供商和模型列表

```bash
quota-guard providers

# 输出示例：
# Anthropic (Claude)  (anthropic)
#   Reset: Anthropic resets token quota every 5 hours (300 minutes)
#   Models:
#     - claude-opus-4-5
#     - claude-sonnet-4-5
#     - claude-haiku-4-5
#     ...
```

---

### `quota-guard set <key> <value>` — 修改全局设置

```bash
quota-guard set pollIntervalSeconds 30    # 将轮询间隔改为 30 秒
quota-guard set notifications true        # 开启通知
```

---

### `quota-guard config` — 查看完整配置

```bash
quota-guard config
# 输出当前所有配置（API Key 自动脱敏显示为 ***）
# 同时显示配置文件路径
```

---

### `quota-guard reset` — 清空所有配置

```bash
quota-guard reset
# 删除所有模型配置和全局设置，操作前会二次确认
```

---

## 阈值工作原理

```
Token 使用量:  0%─────────[resumeThreshold 恢复阈值]──────[stopThreshold 暂停阈值]──100%
                                      ↑                              ↑
                               Agent 恢复调用                  Agent 停止调用
```

**以 Claude 为例（5 小时重置周期）：**

- `stopThreshold: 90` — 当 Token 使用量达到 90% 时，守卫暂停 Agent 调用
- `resumeThreshold: 20` — Claude 5 小时重置后，使用量回到 0% 附近（≤ 20%），自动恢复调用

---

## SDK 集成（在代码中使用）

在 Agent 代码中引入，在每次 API 调用前检查是否允许：

```js
const { QuotaGuard } = require('ai-quota-guard');

const guard = new QuotaGuard({
  models: [
    {
      provider: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: 'claude-opus-4-5',
      stopThreshold: 90,   // 使用量达到 90% 时暂停
      resumeThreshold: 20, // 使用量降回 20% 时恢复（额度重置后）
    },
    {
      provider: 'openai',
      apiKey: process.env.OPENAI_API_KEY,
      model: 'gpt-4o',
      stopThreshold: 85,
      resumeThreshold: 10,
    },
  ],
  pollIntervalSeconds: 60, // 每 60 秒轮询一次
});

// 监听状态变化
guard.on('paused', ({ id, usedPercent }) => {
  console.log(`⏸ ${id} 已暂停 — 当前使用量 ${usedPercent}%`);
});

guard.on('resumed', ({ id, usedPercent }) => {
  console.log(`▶ ${id} 已恢复 — 当前使用量 ${usedPercent}%`);
});

guard.on('error', ({ id, error }) => {
  console.error(`${id} 探测失败: ${error}`);
});

guard.start();

// 在 Agent 调用模型前检查
async function callModel(prompt) {
  if (!guard.isAllowed('anthropic', 'claude-opus-4-5')) {
    console.log('模型已暂停，等待额度恢复…');
    return null; // 或排队等待
  }
  // 正常调用 API
  const response = await anthropic.messages.create({ ... });
  return response;
}
```

### 事件列表

| 事件 | 数据 | 说明 |
|------|------|------|
| `started` | `{ models }` | 监控已启动 |
| `initialized` | `{ id, state, quota }` | 首次探测完成 |
| `quota` | `{ id, quota, state }` | 每次轮询数据更新 |
| `paused` | `{ id, provider, model, usedPercent, stopThreshold, quota }` | 达到暂停阈值 |
| `resumed` | `{ id, provider, model, usedPercent, resumeThreshold, quota }` | 额度恢复，重新激活 |
| `error` | `{ id, error }` | 探测失败 |
| `stopped` | — | 监控已停止 |

### 方法列表

| 方法 | 返回值 | 说明 |
|------|--------|------|
| `start()` | `void` | 启动轮询监控 |
| `stop()` | `void` | 停止所有轮询 |
| `isAllowed(provider, model)` | `boolean` | 检查该模型当前是否允许调用 |
| `getSnapshot()` | `Array` | 获取所有模型当前状态快照 |
| `getHistory(id)` | `Array` | 获取指定模型最近 100 次探测记录 |
| `forceProbe(provider, model)` | `Promise<quota>` | 立即强制重新探测（跳过缓存） |

---

## MCP Server（Claude Code 集成）

将 `quota-guard` 作为 MCP Server，让 Claude Code 在每次调用前自动检查额度：

在 Claude Code 配置文件中添加：

```json
{
  "mcpServers": {
    "quota-guard": {
      "command": "quota-guard-mcp"
    }
  }
}
```

可用的 MCP 工具：

| 工具名 | 说明 |
|--------|------|
| `quota_status` | 查看所有模型当前额度状态 |
| `quota_is_allowed` | 检查指定模型是否允许调用 |
| `quota_add_model` | 添加/更新监控模型 |
| `quota_list_models` | 列出所有已配置模型 |
| `quota_remove_model` | 删除模型配置 |
| `quota_force_probe` | 强制重新探测指定模型 |

---

## 环境变量

在项目根目录创建 `.env` 文件，API Key 会自动加载：

```env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AIza...
```

---

## 配置文件位置

| 系统 | 路径 |
|------|------|
| macOS / Linux | `~/.config/ai-quota-guard/config.json` |
| Windows | `%APPDATA%\ai-quota-guard\config.json` |

---

## License

MIT
