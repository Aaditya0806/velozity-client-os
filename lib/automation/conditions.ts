/**
 * Condition evaluation.
 *
 * Pure, total and side-effect free: it reads a snapshot and returns booleans.
 * There is no `eval`, no template execution and no way for a condition to reach
 * the database — the snapshot is assembled once, before evaluation, so what an
 * automation decided on is exactly what gets recorded in its run history.
 */
import type { Condition } from './actions';

export interface ConditionResult {
  path: string;
  op: string;
  expected: unknown;
  actual: unknown;
  passed: boolean;
}

/** Reads a dotted path. Missing segments yield undefined rather than throwing. */
export function readPath(snapshot: unknown, path: string): unknown {
  let cursor: unknown = snapshot;
  for (const segment of path.split('.')) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function compareNumbers(a: unknown, b: unknown): number | null {
  const x = typeof a === 'number' ? a : Number.parseFloat(String(a));
  const y = typeof b === 'number' ? b : Number.parseFloat(String(b));
  if (Number.isNaN(x) || Number.isNaN(y)) return null;
  return x === y ? 0 : x < y ? -1 : 1;
}

export function evaluateCondition(snapshot: unknown, condition: Condition): ConditionResult {
  const actual = readPath(snapshot, condition.path);
  const expected = condition.value;
  let passed = false;

  switch (condition.op) {
    case 'eq':
      passed = String(actual ?? '') === String(expected ?? '');
      break;
    case 'ne':
      passed = String(actual ?? '') !== String(expected ?? '');
      break;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const cmp = compareNumbers(actual, expected);
      if (cmp === null) {
        passed = false;
      } else {
        passed =
          condition.op === 'gt' ? cmp > 0
          : condition.op === 'gte' ? cmp >= 0
          : condition.op === 'lt' ? cmp < 0
          : cmp <= 0;
      }
      break;
    }
    case 'in':
      passed = Array.isArray(expected) && expected.map(String).includes(String(actual));
      break;
    case 'not_in':
      passed = !Array.isArray(expected) || !expected.map(String).includes(String(actual));
      break;
    case 'contains':
      passed = Array.isArray(actual)
        ? actual.map(String).includes(String(expected))
        : String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
      break;
    case 'not_contains':
      passed = Array.isArray(actual)
        ? !actual.map(String).includes(String(expected))
        : !String(actual ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
      break;
    case 'starts_with':
      passed = String(actual ?? '').toLowerCase().startsWith(String(expected ?? '').toLowerCase());
      break;
    case 'is_null':
      passed = actual === null || actual === undefined || actual === '';
      break;
    case 'is_not_null':
      passed = actual !== null && actual !== undefined && actual !== '';
      break;
    case 'changed_to':
      // Reads the transition payload rather than the entity, so "became won" is
      // distinguishable from "is won".
      passed = String(readPath(snapshot, 'event.to') ?? '') === String(expected ?? '');
      break;
    default:
      passed = false;
  }

  return { path: condition.path, op: condition.op, expected, actual, passed };
}

/** All conditions must pass. AND is the only combinator, deliberately. */
export function evaluateConditions(
  snapshot: unknown,
  conditions: readonly Condition[],
): { passed: boolean; results: ConditionResult[] } {
  const results = conditions.map((c) => evaluateCondition(snapshot, c));
  return { passed: results.every((r) => r.passed), results };
}

/**
 * The trigger filter is a shallow equality match against the event payload,
 * so `{ "to": "won" }` narrows `opportunity.stage_changed` to the won case.
 */
export function matchesTriggerFilter(
  payload: Record<string, unknown>,
  filter: Record<string, unknown>,
): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    if (String(payload[key] ?? '') !== String(expected ?? '')) return false;
  }
  return true;
}
