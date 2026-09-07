/**
 * Action executors.
 *
 * Each executor does one narrowly-defined thing. Note what they have in common:
 * none of them sends anything to a client, and none of them changes a lifecycle
 * state. An automation may prepare work and tell people about it; committing to
 * something remains a human act.
 */
import type { Tx } from '@/lib/db';
import { AppError } from '@/lib/http/errors';
import { emitEvent, recordActivity, notify } from '@/lib/events';
import type { AutomationAction } from './actions';
import type { AutomationSnapshot } from './snapshot';
import type { AutomationRow, EventRow } from './engine';
import { logger } from '@/lib/util/logger';

export interface ExecutionContext {
  action: AutomationAction;
  automation: AutomationRow;
  event: EventRow;
  snapshot: AutomationSnapshot;
  runId: string;
}

export async function executeAction(tx: Tx, ctx: ExecutionContext): Promise<unknown> {
  switch (ctx.action.type) {
    case 'draft_email':
      return draftEmail(tx, ctx, ctx.action.params);
    case 'generate_contract':
      return generateContract(tx, ctx, ctx.action.params);
    case 'notify':
      return sendNotification(tx, ctx, ctx.action.params);
    case 'create_task':
      return createTask(tx, ctx, ctx.action.params);
    case 'assign_owner':
      return assignOwner(tx, ctx, ctx.action.params);
    case 'add_tag':
      return addTag(tx, ctx, ctx.action.params);
    case 'set_field':
      return setField(tx, ctx, ctx.action.params);
    case 'create_payment_requirement':
      return createPaymentRequirement(tx, ctx, ctx.action.params);
    case 'start_onboarding':
      return startOnboarding(tx, ctx);
    case 'request_ai_action':
      return requestAiAction(tx, ctx, ctx.action.params);
    case 'add_activity':
      return addActivity(tx, ctx, ctx.action.params);
    default: {
      // The enumeration is closed; this is unreachable, and saying so in the
      // type system means a new action cannot be added without an executor.
      const never: never = ctx.action;
      throw new AppError('VALIDATION_ERROR', `Unhandled automation action: ${JSON.stringify(never)}`);
    }
  }
}

/**
 * Drafts an email. It is never sent.
 *
 * The message is stored with `requires_approval = true` and status `draft`; a
 * person with `email:send:org` reviews and sends it. There is deliberately no
 * automation path that puts a message in front of a client.
 */
async function draftEmail(
  tx: Tx,
  ctx: ExecutionContext,
  params: Extract<AutomationAction, { type: 'draft_email' }>['params'],
): Promise<unknown> {
  const orgId = ctx.automation.org_id;

  const template = await tx.maybeOne<{
    id: string; version_id: string; subject: string; body_html: string; body_text: string | null;
  }>(
    `select t.id, v.id as version_id, v.subject, v.body_html, v.body_text
     from email_templates t
     join email_template_versions v on v.id = t.current_version_id
     where t.org_id = $1 and t.key = $2 and t.deleted_at is null and t.is_active`,
    [orgId, params.template],
  );

  if (!template) {
    throw new AppError('NOT_FOUND', `No active email template with key "${params.template}".`);
  }

  const recipient = await resolveRecipient(tx, ctx, params.to);
  if (!recipient) {
    throw new AppError('VALIDATION_ERROR', `Could not resolve a recipient for "${params.to}".`);
  }

  const variables: Record<string, unknown> = {
    client_name: ctx.snapshot.client?.name ?? '',
    contact_name: recipient.name,
    opportunity_name: ctx.snapshot.opportunity?.name ?? '',
    ...params.variables,
  };

  const subject = substitute(template.subject, variables);
  const bodyHtml = substitute(template.body_html, variables);

  const message = await tx.one<{ id: string }>(
    `insert into email_messages (
       org_id, company_id, contact_id, entity_type, entity_id, template_version_id,
       provider, from_email, from_name, to_emails, subject, body_html, body_text,
       status, requires_approval, created_by
     ) values ($1,$2,$3,$4,$5,$6,'noop',$7,$8,$9::text[]::citext[],$10,$11,$12,'draft',true,null)
     returning id`,
    [
      orgId,
      ctx.snapshot.client?.id ?? null,
      recipient.contactId,
      ctx.event.entity_type,
      ctx.event.entity_id,
      template.version_id,
      'no-reply@velozity.local',
      'Velozity',
      [recipient.email],
      subject,
      bodyHtml,
      template.body_text ? substitute(template.body_text, variables) : null,
    ],
  );

  await emitEvent(tx, {
    name: 'email.drafted',
    entityType: 'email_message',
    entityId: message.id,
    payload: { template: params.template, to: recipient.email, automation_id: ctx.automation.id },
    actorType: 'automation',
    actorUserId: null,
    depth: ctx.event.depth + 1,
  });

  // Someone has to decide whether this goes out.
  const owner = await resolveTargetUser(tx, ctx, 'opportunity.owner');
  if (owner) {
    await notify(tx, {
      userId: owner,
      category: 'approval',
      title: 'An email draft is waiting for you',
      body: subject,
      entityType: 'email_message',
      entityId: message.id,
      linkUrl: `/clients/${ctx.snapshot.client?.id ?? ''}?tab=emails`,
      dedupeKey: `email-draft:${message.id}`,
    });
  }

  return { email_message_id: message.id, requires_approval: true, to: recipient.email };
}

/**
 * Generates a contract draft. It is not approved and not sent.
 */
async function generateContract(
  tx: Tx,
  ctx: ExecutionContext,
  params: Extract<AutomationAction, { type: 'generate_contract' }>['params'],
): Promise<unknown> {
  const orgId = ctx.automation.org_id;
  const companyId = ctx.snapshot.client?.id;
  if (!companyId) {
    throw new AppError('VALIDATION_ERROR', 'This automation has no client to draft a contract for.');
  }

  // Do not draft a second one if the client already has this paperwork.
  const existing = await tx.maybeOne<{ id: string; status: string }>(
    `select id, status from contracts
     where company_id = $1 and contract_type = $2 and deleted_at is null
       and status not in ('declined','expired','voided')
     limit 1`,
    [companyId, params.contract_type],
  );
  if (existing) {
    return { skipped: true, reason: 'A contract of this type already exists.', contract_id: existing.id };
  }

  const template = params.template_key
    ? await tx.maybeOne<{ version_id: string }>(
        `select v.id as version_id from contract_templates t
         join contract_template_versions v on v.id = t.current_version_id
         where t.org_id = $1 and t.key = $2 and t.is_active and t.deleted_at is null`,
        [orgId, params.template_key],
      )
    : await tx.maybeOne<{ version_id: string }>(
        `select v.id as version_id from contract_templates t
         join contract_template_versions v on v.id = t.current_version_id
         where t.org_id = $1 and t.contract_type = $2 and t.is_active and t.deleted_at is null
         order by t.created_at limit 1`,
        [orgId, params.contract_type],
      );

  if (!template) {
    throw new AppError(
      'NOT_FOUND',
      `No active ${params.contract_type.toUpperCase()} template is configured.`,
    );
  }

  const reference = await tx.one<{ reference: string }>(
    `select app.next_reference($1, $2, $3) as reference`,
    [orgId, `contract_${params.contract_type}`, params.contract_type.toUpperCase()],
  );

  const contract = await tx.one<{ id: string; reference: string }>(
    `insert into contracts (
       org_id, company_id, opportunity_id, reference, title, contract_type, origin,
       template_version_id, source_proposal_version_id, currency, contract_value,
       owner_user_id, created_by
     ) values ($1,$2,$3,$4,$5,$6,'our_template',$7,$8,$9,$10,$11,null)
     returning id, reference`,
    [
      orgId, companyId, ctx.snapshot.opportunity?.id ?? null, reference.reference,
      `${params.contract_type.toUpperCase()} — ${ctx.snapshot.client?.name ?? 'client'}`,
      params.contract_type, template.version_id,
      ctx.snapshot.opportunity?.accepted_proposal_version_id ?? null,
      ctx.snapshot.opportunity?.currency ?? null,
      ctx.snapshot.opportunity?.amount ?? null,
      ctx.snapshot.opportunity?.owner_user_id ?? null,
    ],
  );

  await emitEvent(tx, {
    name: 'contract.created',
    entityType: 'contract',
    entityId: contract.id,
    payload: {
      reference: contract.reference,
      contract_type: params.contract_type,
      company_id: companyId,
      generated_by_automation: ctx.automation.id,
    },
    actorType: 'automation',
    actorUserId: null,
    depth: ctx.event.depth + 1,
  });

  await recordActivity(tx, {
    entityType: 'contract',
    entityId: contract.id,
    companyId: String(companyId),
    activityType: 'automation',
    title: `${params.contract_type.toUpperCase()} ${contract.reference} drafted automatically`,
    body: `Generated by the "${ctx.automation.name}" automation. It still needs legal review before it can be sent.`,
    actorType: 'automation',
    actorUserId: null,
  });

  return { contract_id: contract.id, reference: contract.reference, status: 'draft' };
}

async function sendNotification(
  tx: Tx,
  ctx: ExecutionContext,
  params: Extract<AutomationAction, { type: 'notify' }>['params'],
): Promise<unknown> {
  const targets = params.target.startsWith('role:')
    ? await resolveRoleMembers(tx, ctx.automation.org_id, params.target.slice(5))
    : [await resolveTargetUser(tx, ctx, params.target)].filter((u): u is string => Boolean(u));

  for (const userId of targets) {
    await notify(tx, {
      userId,
      category: 'automation',
      title: substitute(params.title, ctx.snapshot as Record<string, unknown>),
      body: params.body ? substitute(params.body, ctx.snapshot as Record<string, unknown>) : null,
      entityType: ctx.event.entity_type,
      entityId: ctx.event.entity_id,
      priority: params.priority,
      dedupeKey: `automation:${ctx.runId}:${userId}`,
    });
  }

  return { notified: targets.length };
}

async function createTask(
  tx: Tx,
  ctx: ExecutionContext,
  params: Extract<AutomationAction, { type: 'create_task' }>['params'],
): Promise<unknown> {
  const assignee =
    params.assign_to === 'unassigned' ? null : await resolveTargetUser(tx, ctx, params.assign_to);

  const reference = await tx.one<{ reference: string }>(
    `select app.next_reference($1, 'task', 'TSK') as reference`,
    [ctx.automation.org_id],
  );

  const task = await tx.one<{ id: string }>(
    `insert into tasks (
       org_id, project_id, company_id, reference, title, description, status, priority,
       assignee_user_id, due_date, created_by
     ) values ($1,$2,$3,$4,$5,$6,'todo',$7,$8, current_date + make_interval(days => $9), null)
     returning id`,
    [
      ctx.automation.org_id,
      ctx.snapshot.project?.id ?? null,
      ctx.snapshot.client?.id ?? null,
      reference.reference,
      substitute(params.title, ctx.snapshot as Record<string, unknown>),
      params.description ?? null,
      params.priority,
      assignee,
      params.due_in_days,
    ],
  );

  await emitEvent(tx, {
    name: 'task.created',
    entityType: 'task',
    entityId: task.id,
    payload: { title: params.title, automation_id: ctx.automation.id },
    actorType: 'automation',
    actorUserId: null,
    depth: ctx.event.depth + 1,
  });

  if (assignee) {
    await notify(tx, {
      userId: assignee,
      category: 'assignment',
      title: 'A task was created for you',
      body: params.title,
      entityType: 'task',
      entityId: task.id,
      linkUrl: `/tasks/${task.id}`,
      dedupeKey: `automation-task:${task.id}`,
    });
  }

  return { task_id: task.id };
}

async function assignOwner(
  tx: Tx,
  ctx: ExecutionContext,
  params: Extract<AutomationAction, { type: 'assign_owner' }>['params'],
): Promise<unknown> {
  const table = ctx.event.entity_type === 'company' ? 'companies' : 'opportunities';
  const column = 'owner_user_id';

  if (!ctx.event.entity_id) throw new AppError('VALIDATION_ERROR', 'No entity to assign.');

  await tx.query(`update ${table} set ${column} = $2 where id = $1`, [
    ctx.event.entity_id,
    params.user_id,
  ]);

  await notify(tx, {
    userId: params.user_id,
    category: 'assignment',
    title: 'A record was assigned to you',
    entityType: ctx.event.entity_type,
    entityId: ctx.event.entity_id,
    dedupeKey: `automation-assign:${ctx.runId}`,
  });

  return { assigned_to: params.user_id };
}

async function addTag(
  tx: Tx,
  ctx: ExecutionContext,
  params: Extract<AutomationAction, { type: 'add_tag' }>['params'],
): Promise<unknown> {
  const table =
    ctx.event.entity_type === 'company' ? 'companies'
    : ctx.event.entity_type === 'opportunity' ? 'opportunities'
    : ctx.event.entity_type === 'project' ? 'projects'
    : null;

  if (!table || !ctx.event.entity_id) {
    throw new AppError('VALIDATION_ERROR', `Tags cannot be applied to a ${ctx.event.entity_type}.`);
  }

  await tx.query(
    `update ${table} set tags = array(select distinct unnest(tags || $2::text[])) where id = $1`,
    [ctx.event.entity_id, [params.tag]],
  );
  return { tag: params.tag };
}

/**
 * Sets one of a short allow-list of non-consequential fields.
 * Lifecycle columns are not on the list, so an automation cannot move an entity
 * through its state machine and skip the guards.
 */
async function setField(
  tx: Tx,
  ctx: ExecutionContext,
  params: Extract<AutomationAction, { type: 'set_field' }>['params'],
): Promise<unknown> {
  const [entityName, column] = params.field.split('.') as [string, string];

  const table =
    entityName === 'opportunity' ? 'opportunities'
    : entityName === 'company' ? 'companies'
    : entityName === 'project' ? 'projects'
    : null;

  if (!table) throw new AppError('VALIDATION_ERROR', `Unknown entity in field path.`);

  const targetId =
    entityName === 'opportunity' ? ctx.snapshot.opportunity?.id
    : entityName === 'company' ? ctx.snapshot.client?.id
    : ctx.snapshot.project?.id;

  if (!targetId) {
    throw new AppError('VALIDATION_ERROR', `This automation has no ${entityName} to update.`);
  }

  await tx.query(`update ${table} set "${column}" = $2 where id = $1`, [targetId, params.value]);
  return { field: params.field, value: params.value };
}

async function createPaymentRequirement(
  tx: Tx,
  ctx: ExecutionContext,
  params: Extract<AutomationAction, { type: 'create_payment_requirement' }>['params'],
): Promise<unknown> {
  const companyId = ctx.snapshot.client?.id;
  if (!companyId) throw new AppError('VALIDATION_ERROR', 'No client to raise a requirement against.');

  const contract = await tx.maybeOne<{ id: string; currency: string | null }>(
    `select id, currency from contracts
     where company_id = $1 and contract_type in ('msa','sow') and status = 'fully_executed'
       and deleted_at is null
     order by executed_at desc limit 1`,
    [companyId],
  );

  const row = await tx.one<{ id: string }>(
    `insert into payment_requirements (
       org_id, company_id, opportunity_id, contract_id, name, requirement_type,
       amount, percent_of_value, currency, blocks_onboarding, created_by
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,null)
     returning id`,
    [
      ctx.automation.org_id, companyId, ctx.snapshot.opportunity?.id ?? null,
      contract?.id ?? null, params.name, params.requirement_type,
      params.amount ?? null, params.percent_of_value ?? null,
      contract?.currency ?? ctx.snapshot.opportunity?.currency ?? 'USD',
      params.blocks_onboarding,
    ],
  );

  return { payment_requirement_id: row.id };
}

async function startOnboarding(tx: Tx, ctx: ExecutionContext): Promise<unknown> {
  const companyId = ctx.snapshot.client?.id;
  if (!companyId) throw new AppError('VALIDATION_ERROR', 'No client to onboard.');

  const existing = await tx.maybeOne<{ id: string }>(
    `select id from onboardings
     where company_id = $1 and (opportunity_id = $2 or $2 is null) and deleted_at is null
     limit 1`,
    [companyId, ctx.snapshot.opportunity?.id ?? null],
  );
  if (existing) return { skipped: true, onboarding_id: existing.id };

  const row = await tx.one<{ id: string }>(
    `insert into onboardings (org_id, company_id, opportunity_id, owner_user_id, created_by)
     values ($1,$2,$3,$4,null) returning id`,
    [
      ctx.automation.org_id, companyId, ctx.snapshot.opportunity?.id ?? null,
      ctx.snapshot.opportunity?.owner_user_id ?? null,
    ],
  );

  await emitEvent(tx, {
    name: 'onboarding.created',
    entityType: 'onboarding',
    entityId: row.id,
    payload: { company_id: companyId, automation_id: ctx.automation.id },
    actorType: 'automation',
    actorUserId: null,
    depth: ctx.event.depth + 1,
  });

  return { onboarding_id: row.id };
}

/**
 * Queues an AI action for human approval. The model does not run here and its
 * output would not be applied even if it did — that is the ai_actions flow.
 */
async function requestAiAction(
  tx: Tx,
  ctx: ExecutionContext,
  params: Extract<AutomationAction, { type: 'request_ai_action' }>['params'],
): Promise<unknown> {
  const aiEnabled = await tx.one<{ ai_enabled: boolean }>(
    `select ai_enabled from organizations where id = $1`,
    [ctx.automation.org_id],
  );
  if (!aiEnabled.ai_enabled) {
    return { skipped: true, reason: 'AI is disabled for this organisation.' };
  }

  await tx.query(
    `insert into jobs (org_id, queue, job_type, payload, priority, singleton_key)
     values ($1, 'default', 'ai.generate', $2, 80, $3)
     on conflict (singleton_key) where singleton_key is not null and status in ('queued','running')
     do nothing`,
    [
      ctx.automation.org_id,
      JSON.stringify({
        action_type: params.action_type,
        entity_type: ctx.event.entity_type,
        entity_id: ctx.event.entity_id,
        company_id: ctx.snapshot.client?.id ?? null,
        automation_id: ctx.automation.id,
      }),
      `ai:${params.action_type}:${ctx.event.entity_id}`,
    ],
  );

  return { queued: true, action_type: params.action_type };
}

async function addActivity(
  tx: Tx,
  ctx: ExecutionContext,
  params: Extract<AutomationAction, { type: 'add_activity' }>['params'],
): Promise<unknown> {
  if (!ctx.event.entity_id) throw new AppError('VALIDATION_ERROR', 'No entity for this activity.');

  const id = await recordActivity(tx, {
    entityType: ctx.event.entity_type,
    entityId: ctx.event.entity_id,
    companyId: (ctx.snapshot.client?.id as string) ?? null,
    activityType: 'automation',
    title: substitute(params.title, ctx.snapshot as Record<string, unknown>),
    body: params.body ? substitute(params.body, ctx.snapshot as Record<string, unknown>) : null,
    isInternal: params.is_internal,
    actorType: 'automation',
    actorUserId: null,
  });

  return { activity_id: id };
}

// -----------------------------------------------------------------------------

async function resolveTargetUser(
  tx: Tx,
  ctx: ExecutionContext,
  target: string,
): Promise<string | null> {
  switch (target) {
    case 'opportunity.owner':
      return (ctx.snapshot.opportunity?.owner_user_id as string) ?? null;
    case 'company.owner':
      return (ctx.snapshot.client?.owner_user_id as string) ?? null;
    case 'project.manager':
      return (ctx.snapshot.project?.manager_user_id as string) ?? null;
    case 'task.assignee':
      return (ctx.snapshot.entity?.assignee_user_id as string) ?? null;
    default:
      void tx;
      return null;
  }
}

async function resolveRoleMembers(tx: Tx, orgId: string, roleKey: string): Promise<string[]> {
  const rows = await tx.many<{ user_id: string }>(
    `select distinct ur.user_id from user_roles ur
     join roles r on r.id = ur.role_id
     where ur.org_id = $1 and r.key = $2`,
    [orgId, roleKey],
  );
  return rows.map((r) => r.user_id);
}

async function resolveRecipient(
  tx: Tx,
  ctx: ExecutionContext,
  target: string,
): Promise<{ email: string; name: string; contactId: string | null } | null> {
  const companyId = ctx.snapshot.client?.id;

  if (target === 'opportunity_owner') {
    const ownerId = ctx.snapshot.opportunity?.owner_user_id;
    if (!ownerId) return null;
    const user = await tx.maybeOne<{ email: string; full_name: string }>(
      `select email, full_name from user_profiles where id = $1`,
      [ownerId],
    );
    return user ? { email: user.email, name: user.full_name, contactId: null } : null;
  }

  if (!companyId) return null;

  const column =
    target === 'decision_maker' ? `contact_role = 'decision_maker'`
    : target === 'billing_contact' ? 'is_billing'
    : 'is_primary';

  const contact = await tx.maybeOne<{ id: string; email: string; full_name: string }>(
    `select id, email, full_name from contacts
     where company_id = $1 and deleted_at is null and status = 'active'
       and email is not null and not email_opt_out and ${column}
     limit 1`,
    [companyId],
  );

  return contact
    ? { email: contact.email, name: contact.full_name, contactId: contact.id }
    : null;
}

/**
 * Substitutes {{path}} from the snapshot into a string.
 *
 * The same discipline as the contract renderer: substitution only, no
 * expressions. A path with no value becomes an empty string here, because an
 * automation notification is not a legal document — but nothing is invented.
 */
function substitute(template: string, context: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, path: string) => {
    let cursor: unknown = context;
    for (const segment of path.split('.')) {
      if (cursor === null || cursor === undefined || typeof cursor !== 'object') return '';
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    return cursor === null || cursor === undefined ? '' : String(cursor);
  });
}

export { logger };
