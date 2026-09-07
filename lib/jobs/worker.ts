/**
 * The job worker.
 *
 * Runs as service_role, claims work with SELECT ... FOR UPDATE SKIP LOCKED, and
 * handles each job type in a handler that is safe to run twice. Delivery is
 * at-least-once, so idempotency is a property of the handlers, not something the
 * queue promises.
 *
 * A job that exhausts its attempts becomes `dead` rather than being retried
 * forever, and that is loud: a dead job is a thing someone must look at.
 */
import { withService } from '@/lib/db';
import { claimJobs, completeJob, failJob, type JobRow, type JobType } from './queue';
import { logger } from '@/lib/util/logger';
import { randomUUID } from 'node:crypto';

type Handler = (payload: Record<string, unknown>, job: JobRow) => Promise<unknown>;

const HANDLERS: Partial<Record<JobType, Handler>> = {
  'event.dispatch': async (payload) => {
    const { dispatchEvent } = await import('@/lib/automation/engine');
    await dispatchEvent(String(payload.eventId));
    return { dispatched: payload.eventId };
  },

  'webhook.process': async (payload) => {
    const { processWebhookEvent } = await import('@/lib/webhooks/processor');
    await processWebhookEvent(String(payload.webhookEventId));
    return { processed: payload.webhookEventId };
  },

  'signature.download_executed': async (payload) => {
    const { downloadAndStoreExecutedDocument } = await import(
      '@/lib/workflows/executed-document'
    );
    return downloadAndStoreExecutedDocument({
      signatureRequestId: String(payload.signatureRequestId),
      contractId: String(payload.contractId),
    });
  },

  'onboarding.evaluate_gate': async (payload) => {
    const { evaluateGate } = await import('@/lib/services/onboarding');
    return withService('re-evaluate onboarding gate', async (tx) => {
      const onboardingId = String(payload.onboarding_id ?? payload.onboardingId);
      const onboarding = await tx.one<{ org_id: string }>(
        `select org_id from onboardings where id = $1`,
        [onboardingId],
      );
      await tx.bindOrg(onboarding.org_id);
      return evaluateGate(tx, onboardingId);
    });
  },

  'task.overdue_sweep': async () =>
    withService('sweep overdue tasks', async (tx) => {
      // Notifies each assignee once per day about their overdue work. The
      // dedupe key contains the date, so a re-run on the same day is silent.
      const today = new Date().toISOString().slice(0, 10);
      const overdue = await tx.many<{
        org_id: string; assignee_user_id: string; overdue_count: string;
      }>(
        `select org_id, assignee_user_id, count(*)::text as overdue_count
         from tasks
         where deleted_at is null
           and status not in ('done','cancelled')
           and due_date < current_date
           and assignee_user_id is not null
         group by org_id, assignee_user_id`,
      );

      for (const row of overdue) {
        await tx.bindOrg(row.org_id);
        await tx.query(
          `select app.deliver_notification($1,$2,$3,'task',$4,$5,null,null,'/tasks?scope=overdue','high',null,$6)`,
          [
            randomUUID(),
            row.org_id,
            row.assignee_user_id,
            `${row.overdue_count} overdue ${Number(row.overdue_count) === 1 ? 'task' : 'tasks'}`,
            'Some of your work has passed its due date.',
            `overdue:${row.assignee_user_id}:${today}`,
          ],
        );
      }

      return { notified: overdue.length };
    }),

  /**
   * Opens a renewal cycle for every contract entering its notice window, then
   * notifies the owner.
   *
   * Phase 1 only notified, which meant nothing recorded what happened next.
   * Opening the row first is what turns a reminder into a piece of work: the
   * notification now points at something that can be owned, worked and closed
   * with a reason.
   *
   * `app.open_renewal_cycle` is idempotent on (contract, period_end), so a
   * sweep that runs hourly still produces one row per cycle.
   */
  'renewal.sweep': async () =>
    withService('sweep upcoming renewals', async (tx) => {
      const today = new Date().toISOString().slice(0, 10);
      const renewals = await tx.many<{
        org_id: string; contract_id: string; reference: string;
        company_name: string; owner_user_id: string | null; days_remaining: string;
      }>(
        `select c.org_id, c.id as contract_id, c.reference, co.name as company_name,
                c.owner_user_id, (c.expiry_date - current_date)::text as days_remaining
         from contracts c
         join companies co on co.id = c.company_id
         where c.deleted_at is null
           and c.status = 'fully_executed'
           and c.expiry_date is not null
           and c.expiry_date between current_date
             and current_date + make_interval(days => coalesce(c.renewal_notice_days, 60))`,
      );

      let opened = 0;
      let notified = 0;

      for (const renewal of renewals) {
        await tx.bindOrg(renewal.org_id);

        const row = await tx.one<{ id: string | null }>(
          `select app.open_renewal_cycle($1) as id`,
          [renewal.contract_id],
        );
        if (row.id) opened += 1;

        // A contract with no owner still gets its renewal row; there is simply
        // nobody to tell. Losing the record because of that would be the worse
        // of the two failures.
        if (!renewal.owner_user_id) continue;

        await tx.query(
          `select app.deliver_notification($1,$2,$3,'contract',$4,$5,'contract',$6,$7,'normal',null,$8)`,
          [
            randomUUID(),
            renewal.org_id,
            renewal.owner_user_id,
            `${renewal.reference} expires in ${renewal.days_remaining} days`,
            renewal.company_name,
            renewal.contract_id,
            `/legal/renewals`,
            `renewal:${renewal.contract_id}:${today}`,
          ],
        );
        notified += 1;
      }

      return { opened, notified, considered: renewals.length };
    }),

  /**
   * Sends the channel messages that have been queued.
   *
   * Each delivery is claimed, attempted and recorded individually. A provider
   * that is misconfigured fails permanently and is marked failed rather than
   * retried forever — a Slack bot that was never invited to the channel will
   * not be invited by trying again a hundred times, and the retries bury the
   * one error that explains it.
   */
  'channel.dispatch': async () =>
    withService('dispatch channel messages', async (tx) => {
      const pending = await tx.many<{
        id: string;
        org_id: string;
        recipient: string;
        subject: string | null;
        body: string;
        attempts: number;
        provider: string;
        display_name: string;
        config: Record<string, unknown>;
        secret_ref: string | null;
      }>(
        `select d.id, d.org_id, d.recipient, d.subject, d.body, d.attempts,
                c.provider, c.display_name, c.config, c.secret_ref
           from channel_deliveries d
           join integration_connections c on c.id = d.connection_id
          where d.status = 'queued'
            and c.deleted_at is null
            and c.status = 'active'
          order by d.queued_at
          limit 50`,
      );

      let sent = 0;
      let failed = 0;

      for (const delivery of pending) {
        await tx.bindOrg(delivery.org_id);

        try {
          const { channelProvider } = await import('@/lib/integrations');
          const { resolveSecret } = await import('@/lib/integrations/secrets');

          const provider = channelProvider(delivery.provider);
          const token = resolveSecret(delivery.secret_ref, delivery.display_name);

          const result = await provider.send(
            {
              recipient: delivery.recipient,
              body: delivery.body,
              ...(delivery.subject ? { subject: delivery.subject } : {}),
            },
            { token, config: delivery.config },
          );

          await tx.query(
            `update channel_deliveries
                set status = 'sent', provider_message_id = $2, sent_at = now(),
                    attempts = attempts + 1, error = null
              where id = $1`,
            [delivery.id, result.providerMessageId],
          );
          await tx.query(
            `update integration_connections
                set last_used_at = now(), last_error = null, status = 'active'
              where id = (select connection_id from channel_deliveries where id = $1)`,
            [delivery.id],
          );
          sent += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const code = (error as { code?: string }).code;

          // PROVIDER_UNAVAILABLE means configuration: retrying cannot fix it.
          const permanent = code === 'PROVIDER_UNAVAILABLE' || code === 'VALIDATION_ERROR';
          const exhausted = delivery.attempts + 1 >= 5;

          await tx.query(
            `update channel_deliveries
                set status = case when $3 then 'failed' else 'queued' end,
                    attempts = attempts + 1,
                    error = $2
              where id = $1`,
            [delivery.id, message.slice(0, 500), permanent || exhausted],
          );

          if (permanent) {
            // Marking the connection itself, so the settings page can say which
            // integration is broken instead of leaving it looking healthy.
            await tx.query(
              `update integration_connections
                  set status = 'error', last_error = $2
                where id = (select connection_id from channel_deliveries where id = $1)`,
              [delivery.id, message.slice(0, 500)],
            );
          }

          logger.warn('Channel delivery failed', {
            delivery_id: delivery.id,
            provider: delivery.provider,
            permanent,
            error: message,
          });
          failed += 1;
        }
      }

      return { considered: pending.length, sent, failed };
    }),

  /**
   * Pulls new mail from every connected mailbox.
   *
   * Two properties this job must preserve, both of which are easy to lose:
   *
   *   - It only ever reads. There is no branch here that sends anything. A
   *     message arriving cannot cause a message to leave, which is the same
   *     rule the automation engine follows and for the same reason.
   *
   *   - It stores only mail exchanged with a known contact.
   *     `app.ingest_inbound_email` decides that, and returns null for anything
   *     else. The mailbox belongs to a person and most of it is none of this
   *     product's business.
   */
  'mailbox.sync': async () =>
    withService('sync connected mailboxes', async (tx) => {
      const connections = await tx.many<{
        id: string;
        org_id: string;
        provider: string;
        display_name: string;
        config: Record<string, unknown>;
        secret_ref: string | null;
        sync_cursor: string | null;
      }>(
        `select id, org_id, provider, display_name, config, secret_ref, sync_cursor
           from integration_connections
          where deleted_at is null
            and status = 'active'
            and purpose = 'mailbox'
            and provider in ('gmail', 'microsoft')`,
      );

      let ingested = 0;
      let skipped = 0;

      for (const connection of connections) {
        await tx.bindOrg(connection.org_id);

        try {
          const { mailboxProvider } = await import('@/lib/email/mailbox');
          const { resolveSecret } = await import('@/lib/integrations/secrets');

          const provider = mailboxProvider(connection.provider);
          const accessToken = resolveSecret(connection.secret_ref, connection.display_name);

          const page = await provider.list(
            { accessToken, config: connection.config },
            connection.sync_cursor,
            50,
          );

          for (const message of page.messages) {
            const row = await tx.one<{ id: string | null }>(
              `select app.ingest_inbound_email(
                 $1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10,$11,$12,$13
               ) as id`,
              [
                connection.org_id,
                connection.id,
                connection.provider,
                message.rfc822MessageId,
                message.threadKey,
                message.inReplyTo,
                message.fromEmail,
                message.fromName,
                message.toEmails,
                message.subject,
                message.bodyText,
                message.snippet,
                message.receivedAt,
              ],
            );
            if (row.id) ingested += 1;
            else skipped += 1;
          }

          await tx.query(
            `update integration_connections
                set sync_cursor = $2, last_synced_at = now(), last_error = null, status = 'active'
              where id = $1`,
            [connection.id, page.cursor],
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const permanent = (error as { code?: string }).code === 'PROVIDER_UNAVAILABLE';

          await tx.query(
            `update integration_connections
                set last_error = $2, status = case when $3 then 'error' else status end
              where id = $1`,
            [connection.id, message.slice(0, 500), permanent],
          );

          logger.warn('Mailbox sync failed', {
            connection_id: connection.id,
            provider: connection.provider,
            permanent,
            error: message,
          });
        }
      }

      return { mailboxes: connections.length, ingested, skipped };
    }),

  'health.recompute': async () =>
    withService('recompute client health', async (tx) => {
      // A deliberately simple, explainable score. Anything cleverer would need
      // to be justifiable to a client whose account it labels "at risk".
      const updated = await tx.query(
        `update companies c
         set health_score = s.score,
             health_status = case
               when s.score >= 75 then 'healthy'
               when s.score >= 50 then 'watch'
               when s.score >= 25 then 'at_risk'
               else 'critical'
             end,
             health_computed_at = now()
         from (
           select co.id,
             greatest(0, least(100,
               60
               - 20 * (select count(*) from projects p
                       where p.company_id = co.id and p.deleted_at is null
                         and p.health in ('at_risk','off_track'))
               - 15 * (case when exists (
                   select 1 from invoices i
                   where i.company_id = co.id and i.deleted_at is null
                     and i.due_date < current_date
                     and i.status not in ('paid','cancelled','written_off','draft')
                 ) then 1 else 0 end)
               - 10 * (case when not exists (
                   select 1 from activities a
                   where a.company_id = co.id and a.occurred_at > now() - interval '45 days'
                 ) then 1 else 0 end)
               + 20 * (case when exists (
                   select 1 from projects p
                   where p.company_id = co.id and p.deleted_at is null
                     and p.status = 'active' and p.health = 'on_track'
                 ) then 1 else 0 end)
               + 15 * (case when exists (
                   select 1 from opportunities o
                   where o.company_id = co.id and o.deleted_at is null
                     and o.stage not in ('won','lost','closed')
                 ) then 1 else 0 end)
             ))::smallint as score
           from companies co
           where co.deleted_at is null and co.lifecycle_stage = 'client'
         ) s
         where c.id = s.id`,
      );

      return { updated: updated.rowCount };
    }),
};

export interface WorkerOptions {
  queue?: string;
  batchSize?: number;
  workerId?: string;
}

/** Drains one batch. Returns how many jobs ran. */
export async function runOnce(options: WorkerOptions = {}): Promise<number> {
  const workerId = options.workerId ?? `worker-${process.pid}-${randomUUID().slice(0, 8)}`;

  const jobs = await withService(
    'claim jobs',
    (tx) => claimJobs(tx, workerId, { queue: options.queue, limit: options.batchSize ?? 10 }),
    { routine: true },
  );

  for (const job of jobs) {
    const handler = HANDLERS[job.job_type];
    const started = Date.now();

    if (!handler) {
      logger.error('No handler for job type', { job_id: job.id, job_type: job.job_type });
      await withService('mark job unhandled', (tx) =>
        failJob(tx, { ...job, attempts: job.max_attempts }, new Error(
          `No handler is registered for job type "${job.job_type}".`,
        )),
      );
      continue;
    }

    try {
      const result = await handler(job.payload ?? {}, job);
      await withService('complete job', (tx) =>
        completeJob(tx, job.id, result as Record<string, unknown>),
      );
      logger.info('Job completed', {
        job_id: job.id,
        job_type: job.job_type,
        duration_ms: Date.now() - started,
      });
    } catch (error) {
      logger.error('Job failed', {
        job_id: job.id,
        job_type: job.job_type,
        attempt: job.attempts,
        error,
      });
      await withService('fail job', (tx) => failJob(tx, job, error));
    }
  }

  return jobs.length;
}

/**
 * Drains the events outbox.
 *
 * Events are their own queue (see lib/events), so the worker polls them
 * directly rather than requiring a job row per event.
 */
export async function dispatchPendingEvents(limit = 25): Promise<number> {
  const pending = await withService(
    'find pending events',
    (tx) =>
      tx.many<{ id: string }>(
        `select id from events
         where status in ('pending', 'failed')
           and attempts < 5
         order by occurred_at
         limit $1`,
        [limit],
      ),
    { routine: true },
  );

  const { dispatchEvent } = await import('@/lib/automation/engine');

  for (const event of pending) {
    try {
      await dispatchEvent(event.id);
    } catch (error) {
      logger.error('Event dispatch failed', { event_id: event.id, error });
    }
  }

  return pending.length;
}

/**
 * Long-running loop for a dedicated worker process.
 *
 * Polls, backs off when idle, and speeds straight back up the moment there is
 * work. The backoff matters more than it looks: each poll is two round trips to
 * the database, and against a managed instance in another region a fixed
 * two-second interval is a great deal of traffic to discover that nothing has
 * happened.
 *
 * An idle worker is silent apart from a periodic heartbeat, so that a quiet log
 * means "nothing to do" and can be told apart from "the process died".
 */
export async function runForever(
  options: WorkerOptions & { intervalMs?: number; maxIntervalMs?: number } = {},
): Promise<void> {
  const baseInterval = options.intervalMs ?? 2000;
  const maxInterval = options.maxIntervalMs ?? 15_000;
  const heartbeatMs = 5 * 60_000;

  let running = true;
  let interval = baseInterval;
  let lastHeartbeat = Date.now();
  let sinceHeartbeat = { jobs: 0, events: 0, errors: 0 };

  const stop = () => {
    logger.info('Worker shutting down');
    running = false;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  logger.info('Worker started', {
    queue: options.queue ?? 'default',
    poll_ms: baseInterval,
    max_poll_ms: maxInterval,
  });

  while (running) {
    try {
      const events = await dispatchPendingEvents();
      const jobs = await runOnce(options);

      sinceHeartbeat.events += events;
      sinceHeartbeat.jobs += jobs;

      if (events === 0 && jobs === 0) {
        await new Promise((resolve) => setTimeout(resolve, interval));
        // Ease off while nothing is happening, up to the ceiling.
        interval = Math.min(Math.round(interval * 1.5), maxInterval);
      } else {
        // There was work; return to a tight loop so the next item is picked up
        // immediately rather than after a long idle wait.
        interval = baseInterval;
      }
    } catch (error) {
      sinceHeartbeat.errors++;
      logger.error('Worker iteration failed', { error });
      await new Promise((resolve) => setTimeout(resolve, interval));
      interval = Math.min(Math.round(interval * 1.5), maxInterval);
    }

    if (Date.now() - lastHeartbeat >= heartbeatMs) {
      logger.info('Worker heartbeat', {
        jobs_run: sinceHeartbeat.jobs,
        events_dispatched: sinceHeartbeat.events,
        errors: sinceHeartbeat.errors,
        poll_ms: interval,
      });
      lastHeartbeat = Date.now();
      sinceHeartbeat = { jobs: 0, events: 0, errors: 0 };
    }
  }
}
