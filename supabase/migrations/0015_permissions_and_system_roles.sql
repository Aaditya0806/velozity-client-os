-- =============================================================================
-- 0015_permissions_and_system_roles.sql
-- The permission catalogue and the eight system roles.
--
-- This is reference data the product ships with, so it lives in a migration
-- rather than in the seed script: a production database must have it, and it
-- must be identical everywhere.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- PERMISSIONS
--
-- `scoped` resources get all three scopes (own / team / org); everything else is
-- an org-wide authority that has no meaningful narrower form.
-- -----------------------------------------------------------------------------
with scoped(resource, action, description, sensitive) as (
  values
    ('company',     'read',   'View companies',                     false),
    ('company',     'create', 'Create companies',                   false),
    ('company',     'update', 'Edit companies',                     false),
    ('company',     'delete', 'Archive companies',                  false),
    ('contact',     'read',   'View contacts',                      false),
    ('contact',     'create', 'Create contacts',                    false),
    ('contact',     'update', 'Edit contacts',                      false),
    ('contact',     'delete', 'Archive contacts',                   false),
    ('opportunity', 'read',   'View opportunities',                 false),
    ('opportunity', 'create', 'Create opportunities',               false),
    ('opportunity', 'update', 'Edit opportunities',                 false),
    ('opportunity', 'delete', 'Archive opportunities',              false),
    ('proposal',    'read',   'View proposals',                     false),
    ('proposal',    'create', 'Create proposals',                   false),
    ('proposal',    'update', 'Edit proposals',                     false),
    ('contract',    'read',   'View contracts',                     true),
    ('contract',    'create', 'Draft contracts',                    true),
    ('contract',    'update', 'Edit contract drafts',               true),
    ('project',     'read',   'View projects',                      false),
    ('project',     'create', 'Create projects',                    false),
    ('project',     'update', 'Edit projects',                      false),
    ('project',     'delete', 'Archive projects',                   false),
    ('task',        'read',   'View tasks',                         false),
    ('task',        'create', 'Create tasks',                       false),
    ('task',        'update', 'Edit tasks',                         false),
    ('task',        'delete', 'Delete tasks',                       false)
)
insert into permissions (key, resource, action, scope, description, is_sensitive)
select s.resource || ':' || s.action || ':' || sc.scope,
       s.resource, s.action, sc.scope,
       s.description || ' (' || sc.scope || ' scope)',
       s.sensitive
from scoped s
cross join (values ('own'), ('team'), ('org')) as sc(scope)
on conflict (key) do nothing;

-- Org-wide authorities.
insert into permissions (key, resource, action, scope, description, is_sensitive)
values
  -- Tenant administration
  ('organization:read:org',       'organization', 'read',   'org', 'View organisation settings',            false),
  ('organization:update:org',     'organization', 'update', 'org', 'Change organisation settings',          false),
  ('user:read:org',               'user',   'read',       'org', 'View users',                              false),
  ('user:create:org',             'user',   'create',     'org', 'Invite users',                            false),
  ('user:update:org',             'user',   'update',     'org', 'Edit user profiles',                      false),
  ('user:manage:org',             'user',   'manage',     'org', 'Add, remove and deactivate members',      true),
  ('role:manage:org',             'role',   'manage',     'org', 'Create and edit roles',                   true),
  ('role:assign:org',             'role',   'assign',     'org', 'Assign roles to users',                   true),
  ('team:manage:org',             'team',   'manage',     'org', 'Manage teams and membership',             false),
  ('audit:read:org',              'audit',  'read',       'org', 'Read the audit log and event history',    true),
  ('settings:manage:org',         'settings','manage',    'org', 'Manage application settings',             true),

  -- Sales
  ('proposal:approve:org',        'proposal', 'approve',  'org', 'Approve a proposal version internally',   true),
  ('proposal:send:org',           'proposal', 'send',     'org', 'Send a proposal to a client',             true),
  ('proposal:delete:org',         'proposal', 'delete',   'org', 'Archive proposals',                       false),

  -- Legal. Send authority is intentionally separate from deal ownership.
  ('contract:approve:org',        'contract', 'approve',  'org', 'Approve a contract for sending',          true),
  ('contract:send:org',           'contract', 'send',     'org', 'Send a contract for signature',           true),
  ('contract:void:org',           'contract', 'void',     'org', 'Void a contract in flight',               true),
  ('contract:delete:org',         'contract', 'delete',   'org', 'Archive contract drafts',                 true),
  ('contract_template:read:org',  'contract_template', 'read',   'org', 'View contract templates',          false),
  ('contract_template:manage:org','contract_template', 'manage', 'org', 'Create and edit contract templates', true),
  ('legal:override:org',          'legal',  'override',   'org', 'Force onboarding past the legal gate',    true),

  -- Documents
  ('document:read:org',           'document', 'read',     'org', 'View and download documents',             false),
  ('document:create:org',         'document', 'create',   'org', 'Upload documents',                        false),
  ('document:update:org',         'document', 'update',   'org', 'Rename and re-categorise documents',      false),
  ('document:delete:org',         'document', 'delete',   'org', 'Archive documents',                       false),
  ('document:read_confidential:org','document','read_confidential','org','Open documents marked confidential', true),

  -- Catalogue and delivery
  ('service:read:org',            'service', 'read',      'org', 'View the service catalogue',              false),
  ('service:manage:org',          'service', 'manage',    'org', 'Create and edit services',                false),
  ('onboarding:read:org',         'onboarding', 'read',   'org', 'View onboarding status',                  false),
  ('onboarding:manage:org',       'onboarding', 'manage', 'org', 'Run the onboarding workflow',             false),
  ('kpi:read:org',                'kpi',    'read',       'org', 'View KPIs',                               false),
  ('kpi:manage:org',              'kpi',    'manage',     'org', 'Define KPIs and record measurements',      false),
  ('report:read:org',             'report', 'read',       'org', 'View reports',                            false),
  ('report:manage:org',           'report', 'manage',     'org', 'Create and publish client reports',       false),

  -- Finance and commercially sensitive figures
  ('finance:read:org',            'finance', 'read',      'org', 'View invoices, payments and requirements', true),
  ('finance:manage:org',          'finance', 'manage',    'org', 'Manage invoices and payment requirements', true),
  ('payment:manage:org',          'payment', 'manage',    'org', 'Record and allocate payments',             true),
  ('margin:read:org',             'margin', 'read',       'org', 'See margin figures',                       true),
  ('cost:read:org',               'cost',   'read',       'org', 'See internal cost figures',                true),
  ('internal_note:read:org',      'internal_note', 'read','org', 'Read internal notes and private activity', true),

  -- AI
  ('ai:read:org',                 'ai', 'read',           'org', 'View AI actions and analysis',            true),
  ('ai:use:org',                  'ai', 'use',            'org', 'Ask the AI assistant and request drafts', false),
  ('ai:approve:org',              'ai', 'approve',        'org', 'Approve or reject AI-proposed actions',   true),

  -- Automations and email
  ('automation:read:org',         'automation', 'read',   'org', 'View automations and run history',        false),
  ('automation:manage:org',       'automation', 'manage', 'org', 'Create and edit automations',             true),
  ('email:read:org',              'email', 'read',        'org', 'View sent and drafted email',             false),
  ('email:draft:org',             'email', 'draft',       'org', 'Compose email drafts',                    false),
  ('email:send:org',              'email', 'send',        'org', 'Send email to clients',                   true),
  ('email:manage:org',            'email', 'manage',      'org', 'Manage email templates',                  false)
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- SYSTEM ROLES
-- -----------------------------------------------------------------------------
insert into roles (org_id, key, name, description, is_system, rank) values
  (null, 'super_admin',     'Super Admin',     'Full control of the organisation, including roles, legal overrides and finance.', true, 10),
  (null, 'management',      'Management',      'Org-wide visibility including commercial figures, plus proposal and contract approval.', true, 20),
  (null, 'legal_admin',     'Legal / Admin',   'Owns contract templates, legal review, sending for signature and legal overrides.', true, 30),
  (null, 'finance',         'Finance',         'Owns invoices, payments and payment requirements; sees margin and cost.', true, 40),
  (null, 'sales',           'Sales',           'Runs the pipeline: companies, contacts, opportunities, discovery and proposals.', true, 50),
  (null, 'project_manager', 'Project Manager', 'Runs delivery: projects, workstreams, tasks, KPIs and client reports.', true, 50),
  (null, 'delivery',        'Delivery',        'Works assigned tasks and deliverables.', true, 60),
  (null, 'client',          'Client',          'External portal access. Holds no internal permissions.', true, 90)
on conflict do nothing;

-- Helper: grant a set of permission keys to a system role.
create or replace function app.grant_permissions(p_role_key text, p_keys text[])
returns void
language sql
as $$
  insert into role_permissions (role_id, permission_id)
  select r.id, p.id
  from roles r
  join permissions p on p.key = any (p_keys)
  where r.key = p_role_key and r.org_id is null
  on conflict do nothing
$$;

-- Super Admin: every permission that exists, at org scope where scoped.
insert into role_permissions (role_id, permission_id)
select r.id, p.id
from roles r
cross join permissions p
where r.key = 'super_admin' and r.org_id is null and p.scope = 'org'
on conflict do nothing;

-- Management: org-wide visibility and commercial authority, but not user or
-- role administration and not legal override.
select app.grant_permissions('management', array[
  'organization:read:org',
  'company:read:org','company:create:org','company:update:org',
  'contact:read:org','contact:create:org','contact:update:org',
  'opportunity:read:org','opportunity:create:org','opportunity:update:org',
  'proposal:read:org','proposal:create:org','proposal:update:org','proposal:approve:org','proposal:send:org',
  'contract:read:org','contract:approve:org',
  'contract_template:read:org',
  'document:read:org','document:create:org','document:update:org','document:read_confidential:org',
  'service:read:org','service:manage:org',
  'onboarding:read:org','onboarding:manage:org',
  'project:read:org','project:create:org','project:update:org',
  'task:read:org','task:create:org','task:update:org',
  'kpi:read:org','kpi:manage:org',
  'report:read:org','report:manage:org',
  'finance:read:org',
  'margin:read:org','cost:read:org','internal_note:read:org',
  'ai:read:org','ai:use:org','ai:approve:org',
  'automation:read:org','automation:manage:org',
  'email:read:org','email:draft:org','email:send:org',
  'audit:read:org','user:read:org'
]);

-- Legal / Admin: the only role besides Super Admin that may send contracts for
-- signature or override the legal gate. Deliberately holds no finance authority.
select app.grant_permissions('legal_admin', array[
  'organization:read:org',
  'company:read:org','contact:read:org','opportunity:read:org',
  'proposal:read:org',
  'contract:read:org','contract:create:org','contract:update:org',
  'contract:approve:org','contract:send:org','contract:void:org','contract:delete:org',
  'contract_template:read:org','contract_template:manage:org',
  'legal:override:org',
  'document:read:org','document:create:org','document:update:org','document:read_confidential:org',
  'onboarding:read:org','onboarding:manage:org',
  'internal_note:read:org',
  'ai:read:org','ai:use:org',
  'email:read:org','email:draft:org','email:send:org','email:manage:org',
  'audit:read:org','user:read:org','service:read:org','project:read:org','report:read:org'
]);

-- Finance: money, and the commercial figures needed to reason about it.
select app.grant_permissions('finance', array[
  'organization:read:org',
  'company:read:org','contact:read:org','opportunity:read:org',
  'proposal:read:org','contract:read:org',
  'document:read:org','document:create:org',
  'service:read:org',
  'project:read:org','onboarding:read:org',
  'report:read:org',
  'finance:read:org','finance:manage:org','payment:manage:org',
  'margin:read:org','cost:read:org',
  'ai:use:org','email:read:org','email:draft:org',
  'audit:read:org'
]);

-- Sales: owns the funnel at team scope. Cannot approve or send contracts, and
-- cannot see margin or cost.
select app.grant_permissions('sales', array[
  'company:read:team','company:create:org','company:update:team',
  'contact:read:team','contact:create:org','contact:update:team',
  'opportunity:read:team','opportunity:create:org','opportunity:update:team',
  'proposal:read:team','proposal:create:org','proposal:update:team',
  'contract:read:team','contract:create:org',
  'document:read:org','document:create:org',
  'service:read:org',
  'project:read:team','task:read:team','task:create:org','task:update:team',
  'kpi:read:org','report:read:org',
  'onboarding:read:org',
  'internal_note:read:org',
  'ai:use:org','ai:read:org',
  'email:read:org','email:draft:org','email:send:org',
  'automation:read:org'
]);

-- Project Manager: owns delivery org-wide.
select app.grant_permissions('project_manager', array[
  'company:read:org','contact:read:org',
  'opportunity:read:team','proposal:read:team','contract:read:team',
  'document:read:org','document:create:org','document:update:org',
  'service:read:org',
  'onboarding:read:org','onboarding:manage:org',
  'project:read:org','project:create:org','project:update:org',
  'task:read:org','task:create:org','task:update:org','task:delete:org',
  'kpi:read:org','kpi:manage:org',
  'report:read:org','report:manage:org',
  'internal_note:read:org',
  'ai:use:org','ai:read:org',
  'email:read:org','email:draft:org','email:send:org',
  'automation:read:org'
]);

-- Delivery: works the tasks assigned to them and the projects they are on.
select app.grant_permissions('delivery', array[
  'company:read:team','contact:read:team',
  'document:read:org','document:create:org',
  'service:read:org',
  'project:read:team',
  'task:read:team','task:create:org','task:update:own',
  'kpi:read:org','report:read:org',
  'ai:use:org',
  'email:read:org','email:draft:org'
]);

-- Client: portal only. Holds nothing internally; the portal reads through the
-- dedicated portal.* views rather than these permissions.
-- (No grants by design.)

comment on function app.grant_permissions is
  'Migration helper for wiring system roles to permission keys.';
