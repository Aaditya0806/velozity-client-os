/**
 * Contract template rendering.
 *
 * Deliberately the least clever code in the system.
 *
 * A template is legal text containing {{variable}} placeholders. The renderer
 * substitutes declared variables and does nothing else: no conditionals, no
 * loops, no expressions, no defaults, no partial matches. If a required variable
 * has no value the render FAILS. It never invents one, and it never leaves the
 * placeholder in the output where a human might sign around it.
 *
 * This is why AI is allowed to propose variable *values* but never to generate
 * clause text: the surface it can influence is exactly the set of declared
 * variables, and every one of them is shown to a person before anything is sent.
 */
import { AppError } from '@/lib/http/errors';

export type VariableType = 'string' | 'number' | 'date' | 'money' | 'multiline';

export interface TemplateVariable {
  key: string;
  label: string;
  type: VariableType;
  required: boolean;
  description?: string;
  /** Where the value normally comes from, e.g. `company.legal_name`. */
  source_hint?: string;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
const VALID_KEY = /^[a-zA-Z0-9_.]{1,64}$/;

export interface RenderResult {
  body: string;
  /** The exact values substituted, stored on the contract for reproducibility. */
  used: Record<string, string>;
}

/**
 * Extracts every placeholder that appears in a template body.
 * Used to validate that the declared variable list actually covers the text.
 */
export function extractPlaceholders(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(PLACEHOLDER)) {
    const key = match[1];
    if (key) found.add(key);
  }
  return [...found].sort();
}

/**
 * Checks a template for internal consistency before it is made active:
 * every placeholder must be declared, and every declared variable should appear.
 */
export function validateTemplate(
  body: string,
  variables: TemplateVariable[],
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const declared = new Set(variables.map((v) => v.key));
  const used = extractPlaceholders(body);

  for (const variable of variables) {
    if (!VALID_KEY.test(variable.key)) {
      errors.push(`Variable key "${variable.key}" contains unsupported characters.`);
    }
  }

  for (const key of used) {
    if (!declared.has(key)) {
      errors.push(`The template uses {{${key}}} but does not declare it as a variable.`);
    }
  }

  for (const key of declared) {
    if (!used.includes(key)) {
      warnings.push(`Variable "${key}" is declared but never appears in the template body.`);
    }
  }

  if (used.length === 0 && variables.length > 0) {
    warnings.push('This template declares variables but contains no placeholders.');
  }

  return { errors, warnings };
}

export interface RenderOptions {
  /**
   * Rendering a preview tolerates missing values, marking them visibly so a
   * draft can be reviewed before every field is known. A preview is never
   * sendable: `render()` is called again without this flag before signing.
   */
  preview?: boolean;
}

export function renderTemplate(
  body: string,
  variables: TemplateVariable[],
  values: Record<string, unknown>,
  options: RenderOptions = {},
): RenderResult {
  const declared = new Map(variables.map((v) => [v.key, v]));
  const used: Record<string, string> = {};
  const missing: string[] = [];
  const undeclared: string[] = [];

  const output = body.replace(PLACEHOLDER, (_match, rawKey: string) => {
    const key = rawKey.trim();
    const variable = declared.get(key);

    if (!variable) {
      // An undeclared placeholder means the template and its variable list have
      // drifted. Substituting anything here would be guessing.
      undeclared.push(key);
      return options.preview ? `[UNDECLARED: ${key}]` : '';
    }

    const raw = values[key];
    const value = formatValue(raw, variable.type);

    if (value === null || value === '') {
      if (variable.required) {
        missing.push(key);
        return options.preview ? `[MISSING: ${variable.label}]` : '';
      }
      used[key] = '';
      return '';
    }

    used[key] = value;
    return value;
  });

  if (undeclared.length > 0) {
    throw new AppError(
      'MISSING_TEMPLATE_VARIABLE',
      'This template contains placeholders that are not declared as variables.',
      { details: { undeclared: [...new Set(undeclared)] } },
    );
  }

  if (missing.length > 0 && !options.preview) {
    throw new AppError(
      'MISSING_TEMPLATE_VARIABLE',
      `This contract cannot be produced: ${missing.length} required value(s) are missing.`,
      {
        details: {
          missing: [...new Set(missing)].map((key) => ({
            key,
            label: declared.get(key)?.label ?? key,
            source_hint: declared.get(key)?.source_hint ?? null,
          })),
        },
      },
    );
  }

  return { body: output, used };
}

/**
 * Values are formatted, never coerced into something they are not. A null stays
 * null so the required check can see it, rather than becoming the string "null"
 * in a signed agreement.
 */
function formatValue(raw: unknown, type: VariableType): string | null {
  if (raw === null || raw === undefined) return null;

  switch (type) {
    case 'number':
    case 'money': {
      const text = String(raw).trim();
      if (text === '') return null;
      if (!/^-?\d+(\.\d+)?$/.test(text)) {
        throw new AppError(
          'MISSING_TEMPLATE_VARIABLE',
          `A ${type} variable received a value that is not numeric.`,
          { details: { value: text } },
        );
      }
      return text;
    }
    case 'date': {
      const text = String(raw).trim();
      if (text === '') return null;
      const parsed = new Date(text);
      if (Number.isNaN(parsed.getTime())) {
        throw new AppError(
          'MISSING_TEMPLATE_VARIABLE',
          'A date variable received a value that is not a valid date.',
          { details: { value: text } },
        );
      }
      return parsed.toISOString().slice(0, 10);
    }
    default: {
      const text = String(raw).trim();
      return text === '' ? null : text;
    }
  }
}

/**
 * Which required variables still lack a value.
 * Used by the UI to show what a person must supply before a contract can be sent.
 */
export function missingRequired(
  variables: TemplateVariable[],
  values: Record<string, unknown>,
): TemplateVariable[] {
  return variables.filter((v) => {
    if (!v.required) return false;
    const raw = values[v.key];
    return raw === null || raw === undefined || String(raw).trim() === '';
  });
}
