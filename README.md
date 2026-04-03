# AI Quota Guard

Monitor AI model API quota usage and automatically pause/resume your agent's API calls based on configurable thresholds.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## Features

- **Real-time quota monitoring** — polls API usage from response headers
- **Auto-pause** — stops agent calls when usage hits your stop threshold
- **Auto-resume** — re-activates calls when quota resets below resume threshold
- **Multi-provider** — supports Anthropic (Claude), OpenAI (GPT), and Google (Gemini)
- **Per-model thresholds** — configure stop/resume % independently per model
- **CLI + SDK** — use as a command-line tool or import as a library
- **MCP Server** — native Claude Code integration via Model Context Protocol

---

## Supported Providers

| Provider | Key | Reset Window |
|----------|-----|-------------|
| Anthropic (Claude) | `anthropic` | Every **5 hours** |
| OpenAI (GPT) | `openai` | Per-minute rate limits |
| Google Gemini | `gemini` | Per-minute rate limits |

---

## Installation

```bash
npm install -g github:Lucaese/ai-quota-guard
```

Or install locally in your project:

```bash
npm install github:Lucaese/ai-quota-guard
```

---

## CLI Usage

### Quick Start

```bash
# 1. Add a model to monitor
quota-guard add

# 2. Check current quota status
quota-guard status

# 3. Start watching (continuous monitoring)
quota-guard watch
```

The `aqg` alias is also available:

```bash
aqg add
aqg watch
```

---

### Commands

#### `quota-guard add` — Add a model

Interactive wizard to configure a model:

```bash
quota-guard add
```

Or pass options directly:

```bash
quota-guard add \
  --provider anthropic \
  --key sk-ant-... \
  --model claude-opus-4-5 \
  --stop 90 \
  --resume 20
```

| Option | Description | Default |
|--------|-------------|---------|
| `-p, --provider` | Provider name (`anthropic`, `openai`, `gemini`) | interactive |
| `-k, --key` | API key | interactive |
| `-m, --model` | Model name | interactive |
| `--stop <pct>` | Pause when usage reaches this % | `90` |
| `--resume <pct>` | Resume when usage drops to this % | `20` |
| `--poll <seconds>` | Poll interval | `60` |

---

#### `quota-guard status` — One-shot status check

```bash
quota-guard status

# JSON output
quota-guard status --json
```

Sample output:
```
anthropic:claude-opus-4-5
  Status   : ● ACTIVE
  Tokens   : ████████░░░░░░░░░░░░░░░░░░░░░░ 28.4% used
  Used     : 284,000 / 1,000,000
  Remaining: 716,000
  Resets   : in 3 hours
  Thresholds: stop at 90% | resume at 20%
```

---

#### `quota-guard watch` — Continuous monitoring

```bash
quota-guard watch

# Override poll interval
quota-guard watch --interval 30
```

The watcher runs indefinitely. When thresholds are crossed:
- **PAUSED** — printed with timestamp when stop threshold is hit
- **RESUMED** — printed with timestamp when quota recovers

Press `Ctrl+C` to stop.

---

#### `quota-guard list` — List configured models

```bash
quota-guard list
# alias: quota-guard ls
```

---

#### `quota-guard remove <id>` — Remove a model

```bash
quota-guard remove anthropic:claude-opus-4-5
# alias: quota-guard rm anthropic:claude-opus-4-5
```

---

#### `quota-guard providers` — Show supported providers

```bash
quota-guard providers
```

---

#### `quota-guard set <key> <value>` — Update global settings

```bash
quota-guard set pollIntervalSeconds 30
quota-guard set notifications true
```

---

#### `quota-guard config` — Show full configuration

```bash
quota-guard config
```

API keys are redacted in output.

---

#### `quota-guard reset` — Clear all configuration

```bash
quota-guard reset
```

---

## SDK / Library Usage

Use `ai-quota-guard` programmatically inside your agent:

```js
const { QuotaGuard } = require('ai-quota-guard');

const guard = new QuotaGuard({
  models: [
    {
      provider: 'anthropic',
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: 'claude-opus-4-5',
      stopThreshold: 90,   // pause when 90% of tokens used
      resumeThreshold: 20, // resume when usage drops to 20% (quota reset)
    },
    {
      provider: 'openai',
      apiKey: process.env.OPENAI_API_KEY,
      model: 'gpt-4o',
      stopThreshold: 85,
      resumeThreshold: 10,
    },
  ],
  pollIntervalSeconds: 60,
});

// Listen for state changes
guard.on('paused',  ({ id, usedPercent }) => {
  console.log(`⏸ ${id} paused — ${usedPercent}% used`);
});

guard.on('resumed', ({ id, usedPercent }) => {
  console.log(`▶ ${id} resumed — ${usedPercent}% used`);
});

guard.on('error', ({ id, error }) => {
  console.error(`Error probing ${id}: ${error}`);
});

guard.start();

// In your agent loop:
async function callModel(prompt) {
  if (!guard.isAllowed('anthropic', 'claude-opus-4-5')) {
    console.log('Model paused – waiting for quota to restore…');
    return null;
  }
  // Your normal API call here
}
```

### Events

| Event | Payload | Description |
|-------|---------|-------------|
| `started` | `{ models }` | Monitor started |
| `initialized` | `{ id, state, quota }` | First probe complete |
| `quota` | `{ id, quota, state }` | Every probe cycle |
| `paused` | `{ id, provider, model, usedPercent, stopThreshold, quota }` | Stop threshold crossed |
| `resumed` | `{ id, provider, model, usedPercent, resumeThreshold, quota }` | Resume threshold crossed |
| `error` | `{ id, error }` | Probe failed |
| `stopped` | — | Monitor stopped |

### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `start()` | `void` | Begin polling |
| `stop()` | `void` | Stop all polling |
| `isAllowed(provider, model)` | `boolean` | Check if model calls are allowed |
| `getSnapshot()` | `Array` | Current state of all models |
| `getHistory(id)` | `Array` | Last 100 quota snapshots for a model |
| `forceProbe(provider, model)` | `Promise<quota>` | Force immediate re-probe |

---

## MCP Server (Claude Code Integration)

Use as an MCP server so Claude Code can check quota before each call:

```json
{
  "mcpServers": {
    "quota-guard": {
      "command": "quota-guard-mcp"
    }
  }
}
```

Available MCP tools: `quota_status`, `quota_is_allowed`, `quota_add_model`, `quota_list_models`, `quota_remove_model`, `quota_force_probe`.

---

## How Thresholds Work

```
Usage %:  0%─────────────[resumeThreshold]──────────[stopThreshold]──100%
                                ↑                           ↑
                          Agent RESUMES                Agent PAUSES
```

**Example with Claude (5h reset window):**
- `stopThreshold: 90` — when you've used 90% of your token allowance, the guard pauses calls
- `resumeThreshold: 20` — after Claude's 5-hour window resets, usage drops back near 0%, which is ≤ 20%, so calls resume automatically

---

## Environment Variables

You can store API keys in a `.env` file (loaded automatically):

```env
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AIza...
```

---

## Configuration File Location

Settings are stored in:
- **macOS/Linux**: `~/.config/ai-quota-guard/config.json`
- **Windows**: `%APPDATA%\ai-quota-guard\config.json`

---

## License

MIT
