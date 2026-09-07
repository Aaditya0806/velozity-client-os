/**
 * The seed must actually run.
 *
 * Seed data that has drifted from the schema is worse than none: it fails at the
 * moment a new developer first tries the project. This test runs it against a
 * fresh database and checks the result is coherent, not merely that it did not
 * throw.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/pglite';
import { setDriver, withTenant } from '@/lib/db';
import { seed } from '@/supabase/seed/seed';
import { testContext } from '../helpers/context';
import { listOpportunities } from '@/lib/services/opportunities';
import { getClientOverview } from '@/lib/services/client360';

describe('seed data', () => {
  let db: TestDatabase;
  let result: Awaited<ReturnType<typeof seed>>;

  beforeAll(async () => {
    db = await createTestDatabase();
    setDriver(db.driver);
    result = await seed(db.driver);
  });

  afterAll(async () => {
    setDriver(null);
    await db.close();
  });

  it('creates one demo organisation, marked as demo', async () => {
    const orgs = await db.driver.query<{ id: string; is_demo: boolean; slug: string }>(
      'select id, is_demo, slug from organizations',
    );
    expect(orgs.rows).toHaveLength(1);
    expect(orgs.rows[0]?.is_demo).toBe(true);
    expect(orgs.rows[0]?.slug).toBe('velozity-demo');
  });

  it('creates every role with a real person in it', async () => {
    const rows = await db.driver.query<{ role: string; people: string }>(
      `select r.key as role, count(*)::text as people
       from user_roles ur join roles r on r.id = ur.role_id
       where ur.org_id = $1 group by r.key order by r.key`,
      [result.orgId],
    );
    const roles = rows.rows.map((r) => r.role).sort();
    expect(roles).toEqual([
      'delivery', 'finance', 'legal_admin', 'management',
      'project_manager', 'sales', 'super_admin',
    ]);
  });

  it('marks every seeded row as demo data', async () => {
    for (const table of ['companies', 'contacts', 'opportunities', 'services', 'user_profiles']) {
      const rows = await db.driver.query<{ c: number }>(
        `select count(*)::int as c from ${table} where not is_demo`,
      );
      expect(rows.rows[0]?.c, `${table} has non-demo rows`).toBe(0);
    }
  });

  it('produces an opportunity in every pipeline stage worth showing', async () => {
    const rows = await db.driver.query<{ stage: string }>(
      `select distinct stage from opportunities where org_id = $1 order by stage`,
      [result.orgId],
    );
    const stages = rows.rows.map((r) => r.stage);
    for (const stage of ['lead', 'qualified', 'discovery', 'diagnosis', 'solution', 'won', 'lost', 'dormant']) {
      expect(stages, `missing a deal in stage ${stage}`).toContain(stage);
    }
  });

  it('gives every service a delivery plan, KPIs and required documents', async () => {
    for (const serviceId of result.serviceIds) {
      const counts = await db.driver.query<{ tasks: number; kpis: number; documents: number }>(
        `select
           (select count(*)::int from service_default_tasks where service_id = $1) as tasks,
           (select count(*)::int from service_default_kpis where service_id = $1) as kpis,
           (select count(*)::int from service_required_documents where service_id = $1) as documents`,
        [serviceId],
      );
      expect(counts.rows[0]!.tasks).toBeGreaterThan(0);
      expect(counts.rows[0]!.kpis).toBeGreaterThan(0);
      expect(counts.rows[0]!.documents).toBeGreaterThan(0);
    }
  });

  it('ships active contract templates whose placeholders are all declared', async () => {
    const { validateTemplate } = await import('@/lib/contracts/renderer');

    const versions = await db.driver.query<{ body: string; variables: unknown }>(
      `select body, variables from contract_template_versions where status = 'active'`,
    );
    expect(versions.rows.length).toBeGreaterThan(0);

    for (const version of versions.rows) {
      const variables = (version.variables as Array<{
        key: string; label: string; type: 'string' | 'number' | 'date' | 'money' | 'multiline'; required: boolean;
      }>).map((v) => ({ ...v, required: v.required !== false }));

      const { errors } = validateTemplate(version.body, variables);
      expect(errors, `template has undeclared placeholders: ${errors.join('; ')}`).toEqual([]);
    }
  });

  it('loads FX rates so base-currency reporting has something to work with', async () => {
    const rates = await db.driver.query<{ c: number }>('select count(*)::int as c from fx_rates');
    expect(rates.rows[0]!.c).toBeGreaterThan(0);
  });

  it('produces a pipeline a salesperson can actually read', async () => {
    const ctx = await testContext(db.driver, result.users.sales!.id, result.orgId);
    const rows = await withTenant(
      { userId: result.users.sales!.id, orgId: result.orgId },
      (tx) =>
        listOpportunities(tx, ctx, {
          page: 1, page_size: 50, sort: 'updated_at', direction: 'desc',
        } as Parameters<typeof listOpportunities>[2]),
      { readOnly: true },
    );
    expect(rows.rows.length).toBeGreaterThan(0);
  });

  it('produces a Client 360 that renders for a manager', async () => {
    const ctx = await testContext(db.driver, result.users.management!.id, result.orgId);
    const overview = await withTenant(
      { userId: result.users.management!.id, orgId: result.orgId },
      (tx) => getClientOverview(tx, ctx, result.companies.northwind!),
      { readOnly: true },
    );

    expect(overview.company.name).toBe('Northwind Analytics');
    expect(overview.contacts.length).toBeGreaterThan(0);
    expect(overview.pipeline.won_count).toBe('1');
  });

  it('models a multi-entity client group', async () => {
    const ctx = await testContext(db.driver, result.users.management!.id, result.orgId);
    const overview = await withTenant(
      { userId: result.users.management!.id, orgId: result.orgId },
      (tx) => getClientOverview(tx, ctx, result.companies.meridian!),
      { readOnly: true },
    );
    // The parent plus its subsidiary.
    expect(overview.group_company_ids.length).toBe(2);
  });

  it('ships automations that are data, with no send action anywhere', async () => {
    const rows = await db.driver.query<{ actions: unknown }>(
      `select actions from automations where org_id = $1`,
      [result.orgId],
    );
    expect(rows.rows.length).toBeGreaterThan(0);

    const { actionSchema } = await import('@/lib/automation/actions');
    for (const row of rows.rows) {
      const actions = row.actions as Array<{ type: string }>;
      for (const action of actions) {
        expect(actionSchema.safeParse(action).success, `invalid seeded action ${action.type}`).toBe(true);
        expect(action.type).not.toBe('send_email');
        expect(action.type).not.toBe('send_contract');
      }
    }
  });
});
