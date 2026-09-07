/**
 * The builder's field metadata against the engine's schemas.
 *
 * The action list is closed — that is the safety property the whole automation
 * design rests on, and in particular there is no action that sends email. A
 * builder that could offer a twelfth action, or offer the wrong parameters for
 * an existing one, would either produce automations the server rejects or,
 * worse, quietly stop offering a parameter that still matters.
 *
 * These tests make the two lists impossible to drift apart silently.
 */
import { describe, it, expect } from 'vitest';
import {
  ACTION_TYPES,
  CONDITION_OPERATORS,
  SETTABLE_FIELDS,
  actionSchema,
  automationSchema,
} from '@/lib/automation/actions';
import {
  ACTION_SPECS,
  ORDERED_ACTIONS,
  OPERATOR_LABELS,
  VALUELESS_OPERATORS,
} from '@/lib/automation/builder-meta';

describe('automation builder metadata', () => {
  it('describes every action the engine accepts, and no others', () => {
    expect(Object.keys(ACTION_SPECS).sort()).toEqual([...ACTION_TYPES].sort());
    expect(ORDERED_ACTIONS.map((spec) => spec.type)).toEqual([...ACTION_TYPES]);
  });

  it('offers no way to send an email', () => {
    // The single most important line in this file. Automations draft; people
    // send. A builder that offered "send_email" would be offering something the
    // schema refuses — but it would also be advertising a capability this
    // product deliberately does not have.
    const labels = ORDERED_ACTIONS.map((spec) => `${spec.type} ${spec.label}`.toLowerCase());
    for (const label of labels) {
      expect(label).not.toMatch(/send.*email|email.*send/);
    }
    expect(ACTION_TYPES).not.toContain('send_email' as never);
  });

  it('labels every operator the engine accepts', () => {
    for (const operator of CONDITION_OPERATORS) {
      expect(OPERATOR_LABELS[operator], `${operator} needs a label`).toBeTruthy();
    }
  });

  it('treats only the value-free operators as value-free', () => {
    for (const operator of VALUELESS_OPERATORS) {
      expect(CONDITION_OPERATORS).toContain(operator);
    }
    expect([...VALUELESS_OPERATORS]).toEqual(['is_null', 'is_not_null']);
  });

  it('offers only fields the engine will actually set', () => {
    const spec = ACTION_SPECS.set_field;
    const field = spec.fields.find((f) => f.key === 'field');
    expect(field?.options).toEqual([...SETTABLE_FIELDS]);
  });

  it('never offers a lifecycle column as a settable field', () => {
    // Stage and status changes go through the transition service so the guards
    // run. If one ever appeared here it would mean the allow-list had grown.
    for (const field of SETTABLE_FIELDS) {
      expect(field).not.toMatch(/\.(stage|status)$/);
    }
  });

  it('produces a valid action for every type when its defaults are filled in', () => {
    // Walks every action the builder can create with only its defaults plus a
    // placeholder for each required field, and checks the engine's schema
    // accepts the shape. This is what catches a spec that names a parameter the
    // schema does not have, or misses one it requires.
    const placeholders: Record<string, unknown> = {
      template: 'a_template',
      to: 'primary_contact',
      contract_type: 'nda',
      target: 'company.owner',
      title: 'A title',
      user_id: '00000000-0000-4000-8000-000000000000',
      tag: 'a-tag',
      field: SETTABLE_FIELDS[0],
      value: 'a value',
      name: 'A requirement',
      action_type: 'draft_email',
    };

    for (const spec of ORDERED_ACTIONS) {
      const params: Record<string, unknown> = {};
      for (const field of spec.fields) {
        if (field.default !== undefined) params[field.key] = field.default;
        if (field.required) params[field.key] = placeholders[field.key] ?? 'value';
      }

      const result = actionSchema.safeParse({ type: spec.type, params });
      expect(
        result.success,
        `${spec.type} built from its spec should validate: ${
          result.success ? '' : JSON.stringify(result.error.issues)
        }`,
      ).toBe(true);
    }
  });

  it('rejects an automation with no actions', () => {
    const result = automationSchema.safeParse({
      name: 'Empty',
      trigger_event: 'opportunity.won',
      actions: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown action type outright', () => {
    const result = automationSchema.safeParse({
      name: 'Sneaky',
      trigger_event: 'opportunity.won',
      actions: [{ type: 'send_email', params: { to: 'someone@example.com' } }],
    });
    expect(result.success).toBe(false);
  });

  it('caps chain depth and action count where the engine does', () => {
    const tooDeep = automationSchema.safeParse({
      name: 'Deep',
      trigger_event: 'opportunity.won',
      actions: [{ type: 'add_tag', params: { tag: 'x' } }],
      max_depth: 6,
    });
    expect(tooDeep.success).toBe(false);

    const tooMany = automationSchema.safeParse({
      name: 'Many',
      trigger_event: 'opportunity.won',
      actions: Array.from({ length: 11 }, () => ({ type: 'add_tag', params: { tag: 'x' } })),
    });
    expect(tooMany.success).toBe(false);
  });
});
