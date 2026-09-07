/**
 * The client portal boundary.
 *
 * A portal user is a customer's employee holding a login to a system that also
 * contains every other customer's data, our margins, our internal notes and our
 * AI analysis. These tests are the evidence that the boundary is real: they run
 * as the actual `authenticated` role, through the actual views and functions.
 *
 * Two properties are being defended:
 *
 *   1. A portal user sees their own company and nothing else — not another
 *      client of the same agency, and not another tenant.
 *   2. What they see is a projection, not a filtered table. Cost, margin and
 *      internal notes are absent from the view, so no bug in the application
 *      can select them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../helpers/pglite';
import { setDriver, withTenant } from '@/lib/db';
import { createOrgWithAdmin, createCompany, type SeedOrg, type SeedUser } from '../helpers/factories';

interface PortalPerson {
  userId: string;
  contactId: string;
  portalUserId: string;
}

describe('client portal isolation', () => {
  let db: TestDatabase;
  let org: SeedOrg;
  let admin: SeedUser;
  let acme: { id: string; name: string };
  let rival: { id: string; name: string };
  let otherOrg: SeedOrg;
  let otherCompany: { id: string; name: string };

  // A client of Acme who may see everything their capabilities allow.
  let acmeClient: PortalPerson;
  // A second Acme client with the minimum: documents only.
  let acmeReadOnly: PortalPerson;

  let acmeProject: string;
  let rivalProject: string;
  let acmeDeliverable: string;
  let rivalDeliverable: string;

  /** Creates an auth user, a profile and a portal_users row — and no membership. */
  async function makePortalUser(
    companyId: string,
    orgId: string,
    email: string,
    capabilities: { invoices: boolean; documents: boolean; approve: boolean },
  ): Promise<PortalPerson> {
    const userId = randomUUID();
    const contactId = randomUUID();
    const portalUserId = randomUUID();

    await db.driver.query(
      `insert into auth.users (id, email) values ($1, $2)`, [userId, email],
    );
    await db.driver.query(
      `insert into user_profiles (id, email, full_name, status)
       values ($1, $2, $3, 'active')`,
      [userId, email, email],
    );
    await db.driver.query(
      `insert into contacts (id, org_id, company_id, first_name, last_name, email, contact_role)
       values ($1, $2, $3, 'Test', 'Client', $4, 'champion')`,
      [contactId, orgId, companyId, email],
    );
    await db.driver.query(
      `insert into portal_users (
         id, org_id, company_id, contact_id, user_id, status,
         can_view_invoices, can_view_documents, can_approve_deliverables
       ) values ($1,$2,$3,$4,$5,'active',$6,$7,$8)`,
      [
        portalUserId, orgId, companyId, contactId, userId,
        capabilities.invoices, capabilities.documents, capabilities.approve,
      ],
    );

    return { userId, contactId, portalUserId };
  }

  /** Runs as a portal user. Note there is no membership to name an org with. */
  function asPortal<T>(person: PortalPerson, orgId: string, fn: Parameters<typeof withTenant<T>>[1]) {
    return withTenant<T>({ userId: person.userId, orgId }, fn);
  }

  beforeAll(async () => {
    db = await createTestDatabase();
    setDriver(db.driver);

    const a = await createOrgWithAdmin(db.driver, { slug: 'agency', name: 'The Agency' });
    org = a.org;
    admin = a.admin;

    const b = await createOrgWithAdmin(db.driver, { slug: 'other-agency', name: 'Other Agency' });
    otherOrg = b.org;

    acme = await createCompany(db.driver, org.id, { name: 'Acme Corp' });
    rival = await createCompany(db.driver, org.id, { name: 'Rival Industries' });
    otherCompany = await createCompany(db.driver, otherOrg.id, { name: 'Someone Else' });

    acmeClient = await makePortalUser(acme.id, org.id, 'client@acme.test', {
      invoices: true, documents: true, approve: true,
    });
    acmeReadOnly = await makePortalUser(acme.id, org.id, 'readonly@acme.test', {
      invoices: false, documents: true, approve: false,
    });

    // Projects and deliverables for both clients, so "sees their own" has
    // something to be distinguished from.
    acmeProject = randomUUID();
    rivalProject = randomUUID();
    for (const [id, companyId, name] of [
      [acmeProject, acme.id, 'Acme Rebuild'],
      [rivalProject, rival.id, 'Rival Rebuild'],
    ] as const) {
      await db.driver.query(
        `insert into projects (id, org_id, company_id, code, name, status, currency, created_by)
         values ($1,$2,$3,$4,$5,'active','USD',$6)`,
        [id, org.id, companyId, `PRJ-${name.slice(0, 3).toUpperCase()}`, name, admin.id],
      );
    }

    acmeDeliverable = randomUUID();
    rivalDeliverable = randomUUID();
    for (const [id, projectId, name] of [
      [acmeDeliverable, acmeProject, 'Acme Brand Guide'],
      [rivalDeliverable, rivalProject, 'Rival Brand Guide'],
    ] as const) {
      await db.driver.query(
        `insert into deliverables (id, org_id, project_id, name, status, is_client_visible)
         values ($1,$2,$3,$4,'delivered', true)`,
        [id, org.id, projectId, name],
      );
    }
  });

  afterAll(async () => {
    setDriver(null);
    await db.close();
  });

  // ---------------------------------------------------------------- identity

  it('gives a portal user no organisation membership', async () => {
    // The whole separation rests on this. A membership would make them an
    // internal user with an empty permission set rather than a client.
    const rows = await db.driver.query(
      `select 1 from org_memberships where user_id = $1`,
      [acmeClient.userId],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it('resolves exactly one company for a portal user', async () => {
    const companies = await asPortal<string[]>(acmeClient, org.id, async (tx) => {
      const row = await tx.one<{ ids: string[] }>(`select app.portal_company_ids() as ids`);
      return row.ids;
    });
    expect(companies).toEqual([acme.id]);
  });

  // ------------------------------------------------------------- projections

  it('shows a portal user only their own company', async () => {
    const rows = await asPortal(acmeClient, org.id, (tx) =>
      tx.many<{ id: string; name: string }>(`select id, name from portal.companies`),
    );
    expect(rows.map((r) => r.name)).toEqual(['Acme Corp']);
  });

  it('hides another client of the same agency', async () => {
    const rows = await asPortal(acmeClient, org.id, (tx) =>
      tx.many<{ id: string }>(`select id from portal.projects`),
    );
    expect(rows.map((r) => r.id)).toEqual([acmeProject]);
    expect(rows.map((r) => r.id)).not.toContain(rivalProject);
  });

  it('hides another tenant entirely', async () => {
    const rows = await asPortal(acmeClient, org.id, (tx) =>
      tx.many<{ id: string }>(`select id from portal.companies where id = $1`, [otherCompany.id]),
    );
    expect(rows).toHaveLength(0);
  });

  it('cannot reach a rival by naming its id directly', async () => {
    // The view has no row to return; there is nothing to filter incorrectly.
    const rows = await asPortal(acmeClient, org.id, (tx) =>
      tx.many<{ id: string }>(`select id from portal.projects where id = $1`, [rivalProject]),
    );
    expect(rows).toHaveLength(0);
  });

  it('excludes cost and margin from the projection as columns, not as filters', async () => {
    // Asserted against the catalogue rather than by watching a query fail:
    // absence of the column is the property, and it holds whether or not any
    // particular SELECT happens to be written today.
    const columns = await db.driver.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'portal' and table_name = 'projects'`,
    );
    const names = columns.rows.map((r) => r.column_name);

    expect(names).toContain('name');
    for (const forbidden of ['margin_percent', 'cost_total', 'internal_notes', 'budget_amount']) {
      expect(names, `portal.projects must not expose ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('refuses a portal user access to the underlying public tables', async () => {
    // RLS on public.projects has no policy that a non-member satisfies.
    const rows = await asPortal(acmeClient, org.id, (tx) =>
      tx.many<{ id: string }>(`select id from projects`),
    );
    expect(rows).toHaveLength(0);
  });

  // ------------------------------------------------------------ capabilities

  it('reports capabilities from portal_users, not from the request', async () => {
    // Sequential, not Promise.all: PGlite is a single connection, so two
    // overlapping transactions interleave and the second `set_config` replaces
    // the first one's identity mid-flight. The failure looks like a broken
    // permission check and is nothing of the kind.
    const canApprove = await asPortal<boolean>(acmeClient, org.id, async (tx) =>
      (await tx.one<{ ok: boolean }>(`select app.portal_can($1,'approve_deliverables') as ok`, [acme.id])).ok,
    );
    const cannotApprove = await asPortal<boolean>(acmeReadOnly, org.id, async (tx) =>
      (await tx.one<{ ok: boolean }>(`select app.portal_can($1,'approve_deliverables') as ok`, [acme.id])).ok,
    );
    expect(canApprove).toBe(true);
    expect(cannotApprove).toBe(false);
  });

  it('rejects an unknown capability rather than defaulting to allow', async () => {
    await expect(
      asPortal(acmeClient, org.id, (tx) =>
        tx.one(`select app.portal_can($1,'view_everything') as ok`, [acme.id]),
      ),
    ).rejects.toThrow(/Unknown portal capability/);
  });

  it('reports no capability at all for another client', async () => {
    const ok = await asPortal<boolean>(acmeClient, org.id, async (tx) =>
      (await tx.one<{ ok: boolean }>(`select app.portal_can($1,'view_documents') as ok`, [rival.id])).ok,
    );
    expect(ok).toBe(false);
  });

  // ------------------------------------------------------------- deliverables

  it('lets an entitled client accept their own deliverable', async () => {
    const result = await asPortal<{ status: string }>(acmeClient, org.id, async (tx) => {
      const row = await tx.one<{ result: { status: string } }>(
        `select app.portal_decide_deliverable($1,'accepted',null) as result`,
        [acmeDeliverable],
      );
      return row.result;
    });
    expect(result.status).toBe('accepted');

    const stored = await db.driver.query<{ status: string; accepted_by_contact_id: string }>(
      `select status, accepted_by_contact_id from deliverables where id = $1`,
      [acmeDeliverable],
    );
    expect(stored.rows[0]?.status).toBe('accepted');
    // Attributed to the contact, resolved from the session rather than supplied.
    expect(stored.rows[0]?.accepted_by_contact_id).toBe(acmeClient.contactId);
  });

  it('records the decision on the client-visible timeline, as a portal actor', async () => {
    const rows = await db.driver.query<{ actor_type: string; is_internal: boolean }>(
      `select actor_type, is_internal from activities
        where entity_id = $1 and entity_type = 'deliverable'`,
      [acmeDeliverable],
    );
    expect(rows.rows[0]?.actor_type).toBe('portal_user');
    expect(rows.rows[0]?.is_internal).toBe(false);
  });

  it('refuses a client without the capability', async () => {
    const fresh = randomUUID();
    await db.driver.query(
      `insert into deliverables (id, org_id, project_id, name, status, is_client_visible)
       values ($1,$2,$3,'Second Guide','delivered',true)`,
      [fresh, org.id, acmeProject],
    );

    await expect(
      asPortal(acmeReadOnly, org.id, (tx) =>
        tx.one(`select app.portal_decide_deliverable($1,'accepted',null)`, [fresh]),
      ),
    ).rejects.toThrow(/No such deliverable/);
  });

  it("refuses another client's deliverable, and says only that it does not exist", async () => {
    // The message must not distinguish "not yours" from "not there": the
    // difference is itself information about a client you cannot see.
    await expect(
      asPortal(acmeClient, org.id, (tx) =>
        tx.one(`select app.portal_decide_deliverable($1,'accepted',null)`, [rivalDeliverable]),
      ),
    ).rejects.toThrow(/No such deliverable/);

    const untouched = await db.driver.query<{ status: string }>(
      `select status from deliverables where id = $1`,
      [rivalDeliverable],
    );
    expect(untouched.rows[0]?.status).toBe('delivered');
  });

  it('refuses a deliverable that is not awaiting a decision', async () => {
    const draft = randomUUID();
    await db.driver.query(
      `insert into deliverables (id, org_id, project_id, name, status, is_client_visible)
       values ($1,$2,$3,'Not Ready','pending',true)`,
      [draft, org.id, acmeProject],
    );

    await expect(
      asPortal(acmeClient, org.id, (tx) =>
        tx.one(`select app.portal_decide_deliverable($1,'accepted',null)`, [draft]),
      ),
    ).rejects.toThrow(/not awaiting a decision/);
  });

  it('requires a reason for a rejection', async () => {
    const item = randomUUID();
    await db.driver.query(
      `insert into deliverables (id, org_id, project_id, name, status, is_client_visible)
       values ($1,$2,$3,'Needs Work','delivered',true)`,
      [item, org.id, acmeProject],
    );

    await expect(
      asPortal(acmeClient, org.id, (tx) =>
        tx.one(`select app.portal_decide_deliverable($1,'rejected','   ')`, [item]),
      ),
    ).rejects.toThrow(/must say why/);

    const stored = await db.driver.query<{ status: string }>(
      `select status from deliverables where id = $1`, [item],
    );
    expect(stored.rows[0]?.status).toBe('delivered');
  });

  it('rejects an invalid decision value outright', async () => {
    await expect(
      asPortal(acmeClient, org.id, (tx) =>
        tx.one(`select app.portal_decide_deliverable($1,'approved',null)`, [acmeDeliverable]),
      ),
    ).rejects.toThrow(/must be accepted or rejected/);
  });

  // ----------------------------------------------------------------- writes

  it('cannot write to a portal view', async () => {
    await expect(
      asPortal(acmeClient, org.id, (tx) =>
        tx.query(`update portal.projects set name = 'Renamed' where id = $1`, [acmeProject]),
      ),
    ).rejects.toThrow();
  });

  it('cannot update a public table directly', async () => {
    await asPortal(acmeClient, org.id, (tx) =>
      tx.query(`update deliverables set status = 'accepted' where id = $1`, [rivalDeliverable]),
    );

    const stored = await db.driver.query<{ status: string }>(
      `select status from deliverables where id = $1`, [rivalDeliverable],
    );
    // The policy matched no rows rather than raising: the write is a no-op.
    expect(stored.rows[0]?.status).toBe('delivered');
  });

  it('cannot grant itself access by inserting a portal_users row', async () => {
    await expect(
      asPortal(acmeClient, org.id, (tx) =>
        tx.query(
          `insert into portal_users (org_id, company_id, contact_id, user_id, status)
           values ($1,$2,$3,$4,'active')`,
          [org.id, rival.id, acmeClient.contactId, acmeClient.userId],
        ),
      ),
    ).rejects.toThrow();
  });

  it('cannot grant portal access to itself through the admin function', async () => {
    // The function checks `company:update`, which a portal user cannot hold —
    // they have no membership through which to hold anything.
    await expect(
      asPortal(acmeClient, org.id, (tx) =>
        tx.one(`select app.grant_portal_access($1,$2,true,true,true)`, [
          acmeClient.contactId,
          acmeClient.userId,
        ]),
      ),
    ).rejects.toThrow(/Not permitted/);
  });
});
