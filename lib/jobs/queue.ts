/**
 * The job queue.
 *
 * A plain PostgreSQL table drained with SELECT ... FOR UPDATE SKIP LOCKED.
 *
 * Keeping the queue in the business database rather than in Redis or SQS buys
 * the property that matters here: a job is enqueued in the same transaction as
 * the change that requires it. There is no window in which a contract is marked
 * sent but the notification job was lost, and no need for two-phase commit to
 * avoid one.
 */
import type { Tx } from '@/lib/db';

export type JobType =
  | 'event.dispatch'
  | 'automation.run'
  | 'email.send'
  | 'webhook.process'
  | 'signature.poll'
  | 'signature.download_executed'
  | 'document.verify_hash'
  | 'onboarding.evaluate_gate'
  | 'project.provision'
  | 'report.generate'
  | 'health.recompute'
  | 'task.overdue_sweep'
  | 'renewal.sweep'
  | 'channel.dispatch'
  | 'mailbox.sync';

export interface EnqueueInput {
  type: JobType;
  payload?: Record<string, unknown>;
  orgId?: string | null;
  queue?: string;
  priority?: number;
  runAt?: Date;
  maxAttempts?: number;
  /** Collapses duplicate enqueues of the same logical work while it is pending. */
  singletonKey?: string;
}

export async function enqueueJob(tx: Tx, input: EnqueueInput): Promise<string | null> {
  const row = await tx.maybeOne<{ id: string }>(
    `insert into jobs (org_id, queue, job_type, payload, priority, run_at, max_attempts, singleton_key)
     values ($1, $2, $3, $4, $5, coalesce($6, now()), $7, $8)
     on conflict (singleton_key) where singleton_key is not null and status in ('queued','running')
     do nothing
     returning id`,
    [
      input.orgId ?? tx.context.orgId ?? null,
      input.queue ?? 'default',
      input.type,
      JSON.stringify(input.payload ?? {}),
      input.priority ?? 100,
      input.runAt ? input.runAt.toISOString() : null,
      input.maxAttempts ?? 5,
      input.singletonKey ?? null,
    ],
  );
  return row?.id ?? null;
}

export interface JobRow {
  id: string;
  org_id: string | null;
  queue: string;
  job_type: JobType;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

/**
 * Claims up to `limit` due jobs. SKIP LOCKED lets several workers drain the same
 * queue without coordinating.
 */
export async function claimJobs(
  tx: Tx,
  workerId: string,
  options: { queue?: string; limit?: number } = {},
): Promise<JobRow[]> {
  return tx.many<JobRow>(
    `with claimed as (
       select id from jobs
       where queue = $1
         and status in ('queued', 'failed')
         and run_at <= now()
         and attempts < max_attempts
       order by priority asc, run_at asc
       for update skip locked
       limit $2
     )
     update jobs j
     set status = 'running',
         attempts = j.attempts + 1,
         locked_at = now(),
         locked_by = $3
     from claimed
     where j.id = claimed.id
     returning j.id, j.org_id, j.queue, j.job_type, j.payload, j.attempts, j.max_attempts`,
    [options.queue ?? 'default', options.limit ?? 10, workerId],
  );
}

export async function completeJob(
  tx: Tx,
  jobId: string,
  result?: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `update jobs set status = 'completed', completed_at = now(), locked_at = null,
                     locked_by = null, result = $2, last_error = null
     where id = $1`,
    [jobId, JSON.stringify(result ?? {})],
  );
}

/** Exponential backoff with a cap; a job past max_attempts becomes `dead`. */
export async function failJob(tx: Tx, job: JobRow, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= job.max_attempts;
  const backoffSeconds = Math.min(3600, 2 ** job.attempts * 15);

  await tx.query(
    `update jobs
     set status = $2,
         last_error = $3,
         locked_at = null,
         locked_by = null,
         run_at = case when $2 = 'failed' then now() + make_interval(secs => $4) else run_at end
     where id = $1`,
    [job.id, exhausted ? 'dead' : 'failed', message.slice(0, 2000), backoffSeconds],
  );
}

export function backoffSeconds(attempt: number): number {
  return Math.min(3600, 2 ** attempt * 15);
}
