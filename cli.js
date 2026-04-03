#!/usr/bin/env node

'use strict';

require('dotenv').config();

const { program } = require('commander');
const chalk = require('chalk');
const inquirer = require('inquirer');
const ora = require('ora');
const { table } = require('table');
const boxen = require('boxen');
const cliProgress = require('cli-progress');
const dayjs = require('dayjs');
const relativeTime = require('dayjs/plugin/relativeTime');
dayjs.extend(relativeTime);

const { QuotaMonitor, STATE } = require('../src/monitor');
const { createProvider, getSupportedProviders } = require('../src/providers');
const ConfigManager = require('../src/config');

const pkg = require('../package.json');

// ─── helpers ────────────────────────────────────────────────────────────────

function stateColor(state) {
  switch (state) {
    case STATE.ACTIVE:  return chalk.green('● ACTIVE');
    case STATE.PAUSED:  return chalk.red('⏸ PAUSED');
    case STATE.UNKNOWN: return chalk.yellow('? UNKNOWN');
    case STATE.ERROR:   return chalk.red('✗ ERROR');
    default:            return chalk.grey(state);
  }
}

function bar(usedPct, width = 30) {
  const filled = Math.round((usedPct / 100) * width);
  const empty = width - filled;
  const color = usedPct >= 90 ? chalk.red : usedPct >= 70 ? chalk.yellow : chalk.green;
  return color('█'.repeat(filled)) + chalk.grey('░'.repeat(empty));
}

function fmtNum(n) {
  if (!n && n !== 0) return chalk.grey('—');
  return n.toLocaleString();
}

// ─── CLI setup ───────────────────────────────────────────────────────────────

program
  .name('quota-guard')
  .description(
    chalk.cyan('AI Quota Guard') +
    ' – Monitor and auto-pause AI model calls based on usage thresholds'
  )
  .version(pkg.version, '-v, --version');

// ─── add ─────────────────────────────────────────────────────────────────────

program
  .command('add')
  .description('Configure a new AI model to monitor')
  .option('-p, --provider <provider>', 'Provider (anthropic | openai | gemini)')
  .option('-k, --key <apiKey>', 'API key')
  .option('-m, --model <model>', 'Model name')
  .option('--stop <percent>', 'Stop threshold % (default 90)', parseFloat)
  .option('--resume <percent>', 'Resume threshold % (default 20)', parseFloat)
  .option('--poll <seconds>', 'Poll interval in seconds (default 60)', parseInt)
  .action(async (opts) => {
    console.log(boxen(chalk.cyan.bold('Add Model'), { padding: 1, borderStyle: 'round' }));

    const supported = getSupportedProviders();

    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'provider',
        message: 'Select AI provider:',
        choices: supported.map((p) => ({ name: p.displayName, value: p.key })),
        when: !opts.provider,
        default: opts.provider,
      },
      {
        type: 'password',
        name: 'apiKey',
        message: 'Enter your API key:',
        mask: '*',
        when: !opts.key,
        validate: (v) => v.length > 0 || 'API key cannot be empty',
      },
      {
        type: 'list',
        name: 'model',
        message: 'Select model:',
        choices: (ans) => {
          const prov = opts.provider || ans.provider;
          const p = supported.find((s) => s.key === prov);
          return p ? p.models : [];
        },
        when: !opts.model,
      },
      {
        type: 'number',
        name: 'stopThreshold',
        message: 'Stop threshold – pause agent when token usage % reaches:',
        default: opts.stop || 90,
        validate: (v) => (v > 0 && v <= 100) || 'Must be 1-100',
      },
      {
        type: 'number',
        name: 'resumeThreshold',
        message: 'Resume threshold – re-activate agent when token usage % drops to:',
        default: opts.resume || 20,
        validate: (v, ans) => {
          const stop = ans.stopThreshold || opts.stop || 90;
          return (v >= 0 && v < stop) || `Must be less than stop threshold (${stop})`;
        },
      },
    ]);

    const cfg = {
      provider: opts.provider || answers.provider,
      apiKey: opts.key || answers.apiKey,
      model: opts.model || answers.model,
      stopThreshold: answers.stopThreshold,
      resumeThreshold: answers.resumeThreshold,
    };

    if (opts.poll) ConfigManager.setSetting('pollIntervalSeconds', opts.poll);

    // Validate key
    const spinner = ora('Validating API key…').start();
    try {
      const provider = createProvider(cfg.provider, { apiKey: cfg.apiKey, model: cfg.model });
      const validation = await provider.validateKey();
      if (!validation.valid) {
        spinner.fail(chalk.red(`API key validation failed: ${validation.error}`));
        process.exit(1);
      }
      spinner.succeed(chalk.green('API key validated ✓'));
    } catch (err) {
      spinner.fail(chalk.red(`Validation error: ${err.message}`));
      process.exit(1);
    }

    const id = ConfigManager.saveModel(cfg);
    console.log(chalk.green(`\n✓ Model saved: ${chalk.bold(id)}`));
    console.log(chalk.grey(`  Stop at ${cfg.stopThreshold}% used | Resume at ${cfg.resumeThreshold}% used`));
    console.log(chalk.grey(`\nConfig stored at: ${ConfigManager.getConfigPath()}`));
    console.log(chalk.cyan('\nRun `quota-guard watch` to start monitoring.'));
  });

// ─── list ─────────────────────────────────────────────────────────────────────

program
  .command('list')
  .alias('ls')
  .description('List all configured models')
  .action(() => {
    const models = ConfigManager.getModels();
    if (models.length === 0) {
      console.log(chalk.yellow('No models configured. Run `quota-guard add` to get started.'));
      return;
    }

    const rows = [
      [
        chalk.bold('ID'),
        chalk.bold('Provider'),
        chalk.bold('Model'),
        chalk.bold('Stop %'),
        chalk.bold('Resume %'),
      ],
      ...models.map((m) => [
        chalk.cyan(`${m.provider}:${m.model || 'default'}`),
        m.provider,
        m.model || '(default)',
        chalk.red(`${m.stopThreshold || 90}%`),
        chalk.green(`${m.resumeThreshold || 20}%`),
      ]),
    ];

    console.log(table(rows));
    const settings = ConfigManager.getSettings();
    console.log(chalk.grey(`Poll interval: ${settings.pollIntervalSeconds}s`));
  });

// ─── remove ──────────────────────────────────────────────────────────────────

program
  .command('remove <id>')
  .alias('rm')
  .description('Remove a configured model (e.g. anthropic:claude-opus-4-5)')
  .action((id) => {
    ConfigManager.removeModel(id);
    console.log(chalk.green(`✓ Removed: ${id}`));
  });

// ─── status ──────────────────────────────────────────────────────────────────

program
  .command('status')
  .description('Check current quota for all configured models (one-shot)')
  .option('-j, --json', 'Output raw JSON')
  .action(async (opts) => {
    const models = ConfigManager.getModels();
    if (models.length === 0) {
      console.log(chalk.yellow('No models configured. Run `quota-guard add` first.'));
      return;
    }

    const spinner = ora('Probing quotas…').start();
    const results = [];

    for (const m of models) {
      try {
        const provider = createProvider(m.provider, { apiKey: m.apiKey, model: m.model });
        const quota = await provider.getQuota();
        results.push({ model: m, quota, error: null });
      } catch (err) {
        results.push({ model: m, quota: null, error: err.message });
      }
    }

    spinner.stop();

    if (opts.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    for (const { model: m, quota, error } of results) {
      const id = `${m.provider}:${m.model || 'default'}`;
      console.log('\n' + chalk.bold.cyan(id));
      if (error) {
        console.log(chalk.red(`  ✗ Error: ${error}`));
        continue;
      }

      const usedPct = quota.tokens.usedPercent || 0;
      const isOver = usedPct >= (m.stopThreshold || 90);
      const stateLabel = isOver ? chalk.red('⏸ PAUSED (threshold exceeded)') : chalk.green('● ACTIVE');

      console.log(`  Status   : ${stateLabel}`);
      console.log(`  Tokens   : ${bar(usedPct)} ${usedPct.toFixed(1)}% used`);
      console.log(`  Used     : ${fmtNum(quota.tokens.used)} / ${fmtNum(quota.tokens.limit)}`);
      console.log(`  Remaining: ${fmtNum(quota.tokens.remaining)}`);
      if (quota.tokens.resetAt) {
        console.log(`  Resets   : ${dayjs(quota.tokens.resetAt).fromNow()} (${quota.tokens.resetAt})`);
      }
      console.log(`  Thresholds: stop at ${chalk.red(m.stopThreshold || 90)}% | resume at ${chalk.green(m.resumeThreshold || 20)}%`);
    }
    console.log('');
  });

// ─── watch ───────────────────────────────────────────────────────────────────

program
  .command('watch')
  .description('Start continuous quota monitoring (runs until Ctrl+C)')
  .option('-i, --interval <seconds>', 'Poll interval override', parseInt)
  .action(async (opts) => {
    const models = ConfigManager.getModels();
    if (models.length === 0) {
      console.log(chalk.yellow('No models configured. Run `quota-guard add` first.'));
      return;
    }

    const settings = ConfigManager.getSettings();
    const pollInterval = opts.interval || settings.pollIntervalSeconds || 60;

    console.log(
      boxen(
        chalk.cyan.bold('AI Quota Guard') + chalk.grey(` v${pkg.version}`) +
        `\nMonitoring ${chalk.bold(models.length)} model(s) · polling every ${pollInterval}s\n` +
        chalk.grey('Press Ctrl+C to stop'),
        { padding: 1, borderStyle: 'double', borderColor: 'cyan' }
      )
    );

    const monitor = new QuotaMonitor({
      models,
      pollIntervalSeconds: pollInterval,
    });

    const lastQuotas = {};

    monitor.on('initialized', ({ id, state, quota }) => {
      const symbol = state === STATE.ACTIVE ? chalk.green('▶') : chalk.red('⏸');
      console.log(`${chalk.grey(ts())} ${symbol} ${chalk.cyan(id)} initialized – ${state}`);
      if (quota) printQuotaLine(id, quota, state);
    });

    monitor.on('quota', ({ id, quota, state }) => {
      lastQuotas[id] = { quota, state };
      printQuotaLine(id, quota, state);
    });

    monitor.on('paused', ({ id, usedPercent, stopThreshold }) => {
      console.log(
        `\n${chalk.grey(ts())} ${chalk.red.bold('⏸ PAUSED')} ${chalk.cyan(id)} – usage ${chalk.red(usedPercent + '%')} ≥ stop threshold ${stopThreshold}%`
      );
      console.log(chalk.yellow('  ⚡ Agent calls to this model should be halted.\n'));
    });

    monitor.on('resumed', ({ id, usedPercent, resumeThreshold }) => {
      console.log(
        `\n${chalk.grey(ts())} ${chalk.green.bold('▶ RESUMED')} ${chalk.cyan(id)} – usage ${chalk.green(usedPercent + '%')} ≤ resume threshold ${resumeThreshold}%`
      );
      console.log(chalk.green('  ✓ Agent calls to this model can proceed.\n'));
    });

    monitor.on('error', ({ id, error }) => {
      console.log(`${chalk.grey(ts())} ${chalk.red('✗')} ${chalk.cyan(id)} probe failed: ${error}`);
    });

    monitor.start();

    process.on('SIGINT', () => {
      console.log('\n' + chalk.grey('Stopping monitor…'));
      monitor.stop();
      process.exit(0);
    });
  });

// ─── set ──────────────────────────────────────────────────────────────────────

program
  .command('set <key> <value>')
  .description('Update global settings (e.g. set pollIntervalSeconds 30)')
  .action((key, value) => {
    const parsed = isNaN(value) ? value : parseFloat(value);
    ConfigManager.setSetting(key, parsed);
    console.log(chalk.green(`✓ ${key} = ${parsed}`));
  });

// ─── config ───────────────────────────────────────────────────────────────────

program
  .command('config')
  .description('Show current configuration')
  .action(() => {
    const cfg = ConfigManager.export();
    console.log(JSON.stringify(cfg, (k, v) => k === 'apiKey' ? '***' : v, 2));
    console.log(chalk.grey(`\nConfig file: ${ConfigManager.getConfigPath()}`));
  });

// ─── providers ────────────────────────────────────────────────────────────────

program
  .command('providers')
  .description('List supported providers and models')
  .action(() => {
    const supported = getSupportedProviders();
    for (const p of supported) {
      console.log('\n' + chalk.bold.cyan(p.displayName) + chalk.grey(` (${p.key})`));
      console.log(chalk.grey('  Reset: ') + p.resetInfo.description);
      console.log(chalk.grey('  Models:'));
      for (const m of p.models) {
        console.log(`    - ${m}`);
      }
    }
    console.log('');
  });

// ─── reset / clear ────────────────────────────────────────────────────────────

program
  .command('reset')
  .description('Clear all configuration')
  .action(async () => {
    const { confirm } = await inquirer.prompt([{
      type: 'confirm', name: 'confirm',
      message: chalk.red('This will delete ALL configured models and settings. Continue?'),
      default: false,
    }]);
    if (confirm) {
      ConfigManager.clear();
      console.log(chalk.green('✓ Configuration cleared.'));
    }
  });

// ─── helpers ──────────────────────────────────────────────────────────────────

function ts() {
  return dayjs().format('HH:mm:ss');
}

function printQuotaLine(id, quota, state) {
  const usedPct = quota.tokens.usedPercent || 0;
  const prefix = state === STATE.PAUSED ? chalk.red('⏸') : chalk.green('▶');
  const used = fmtNum(quota.tokens.used);
  const total = fmtNum(quota.tokens.limit);
  const reset = quota.tokens.resetAt ? chalk.grey(`resets ${dayjs(quota.tokens.resetAt).fromNow()}`) : '';
  process.stdout.write(
    `\r${chalk.grey(ts())} ${prefix} ${chalk.cyan(id.padEnd(40))} ${bar(usedPct, 20)} ${usedPct.toFixed(1).padStart(5)}%  ${used}/${total}  ${reset}          `
  );
  if (state === STATE.PAUSED || state === STATE.ACTIVE) {
    // newline to avoid overwrite on state change
  }
}

// ─── run ──────────────────────────────────────────────────────────────────────

program.parse(process.argv);

if (process.argv.length < 3) {
  program.help();
}
