/**
 * The TypeScript catalogue and the database catalogue must not drift. If they
 * do, the UI hides a button the server would have allowed, or worse, shows one
 * the server refuses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../helpers/pglite';
import { allPermissionKeys, SYSTEM_ROLE_KEYS, buildPermissionSet, canAccessRow, redactSensitiveFields } from '@/lib/permissions';

describe('permission catalogue', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  it('matches the permissions defined in the database exactly', async () => {
    const res = await db.driver.query<{ key: string }>('select key from permissions');
    const inDb = new Set(res.rows.map((r) => r.key));
    const inCode = new Set(allPermissionKeys());

    const missingInDb = [...inCode].filter((k) => !inDb.has(k)).sort();
    const missingInCode = [...inDb].filter((k) => !inCode.has(k)).sort();

    expect({ missingInDb, missingInCode }).toEqual({ missingInDb: [], missingInCode: [] });
  });

  it('defines every system role in the database', async () => {
    const res = await db.driver.query<{ key: string }>(
      'select key from roles where org_id is null',
    );
    expect(res.rows.map((r) => r.key).sort()).toEqual([...SYSTEM_ROLE_KEYS].sort());
  });

  it('gives Super Admin every org-scoped permission', async () => {
    const res = await db.driver.query<{ missing: string }>(`
      select p.key as missing
      from permissions p
      where p.scope = 'org'
        and not exists (
          select 1 from role_permissions rp
          join roles r on r.id = rp.role_id
          where rp.permission_id = p.id and r.key = 'super_admin' and r.org_id is null
        )
    `);
    expect(res.rows.map((r) => r.missing)).toEqual([]);
  });

  it('does not grant contract send authority to Sales', async () => {
    const res = await db.driver.query<{ key: string }>(`
      select p.key from role_permissions rp
      join roles r on r.id = rp.role_id
      join permissions p on p.id = rp.permission_id
      where r.key = 'sales' and p.key in ('contract:send:org','contract:approve:org','legal:override:org')
    `);
    expect(res.rows).toEqual([]);
  });

  it('does not expose margin or cost to Sales or Delivery', async () => {
    const res = await db.driver.query<{ role: string; key: string }>(`
      select r.key as role, p.key from role_permissions rp
      join roles r on r.id = rp.role_id
      join permissions p on p.id = rp.permission_id
      where r.key in ('sales','delivery') and p.key in ('margin:read:org','cost:read:org')
    `);
    expect(res.rows).toEqual([]);
  });

  it('grants legal override only to Legal/Admin and Super Admin', async () => {
    const res = await db.driver.query<{ role: string }>(`
      select r.key as role from role_permissions rp
      join roles r on r.id = rp.role_id
      join permissions p on p.id = rp.permission_id
      where p.key = 'legal:override:org' and r.org_id is null
      order by r.key
    `);
    expect(res.rows.map((r) => r.role)).toEqual(['legal_admin', 'super_admin']);
  });

  it('gives the Client role no internal permissions at all', async () => {
    const res = await db.driver.query<{ c: number }>(`
      select count(*)::int as c from role_permissions rp
      join roles r on r.id = rp.role_id
      where r.key = 'client' and r.org_id is null
    `);
    expect(res.rows[0]?.c).toBe(0);
  });
});

describe('PermissionSet', () => {
  const set = buildPermissionSet([
    'company:read:team',
    'company:read:own',
    'opportunity:read:org',
    'margin:read:org',
  ]);

  it('resolves the broadest scope held for a resource:action pair', () => {
    expect(set.scopeFor('company', 'read')).toBe('team');
    expect(set.scopeFor('opportunity', 'read')).toBe('org');
    expect(set.scopeFor('contract', 'read')).toBeNull();
  });

  it('throws FORBIDDEN for a permission that is not held', () => {
    expect(() => set.require('contract:send:org')).toThrowError(/contract:send:org/);
    expect(() => set.require('margin:read:org')).not.toThrow();
  });

  it('applies team scope against the actor\'s teams', () => {
    const actor = { userId: 'u1', teamIds: ['t1'] };
    expect(canAccessRow(set, 'company', 'read', { teamId: 't1' }, actor)).toBe(true);
    expect(canAccessRow(set, 'company', 'read', { teamId: 't2' }, actor)).toBe(false);
    expect(canAccessRow(set, 'company', 'read', { ownerUserId: 'u1' }, actor)).toBe(true);
    expect(canAccessRow(set, 'company', 'read', { ownerUserId: 'u2' }, actor)).toBe(false);
  });

  it('allows every row at org scope', () => {
    const actor = { userId: 'u1', teamIds: [] };
    expect(canAccessRow(set, 'opportunity', 'read', { ownerUserId: 'someone-else' }, actor)).toBe(true);
  });

  it('strips fields the caller has no permission to see', () => {
    const row = {
      id: 'x',
      total: '1000.00',
      margin_amount: '400.00',
      cost_total: '600.00',
      internal_notes: 'Client is price-sensitive',
    };

    const withMargin = redactSensitiveFields(row, set);
    expect(withMargin.margin_amount).toBe('400.00');
    expect(withMargin).not.toHaveProperty('cost_total');
    expect(withMargin).not.toHaveProperty('internal_notes');

    const withNothing = redactSensitiveFields(row, buildPermissionSet([]));
    expect(withNothing).not.toHaveProperty('margin_amount');
    expect(withNothing).not.toHaveProperty('cost_total');
    expect(withNothing).not.toHaveProperty('internal_notes');
    expect(withNothing.total).toBe('1000.00');
  });
});
