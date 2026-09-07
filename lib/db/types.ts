/**
 * A minimal SQL client surface, implemented by node-postgres in production and
 * by PGlite in tests. Everything above this line is written once and runs
 * identically against both.
 */
export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export interface SqlExecutor {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
}

export interface SqlConnection extends SqlExecutor {
  release(): void;
}

export interface SqlDriver extends SqlExecutor {
  connect(): Promise<SqlConnection>;
  end(): Promise<void>;
}

/** Identity and tenant context carried into every database transaction. */
export interface DbContext {
  /**
   * Supabase Auth user id, becoming request.jwt.claims.sub.
   * NULL only for service-role background work, which has no user.
   */
  userId: string | null;
  /** The organisation this request is scoped to. */
  orgId: string | null;
  /** Correlation id, exposed to triggers via app.request_id. */
  requestId?: string;
  /** Additional JWT claims to expose, e.g. role, email. */
  claims?: Record<string, unknown>;
}
