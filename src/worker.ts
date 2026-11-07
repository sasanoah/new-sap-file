import { setTimeout as sleep } from 'node:timers/promises';
import { buildDeps } from './bootstrap.js';
import { loadEnv } from './platform/config/env.js';
import { runJobBatch } from './modules/whatsapp/worker.js';

const env = loadEnv();
const deps = buildDeps(env);
let stopping = false;
process.on('SIGTERM', () => (stopping = true));
process.on('SIGINT', () => (stopping = true));

deps.log.info({ outboundMode: env.WHATSAPP_OUTBOUND_MODE }, 'worker started');
while (!stopping) {
  try {
    const r = await runJobBatch(deps, env.WORKER_BATCH_SIZE);
    if (r.processed + r.retried + r.dead === 0) await sleep(env.WORKER_POLL_INTERVAL_MS);
  } catch (err) {
    deps.log.error({ err }, 'worker batch failed');
    await sleep(env.WORKER_POLL_INTERVAL_MS * 5);
  }
}
await deps.db.destroy();
deps.log.info('worker stopped');
