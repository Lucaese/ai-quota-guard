#!/usr/bin/env node

/**
 * ai-quota-guard MCP Server
 * 
 * Exposes quota monitoring as MCP tools so Claude Code can:
 * - check quota status
 * - get notified when limits are near
 * - know whether it's safe to continue calling models
 */

'use strict';

require('dotenv').config();

const readline = require('readline');

// ─── MCP protocol helpers ────────────────────────────────────────────────────

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function sendResult(id, content) {
  send({
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content, null, 2) }],
    },
  });
}

function sendError(id, code, message) {
  send({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  });
}

// ─── Tools definition ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'quota_status',
    description:
      'Check current API quota usage for all configured AI models. Returns usage percentage, remaining tokens, and whether the model is active or paused.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Filter by provider (anthropic, openai, gemini). Leave empty for all.',
          enum: ['anthropic', 'openai', 'gemini'],
        },
      },
      required: [],
    },
  },
  {
    name: 'quota_is_allowed',
    description:
      'Check if a specific model is currently allowed to receive API calls (i.e. quota not exceeded). Returns true/false.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Provider name (anthropic, openai, gemini)',
          enum: ['anthropic', 'openai', 'gemini'],
        },
        model: {
          type: 'string',
          description: 'Model name e.g. claude-opus-4-5',
        },
      },
      required: ['provider', 'model'],
    },
  },
  {
    name: 'quota_add_model',
    description:
      'Add or update a model to monitor. Provide the provider, API key, model name, stop threshold (pause at X% usage), and resume threshold.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          description: 'Provider name: anthropic, openai, or gemini',
          enum: ['anthropic', 'openai', 'gemini'],
        },
        apiKey: {
          type: 'string',
          description: 'API key for the provider',
        },
        model: {
          type: 'string',
          description: 'Model name e.g. claude-opus-4-5',
        },
        stopThreshold: {
          type: 'number',
          description: 'Pause calls when usage % reaches this value (default 90)',
        },
        resumeThreshold: {
          type: 'number',
          description: 'Resume calls when usage % drops to this value (default 20)',
        },
      },
      required: ['provider', 'apiKey', 'model'],
    },
  },
  {
    name: 'quota_list_models',
    description: 'List all configured models with their thresholds.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'quota_remove_model',
    description: 'Remove a model from monitoring.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Provider name' },
        model: { type: 'string', description: 'Model name' },
      },
      required: ['provider', 'model'],
    },
  },
  {
    name: 'quota_force_probe',
    description: 'Force an immediate fresh quota probe for a specific model (bypasses cache).',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Provider name' },
        model: { type: 'string', description: 'Model name' },
      },
      required: ['provider', 'model'],
    },
  },
];

// ─── Tool handlers ───────────────────────────────────────────────────────────

const ConfigManager = require('./src/config');
const { createProvider } = require('./src/providers');
const { QuotaMonitor, STATE } = require('./src/monitor');

// Singleton monitor (started lazily)
let _monitor = null;

function getMonitor() {
  if (_monitor) return _monitor;
  const models = ConfigManager.getModels();
  const settings = ConfigManager.getSettings();
  _monitor = new QuotaMonitor({ models, pollIntervalSeconds: settings.pollIntervalSeconds || 60 });
  _monitor.start();
  return _monitor;
}

async function handleTool(name, args) {
  switch (name) {
    case 'quota_status': {
      const monitor = getMonitor();
      const snapshot = monitor.getSnapshot();
      const filtered = args.provider
        ? snapshot.filter((s) => s.id.startsWith(args.provider + ':'))
        : snapshot;

      if (filtered.length === 0) {
        return 'No models configured. Use quota_add_model to add one.';
      }

      const lines = filtered.map((s) => {
        const q = s.quota;
        if (!q) return `${s.id}: state=${s.state} (not yet probed)`;
        const usedPct = q.tokens.usedPercent || 0;
        const statusIcon = s.state === STATE.PAUSED ? '⏸ PAUSED' : s.state === STATE.ACTIVE ? '▶ ACTIVE' : s.state;
        return [
          `Model: ${s.id}`,
          `  Status: ${statusIcon}`,
          `  Token usage: ${usedPct.toFixed(1)}% (${(q.tokens.used || 0).toLocaleString()} / ${(q.tokens.limit || 0).toLocaleString()})`,
          `  Remaining: ${(q.tokens.remaining || 0).toLocaleString()} tokens`,
          q.tokens.resetAt ? `  Resets: ${q.tokens.resetAt}` : null,
          `  Probed at: ${q.timestamp}`,
        ].filter(Boolean).join('\n');
      });

      return lines.join('\n\n');
    }

    case 'quota_is_allowed': {
      const monitor = getMonitor();
      const allowed = monitor.isAllowed(args.provider, args.model);
      const id = `${args.provider}:${args.model}`;
      const snapshot = monitor.getSnapshot().find((s) => s.id === id);
      const usedPct = snapshot?.quota?.tokens?.usedPercent;

      return {
        allowed,
        model: id,
        state: snapshot?.state || 'unknown',
        usedPercent: usedPct != null ? usedPct : null,
        message: allowed
          ? `✅ ${id} is ACTIVE – safe to call`
          : `⏸ ${id} is PAUSED – quota limit reached, please wait for reset`,
      };
    }

    case 'quota_add_model': {
      const cfg = {
        provider: args.provider,
        apiKey: args.apiKey,
        model: args.model,
        stopThreshold: args.stopThreshold || 90,
        resumeThreshold: args.resumeThreshold || 20,
      };

      // Validate key
      const provider = createProvider(cfg.provider, { apiKey: cfg.apiKey, model: cfg.model });
      const validation = await provider.validateKey();
      if (!validation.valid) {
        return `❌ API key validation failed: ${validation.error}`;
      }

      const id = ConfigManager.saveModel(cfg);

      // Restart monitor with new config
      if (_monitor) {
        _monitor.stop();
        _monitor = null;
      }
      getMonitor();

      return `✅ Model added: ${id}\n  Stop at ${cfg.stopThreshold}% | Resume at ${cfg.resumeThreshold}%\n  Monitoring started.`;
    }

    case 'quota_list_models': {
      const models = ConfigManager.getModels();
      if (models.length === 0) return 'No models configured.';
      return models
        .map((m) => {
          const id = `${m.provider}:${m.model || 'default'}`;
          return `${id}\n  Stop: ${m.stopThreshold || 90}% | Resume: ${m.resumeThreshold || 20}%`;
        })
        .join('\n\n');
    }

    case 'quota_remove_model': {
      const id = `${args.provider}:${args.model}`;
      ConfigManager.removeModel(id);
      if (_monitor) { _monitor.stop(); _monitor = null; }
      getMonitor();
      return `✅ Removed: ${id}`;
    }

    case 'quota_force_probe': {
      const monitor = getMonitor();
      const quota = await monitor.forceProbe(args.provider, args.model);
      return quota;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ─── MCP message loop ────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line.trim());
  } catch {
    return;
  }

  const { id, method, params } = msg;

  // Notifications (no id) – ignore
  if (id === undefined && method?.startsWith('notifications/')) return;

  try {
    switch (method) {
      case 'initialize':
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'ai-quota-guard', version: '1.0.0' },
          },
        });
        break;

      case 'tools/list':
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
        break;

      case 'tools/call': {
        const { name, arguments: toolArgs = {} } = params;
        const result = await handleTool(name, toolArgs);
        sendResult(id, result);
        break;
      }

      default:
        sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    sendError(id, -32000, err.message);
  }
});

process.on('SIGTERM', () => {
  if (_monitor) _monitor.stop();
  process.exit(0);
});
