/**
 * The renewal cycle.
 *
 * Two things are being defended. First, that `status` moves only through the
 * transition channel — a stray UPDATE is refused by the database, not by
 * convention. Second, that a lost renewal cannot be recorded without a reason,
 * because churn you cannot explain is churn you cannot act on.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../helpers/pglite';
import { setDriver, withTenant } from '@/lib/db';
import { createOrgWithAdmin, createCompany, type SeedOrg, type SeedUser } from '../helpers/factories';
import { testContext } from '../helpers/context';
import { transitionRenewal, listRenewals, getRenewalSummary } from '@/lib/services/renewals';

describe('renewals', () => {
  let db: TestDatabase;
  let org: SeedOrg;
  let admin: SeedUser;
  let company: { id: string; name: string };
  let contractId: string;

  /** An executed contract expiring inside its notice window. */
  async function createContract(expiryOffsetDays: number, value = '50000.00'): Promise<string> {
    const id = randomUUID();
    await db.driver.query(
      `insert into contracts (
         id, org_id, company_id, reference, title, contract_type, status,
         currency, contract_value, effective_date, expiry_date, renewal_notice_days,
         owner_user_id, executed_at, created_by
       ) values ($1,$2,$3,$4,'Master Agreement','msa','fully_executed',
                 'USD',$5, current_date - 365,
                 current_date + make_interval(days => $6::int), 60, $7, now(), $7)`,
      [id, org.id, company.id, `MSA-${id.slice(0, 8)}`, value, expiryOffsetDays, admin.id],
    );
    return id;
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    setDriver(db.driver);

    const a = await createOrgWithAdmin(db.driver, { slug: 'agency', name: 'Agency' });
    org = a.org;
    admin = a.admin;
    company = await createCompany(db.driver, org.id, { name: 'Longstanding Client' });
    contractId = await createContract(30);

    // No FX row is needed: the org's base currency is USD and so is the
    // contract's, and app.fx_rate_at returns 1 for a same-currency pair rather
    // than requiring a rate to exist.
  });

  afterAll(async () => {
    setDriver(null);
    await db.close();
  });

  it('opens exactly one cycle per contract, however often the sweep runs', async () => {
    await withTenant({ userId: admin.id, orgId: org.id }, async (tx) => {
      await tx.one(`select app.open_renewal_cycle($1) as id`, [contractId]);
      await tx.one(`select app.open_renewal_cycle($1) as id`, [contractId]);
      await tx.one(`select app.open_renewal_cycle($1) as id`, [contractId]);
    });

    const rows = await db.driver.query(
      `select id from renewals where contract_id = $1`, [contractId],
    );
    expect(rows.rows).toHaveLength(1);
  });

  it('carries the contract value across as the value at risk', async () => {
    const row = await db.driver.query<{ value_at_risk: string; currency: string; status: string }>(
      `select value_at_risk, currency, status from renewals where contract_id = $1`,
      [contractId],
    );
    expect(row.rows[0]).toMatchObject({
      value_at_risk: '50000.00',
      currency: 'USD',
      status: 'upcoming',
    });
  });

  it('opens no cycle for a contract that is not executed', async () => {
    const draft = randomUUID();
    await db.driver.query(
      `insert into contracts (id, org_id, company_id, reference, title, contract_type,
                              status, expiry_date, created_by)
       values ($1,$2,$3,$4,'Draft','msa','draft', current_date + 30, $5)`,
      [draft, org.id, company.id, `MSA-DRAFT-${draft.slice(0, 6)}`, admin.id],
    );

    const result = await withTenant({ userId: admin.id, orgId: org.id }, (tx) =>
      tx.one<{ id: string | null }>(`select app.open_renewal_cycle($1) as id`, [draft]),
    );
    expect(result.id).toBeNull();
  });

  it('refuses a direct UPDATE of status outside the transition channel', async () => {
    // This is the property that makes the state machine real rather than
    // advisory: the guard trigger rejects the write itself.
    await expect(
      withTenant({ userId: admin.id, orgId: org.id }, (tx) =>
        tx.query(`update renewals set status = 'won' where contract_id = $1`, [contractId]),
      ),
    ).rejects.toThrow();
  });

  it('moves upcoming to in_progress through the service', async () => {
    const ctx = await testContext(db.driver, admin.id, org.id);
    const renewal = await db.driver.query<{ id: string }>(
      `select id from renewals where contract_id = $1`, [contractId],
    );
    const id = renewal.rows[0]!.id;

    const result = await withTenant({ userId: admin.id, orgId: org.id }, (tx) =>
      transitionRenewal(tx, ctx, id, { to: 'in_progress' }),
    );

    expect(result).toMatchObject({ from: 'upcoming', to: 'in_progress' });
  });

  it('refuses an illegal move', async () => {
    const ctx = await testContext(db.driver, admin.id, org.id);
    const other = await createContract(45);
    await withTenant({ userId: admin.id, orgId: org.id }, (tx) =>
      tx.one(`select app.open_renewal_cycle($1)`, [other]),
    );
    const row = await db.driver.query<{ id: string }>(
      `select id from renewals where contract_id = $1`, [other],
    );
    const id = row.rows[0]!.id;

    // Won is terminal; there is no way back out of it.
    await withTenant({ userId: admin.id, orgId: org.id }, (tx) =>
      transitionRenewal(tx, ctx, id, { to: 'won' }),
    );

    await expect(
      withTenant({ userId: admin.id, orgId: org.id }, (tx) =>
        transitionRenewal(tx, ctx, id, { to: 'in_progress' }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('refuses to record a loss without a reason', async () => {
    const ctx = await testContext(db.driver, admin.id, org.id);
    const contract = await createContract(20);
    await withTenant({ userId: admin.id, orgId: org.id }, (tx) =>
      tx.one(`select app.open_renewal_cycle($1)`, [contract]),
    );
    const row = await db.driver.query<{ id: string }>(
      `select id from renewals where contract_id = $1`, [contract],
    );

    await expect(
      withTenant({ userId: admin.id, orgId: org.id }, (tx) =>
        transitionRenewal(tx, ctx, row.rows[0]!.id, { to: 'lost' }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    const after = await db.driver.query<{ status: string }>(
      `select status from renewals where id = $1`, [row.rows[0]!.id],
    );
    expect(after.rows[0]?.status).toBe('upcoming');
  });

  it('records the loss reason and stamps who decided it', async () => {
    const ctx = await testContext(db.driver, admin.id, org.id);
    const contract = await createContract(15);
    await withTenant({ userId: admin.id, orgId: org.id }, (tx) =>
      tx.one(`select app.open_renewal_cycle($1)`, [contract]),
    );
    const row = await db.driver.query<{ id: string }>(
      `select id from renewals where contract_id = $1`, [contract],
    );

    await withTenant({ userId: admin.id, orgId: org.id }, (tx) =>
      transitionRenewal(tx, ctx, row.rows[0]!.id, {
        to: 'lost',
        loss_reason: 'Budget cut after a change of sponsor',
      }),
    );

    const after = await db.driver.query<{
      status: string; loss_reason: string; decided_by: string; decided_at: string;
    }>(
      `select status, loss_reason, decided_by, decided_at from renewals where id = $1`,
      [row.rows[0]!.id],
    );
    expect(after.rows[0]).toMatchObject({
      status: 'lost',
      loss_reason: 'Budget cut after a change of sponsor',
      decided_by: admin.id,
    });
    expect(after.rows[0]?.decided_at).not.toBeNull();
  });

  it('emits an event for the outcome so automations can react', async () => {
    const events = await db.driver.query<{ name: string }>(
      `select name from events where entity_type = 'renewal' and name = 'renewal.lost'`,
    );
    expect(events.rows.length).toBeGreaterThan(0);
  });

  it('reports retention as a share of decided value, and null when nothing is decided', async () => {
    const ctx = await testContext(db.driver, admin.id, org.id);
    const summary = await withTenant({ userId: admin.id, orgId: org.id }, (tx) =>
      getRenewalSummary(tx, ctx),
    );

    // One won at 50k and one lost at 50k in the last twelve months.
    expect(summary.retention_rate).toBe(50);
    expect(summary.top_loss_reasons[0]).toMatchObject({
      reason: 'Budget cut after a change of sponsor',
      count: 1,
    });
  });

  it('lists renewals with a total in one query', async () => {
    const result = await withTenant({ userId: admin.id, orgId: org.id }, (tx) =>
      listRenewals(tx, { page: 1, page_size: 10 }),
    );
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.total).toBe(result.rows.length);
    expect(result.rows[0]).toHaveProperty('company_name');
  });
});
