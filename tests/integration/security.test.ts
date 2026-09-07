/**
 * Security tests.
 *
 * One test per attack the specification names. These are not smoke tests: each
 * one performs the attack and asserts it fails, so a regression that reopens the
 * hole breaks the build rather than shipping.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '../helpers/pglite';
import { setDriver, withTenant, withService, type Tx } from '@/lib/db';
import {
  createOrgWithAdmin, createUserWithRole, createCompany, createTeam, addToTeam,
  type SeedOrg, type SeedUser,
} from '../helpers/factories';
import { testContext } from '../helpers/context';
import type { RequestContext } from '@/lib/auth/session';
import { AppError } from '@/lib/http/errors';

describe('cross-tenant access', () => {
  let db: TestDatabase;
  let orgA: SeedOrg;
  let orgB: SeedOrg;
  let adminA: SeedUser;
  let adminB: SeedUser;
  let secretsOfB: { companyId: string; contractId: string; documentId: string };

  beforeAll(async () => {
    db = await createTestDatabase();
    setDriver(db.driver);

    const a = await createOrgWithAdmin(db.driver, { slug: 'tenant-a' });
    const b = await createOrgWithAdmin(db.driver, { slug: 'tenant-b' });
    orgA = a.org;
    adminA = a.admin;
    orgB = b.org;
    adminB = b.admin;

    const company = await createCompany(db.driver, orgB.id, { name: 'B Confidential Ltd' });

    const contract = await db.driver.query<{ id: string }>(
      `insert into contracts (org_id, company_id, reference, title, contract_type,
                              currency, contract_value, internal_notes, created_by)
       values ($1,$2,'MSA-B-0001','Tenant B agreement','msa','USD','500000.00',
               'B is negotiating hard on price', $3)
       returning id`,
      [orgB.id, company.id, adminB.id],
    );

    const document = await db.driver.query<{ id: string }>(
      `insert into documents (org_id, company_id, category, name, created_by)
       values ($1,$2,'contract','B secret agreement.pdf',$3) returning id`,
      [orgB.id, company.id, adminB.id],
    );

    secretsOfB = {
      companyId: company.id,
      contractId: contract.rows[0]!.id,
      documentId: document.rows[0]!.id,
    };
  });

  afterAll(async () => {
    setDriver(null);
    await db.close();
  });

  const asA = <T>(fn: (tx: Tx) => Promise<T>, orgId = orgA.id) =>
    withTenant<T>({ userId: adminA.id, orgId }, fn);

  it('cannot read another tenant\'s companies, contracts or documents by id', async () => {
    for (const [table, id] of [
      ['companies', secretsOfB.companyId],
      ['contracts', secretsOfB.contractId],
      ['documents', secretsOfB.documentId],
    ] as const) {
      const rows = await asA((tx) => tx.many(`select id from ${table} where id = $1`, [id]));
      expect(rows, `leaked a row from ${table}`).toHaveLength(0);
    }
  });

  it('cannot read another tenant\'s data by presenting their organisation id', async () => {
    const rows = await asA((tx) => tx.many('select id from companies'), orgB.id);
    expect(rows).toHaveLength(0);
  });

  it('cannot escape its tenant through a join', async () => {
    // A join is the classic way to reach around a row filter. RLS applies to
    // every table in the query, so the joined rows are filtered too.
    const rows = await asA((tx) =>
      tx.many(
        `select c.id, co.name from contracts c
         join companies co on co.id = c.company_id`,
      ),
    );
    expect(rows).toHaveLength(0);
  });

  it('cannot reach another tenant through a subquery or aggregate', async () => {
    const row = await asA((tx) =>
      tx.one<{ total: string; leaked: string | null }>(
        `select count(*)::text as total,
                (select max(title) from contracts) as leaked
         from contracts`,
      ),
    );
    expect(row.total).toBe('0');
    expect(row.leaked).toBeNull();
  });

  it('cannot update another tenant\'s rows', async () => {
    await asA(async (tx) => {
      const res = await tx.query(
        `update contracts set title = 'Owned' where id = $1`,
        [secretsOfB.contractId],
      );
      expect(res.rowCount).toBe(0);
    });

    const unchanged = await withService('verify', (tx) =>
      tx.one<{ title: string }>('select title from contracts where id = $1', [
        secretsOfB.contractId,
      ]),
    );
    expect(unchanged.title).toBe('Tenant B agreement');
  });

  it('cannot delete another tenant\'s rows', async () => {
    await asA(async (tx) => {
      const res = await tx.query('delete from companies where id = $1', [secretsOfB.companyId]);
      expect(res.rowCount).toBe(0);
    });
  });

  it('cannot smuggle a row into another tenant', async () => {
    await expect(
      asA((tx) =>
        tx.query(
          `insert into companies (org_id, name, currency) values ($1,'Trojan','USD')`,
          [orgB.id],
        ),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('cannot read another tenant\'s audit log or event stream', async () => {
    await withService('seed audit', (tx) =>
      tx.query(
        `insert into audit_log (org_id, action, category, summary)
         values ($1,'secret.action','admin','Tenant B did something')`,
        [orgB.id],
      ),
    );

    const audit = await asA((tx) => tx.many('select id from audit_log'));
    expect(audit).toHaveLength(0);
  });
});

describe('privilege escalation', () => {
  let db: TestDatabase;
  let org: SeedOrg;
  let admin: SeedUser;
  let sales: SeedUser;
  let salesCtx: RequestContext;

  beforeAll(async () => {
    db = await createTestDatabase();
    setDriver(db.driver);
    const seeded = await createOrgWithAdmin(db.driver, { slug: 'escalation-co' });
    org = seeded.org;
    admin = seeded.admin;
    sales = await createUserWithRole(db.driver, org.id, 'sales', { email: 'esc@x.test' });
    salesCtx = await testContext(db.driver, sales.id, org.id);
  });

  afterAll(async () => {
    setDriver(null);
    await db.close();
  });

  const asSales = <T>(fn: (tx: Tx) => Promise<T>) =>
    withTenant<T>({ userId: sales.id, orgId: org.id }, fn);

  it('cannot grant itself a role', async () => {
    const superAdmin = await db.driver.query<{ id: string }>(
      `select id from roles where key = 'super_admin' and org_id is null`,
    );

    await expect(
      asSales((tx) =>
        tx.query(
          `insert into user_roles (org_id, user_id, role_id) values ($1,$2,$3)`,
          [org.id, sales.id, superAdmin.rows[0]!.id],
        ),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('cannot add permissions to a role it already holds', async () => {
    const salesRole = await db.driver.query<{ id: string }>(
      `select id from roles where key = 'sales' and org_id is null`,
    );
    const permission = await db.driver.query<{ id: string }>(
      `select id from permissions where key = 'legal:override:org'`,
    );

    await expect(
      asSales((tx) =>
        tx.query(
          `insert into role_permissions (role_id, permission_id) values ($1,$2)`,
          [salesRole.rows[0]!.id, permission.rows[0]!.id],
        ),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('cannot invent a new permission', async () => {
    await expect(
      asSales((tx) =>
        tx.query(
          `insert into permissions (key, resource, action, scope)
           values ('everything:do:org','everything','do','org')`,
        ),
      ),
    ).rejects.toBeTruthy();
  });

  it('cannot promote itself to organisation owner', async () => {
    await asSales(async (tx) => {
      const res = await tx.query(
        `update org_memberships set is_owner = true where user_id = $1`,
        [sales.id],
      );
      expect(res.rowCount).toBe(0);
    });
  });

  it('cannot bypass a permission check by calling the service directly', async () => {
    const { overrideLegalGate } = await import('@/lib/services/onboarding');
    const company = await createCompany(db.driver, org.id, { name: 'Escalation Client' });

    const onboarding = await db.driver.query<{ id: string }>(
      `insert into onboardings (org_id, company_id, created_by) values ($1,$2,$3) returning id`,
      [org.id, company.id, admin.id],
    );

    await expect(
      asSales((tx) =>
        overrideLegalGate(
          tx,
          salesCtx,
          onboarding.rows[0]!.id,
          'I would like to start delivery now without waiting for the paperwork.',
        ),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('cannot forge a permission set to satisfy the service layer', async () => {
    const { overrideLegalGate } = await import('@/lib/services/onboarding');
    const { buildPermissionSet } = await import('@/lib/permissions');

    const company = await createCompany(db.driver, org.id, { name: 'Forged Client' });
    const onboarding = await db.driver.query<{ id: string }>(
      `insert into onboardings (org_id, company_id, created_by) values ($1,$2,$3) returning id`,
      [org.id, company.id, admin.id],
    );

    // A caller who fabricates a context holding every permission gets past the
    // application check. It does not matter: the database resolves permissions
    // from user_roles and never trusts anything passed in from above, so the
    // onboarding is not even visible to this user and the override cannot land.
    //
    // This is the whole point of enforcing rules twice. The application check
    // exists to give a good error message; the database check is what makes the
    // rule true.
    const forged: RequestContext = {
      ...salesCtx,
      permissions: buildPermissionSet(['legal:override:org']),
    };

    await expect(
      asSales((tx) =>
        overrideLegalGate(
          tx,
          forged,
          onboarding.rows[0]!.id,
          'Attempting to override the gate with a fabricated permission set.',
        ),
      ),
    ).rejects.toBeTruthy();

    // Nothing was overridden and no evidence row was written.
    const after = await withService('verify', (tx) =>
      tx.one<{ legal_override_active: boolean }>(
        'select legal_override_active from onboardings where id = $1',
        [onboarding.rows[0]!.id],
      ),
    );
    expect(after.legal_override_active).toBe(false);

    const overrides = await withService('verify', (tx) =>
      tx.many('select id from legal_overrides where onboarding_id = $1', [onboarding.rows[0]!.id]),
    );
    expect(overrides).toHaveLength(0);
  });

  it('stops a direct status write even from a user who may edit the row', async () => {
    // Sales cannot edit contracts at all, so grant a context that can, to prove
    // the transition-channel guard is what stops the write rather than mere row
    // invisibility.
    const company = await createCompany(db.driver, org.id, { name: 'Channel Client' });
    const contract = await db.driver.query<{ id: string }>(
      `insert into contracts (org_id, company_id, reference, title, contract_type, created_by)
       values ($1,$2,'NDA-CH-1','Channel test','nda',$3) returning id`,
      [org.id, company.id, admin.id],
    );

    await expect(
      withTenant({ userId: admin.id, orgId: org.id }, (tx) =>
        tx.query(`update contracts set status = 'fully_executed' where id = $1`, [
          contract.rows[0]!.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('unauthorized contract send', () => {
  let db: TestDatabase;
  let org: SeedOrg;
  let admin: SeedUser;
  let sales: SeedUser;
  let contractId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    setDriver(db.driver);
    const seeded = await createOrgWithAdmin(db.driver, { slug: 'send-co' });
    org = seeded.org;
    admin = seeded.admin;
    sales = await createUserWithRole(db.driver, org.id, 'sales', { email: 'send@x.test' });

    const company = await createCompany(db.driver, org.id, {
      name: 'Send Client',
      ownerUserId: sales.id,
    });

    const contract = await db.driver.query<{ id: string }>(
      `insert into contracts (org_id, company_id, reference, title, contract_type,
                              status, approved_by, approved_at, owner_user_id, created_by)
       values ($1,$2,'NDA-S-0001','Send test','nda','approved_to_send',$3, now(), $4, $3)
       returning id`,
      [org.id, company.id, admin.id, sales.id],
    );
    contractId = contract.rows[0]!.id;
  });

  afterAll(async () => {
    setDriver(null);
    await db.close();
  });

  it('refuses a send from the deal owner without send authority', async () => {
    // The salesperson owns the deal and the contract. Ownership is not authority.
    //
    // Sales holds no contract:update permission at all, so the row is not
    // visible for update and the statement matches nothing. Denial here is
    // silent rather than an error - which is why the assertion is on the
    // outcome, not on an exception.
    const result = await withTenant({ userId: sales.id, orgId: org.id }, (tx) =>
      tx.query(`update contracts set status = 'sent', sent_by = $2 where id = $1`, [
        contractId,
        sales.id,
      ]),
    );
    expect(result.rowCount).toBe(0);

    const unchanged = await withService('verify', (tx) =>
      tx.one<{ status: string; sent_by: string | null }>(
        'select status, sent_by from contracts where id = $1',
        [contractId],
      ),
    );
    expect(unchanged.status).toBe('approved_to_send');
    expect(unchanged.sent_by).toBeNull();
  });

  it('refuses a signature request from a user without contract:send', async () => {
    await expect(
      withTenant({ userId: sales.id, orgId: org.id }, (tx) =>
        tx.query(
          `insert into signature_requests (org_id, contract_id, provider, status, requested_by)
           values ($1,$2,'manual','created',$3)`,
          [org.id, contractId, sales.id],
        ),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('unauthorized finance access', () => {
  let db: TestDatabase;
  let org: SeedOrg;
  let sales: SeedUser;
  let salesCtx: RequestContext;
  let companyId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    setDriver(db.driver);
    const seeded = await createOrgWithAdmin(db.driver, { slug: 'finance-co' });
    org = seeded.org;
    sales = await createUserWithRole(db.driver, org.id, 'sales', { email: 'fin@x.test' });
    salesCtx = await testContext(db.driver, sales.id, org.id);

    const company = await createCompany(db.driver, org.id, {
      name: 'Finance Client',
      ownerUserId: sales.id,
    });
    companyId = company.id;

    await db.driver.query(
      `insert into invoices (org_id, company_id, reference, status, currency, total)
       values ($1,$2,'INV-0001','issued','USD','50000.00')`,
      [org.id, companyId],
    );
    await db.driver.query(
      `insert into payments (org_id, company_id, reference, amount, currency,
                             fx_rate_to_base, transaction_date)
       values ($1,$2,'PAY-0001','25000.00','USD',1,current_date)`,
      [org.id, companyId],
    );
  });

  afterAll(async () => {
    setDriver(null);
    await db.close();
  });

  it('hides invoices and payments from a user without finance:read', async () => {
    const rows = await withTenant({ userId: sales.id, orgId: org.id }, async (tx) => ({
      invoices: await tx.many('select id from invoices'),
      payments: await tx.many('select id from payments'),
    }));

    expect(rows.invoices).toHaveLength(0);
    expect(rows.payments).toHaveLength(0);
  });

  it('refuses the billing panel to a user without finance:read', async () => {
    const { getClientBilling } = await import('@/lib/services/client360');

    await expect(
      withTenant({ userId: sales.id, orgId: org.id }, (tx) =>
        getClientBilling(tx, salesCtx, companyId),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('omits billing from the client overview rather than failing the page', async () => {
    const { getClientOverview } = await import('@/lib/services/client360');

    const overview = await withTenant({ userId: sales.id, orgId: org.id }, (tx) =>
      getClientOverview(tx, salesCtx, companyId),
    );

    // The page still renders; the panel is simply absent.
    expect(overview.billing).toBeNull();
    expect(overview.company.name).toBe('Finance Client');
  });

  it('strips margin and cost from a priced solution', async () => {
    const { redactSensitiveFields, buildPermissionSet } = await import('@/lib/permissions');

    const row = {
      id: 'sol1',
      total: '32400.00',
      margin_amount: '16800.00',
      margin_percent: '51.85',
      cost_total: '15600.00',
      internal_notes: 'We have room to discount by 15%',
    };

    // Sales does hold internal_note:read - they need context on their own deals -
    // but not margin:read or cost:read. Those are stripped on the way out, so an
    // API consumer cannot simply read them from the JSON.
    expect(salesCtx.permissions.has('internal_note:read:org')).toBe(true);
    expect(salesCtx.permissions.has('margin:read:org')).toBe(false);

    const forSales = redactSensitiveFields(row, salesCtx.permissions);
    expect(forSales.total).toBe('32400.00');
    expect(forSales.internal_notes).toBe('We have room to discount by 15%');
    expect(forSales).not.toHaveProperty('margin_amount');
    expect(forSales).not.toHaveProperty('margin_percent');
    expect(forSales).not.toHaveProperty('cost_total');

    // Someone with no sensitive permissions at all sees none of it.
    const forDelivery = redactSensitiveFields(row, buildPermissionSet([]));
    expect(forDelivery).not.toHaveProperty('margin_amount');
    expect(forDelivery).not.toHaveProperty('cost_total');
    expect(forDelivery).not.toHaveProperty('internal_notes');

    const forFinance = redactSensitiveFields(
      row,
      buildPermissionSet(['margin:read:org', 'cost:read:org', 'internal_note:read:org']),
    );
    expect(forFinance.margin_amount).toBe('16800.00');
    expect(forFinance.cost_total).toBe('15600.00');
  });
});

describe('document access', () => {
  let db: TestDatabase;
  let org: SeedOrg;
  let admin: SeedUser;
  let sales: SeedUser;
  let salesCtx: RequestContext;
  let confidentialId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    setDriver(db.driver);
    const seeded = await createOrgWithAdmin(db.driver, { slug: 'docs-co' });
    org = seeded.org;
    admin = seeded.admin;
    sales = await createUserWithRole(db.driver, org.id, 'sales', { email: 'docs@x.test' });
    salesCtx = await testContext(db.driver, sales.id, org.id);

    const company = await createCompany(db.driver, org.id, {
      name: 'Docs Client',
      ownerUserId: sales.id,
    });

    const document = await db.driver.query<{ id: string }>(
      `insert into documents (org_id, company_id, category, name, is_confidential, created_by)
       values ($1,$2,'legal','Board minutes.pdf',true,$3) returning id`,
      [org.id, company.id, admin.id],
    );
    confidentialId = document.rows[0]!.id;

    await db.driver.query(
      `insert into document_versions (org_id, document_id, version_no, storage_path,
                                      file_name, mime_type, size_bytes, sha256, uploaded_by)
       values ($1,$2,1,'orgs/x/y/z/v1/minutes.pdf','minutes.pdf','application/pdf',1024,$3,$4)`,
      [org.id, confidentialId, 'a'.repeat(64), admin.id],
    );
    await db.driver.query(
      `update documents set current_version_id = (
         select id from document_versions where document_id = $1
       ) where id = $1`,
      [confidentialId],
    );
  });

  afterAll(async () => {
    setDriver(null);
    await db.close();
  });

  it('hides a confidential document from a user without the permission', async () => {
    const rows = await withTenant({ userId: sales.id, orgId: org.id }, (tx) =>
      tx.many('select id from documents where id = $1', [confidentialId]),
    );
    expect(rows).toHaveLength(0);
  });

  it('refuses to issue a download link for a confidential document', async () => {
    const { issueDownloadUrl } = await import('@/lib/documents');

    await expect(
      withTenant({ userId: sales.id, orgId: org.id }, (tx) =>
        issueDownloadUrl(tx, salesCtx, confidentialId),
      ),
    ).rejects.toBeTruthy();
  });

  it('refuses new versions on a sealed document', async () => {
    await withService('seal', (tx) =>
      tx.query(`update documents set is_immutable = true where id = $1`, [confidentialId]),
    );

    await expect(
      withService('attempt overwrite', (tx) =>
        tx.query(
          `insert into document_versions (org_id, document_id, version_no, storage_path,
                                          file_name, mime_type, size_bytes, sha256)
           values ($1,$2,2,'orgs/x/y/z/v2/minutes.pdf','minutes.pdf','application/pdf',2048,$3)`,
          [org.id, confidentialId, 'b'.repeat(64)],
        ),
      ),
    ).rejects.toMatchObject({ code: 'DOCUMENT_IMMUTABLE' });
  });

  it('refuses to delete a sealed document', async () => {
    await expect(
      withService('attempt delete', (tx) =>
        tx.query(`update documents set deleted_at = now() where id = $1`, [confidentialId]),
      ),
    ).rejects.toMatchObject({ code: 'DOCUMENT_IMMUTABLE' });
  });

  it('refuses to unseal a sealed document', async () => {
    await expect(
      withService('attempt unseal', (tx) =>
        tx.query(`update documents set is_immutable = false where id = $1`, [confidentialId]),
      ),
    ).rejects.toMatchObject({ code: 'DOCUMENT_IMMUTABLE' });
  });

  it('never mutates a stored version', async () => {
    await expect(
      withService('attempt version tamper', (tx) =>
        tx.query(`update document_versions set sha256 = $1 where document_id = $2`, [
          'c'.repeat(64),
          confidentialId,
        ]),
      ),
    ).rejects.toBeTruthy();
  });
});

describe('webhook spoofing', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    setDriver(db.driver);
  });

  afterAll(async () => {
    setDriver(null);
    await db.close();
  });

  const payload = () =>
    JSON.stringify({
      event_id: randomUUID(),
      request_id: 'manual_forged',
      type: 'completed',
      occurred_at: new Date().toISOString(),
    });

  it('rejects a webhook with no signature', async () => {
    const { ingestWebhook } = await import('@/lib/webhooks/processor');
    const result = await ingestWebhook(
      'manual',
      Buffer.from(payload()),
      new Headers({ 'content-type': 'application/json' }),
      'req_nosig',
    );
    expect(result.accepted).toBe(false);
  });

  it('rejects a webhook with a wrong signature', async () => {
    const { ingestWebhook } = await import('@/lib/webhooks/processor');
    const body = payload();
    const wrong = createHmac('sha256', 'not-the-real-secret').update(body).digest('hex');

    const result = await ingestWebhook(
      'manual',
      Buffer.from(body),
      new Headers({ 'x-velozity-signature': wrong }),
      'req_wrongsig',
    );
    expect(result.accepted).toBe(false);
  });

  it('stores a rejected webhook as evidence rather than discarding it', async () => {
    const { ingestWebhook } = await import('@/lib/webhooks/processor');
    const result = await ingestWebhook(
      'manual',
      Buffer.from(payload()),
      new Headers({}),
      'req_evidence',
    );

    const stored = await withService('check', (tx) =>
      tx.one<{ status: string; signature_verified: boolean; verification_error: string }>(
        `select status, signature_verified, verification_error
         from webhook_events where id = $1`,
        [result.webhookEventId],
      ),
    );

    expect(stored.status).toBe('rejected');
    expect(stored.signature_verified).toBe(false);
    expect(stored.verification_error).toBeTruthy();
  });

  it('never processes an unverified webhook, even if asked directly', async () => {
    const { ingestWebhook, processWebhookEvent } = await import('@/lib/webhooks/processor');

    const result = await ingestWebhook(
      'manual',
      Buffer.from(payload()),
      new Headers({}),
      'req_direct',
    );

    // Calling the processor by hand on a rejected event must not interpret it.
    await processWebhookEvent(result.webhookEventId);

    const stored = await withService('check', (tx) =>
      tx.one<{ status: string }>('select status from webhook_events where id = $1', [
        result.webhookEventId,
      ]),
    );
    expect(stored.status).toBe('rejected');
  });

  it('writes a critical audit record for a spoofing attempt', async () => {
    const { ingestWebhook } = await import('@/lib/webhooks/processor');
    await ingestWebhook('manual', Buffer.from(payload()), new Headers({}), 'req_audit');

    const audit = await withService('check', (tx) =>
      tx.many<{ severity: string; action: string }>(
        `select severity, action from audit_log where action = 'webhook.signature_invalid'`,
      ),
    );

    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0]?.severity).toBe('critical');
  });

  it('rejects an unknown provider name', async () => {
    const { ingestWebhook } = await import('@/lib/webhooks/processor');
    await expect(
      ingestWebhook('evil_provider', Buffer.from('{}'), new Headers({}), 'req_unknown'),
    ).rejects.toBeInstanceOf(AppError);
  });
});

describe('scope enforcement', () => {
  let db: TestDatabase;
  let org: SeedOrg;
  let admin: SeedUser;
  let repA: SeedUser;
  let repB: SeedUser;
  let teamId: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    setDriver(db.driver);
    const seeded = await createOrgWithAdmin(db.driver, { slug: 'scope-co' });
    org = seeded.org;
    admin = seeded.admin;

    repA = await createUserWithRole(db.driver, org.id, 'sales', { email: 'repa@x.test' });
    repB = await createUserWithRole(db.driver, org.id, 'sales', { email: 'repb@x.test' });

    const team = await createTeam(db.driver, org.id, 'North');
    teamId = team.id;
    await addToTeam(db.driver, org.id, teamId, repA.id);

    await createCompany(db.driver, org.id, { name: 'Rep A own', ownerUserId: repA.id });
    await createCompany(db.driver, org.id, { name: 'Team North', ownerUserId: admin.id, teamId });
    await createCompany(db.driver, org.id, { name: 'Rep B own', ownerUserId: repB.id });
    await createCompany(db.driver, org.id, { name: 'Unassigned' });
  });

  afterAll(async () => {
    setDriver(null);
    await db.close();
  });

  it('gives a team-scoped user their own records and their team\'s, and nothing else', async () => {
    const rows = await withTenant({ userId: repA.id, orgId: org.id }, (tx) =>
      tx.many<{ name: string }>('select name from companies order by name'),
    );

    expect(rows.map((r) => r.name).sort()).toEqual(['Rep A own', 'Team North']);
  });

  it('does not leak another rep\'s records to a peer on the same role', async () => {
    const rows = await withTenant({ userId: repB.id, orgId: org.id }, (tx) =>
      tx.many<{ name: string }>('select name from companies order by name'),
    );

    expect(rows.map((r) => r.name)).toEqual(['Rep B own']);
    expect(rows.map((r) => r.name)).not.toContain('Rep A own');
  });

  it('gives an org-scoped user everything in the tenant', async () => {
    const rows = await withTenant({ userId: admin.id, orgId: org.id }, (tx) =>
      tx.many<{ name: string }>('select name from companies'),
    );
    expect(rows).toHaveLength(4);
  });
});

describe('append-only records', () => {
  let db: TestDatabase;
  let org: SeedOrg;
  let admin: SeedUser;

  beforeAll(async () => {
    db = await createTestDatabase();
    setDriver(db.driver);
    const seeded = await createOrgWithAdmin(db.driver, { slug: 'append-co' });
    org = seeded.org;
    admin = seeded.admin;
  });

  afterAll(async () => {
    setDriver(null);
    await db.close();
  });

  it('refuses UPDATE and DELETE on every append-only table, even as service_role', async () => {
    await withService('seed rows', async (tx) => {
      await tx.query(
        `insert into audit_log (org_id, action, category, summary)
         values ($1,'test.append','admin','Original')`,
        [org.id],
      );
      await tx.query(
        `insert into state_transitions (org_id, entity_type, entity_id, from_state, to_state, actor_user_id)
         values ($1,'test',$2,'a','b',$3)`,
        [org.id, randomUUID(), admin.id],
      );
    });

    for (const table of ['audit_log', 'state_transitions']) {
      await expect(
        withService('tamper', (tx) => tx.query(`update ${table} set org_id = org_id`)),
        `${table} allowed UPDATE`,
      ).rejects.toBeTruthy();

      await expect(
        withService('tamper', (tx) => tx.query(`delete from ${table}`)),
        `${table} allowed DELETE`,
      ).rejects.toBeTruthy();
    }
  });

  it('has no UPDATE or DELETE privilege on the audit log for any request role', async () => {
    const grants = await db.driver.query<{ grantee: string; privilege_type: string }>(
      `select grantee, privilege_type
       from information_schema.role_table_grants
       where table_name = 'audit_log'
         and privilege_type in ('UPDATE', 'DELETE')
         and grantee in ('authenticated', 'anon', 'service_role')`,
    );
    expect(grants.rows).toEqual([]);
  });
});
