/**
 * Forecasting and delivery profitability.
 *
 * The property under test is the one that makes these numbers trustworthy: an
 * amount that cannot be converted to the base currency is excluded and counted,
 * never silently treated as parity. A total that quietly absorbs an unconverted
 * currency is worse than no total, because it looks the same as a correct one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../helpers/pglite';
import { setDriver, withTenant } from '@/lib/db';
import { createOrgWithAdmin, createCompany, type SeedOrg, type SeedUser } from '../helpers/factories';
import { testContext } from '../helpers/context';
import { getForecast, getProfitability } from '@/lib/services/forecasting';

describe('forecasting', () => {
  let db: TestDatabase;
  let org: SeedOrg;
  let admin: SeedUser;
  let company: { id: string; name: string };
  let projectId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    setDriver(db.driver);

    const a = await createOrgWithAdmin(db.driver, { slug: 'agency-one', name: 'Agency One' });
    org = a.org;
    admin = a.admin;
    company = await createCompany(db.driver, org.id, { name: 'A Client' });

    // Base currency is USD. A EUR rate exists; GBP deliberately has none.
    await db.driver.query(
      `insert into fx_rates (org_id, base_currency, quote_currency, rate, as_of, source)
       values ($1,'EUR','USD',1.10, current_date - 30, 'test')`,
      [org.id],
    );

    const nextMonth = `(date_trunc('month', current_date) + interval '1 month')::date`;

    // Three deals: one USD open, one EUR open (convertible), one GBP (not).
    for (const [amount, currency, probability, stage] of [
      ['100000.00', 'USD', 50, 'proposal_sent'],
      ['100000.00', 'EUR', 100, 'won'],
      ['999999.00', 'GBP', 80, 'negotiation'],
    ] as const) {
      await db.driver.query(
        `insert into opportunities (
           id, org_id, company_id, reference, name, stage, amount, currency,
           probability, expected_close_date, owner_user_id, created_by
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,${nextMonth},$10,$10)`,
        [
          randomUUID(), org.id, company.id, `OPP-${randomUUID().slice(0, 8)}`,
          `${currency} deal`, stage, amount, currency, probability, admin.id,
        ],
      );
    }

    projectId = randomUUID();
    await db.driver.query(
      `insert into projects (id, org_id, company_id, code, name, status, currency,
                             budget_amount, cost_to_date, created_by)
       values ($1,$2,$3,'PRJ-1','Delivery','active','USD','80000.00','30000.00',$4)`,
      [projectId, org.id, company.id, admin.id],
    );

    await db.driver.query(
      `insert into invoices (id, org_id, company_id, project_id, reference, status,
                             currency, subtotal, tax_total, total, amount_paid,
                             issue_date, due_date, created_by)
       values ($1,$2,$3,$4,'INV-1','partially_paid','USD','100000.00',0,'100000.00','40000.00',
               current_date - 10, current_date + 20, $5)`,
      [randomUUID(), org.id, company.id, projectId, admin.id],
    );

    await db.driver.query(
      `insert into tasks (id, org_id, project_id, title, status, estimated_hours,
                          actual_hours, created_by)
       values ($1,$2,$3,'Build','done','100.00','130.00',$4)`,
      [randomUUID(), org.id, projectId, admin.id],
    );
  });

  afterAll(async () => {
    setDriver(null);
    await db.close();
  });

  it('weights open pipeline by probability', async () => {
    const ctx = await testContext(db.driver, admin.id, org.id);
    const forecast = await withTenant({ userId: admin.id, orgId: org.id }, (tx) =>
      getForecast(tx, ctx, { horizon: 3 }),
    );

    // USD 100k at 50% is the only convertible open deal: 50k weighted.
    expect(Number(forecast.totals.weighted)).toBe(50000);
    expect(Number(forecast.totals.open)).toBe(100000);
  });

  it('counts a won deal as committed, not as open', async () => {
    const ctx = await testContext(db.driver, admin.id, org.id);
    const forecast = await withTenant({ userId: admin.id, orgId: org.id }, (tx) =>
      getForecast(tx, ctx, { horizon: 3 }),
    );

    // EUR 100k at 1.10 = 110,000 committed.
    expect(Number(forecast.totals.committed)).toBe(110000);
  });

  it('excludes an unconvertible deal and reports that it did', async () => {
    const ctx = await testContext(db.driver, admin.id, org.id);
    const forecast = await withTenant({ userId: admin.id, orgId: org.id }, (tx) =>
      getForecast(tx, ctx, { horizon: 3 }),
    );

    expect(forecast.unconvertible.count).toBe(1);
    expect(forecast.unconvertible.currencies).toEqual(['GBP']);
    // The GBP amount is nowhere in the totals.
    expect(Number(forecast.totals.open)).toBeLessThan(999999);
  });

  it('returns one row per month of the horizon', async () => {
    const ctx = await testContext(db.driver, admin.id, org.id);
    const forecast = await withTenant({ userId: admin.id, orgId: org.id }, (tx) =>
      getForecast(tx, ctx, { horizon: 6 }),
    );
    expect(forecast.periods).toHaveLength(6);
  });

  it('computes margin from invoiced revenue less recorded cost', async () => {
    const ctx = await testContext(db.driver, admin.id, org.id);
    const report = await withTenant({ userId: admin.id, orgId: org.id }, (tx) =>
      getProfitability(tx, ctx),
    );

    const project = report.projects.find((p) => p.project_id === projectId);
    expect(project).toBeDefined();
    expect(Number(project!.invoiced)).toBe(100000);
    expect(Number(project!.cost_to_date)).toBe(30000);
    expect(Number(project!.margin)).toBe(70000);
    expect(project!.margin_percent).toBe(70);
  });

  it('reports collected separately from invoiced', async () => {
    const ctx = await testContext(db.driver, admin.id, org.id);
    const report = await withTenant({ userId: admin.id, orgId: org.id }, (tx) =>
      getProfitability(tx, ctx),
    );
    const project = report.projects.find((p) => p.project_id === projectId);
    // Invoiced is not cash. 40k of the 100k has actually arrived.
    expect(Number(project!.collected)).toBe(40000);
  });

  it('flags an hours overrun', async () => {
    const ctx = await testContext(db.driver, admin.id, org.id);
    const report = await withTenant({ userId: admin.id, orgId: org.id }, (tx) =>
      getProfitability(tx, ctx),
    );
    const project = report.projects.find((p) => p.project_id === projectId);
    expect(project!.hours_used_percent).toBe(130);
  });

  it('reports margin as null, not zero, when nothing has been invoiced', async () => {
    const empty = randomUUID();
    await db.driver.query(
      `insert into projects (id, org_id, company_id, code, name, status, currency,
                             cost_to_date, created_by)
       values ($1,$2,$3,'PRJ-2','Unbilled','active','USD','5000.00',$4)`,
      [empty, org.id, company.id, admin.id],
    );

    const ctx = await testContext(db.driver, admin.id, org.id);
    const report = await withTenant({ userId: admin.id, orgId: org.id }, (tx) =>
      getProfitability(tx, ctx),
    );

    const project = report.projects.find((p) => p.project_id === empty);
    // -100% would be arithmetically true and completely misleading: the work
    // simply has not been billed yet.
    expect(project!.margin_percent).toBeNull();
  });
});
