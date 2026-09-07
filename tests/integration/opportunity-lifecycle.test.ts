/**
 * The opportunity state machine and its guards.
 *
 * Two things are being proven here:
 *   1. the guards refuse an unqualified advance with a useful error, and
 *   2. the *database* refuses a stage change that bypasses the transition
 *      service entirely — which is what makes the guards more than advice.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/pglite';
import { setDriver, withTenant } from '@/lib/db';
import { createOrgWithAdmin, createCompany, type SeedOrg, type SeedUser } from '../helpers/factories';
import { testContext } from '../helpers/context';
import {
  createOpportunity, transitionOpportunity, captureLead, updateOpportunity,
} from '@/lib/services/opportunities';
import type { RequestContext } from '@/lib/auth/session';

describe('opportunity lifecycle', () => {
  let db: TestDatabase;
  let org: SeedOrg;
  let admin: SeedUser;
  let ctx: RequestContext;
  let companyId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    setDriver(db.driver);
    const seeded = await createOrgWithAdmin(db.driver, { slug: 'pipeline-co' });
    org = seeded.org;
    admin = seeded.admin;
    ctx = await testContext(db.driver, admin.id, org.id);
  });

  beforeEach(async () => {
    const company = await createCompany(db.driver, org.id, {
      name: `Client ${Math.random().toString(36).slice(2, 8)}`,
      ownerUserId: admin.id,
    });
    companyId = company.id;
  });

  afterAll(async () => {
    setDriver(null);
    await db.close();
  });

  const run = <T>(fn: Parameters<typeof withTenant<T>>[1]) =>
    withTenant<T>({ userId: admin.id, orgId: org.id, requestId: 'req_test' }, fn);

  async function newOpportunity(overrides: Record<string, unknown> = {}) {
    return run((tx) =>
      createOpportunity(tx, ctx, {
        company_id: companyId,
        name: 'Website revamp',
        amount: '25000.00',
        probability: 10,
        tags: [],
        ...overrides,
      } as Parameters<typeof createOpportunity>[2]),
    );
  }

  it('allocates a sequential, human-readable reference', async () => {
    const a = await newOpportunity();
    const b = await newOpportunity();
    expect(String(a.reference)).toMatch(/^OPP-\d{6}$/);
    expect(Number(String(b.reference).slice(4))).toBe(Number(String(a.reference).slice(4)) + 1);
  });

  it('refuses to qualify without a business problem, budget and decision maker', async () => {
    const opp = await newOpportunity();

    await expect(
      run((tx) => transitionOpportunity(tx, ctx, opp.id, { to: 'qualified' })),
    ).rejects.toMatchObject({
      code: 'OPPORTUNITY_QUALIFICATION_INCOMPLETE',
      details: { missing: ['business_problem', 'budget_indication', 'decision_maker'] },
    });
  });

  it('qualifies once the evidence is present', async () => {
    const opp = await newOpportunity();
    const contact = await run((tx) =>
      tx.one<{ id: string }>(
        `insert into contacts (org_id, company_id, first_name, last_name, contact_role)
         values ($1,$2,'Dana','Ruiz','decision_maker') returning id`,
        [org.id, companyId],
      ),
    );

    await run((tx) =>
      updateOpportunity(tx, ctx, opp.id, {
        business_problem: 'Inbound conversion has fallen from 4% to 2.1% since the site redesign.',
        budget_indication: '30000.00',
        budget_currency: 'USD',
        decision_maker_contact_id: contact.id,
      }),
    );

    const result = await run((tx) =>
      transitionOpportunity(tx, ctx, opp.id, { to: 'qualified' }),
    );

    expect(result.from).toBe('lead');
    expect(result.to).toBe('qualified');
    expect(result.entity.stage).toBe('qualified');
  });

  it('rejects a stage change made directly with UPDATE', async () => {
    const opp = await newOpportunity();

    await expect(
      run((tx) => tx.query(`update opportunities set stage = 'won' where id = $1`, [opp.id])),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const after = await run((tx) =>
      tx.one<{ stage: string }>('select stage from opportunities where id = $1', [opp.id]),
    );
    expect(after.stage).toBe('lead');
  });

  it('rejects an edge that the machine does not define', async () => {
    const opp = await newOpportunity();
    await expect(
      run((tx) => transitionOpportunity(tx, ctx, opp.id, { to: 'negotiation' })),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('requires a lost reason and records it', async () => {
    const opp = await newOpportunity();

    await expect(
      run((tx) => transitionOpportunity(tx, ctx, opp.id, { to: 'lost', reason: 'Went quiet' })),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const result = await run((tx) =>
      transitionOpportunity(tx, ctx, opp.id, {
        to: 'lost',
        reason: 'Budget was reallocated to a compliance programme.',
        payload: { lost_reason: 'no_budget' },
      }),
    );

    expect(result.entity.stage).toBe('lost');
    expect(result.entity.lost_reason).toBe('no_budget');
    expect(result.entity.probability).toBe(0);
  });

  it('refuses to advance to proposal_sent without an approved proposal', async () => {
    const opp = await qualified();
    await run((tx) => transitionOpportunity(tx, ctx, opp.id, { to: 'discovery' }));
    await run((tx) => transitionOpportunity(tx, ctx, opp.id, { to: 'solution' }));

    await expect(
      run((tx) => transitionOpportunity(tx, ctx, opp.id, { to: 'proposal_sent' })),
    ).rejects.toMatchObject({ code: 'PROPOSAL_NOT_APPROVED' });
  });

  it('refuses to win without an accepted proposal', async () => {
    const opp = await qualified();
    await run((tx) => transitionOpportunity(tx, ctx, opp.id, { to: 'discovery' }));
    await run((tx) => transitionOpportunity(tx, ctx, opp.id, { to: 'solution' }));

    await expect(
      run((tx) => transitionOpportunity(tx, ctx, opp.id, { to: 'won' })),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('parks and restores a dormant opportunity', async () => {
    const opp = await qualified();

    const parked = await run((tx) =>
      transitionOpportunity(tx, ctx, opp.id, {
        to: 'dormant',
        reason: 'Client has paused all new projects until the next budget cycle.',
        payload: { dormant_until: '2027-01-31' },
      }),
    );
    expect(parked.entity.dormant_from_stage).toBe('qualified');

    const revived = await run((tx) =>
      transitionOpportunity(tx, ctx, opp.id, { to: 'qualified' }),
    );
    expect(revived.entity.stage).toBe('qualified');
  });

  it('writes an immutable ledger row for every transition', async () => {
    const opp = await qualified();

    const rows = await run((tx) =>
      tx.many<{ from_state: string; to_state: string; actor_user_id: string }>(
        `select from_state, to_state, actor_user_id from state_transitions
         where entity_type = 'opportunity' and entity_id = $1 order by occurred_at`,
        [opp.id],
      ),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ from_state: 'lead', to_state: 'qualified', actor_user_id: admin.id });

    await expect(
      run((tx) =>
        tx.query(`update state_transitions set to_state = 'won' where entity_id = $1`, [opp.id]),
      ),
    ).rejects.toBeTruthy();
  });

  it('emits an event and a timeline activity for a stage change', async () => {
    const opp = await qualified();

    const events = await run((tx) =>
      tx.many<{ name: string }>(
        `select name from events where entity_id = $1 order by occurred_at`,
        [opp.id],
      ),
    );
    // The qualification helper edits the record before transitioning it, so an
    // `opportunity.updated` event legitimately sits between the two.
    expect(events.map((e) => e.name)).toEqual([
      'opportunity.created',
      'opportunity.updated',
      'opportunity.stage_changed',
    ]);

    const activities = await run((tx) =>
      tx.many<{ title: string }>(
        `select title from activities where entity_id = $1 order by occurred_at`,
        [opp.id],
      ),
    );
    expect(activities.at(-1)?.title).toContain('Lead to Qualified');
  });

  it('creates company, contact and opportunity in one lead-capture transaction', async () => {
    const result = await run((tx) =>
      captureLead(tx, ctx, {
        company: { name: 'Northwind Analytics' },
        contact: {
          first_name: 'Priya',
          last_name: 'Anand',
          email: 'priya@northwind.test',
          contact_role: 'decision_maker',
        },
        opportunity: { amount: '18000.00', source: 'website' },
      } as Parameters<typeof captureLead>[2]),
    );

    expect(result.companyId).toBeTruthy();
    expect(result.contactId).toBeTruthy();
    expect(result.opportunity.stage).toBe('lead');
    expect(result.opportunity.decision_maker_contact_id).toBe(result.contactId);

    // A second enquiry from the same company must not duplicate it.
    const again = await run((tx) =>
      captureLead(tx, ctx, {
        company: { name: 'Northwind Analytics' },
        contact: { first_name: 'Priya', last_name: 'Anand', email: 'priya@northwind.test' },
        opportunity: { amount: '5000.00' },
      } as Parameters<typeof captureLead>[2]),
    );
    expect(again.companyId).toBe(result.companyId);
    expect(again.contactId).toBe(result.contactId);
    expect(again.opportunity.id).not.toBe(result.opportunity.id);
  });

  async function qualified() {
    const opp = await newOpportunity();
    const contact = await run((tx) =>
      tx.one<{ id: string }>(
        `insert into contacts (org_id, company_id, first_name, last_name, contact_role)
         values ($1,$2,'Sam','Okafor','decision_maker') returning id`,
        [org.id, companyId],
      ),
    );
    await run((tx) =>
      updateOpportunity(tx, ctx, opp.id, {
        business_problem: 'Attribution gaps make paid spend impossible to justify.',
        budget_indication: '40000.00',
        budget_currency: 'USD',
        decision_maker_contact_id: contact.id,
      }),
    );
    await run((tx) => transitionOpportunity(tx, ctx, opp.id, { to: 'qualified' }));
    return opp;
  }
});
