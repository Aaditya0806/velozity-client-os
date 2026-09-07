/**
 * The automation action enumeration.
 *
 * Closed by construction. An automation is data, and the only things it can ask
 * for are the entries below — there is no expression language, no scripting, no
 * arbitrary HTTP call.
 *
 * Note what is absent: there is no `send_email` and no `send_contract`. An
 * automation may *draft* an email and it may *generate* a contract, but a person
 * holding the relevant permission decides whether either one leaves the
 * building. That is the difference between automating the work and automating
 * the commitment.
 */
import { z } from 'zod';

export const ACTION_TYPES = [
  'draft_email',
  'generate_contract',
  'notify',
  'create_task',
  'assign_owner',
  'add_tag',
  'set_field',
  'create_payment_requirement',
  'start_onboarding',
  'request_ai_action',
  'add_activity',
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * A field an automation may set.
 *
 * Deliberately a short allow-list of non-consequential attributes. Lifecycle
 * columns are absent: state changes go through the transition service, which
 * runs guards. An automation cannot set `stage`, `status`, `amount` or anything
 * a contract depends on.
 */
export const SETTABLE_FIELDS = [
  'opportunity.probability',
  'opportunity.expected_close_date',
  'opportunity.campaign',
  'company.lifecycle_stage',
  'company.health_status',
  'project.health',
  'project.reporting_cadence',
] as const;

export const actionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('draft_email'),
    params: z.object({
      template: z.string().max(80),
      to: z.enum(['primary_contact', 'decision_maker', 'billing_contact', 'opportunity_owner']),
      /** Drafts always require approval; this is not configurable. */
      variables: z.record(z.unknown()).default({}),
    }),
  }),
  z.object({
    type: z.literal('generate_contract'),
    params: z.object({
      contract_type: z.enum(['nda', 'msa', 'sow', 'addendum', 'amendment', 'other']),
      template_key: z.string().max(80).optional(),
    }),
  }),
  z.object({
    type: z.literal('notify'),
    params: z.object({
      target: z.enum([
        'opportunity.owner',
        'company.owner',
        'project.manager',
        'task.assignee',
        'role:legal_admin',
        'role:finance',
        'role:management',
      ]),
      title: z.string().max(200),
      body: z.string().max(1000).optional(),
      priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
    }),
  }),
  z.object({
    type: z.literal('create_task'),
    params: z.object({
      title: z.string().max(300),
      description: z.string().max(5000).optional(),
      assign_to: z
        .enum(['opportunity.owner', 'company.owner', 'project.manager', 'unassigned'])
        .default('unassigned'),
      due_in_days: z.number().int().min(0).max(365).default(3),
      priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
    }),
  }),
  z.object({
    type: z.literal('assign_owner'),
    params: z.object({ user_id: z.string().uuid() }),
  }),
  z.object({
    type: z.literal('add_tag'),
    params: z.object({ tag: z.string().max(50) }),
  }),
  z.object({
    type: z.literal('set_field'),
    params: z.object({
      field: z.enum(SETTABLE_FIELDS),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    }),
  }),
  z.object({
    type: z.literal('create_payment_requirement'),
    params: z.object({
      name: z.string().max(200),
      percent_of_value: z.number().min(0.01).max(100).optional(),
      amount: z.string().optional(),
      requirement_type: z.enum(['advance', 'milestone', 'final', 'full']).default('advance'),
      blocks_onboarding: z.boolean().default(true),
    }),
  }),
  z.object({
    type: z.literal('start_onboarding'),
    params: z.object({}).default({}),
  }),
  z.object({
    type: z.literal('request_ai_action'),
    params: z.object({
      action_type: z.enum([
        'draft_diagnosis',
        'draft_email',
        'suggest_contract_variables',
        'summarize_discovery',
        'suggest_tasks',
      ]),
    }),
  }),
  z.object({
    type: z.literal('add_activity'),
    params: z.object({
      title: z.string().max(200),
      body: z.string().max(2000).optional(),
      is_internal: z.boolean().default(true),
    }),
  }),
]);

export type AutomationAction = z.infer<typeof actionSchema>;

// -----------------------------------------------------------------------------
// Conditions
// -----------------------------------------------------------------------------

export const CONDITION_OPERATORS = [
  'eq', 'ne', 'gt', 'gte', 'lt', 'lte',
  'in', 'not_in', 'contains', 'not_contains',
  'is_null', 'is_not_null', 'starts_with', 'changed_to',
] as const;

export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export const conditionSchema = z.object({
  /** Dotted path into the input snapshot, e.g. `client.nda_status`. */
  path: z.string().max(120).regex(/^[a-z_][a-z0-9_.]*$/i, 'Invalid condition path.'),
  op: z.enum(CONDITION_OPERATORS),
  value: z.unknown().optional(),
});

export type Condition = z.infer<typeof conditionSchema>;

export const automationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  is_active: z.boolean().default(false),
  trigger_event: z.string().max(80),
  trigger_filter: z.record(z.unknown()).default({}),
  conditions: z.array(conditionSchema).max(20).default([]),
  actions: z.array(actionSchema).min(1).max(10),
  max_depth: z.number().int().min(1).max(5).default(5),
  cooldown_seconds: z.number().int().min(0).max(86_400).default(60),
});

export type AutomationDefinition = z.infer<typeof automationSchema>;
