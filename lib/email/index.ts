/**
 * Email sending.
 *
 * A message is composed as a draft and stored before anything is sent. Sending
 * requires `email:send:org` and, for anything an automation or the AI drafted,
 * an explicit approval — `requires_approval` is enforced by a database check
 * constraint, not merely by this code.
 */
import type { Tx } from '@/lib/db';
import type { RequestContext } from '@/lib/auth/session';
import { AppError } from '@/lib/http/errors';
import { emitEvent, recordActivity } from '@/lib/events';
import { writeAudit } from '@/lib/audit';
import { getEmailProvider } from './providers';
import { serverEnv } from '@/lib/config/env';
import { logger } from '@/lib/util/logger';

export * from './types';
export { getEmailProvider, availableEmailProviders } from './providers';

export async function sendDraft(
  tx: Tx,
  ctx: RequestContext,
  messageId: string,
): Promise<{ messageId: string; providerMessageId: string }> {
  ctx.permissions.require(
    'email:send:org',
    'Sending email to a client requires send authority.',
  );

  const message = await tx.maybeOne<{
    id: string; status: string; requires_approval: boolean; approved_at: string | null;
    company_id: string | null; entity_type: string | null; entity_id: string | null;
    from_email: string; from_name: string | null; to_emails: string[];
    cc_emails: string[]; bcc_emails: string[]; subject: string;
    body_html: string; body_text: string | null;
  }>(
    `select * from email_messages where id = $1 for update`,
    [messageId],
  );
  if (!message) throw new AppError('NOT_FOUND', 'This email was not found.');

  if (message.status !== 'draft') {
    throw new AppError(
      'INVALID_STATE',
      `This email is ${message.status} and cannot be sent again.`,
    );
  }

  if (message.requires_approval && !message.approved_at) {
    throw new AppError(
      'INVALID_STATE',
      'This draft was produced automatically and must be approved before it can be sent.',
    );
  }

  const provider = getEmailProvider();
  const env = serverEnv();

  await tx.query(
    `update email_messages set status = 'sending', queued_at = now(), provider = $2 where id = $1`,
    [messageId, provider.name],
  );

  let result;
  try {
    result = await provider.send({
      from: {
        email: message.from_email || env.EMAIL_FROM_ADDRESS,
        name: message.from_name ?? env.EMAIL_FROM_NAME,
      },
      to: message.to_emails.map((email) => ({ email })),
      cc: message.cc_emails.map((email) => ({ email })),
      bcc: message.bcc_emails.map((email) => ({ email })),
      subject: message.subject,
      html: message.body_html,
      text: message.body_text ?? undefined,
      referenceId: messageId,
    });
  } catch (error) {
    await tx.query(
      `update email_messages set status = 'failed', error = $2 where id = $1`,
      [messageId, error instanceof Error ? error.message : String(error)],
    );
    logger.error('Email send failed', { message_id: messageId, error });
    throw error;
  }

  await tx.query(
    `update email_messages
     set status = 'sent', sent_at = now(), sent_by = $2, provider_message_id = $3
     where id = $1`,
    [messageId, ctx.user.id, result.providerMessageId],
  );

  await tx.query(
    `insert into email_events (org_id, message_id, event_type, occurred_at)
     values ($1,$2,'sent', now())`,
    [ctx.org.id, messageId],
  );

  await emitEvent(tx, {
    name: 'email.sent',
    entityType: 'email_message',
    entityId: messageId,
    payload: {
      to: message.to_emails,
      subject: message.subject,
      provider: provider.name,
    },
  });

  if (message.company_id) {
    await recordActivity(tx, {
      entityType: message.entity_type ?? 'email_message',
      entityId: message.entity_id ?? messageId,
      companyId: message.company_id,
      activityType: 'email',
      title: `Email sent: ${message.subject}`,
      body: message.to_emails.join(', '),
    });
  }

  await writeAudit(tx, {
    orgId: ctx.org.id,
    action: 'email.sent',
    category: 'admin',
    actorUserId: ctx.user.id,
    entityType: 'email_message',
    entityId: messageId,
    summary: `Sent "${message.subject}" to ${message.to_emails.join(', ')}`,
    metadata: { provider: provider.name, provider_message_id: result.providerMessageId },
    requestId: ctx.requestId,
  });

  return { messageId, providerMessageId: result.providerMessageId };
}

export async function approveDraft(
  tx: Tx,
  ctx: RequestContext,
  messageId: string,
): Promise<void> {
  ctx.permissions.require('email:send:org');
  await tx.query(
    `update email_messages set approved_by = $2, approved_at = now()
     where id = $1 and status = 'draft'`,
    [messageId, ctx.user.id],
  );
}
