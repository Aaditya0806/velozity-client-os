/**
 * The permission catalogue, mirrored in TypeScript.
 *
 * The database is the enforcement point; this module exists so that server code
 * and the UI can reason about permissions with autocompletion instead of magic
 * strings. `tests/unit/permission-catalog.test.ts` asserts the two stay in step.
 */

export const SCOPES = ['own', 'team', 'org'] as const;
export type Scope = (typeof SCOPES)[number];

/** Broader scopes subsume narrower ones. */
export const SCOPE_RANK: Record<Scope, number> = { own: 1, team: 2, org: 3 };

/** Resources whose permissions come in all three scopes. */
export const SCOPED_RESOURCES = [
  'company',
  'contact',
  'opportunity',
  'proposal',
  'contract',
  'project',
  'task',
  'renewal',
] as const;
export type ScopedResource = (typeof SCOPED_RESOURCES)[number];

export const SCOPED_ACTIONS: Record<ScopedResource, readonly string[]> = {
  company: ['read', 'create', 'update', 'delete'],
  contact: ['read', 'create', 'update', 'delete'],
  opportunity: ['read', 'create', 'update', 'delete'],
  proposal: ['read', 'create', 'update'],
  contract: ['read', 'create', 'update'],
  project: ['read', 'create', 'update', 'delete'],
  task: ['read', 'create', 'update', 'delete'],
  // A renewal is opened by the sweep and closed by a decision; nobody creates
  // or deletes one by hand, so those actions do not exist rather than existing
  // and being refused.
  renewal: ['read', 'update'],
};

/** Org-wide authorities that have no meaningful narrower form. */
export const ORG_PERMISSIONS = [
  'organization:read:org',
  'organization:update:org',
  'user:read:org',
  'user:create:org',
  'user:update:org',
  'user:manage:org',
  'role:manage:org',
  'role:assign:org',
  'team:manage:org',
  'audit:read:org',
  'settings:manage:org',

  'proposal:approve:org',
  'proposal:send:org',
  'proposal:delete:org',

  'contract:approve:org',
  'contract:send:org',
  'contract:void:org',
  'contract:delete:org',
  'contract_template:read:org',
  'contract_template:manage:org',
  'legal:override:org',

  'document:read:org',
  'document:create:org',
  'document:update:org',
  'document:delete:org',
  'document:read_confidential:org',

  'service:read:org',
  'service:manage:org',
  'onboarding:read:org',
  'onboarding:manage:org',
  'kpi:read:org',
  'kpi:manage:org',
  'report:read:org',
  'report:manage:org',

  'finance:read:org',
  'finance:manage:org',
  'payment:manage:org',
  'margin:read:org',
  'cost:read:org',
  'internal_note:read:org',

  'ai:read:org',
  'ai:use:org',
  'ai:approve:org',

  'automation:read:org',
  'automation:manage:org',
  'email:read:org',
  'email:draft:org',
  'email:send:org',
  'email:manage:org',
] as const;

export type OrgPermission = (typeof ORG_PERMISSIONS)[number];

export type ScopedPermission = `${ScopedResource}:${string}:${Scope}`;
export type PermissionKey = OrgPermission | ScopedPermission;

/**
 * Permissions that reveal commercially or legally sensitive information.
 * Nothing grants these implicitly; they are always an explicit decision.
 */
export const SENSITIVE_PERMISSIONS = new Set<string>([
  'margin:read:org',
  'cost:read:org',
  'internal_note:read:org',
  'finance:read:org',
  'finance:manage:org',
  'payment:manage:org',
  'contract:approve:org',
  'contract:send:org',
  'contract:void:org',
  'legal:override:org',
  'proposal:approve:org',
  'proposal:send:org',
  'ai:read:org',
  'ai:approve:org',
  'audit:read:org',
  'role:manage:org',
  'role:assign:org',
  'user:manage:org',
  'document:read_confidential:org',
  'automation:manage:org',
  'email:send:org',
  'settings:manage:org',
  'contract_template:manage:org',
]);

/** Every permission key the product defines, in catalogue order. */
export function allPermissionKeys(): string[] {
  const scoped: string[] = [];
  for (const resource of SCOPED_RESOURCES) {
    for (const action of SCOPED_ACTIONS[resource]) {
      for (const scope of SCOPES) {
        scoped.push(`${resource}:${action}:${scope}`);
      }
    }
  }
  return [...scoped, ...ORG_PERMISSIONS];
}

export function parsePermission(key: string): {
  resource: string;
  action: string;
  scope: Scope;
} | null {
  const parts = key.split(':');
  if (parts.length !== 3) return null;
  const [resource, action, scope] = parts as [string, string, string];
  if (!SCOPES.includes(scope as Scope)) return null;
  return { resource, action, scope: scope as Scope };
}

export const SYSTEM_ROLE_KEYS = [
  'super_admin',
  'management',
  'legal_admin',
  'finance',
  'sales',
  'project_manager',
  'delivery',
  'client',
] as const;

export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

export const SYSTEM_ROLE_LABELS: Record<SystemRoleKey, string> = {
  super_admin: 'Super Admin',
  management: 'Management',
  legal_admin: 'Legal / Admin',
  finance: 'Finance',
  sales: 'Sales',
  project_manager: 'Project Manager',
  delivery: 'Delivery',
  client: 'Client',
};
