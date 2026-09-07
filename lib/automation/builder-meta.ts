/**
 * Field metadata for the automation builder.
 *
 * The Zod schemas in `actions.ts` say what is *valid*; this says how to ask for
 * it. Kept next to them and derived from the same enumerations, so an action
 * that gains a parameter cannot quietly go un-editable — but deliberately
 * separate, because presentation is not validation and the engine must never
 * import this.
 */
import { ACTION_TYPES, SETTABLE_FIELDS, type ActionType } from './actions';

export interface FieldSpec {
  key: string;
  label: string;
  /** How to render it. */
  kind: 'text' | 'textarea' | 'select' | 'number' | 'boolean';
  options?: readonly string[];
  placeholder?: string;
  hint?: string;
  required?: boolean;
  default?: unknown;
}

export interface ActionSpec {
  type: ActionType;
  label: string;
  /** One sentence on what it does, and where relevant what it does not do. */
  description: string;
  fields: readonly FieldSpec[];
}

export const ACTION_SPECS: Record<ActionType, ActionSpec> = {
  draft_email: {
    type: 'draft_email',
    label: 'Draft an email',
    description:
      'Writes a draft and puts it in the outbox for a person to review. It is never sent automatically — there is no action in this product that sends email without approval.',
    fields: [
      { key: 'template', label: 'Template key', kind: 'text', required: true, placeholder: 'proposal_follow_up' },
      {
        key: 'to',
        label: 'Recipient',
        kind: 'select',
        required: true,
        options: ['primary_contact', 'decision_maker', 'billing_contact', 'opportunity_owner'],
      },
    ],
  },
  generate_contract: {
    type: 'generate_contract',
    label: 'Generate a contract',
    description:
      'Renders a contract from its template as a draft. It is not sent, and not signed.',
    fields: [
      {
        key: 'contract_type',
        label: 'Type',
        kind: 'select',
        required: true,
        options: ['nda', 'msa', 'sow', 'addendum', 'amendment', 'other'],
      },
      { key: 'template_key', label: 'Template key', kind: 'text', placeholder: 'Leave blank for the default' },
    ],
  },
  notify: {
    type: 'notify',
    label: 'Notify someone',
    description: 'Sends an in-app notification.',
    fields: [
      {
        key: 'target',
        label: 'Who',
        kind: 'select',
        required: true,
        options: [
          'opportunity.owner', 'company.owner', 'project.manager', 'task.assignee',
          'role:legal_admin', 'role:finance', 'role:management',
        ],
      },
      { key: 'title', label: 'Title', kind: 'text', required: true },
      { key: 'body', label: 'Body', kind: 'textarea' },
      { key: 'priority', label: 'Priority', kind: 'select', options: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
    ],
  },
  create_task: {
    type: 'create_task',
    label: 'Create a task',
    description: 'Adds a task, optionally assigned and due a number of days out.',
    fields: [
      { key: 'title', label: 'Title', kind: 'text', required: true },
      { key: 'description', label: 'Description', kind: 'textarea' },
      {
        key: 'assign_to',
        label: 'Assign to',
        kind: 'select',
        options: ['opportunity.owner', 'company.owner', 'project.manager', 'unassigned'],
        default: 'unassigned',
      },
      { key: 'due_in_days', label: 'Due in (days)', kind: 'number', default: 3 },
      { key: 'priority', label: 'Priority', kind: 'select', options: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
    ],
  },
  assign_owner: {
    type: 'assign_owner',
    label: 'Assign an owner',
    description: 'Sets the owner of the record the event was about.',
    fields: [
      { key: 'user_id', label: 'User', kind: 'select', required: true, hint: 'Anyone in this organisation' },
    ],
  },
  add_tag: {
    type: 'add_tag',
    label: 'Add a tag',
    description: 'Tags the record.',
    fields: [{ key: 'tag', label: 'Tag', kind: 'text', required: true }],
  },
  set_field: {
    type: 'set_field',
    label: 'Set a field',
    description:
      'Sets one of a short list of non-consequential fields. Lifecycle columns are absent on purpose: a stage or status change goes through the transition service, which runs its guards.',
    fields: [
      { key: 'field', label: 'Field', kind: 'select', required: true, options: SETTABLE_FIELDS },
      { key: 'value', label: 'Value', kind: 'text', required: true },
    ],
  },
  create_payment_requirement: {
    type: 'create_payment_requirement',
    label: 'Create a payment requirement',
    description: 'Adds a payment condition, which can block onboarding until met.',
    fields: [
      { key: 'name', label: 'Name', kind: 'text', required: true },
      {
        key: 'requirement_type',
        label: 'Type',
        kind: 'select',
        options: ['advance', 'milestone', 'final', 'full'],
        default: 'advance',
      },
      { key: 'percent_of_value', label: 'Percent of value', kind: 'number', hint: 'Or give a fixed amount below' },
      { key: 'amount', label: 'Fixed amount', kind: 'text', placeholder: '5000.00' },
      { key: 'blocks_onboarding', label: 'Blocks onboarding', kind: 'boolean', default: true },
    ],
  },
  start_onboarding: {
    type: 'start_onboarding',
    label: 'Start onboarding',
    description:
      'Opens the onboarding checklist. The legal gate still applies — this does not skip it.',
    fields: [],
  },
  request_ai_action: {
    type: 'request_ai_action',
    label: 'Ask the AI to draft something',
    description:
      'Queues a draft for a person to approve. The model cannot write to any record; its output is a proposal.',
    fields: [
      {
        key: 'action_type',
        label: 'What to draft',
        kind: 'select',
        required: true,
        options: [
          'draft_diagnosis', 'draft_email', 'suggest_contract_variables',
          'summarize_discovery', 'suggest_tasks',
        ],
      },
    ],
  },
  add_activity: {
    type: 'add_activity',
    label: 'Add a timeline note',
    description: 'Writes a note on the record’s timeline.',
    fields: [
      { key: 'title', label: 'Title', kind: 'text', required: true },
      { key: 'body', label: 'Body', kind: 'textarea' },
      { key: 'is_internal', label: 'Internal only', kind: 'boolean', default: true, hint: 'Internal notes never appear in the client portal' },
    ],
  },
};

/** Guarantees the two lists cannot drift: every action type has a spec. */
export const ORDERED_ACTIONS: ActionSpec[] = ACTION_TYPES.map((type) => ACTION_SPECS[type]);

export const OPERATOR_LABELS: Record<string, string> = {
  eq: 'is',
  ne: 'is not',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  in: 'is one of',
  not_in: 'is not one of',
  contains: 'contains',
  not_contains: 'does not contain',
  is_null: 'is empty',
  is_not_null: 'is not empty',
  starts_with: 'starts with',
  changed_to: 'changed to',
};

/** Operators that take no value. */
export const VALUELESS_OPERATORS = ['is_null', 'is_not_null'] as const;
