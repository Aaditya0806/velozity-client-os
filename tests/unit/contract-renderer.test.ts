import { describe, it, expect } from 'vitest';
import {
  renderTemplate, validateTemplate, extractPlaceholders, missingRequired,
  type TemplateVariable,
} from '@/lib/contracts/renderer';

const variables: TemplateVariable[] = [
  { key: 'client_name', label: 'Client name', type: 'string', required: true },
  { key: 'company_name', label: 'Our company', type: 'string', required: true },
  { key: 'contract_value', label: 'Contract value', type: 'money', required: true },
  { key: 'effective_date', label: 'Effective date', type: 'date', required: true },
  { key: 'project_name', label: 'Project name', type: 'string', required: false },
];

const body = `This agreement is made between {{company_name}} and {{client_name}}
for a total value of {{contract_value}}, effective {{effective_date}}.
Project: {{project_name}}.`;

describe('contract template rendering', () => {
  it('substitutes every declared variable', () => {
    const result = renderTemplate(body, variables, {
      client_name: 'Northwind Analytics Ltd',
      company_name: 'Velozity Global',
      contract_value: '48000.00',
      effective_date: '2026-10-01',
      project_name: 'Attribution rebuild',
    });

    expect(result.body).toContain('Velozity Global');
    expect(result.body).toContain('Northwind Analytics Ltd');
    expect(result.body).toContain('48000.00');
    expect(result.body).toContain('2026-10-01');
    expect(result.body).not.toContain('{{');
    expect(result.used.client_name).toBe('Northwind Analytics Ltd');
  });

  it('FAILS rather than inventing a value for a missing required variable', () => {
    expect(() =>
      renderTemplate(body, variables, {
        client_name: 'Northwind Analytics Ltd',
        company_name: 'Velozity Global',
        // contract_value deliberately absent
        effective_date: '2026-10-01',
      }),
    ).toThrowError(/cannot be produced/);

    try {
      renderTemplate(body, variables, { client_name: 'X', company_name: 'Y' });
    } catch (error) {
      const details = (error as { details: { missing: Array<{ key: string }> } }).details;
      expect(details.missing.map((m) => m.key).sort()).toEqual([
        'contract_value',
        'effective_date',
      ]);
    }
  });

  it('never leaves a placeholder in a non-preview render', () => {
    const result = renderTemplate(body, variables, {
      client_name: 'A',
      company_name: 'B',
      contract_value: '1.00',
      effective_date: '2026-01-01',
      // project_name is optional and absent
    });
    expect(result.body).not.toMatch(/\{\{/);
    expect(result.body).toContain('Project: .');
  });

  it('marks missing values visibly in a preview instead of failing', () => {
    const result = renderTemplate(body, variables, { client_name: 'A' }, { preview: true });
    expect(result.body).toContain('[MISSING: Our company]');
    expect(result.body).toContain('[MISSING: Contract value]');
  });

  it('rejects a placeholder that is not declared as a variable', () => {
    expect(() =>
      renderTemplate('Signed by {{secret_clause}}', variables, {}),
    ).toThrowError(/not declared as variables/);
  });

  it('refuses a money value that is not numeric', () => {
    expect(() =>
      renderTemplate('{{contract_value}}', variables, { contract_value: 'about forty thousand' }),
    ).toThrowError(/not numeric/);
  });

  it('refuses a date value that is not a date', () => {
    expect(() =>
      renderTemplate('{{effective_date}}', variables, { effective_date: 'next Tuesday-ish' }),
    ).toThrowError(/not a valid date/);
  });

  it('does not interpret anything beyond substitution', () => {
    // No conditionals, no loops, no expressions: these are literal text.
    const template = '{{#if x}}should not render{{/if}} {{client_name}}';
    const result = renderTemplate(template, variables, { client_name: 'Acme' }, { preview: true });
    expect(result.body).toContain('{{#if x}}');
    expect(result.body).toContain('Acme');
  });

  it('renders deterministically', () => {
    const values = {
      client_name: 'A', company_name: 'B', contract_value: '100.00',
      effective_date: '2026-01-01', project_name: 'P',
    };
    const first = renderTemplate(body, variables, values);
    const second = renderTemplate(body, variables, values);
    expect(first.body).toBe(second.body);
  });

  it('finds every placeholder in a template', () => {
    expect(extractPlaceholders(body)).toEqual([
      'client_name', 'company_name', 'contract_value', 'effective_date', 'project_name',
    ]);
  });

  it('flags a template whose placeholders are undeclared', () => {
    const { errors } = validateTemplate('Hello {{unknown_var}}', variables);
    expect(errors.some((e) => e.includes('unknown_var'))).toBe(true);
  });

  it('warns about a declared variable that is never used', () => {
    const { warnings } = validateTemplate('{{client_name}}', variables);
    expect(warnings.some((w) => w.includes('company_name'))).toBe(true);
  });

  it('lists required variables still awaiting a value', () => {
    const missing = missingRequired(variables, { client_name: 'A', contract_value: '  ' });
    expect(missing.map((v) => v.key).sort()).toEqual([
      'company_name', 'contract_value', 'effective_date',
    ]);
  });
});
