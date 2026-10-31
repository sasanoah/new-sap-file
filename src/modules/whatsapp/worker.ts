import { claimJobs, completeJob, failJob, type Job } from '../../platform/events/jobs.js';
import { processAiReplyJob } from './ai/orchestrator.js';
import { processCampaignLaunchJob } from './campaigns/campaigns.js';
import type { WhatsAppDeps } from './context.js';
import { processWebhookEventJob } from './inbound/webhook-job.js';
import { processSendJob } from './outbound/send-worker.js';

const HANDLERS: Record<Job['kind'], (deps: WhatsAppDeps, job: Job) => Promise<void>> = {
  webhook_event: processWebhookEventJob,
  send_message: processSendJob,
  ai_reply: processAiReplyJob,
  campaign_launch: processCampaignLaunchJob,
};

export interface DrainResult {
  processed: number;
  retried: number;
  dead: number;
}

/** Claims and runs one batch of due jobs. */
export async function runJobBatch(deps: WhatsAppDeps, batchSize: number): Promise<DrainResult> {
  const jobs = await claimJobs(deps.db, batchSize, deps.clock.now());
  const out: DrainResult = { processed: 0, retried: 0, dead: 0 };
  for (const job of jobs) {
    try {
      await HANDLERS[job.kind](deps, job);
      await completeJob(deps.db, job.id);
      out.processed++;
    } catch (err) {
      const result = await failJob(deps.db, job, err, deps.clock.now());
      deps.log.warn({ jobId: job.id, kind: job.kind, attempt: job.attempts, result, err: (err as Error).message }, 'job failed');
      if (result === 'retry') out.retried++;
      else out.dead++;
    }
  }
  return out;
}

/** Runs batches until no job is due (used by tests and one-shot tooling). */
export async function drainJobs(deps: WhatsAppDeps, maxBatches = 50): Promise<DrainResult> {
  const total: DrainResult = { processed: 0, retried: 0, dead: 0 };
  for (let i = 0; i < maxBatches; i++) {
    const r = await runJobBatch(deps, 50);
    total.processed += r.processed;
    total.retried += r.retried;
    total.dead += r.dead;
    if (r.processed + r.retried + r.dead === 0) break;
  }
  return total;
}
