/**
 * Tenant isolation.
 *
 * These are the tests that matter most in a multi-tenant product: they run real
 * SQL through real RLS policies as the real `authenticated` role. If any of them
 * regress, one customer can read another's data.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/pglite';
import { setDriver, withTenant } from '@/lib/db';
import {
  createOrgWithAdmin,
  createCompany,
  createUserWithRole,
  createUser,
  type SeedOrg,
  type SeedUser,
} from '../helpers/factories';

describe('RLS tenant isolation', () => {
  let db: TestDatabase;
  let orgA: SeedOrg;
  let adminA: SeedUser;
  let orgB: SeedOrg;
  let adminB: SeedUser;
  let companyA: { id: string; name: string };
  let companyB: { id: string; name: string };

  beforeAll(async () => {
    db = await createTestDatabase();
    setDriver(db.driver);

    const a = await createOrgWithAdmin(db.driver, { slug: 'org-alpha', name: 'Alpha Ltd' });
    orgA = a.org;
    adminA = a.admin;

    const b = await createOrgWithAdmin(db.driver, { slug: 'org-beta', name: 'Beta Ltd' });
    orgB = b.org;
    adminB = b.admin;

    companyA = await createCompany(db.driver, orgA.id, { name: 'Alpha Client One' });
    companyB = await createCompany(db.driver, orgB.id, { name: 'Beta Client One' });
  });

  afterAll(async () => {
    setDriver(null);
    await db.close();
  });

  it('shows a member only their own organisation\'s companies', async () => {
    const rows = await withTenant({ userId: adminA.id, orgId: orgA.id }, (tx) =>
      tx.many<{ id: string; name: string }>('select id, name from companies order by name'),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(companyA.id);
  });

  it('returns nothing when a user forges the org context of a tenant they do not belong to', async () => {
    // adminA presents orgB's id. Membership is re-checked in the policy, so the
    // GUC alone buys nothing.
    const rows = await withTenant({ userId: adminA.id, orgId: orgB.id }, (tx) =>
      tx.many('select id from companies'),
    );

    expect(rows).toHaveLength(0);
  });

  it('cannot read a specific cross-tenant row even when the id is known', async () => {
    const rows = await withTenant({ userId: adminA.id, orgId: orgA.id }, (tx) =>
      tx.many('select id from companies where id = $1', [companyB.id]),
    );

    expect(rows).toHaveLength(0);
  });

  it('refuses to insert a row into another tenant', async () => {
    await expect(
      withTenant({ userId: adminA.id, orgId: orgA.id }, (tx) =>
        tx.query(
          `insert into companies (org_id, name, currency) values ($1, 'Smuggled', 'USD')`,
          [orgB.id],
        ),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses to move an existing row into another tenant', async () => {
    await withTenant({ userId: adminA.id, orgId: orgA.id }, async (tx) => {
      const res = await tx.query('update companies set org_id = $1 where id = $2', [
        orgB.id,
        companyA.id,
      ]);
      // The WITH CHECK clause rejects the new row, so either the statement
      // errors or it matches nothing. Neither may result in a moved row.
      expect(res.rowCount).toBe(0);
    }).catch((error) => {
      expect(error).toMatchObject({ code: 'FORBIDDEN' });
    });

    const stillInA = await withTenant({ userId: adminA.id, orgId: orgA.id }, (tx) =>
      tx.maybeOne('select id from companies where id = $1', [companyA.id]),
    );
    expect(stillInA).not.toBeNull();
  });

  it('returns nothing for a user with no organisation context', async () => {
    const rows = await withTenant({ userId: adminA.id, orgId: null }, (tx) =>
      tx.many('select id from companies'),
    );
    expect(rows).toHaveLength(0);
  });

  it('returns nothing for a user who is not a member of any organisation', async () => {
    const outsider = await createUser(db.driver, { email: 'outsider@example.test' });
    const rows = await withTenant({ userId: outsider.id, orgId: orgA.id }, (tx) =>
      tx.many('select id from companies'),
    );
    expect(rows).toHaveLength(0);
  });

  it('denies a deactivated member even while their membership row survives', async () => {
    const user = await createUserWithRole(db.driver, orgA.id, 'sales', {
      email: 'deactivated@example.test',
    });
    // Sales holds company:read:team, so give them a record they actually own.
    await createCompany(db.driver, orgA.id, {
      name: 'Owned By Deactivated User',
      ownerUserId: user.id,
    });

    const before = await withTenant({ userId: user.id, orgId: orgA.id }, (tx) =>
      tx.many('select id from companies'),
    );
    expect(before.length).toBeGreaterThan(0);

    await db.driver.query(
      `update org_memberships set status = 'deactivated', deactivated_at = now()
       where org_id = $1 and user_id = $2`,
      [orgA.id, user.id],
    );

    const after = await withTenant({ userId: user.id, orgId: orgA.id }, (tx) =>
      tx.many('select id from companies'),
    );
    expect(after).toHaveLength(0);
  });

  it('denies a user whose profile has been deactivated', async () => {
    const user = await createUserWithRole(db.driver, orgB.id, 'sales', {
      email: 'suspended@example.test',
    });
    await createCompany(db.driver, orgB.id, {
      name: 'Owned By Suspended User',
      ownerUserId: user.id,
    });

    await db.driver.query(`update user_profiles set status = 'deactivated' where id = $1`, [
      user.id,
    ]);

    const rows = await withTenant({ userId: user.id, orgId: orgB.id }, (tx) =>
      tx.many('select id from companies'),
    );
    expect(rows).toHaveLength(0);
  });

  it('keeps the audit log isolated per tenant', async () => {
    await db.driver.query(
      `insert into audit_log (org_id, action, category, summary) values ($1, 'test.event', 'admin', 'A')`,
      [orgA.id],
    );
    await db.driver.query(
      `insert into audit_log (org_id, action, category, summary) values ($1, 'test.event', 'admin', 'B')`,
      [orgB.id],
    );

    const rowsA = await withTenant({ userId: adminA.id, orgId: orgA.id }, (tx) =>
      tx.many<{ summary: string }>('select summary from audit_log'),
    );

    expect(rowsA.map((r) => r.summary)).toEqual(['A']);
  });

  it('makes the audit log genuinely append-only', async () => {
    await db.driver.query(
      `insert into audit_log (org_id, action, category, summary) values ($1, 'test.immutable', 'admin', 'original')`,
      [orgB.id],
    );

    await expect(
      withTenant({ userId: adminB.id, orgId: orgB.id }, (tx) =>
        tx.query(`update audit_log set summary = 'tampered' where org_id = $1`, [orgB.id]),
      ),
    ).rejects.toBeTruthy();

    await expect(
      withTenant({ userId: adminB.id, orgId: orgB.id }, (tx) =>
        tx.query(`delete from audit_log where org_id = $1`, [orgB.id]),
      ),
    ).rejects.toBeTruthy();
  });
});
