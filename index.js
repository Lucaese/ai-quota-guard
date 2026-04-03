/**
 * ai-quota-guard – public SDK API
 * 
 * Usage as a library:
 * 
 *   const { QuotaGuard } = require('ai-quota-guard');
 * 
 *   const guard = new QuotaGuard({
 *     models: [
 *       {
 *         provider: 'anthropic',
 *         apiKey: process.env.ANTHROPIC_API_KEY,
 *         model: 'claude-opus-4-5',
 *         stopThreshold: 90,   // pause when 90% used
 *         resumeThreshold: 20, // resume when only 20% used (quota reset)
 *       }
 *     ],
 *     pollIntervalSeconds: 60,
 *   });
 * 
 *   guard.on('paused',  ({ id }) => console.log(`⏸  ${id} – quota limit reached`));
 *   guard.on('resumed', ({ id }) => console.log(`▶  ${id} – quota restored`));
 *   guard.start();
 * 
 *   // Before each API call in your agent:
 *   if (guard.isAllowed('anthropic', 'claude-opus-4-5')) {
 *     // proceed with call
 *   } else {
 *     // wait / skip
 *   }
 */

const { QuotaMonitor, STATE } = require('./monitor');
const { createProvider, getSupportedProviders } = require('./providers');
const ConfigManager = require('./config');

class QuotaGuard extends QuotaMonitor {
  constructor(config = {}) {
    // Allow initializing from saved config if no models provided
    if (!config.models || config.models.length === 0) {
      const saved = ConfigManager.export();
      config = { ...saved, ...config };
    }
    super(config);
  }
}

module.exports = {
  QuotaGuard,
  QuotaMonitor,
  STATE,
  createProvider,
  getSupportedProviders,
  ConfigManager,
};
