/**
 * A small, deliberately limited WHERE-clause builder.
 *
 * It exists for one reason: to make parameterisation the only option. Callers
 * supply a SQL fragment containing `?` placeholders plus the values, and the
 * builder renumbers them to $1, $2 ... in order. There is no code path that
 * interpolates a value into SQL, and column identifiers are validated against an
 * allow-list before they can reach an ORDER BY.
 */

export class FilterBuilder {
  private readonly clauses: string[] = [];
  private readonly values: unknown[] = [];

  constructor(...initial: string[]) {
    this.clauses.push(...initial);
  }

  /**
   * Adds a condition. Each `?` in `fragment` consumes one value in order, so a
   * fragment may reference the same value twice by passing it twice.
   *
   *   b.where('(c.name ilike ? or c.email ilike ?)', pattern, pattern)
   */
  where(fragment: string, ...values: unknown[]): this {
    const expected = (fragment.match(/\?/g) ?? []).length;
    if (expected !== values.length) {
      throw new Error(
        `Filter fragment expects ${expected} value(s) but received ${values.length}: ${fragment}`,
      );
    }
    let index = 0;
    const rendered = fragment.replace(/\?/g, () => {
      this.values.push(values[index++]);
      return `$${this.values.length}`;
    });
    this.clauses.push(rendered);
    return this;
  }

  /** Adds a condition only when `value` is neither undefined nor null. */
  whereIf(value: unknown, fragment: string, ...values: unknown[]): this {
    if (value === undefined || value === null || value === '') return this;
    return this.where(fragment, ...(values.length > 0 ? values : [value]));
  }

  /** Appends a value without a clause, for use in LIMIT/OFFSET. */
  bind(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  get sql(): string {
    return this.clauses.length > 0 ? this.clauses.join(' and ') : 'true';
  }

  get params(): unknown[] {
    return [...this.values];
  }

  /** Current parameter count, so a caller can continue numbering safely. */
  get length(): number {
    return this.values.length;
  }
}

export function filters(...initial: string[]): FilterBuilder {
  return new FilterBuilder(...initial);
}
