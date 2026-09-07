/**
 * The automation engine.
 *
 * The tests that matter here are the ones about restraint: an automation must
 * not loop, must not fire repeatedly on one entity, must not send anything to a
 * client, and must not move an entity through its state machine.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../helpers/pglite';
import { setDriver, withTenant, withService, type Tx } from '@/lib/db';
import {
  createOrgWithAdmin, createCompany, type SeedOrg, type SeedUser,
} from '../helpers/factories';
import { testContext } from '../helpers/context';
import { emitEvent } from '@/lib/events';
import { dispatchEvent, runAutomation, type AutomationRow, type EventRow } from '@/lib/automation/engine';
import { evaluateConditions, matchesTriggerFilter, readPath } from '@/lib/automation/conditions';
import { actionSchema, ACTION_TYPES, automationSchema } from '@/lib/automation/actions';
import { buildSnapshot } from '@/lib/automation/snapshot';
import type { RequestContext } from '@/lib/auth/session';

describe('automation engine', () => {
  let db: TestDatabase;
  let org: SeedOrg;
  let admin: SeedUser;
  let ctx: RequestContext;
  let companyId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    setDriver(db.driver);
    const seeded = await createOrgWithAdmin(db.driver, { slug: 'automation-co' });
    org = seeded.org;
    admin = seeded.admin;
    ctx = await testContext(db.driver, admin.id, org.id);
  });

  beforeEach(async () => {
    const company = await createCompany(db.driver, org.id, {
      name: `Auto ${Math.random().toString(36).slice(2, 8)}`,
      ownerUserId: admin.id,
    });
    companyId = company.id;
  });

  afterAll(async () => {
    setDriver(null);
    await db.close();
  });

  const run = <T>(fn: (tx: Tx) => Promise<T>) =>
    withTenant<T>({ userId: admin.id, orgId: org.id, requestId: 'req_auto' }, fn);

  async function createAutomation(overrides: Record<string, unknown> = {}) {
    const definition = {
      name: 'Test automation',
      trigger_event: 'company.updated',
      trigger_filter: {},
      conditions: [],
      actions: [{ type: 'add_activity', params: { title: 'Automation ran', is_internal: true } }],
      max_depth: 5,
      cooldown_seconds: 60,
      ...overrides,
    };

    const row = await db.driver.query<{ id: string }>(
      `insert into automations (
         org_id, name, description, is_active, trigger_event, trigger_filter,
         conditions, actions, max_depth, cooldown_seconds, created_by
       ) values ($1,$2,null,true,$3,$4,$5,$6,$7,$8,$9)
       returning id`,
      [
        org.id, definition.name, definition.trigger_event,
        JSON.stringify(definition.trigger_filter),
        JSON.stringify(definition.conditions),
        JSON.stringify(definition.actions),
        definition.max_depth, definition.cooldown_seconds, admin.id,
      ],
    );
    return row.rows[0]!.id;
  }

  async function loadAutomation(id: string): Promise<AutomationRow> {
    const res = await db.driver.query<AutomationRow>(
      `select id, org_id, name, trigger_event, trigger_filter, conditions, actions,
              max_depth, cooldown_seconds
       from automations where id = $1`,
      [id],
    );
    return res.rows[0]!;
  }

  /**
   * Inserts a real event row. automation_runs references events(id), so a
   * fabricated id would violate the foreign key - and a run that cannot point
   * at its cause is not a run history worth having.
   */
  async function makeEvent(overrides: Partial<EventRow> = {}): Promise<EventRow> {
    const event: EventRow = {
      id: randomUUID(),
      org_id: org.id,
      name: 'company.updated',
      entity_type: 'company',
      entity_id: companyId,
      payload: {},
      actor_user_id: admin.id,
      depth: 0,
      ...overrides,
    };

    await db.driver.query(
      `insert into events (id, org_id, name, entity_type, entity_id, actor_user_id,
                           actor_type, payload, status, depth)
       values ($1,$2,$3,$4,$5,$6,'user',$7,'pending',$8)`,
      [
        event.id, event.org_id, event.name, event.entity_type, event.entity_id,
        event.actor_user_id, JSON.stringify(event.payload), event.depth,
      ],
    );

    return event;
  }

  it('runs an automation whose conditions hold', async () => {
    const automationId = await createAutomation();

    await withService('test', async (tx) => {
      await tx.bindOrg(org.id);
      await runAutomation(tx, await loadAutomation(automationId), await makeEvent());
    });

    const runs = await db.driver.query<{ status: string }>(
      `select status from automation_runs where automation_id = $1`,
      [automationId],
    );
    expect(runs.rows[0]?.status).toBe('succeeded');

    const activities = await db.driver.query<{ title: string; actor_type: string }>(
      `select title, actor_type from activities where entity_id = $1`,
      [companyId],
    );
    expect(activities.rows.some((a) => a.title === 'Automation ran')).toBe(true);
    expect(activities.rows[0]?.actor_type).toBe('automation');
  });

  it('records a run whose conditions failed, rather than staying silent', async () => {
    const automationId = await createAutomation({
      conditions: [{ path: 'client.lifecycle_stage', op: 'eq', value: 'client' }],
    });

    await withService('test', async (tx) => {
      await tx.bindOrg(org.id);
      await runAutomation(tx, await loadAutomation(automationId), await makeEvent());
    });

    const runs = await db.driver.query<{ status: string; condition_results: unknown }>(
      `select status, condition_results from automation_runs where automation_id = $1`,
      [automationId],
    );
    expect(runs.rows[0]?.status).toBe('conditions_failed');
    // The evaluation is stored, so "why didn't it fire?" is answerable.
    expect(JSON.stringify(runs.rows[0]?.condition_results)).toContain('lifecycle_stage');
  });

  it('suppresses a re-trigger on the same entity within the cooldown', async () => {
    const automationId = await createAutomation({ cooldown_seconds: 60 });
    const automation = await loadAutomation(automationId);

    await withService('test', async (tx) => {
      await tx.bindOrg(org.id);
      await runAutomation(tx, automation, await makeEvent());
      await runAutomation(tx, automation, await makeEvent());
      await runAutomation(tx, automation, await makeEvent());
    });

    // All three runs share one transaction timestamp, so created_at cannot
    // order them. What matters is the tally: one ran, two were suppressed.
    const runs = await db.driver.query<{ status: string }>(
      `select status from automation_runs where automation_id = $1`,
      [automationId],
    );
    expect(runs.rows.map((r) => r.status).sort()).toEqual([
      'skipped_cooldown',
      'skipped_cooldown',
      'succeeded',
    ]);
  });

  it('allows an immediate re-trigger on a different entity', async () => {
    const automationId = await createAutomation({ cooldown_seconds: 60 });
    const automation = await loadAutomation(automationId);
    const other = await createCompany(db.driver, org.id, { name: 'Other Co', ownerUserId: admin.id });

    await withService('test', async (tx) => {
      await tx.bindOrg(org.id);
      await runAutomation(tx, automation, await makeEvent());
      await runAutomation(tx, automation, await makeEvent({ entity_id: other.id }));
    });

    const runs = await db.driver.query<{ status: string }>(
      `select status from automation_runs where automation_id = $1 order by created_at`,
      [automationId],
    );
    expect(runs.rows.map((r) => r.status)).toEqual(['succeeded', 'succeeded']);
  });

  it('refuses to run past the maximum chain depth', async () => {
    const automationId = await createAutomation({ max_depth: 3, cooldown_seconds: 0 });
    const automation = await loadAutomation(automationId);

    await withService('test', async (tx) => {
      await tx.bindOrg(org.id);
      // depth 2 is inside the limit, depth 3 is at it, depth 4 beyond it.
      await runAutomation(tx, automation, await makeEvent({ depth: 2 }));
      await runAutomation(tx, automation, await makeEvent({ depth: 3 }));
      await runAutomation(tx, automation, await makeEvent({ depth: 4 }));
    });

    const runs = await db.driver.query<{ status: string; depth: number }>(
      `select status, depth from automation_runs where automation_id = $1 order by depth`,
      [automationId],
    );
    expect(runs.rows.map((r) => `${r.depth}:${r.status}`)).toEqual([
      '2:succeeded',
      '3:skipped_depth',
      '4:skipped_depth',
    ]);
  });

  it('stops an automation that would trigger itself', async () => {
    // A tag change emits company.updated, which this automation listens for.
    // Without depth limiting this would run forever.
    const automationId = await createAutomation({
      trigger_event: 'company.updated',
      cooldown_seconds: 0,
      max_depth: 2,
      actions: [{ type: 'add_tag', params: { tag: 'auto-tagged' } }],
    });
    const automation = await loadAutomation(automationId);

    await withService('test', async (tx) => {
      await tx.bindOrg(org.id);
      for (let depth = 0; depth <= 5; depth++) {
        await runAutomation(tx, automation, await makeEvent({ depth }));
      }
    });

    const runs = await db.driver.query<{ status: string }>(
      `select status from automation_runs where automation_id = $1 order by created_at`,
      [automationId],
    );
    const executed = runs.rows.filter((r) => r.status === 'succeeded').length;
    expect(executed).toBe(2);
    expect(runs.rows.filter((r) => r.status === 'skipped_depth').length).toBe(4);
  });

  it('drafts an email without sending it', async () => {
    await db.driver.query(
      `insert into contacts (org_id, company_id, first_name, last_name, email, is_primary)
       values ($1,$2,'Ada','Byron','ada@client.test',true)`,
      [org.id, companyId],
    );

    // Three statements, not one: data-modifying CTEs share a snapshot, so an
    // outer UPDATE cannot see a row a sibling CTE just inserted.
    const template = await db.driver.query<{ id: string }>(
      `insert into email_templates (org_id, key, name, category, created_by)
       values ($1,'nda_request','NDA request','contract',$2) returning id`,
      [org.id, admin.id],
    );
    const templateId = template.rows[0]!.id;

    const version = await db.driver.query<{ id: string }>(
      `insert into email_template_versions
         (org_id, template_id, version_no, subject, body_html, status, created_by)
       values ($1,$2,1,'NDA for {{client_name}}','<p>Hello {{contact_name}}</p>','active',$3)
       returning id`,
      [org.id, templateId, admin.id],
    );

    await db.driver.query(
      `update email_templates set current_version_id = $2 where id = $1`,
      [templateId, version.rows[0]!.id],
    );

    const automationId = await createAutomation({
      actions: [
        { type: 'draft_email', params: { template: 'nda_request', to: 'primary_contact', variables: {} } },
      ],
    });

    await withService('test', async (tx) => {
      await tx.bindOrg(org.id);
      await runAutomation(tx, await loadAutomation(automationId), await makeEvent());
    });

    const messages = await db.driver.query<{
      status: string; requires_approval: boolean; subject: string; sent_at: string | null;
    }>(`select status, requires_approval, subject, sent_at from email_messages where org_id = $1`, [org.id]);

    expect(messages.rows).toHaveLength(1);
    // Drafted, never sent.
    expect(messages.rows[0]?.status).toBe('draft');
    expect(messages.rows[0]?.requires_approval).toBe(true);
    expect(messages.rows[0]?.sent_at).toBeNull();
    // The client name was substituted into the subject.
    expect(messages.rows[0]?.subject).toMatch(/^NDA for Auto /);
  });

  it('offers no action that sends anything to a client', () => {
    // The specification's central restraint, asserted directly on the enumeration.
    expect(ACTION_TYPES).not.toContain('send_email');
    expect(ACTION_TYPES).not.toContain('send_contract');
    expect(ACTION_TYPES).not.toContain('execute_contract');
    expect(ACTION_TYPES).not.toContain('http_request');
    expect(ACTION_TYPES).not.toContain('run_script');
  });

  it('rejects an action type that is not in the enumeration', () => {
    expect(actionSchema.safeParse({ type: 'send_email', params: {} }).success).toBe(false);
    expect(actionSchema.safeParse({ type: 'run_script', params: { code: 'x' } }).success).toBe(false);
    expect(
      actionSchema.safeParse({ type: 'add_tag', params: { tag: 'ok' } }).success,
    ).toBe(true);
  });

  it('refuses to set a lifecycle column through set_field', () => {
    expect(
      actionSchema.safeParse({
        type: 'set_field',
        params: { field: 'opportunity.stage', value: 'won' },
      }).success,
    ).toBe(false);
    expect(
      actionSchema.safeParse({
        type: 'set_field',
        params: { field: 'contract.status', value: 'fully_executed' },
      }).success,
    ).toBe(false);
    expect(
      actionSchema.safeParse({
        type: 'set_field',
        params: { field: 'opportunity.probability', value: 60 },
      }).success,
    ).toBe(true);
  });

  it('requires at least one action', () => {
    const result = automationSchema.safeParse({
      name: 'Empty',
      trigger_event: 'opportunity.won',
      actions: [],
    });
    expect(result.success).toBe(false);
  });

  it('caps chain depth at 5', () => {
    expect(
      automationSchema.safeParse({
        name: 'Deep',
        trigger_event: 'opportunity.won',
        actions: [{ type: 'add_tag', params: { tag: 'x' } }],
        max_depth: 99,
      }).success,
    ).toBe(false);
  });

  it('dispatches an event to its matching automations only', async () => {
    const matching = await createAutomation({
      trigger_event: 'opportunity.won',
      cooldown_seconds: 0,
      actions: [{ type: 'add_activity', params: { title: 'Won handler', is_internal: true } }],
    });
    const other = await createAutomation({
      trigger_event: 'opportunity.lost',
      cooldown_seconds: 0,
      actions: [{ type: 'add_activity', params: { title: 'Lost handler', is_internal: true } }],
    });

    const event = await run((tx) =>
      emitEvent(tx, {
        name: 'opportunity.won',
        entityType: 'company',
        entityId: companyId,
        payload: { company_id: companyId },
      }),
    );

    await dispatchEvent(event.id);

    const runs = await db.driver.query<{ automation_id: string }>(
      `select automation_id from automation_runs where event_id = $1`,
      [event.id],
    );
    expect(runs.rows.map((r) => r.automation_id)).toEqual([matching]);
    expect(runs.rows.map((r) => r.automation_id)).not.toContain(other);

    const processed = await db.driver.query<{ status: string }>(
      `select status from events where id = $1`,
      [event.id],
    );
    expect(processed.rows[0]?.status).toBe('processed');
  });

  it('narrows a trigger with its filter', () => {
    expect(matchesTriggerFilter({ to: 'won', from: 'negotiation' }, { to: 'won' })).toBe(true);
    expect(matchesTriggerFilter({ to: 'lost' }, { to: 'won' })).toBe(false);
    expect(matchesTriggerFilter({ to: 'won' }, {})).toBe(true);
  });

  it('builds a snapshot carrying derived legal status', async () => {
    const snapshot = await withService('test', async (tx) => {
      await tx.bindOrg(org.id);
      return buildSnapshot(tx, {
        id: 'e1', org_id: org.id, name: 'company.updated',
        entity_type: 'company', entity_id: companyId, payload: {}, depth: 0,
      });
    });

    expect(snapshot.client?.nda_status).toBe('pending');
    expect(snapshot.client?.agreement_status).toBe('pending');
    // Sensitive figures are absent from what an automation can reason about.
    expect(snapshot.client).not.toHaveProperty('internal_notes');
  });
});

describe('condition evaluation', () => {
  const snapshot = {
    event: { name: 'opportunity.stage_changed', to: 'won' },
    client: { nda_status: 'pending', tags: ['enterprise'], health_status: null },
    opportunity: { amount: '45000.00', probability: 80 },
  };

  it('reads a dotted path and tolerates missing segments', () => {
    expect(readPath(snapshot, 'client.nda_status')).toBe('pending');
    expect(readPath(snapshot, 'client.missing.deeper')).toBeUndefined();
    expect(readPath(snapshot, 'nothing')).toBeUndefined();
  });

  it('evaluates every operator', () => {
    const cases: Array<[string, string, unknown, boolean]> = [
      ['client.nda_status', 'eq', 'pending', true],
      ['client.nda_status', 'eq', 'executed', false],
      ['client.nda_status', 'ne', 'executed', true],
      ['opportunity.amount', 'gt', 40000, true],
      ['opportunity.amount', 'gt', 50000, false],
      ['opportunity.probability', 'gte', 80, true],
      ['opportunity.amount', 'lt', 50000, true],
      ['client.nda_status', 'in', ['pending', 'draft'], true],
      ['client.nda_status', 'not_in', ['executed'], true],
      ['client.tags', 'contains', 'enterprise', true],
      ['client.tags', 'not_contains', 'smb', true],
      ['client.health_status', 'is_null', undefined, true],
      ['client.nda_status', 'is_not_null', undefined, true],
      ['client.nda_status', 'starts_with', 'pend', true],
      ['event.to', 'changed_to', 'won', true],
      ['event.to', 'changed_to', 'lost', false],
    ];

    for (const [path, op, value, expected] of cases) {
      const result = evaluateConditions(snapshot, [
        { path, op: op as never, value },
      ]);
      expect(
        result.passed,
        `${path} ${op} ${JSON.stringify(value)} should be ${expected}`,
      ).toBe(expected);
    }
  });

  it('requires every condition to pass', () => {
    expect(
      evaluateConditions(snapshot, [
        { path: 'client.nda_status', op: 'eq', value: 'pending' },
        { path: 'opportunity.amount', op: 'gt', value: 40000 },
      ]).passed,
    ).toBe(true);

    expect(
      evaluateConditions(snapshot, [
        { path: 'client.nda_status', op: 'eq', value: 'pending' },
        { path: 'opportunity.amount', op: 'gt', value: 50000 },
      ]).passed,
    ).toBe(false);
  });

  it('fails a numeric comparison against a non-numeric value rather than coercing', () => {
    expect(
      evaluateConditions(snapshot, [
        { path: 'client.nda_status', op: 'gt', value: 10 },
      ]).passed,
    ).toBe(false);
  });

  it('passes with no conditions at all', () => {
    expect(evaluateConditions(snapshot, []).passed).toBe(true);
  });
});
