/**
 * Environment configuration.
 *
 * Parsed once, validated with Zod, and split explicitly into server-only and
 * public halves. Importing `serverEnv` from a Client Component is a build error,
 * which is the point: there is no path by which a secret reaches the browser.
 */
import 'server-only';
import { z } from 'zod';

const bool = z
  .string()
  .transform((v) => v === 'true' || v === '1')
  .pipe(z.boolean());

const serverSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // --- Database -------------------------------------------------------------
  // Direct PostgreSQL connection used for every user-facing query. The
  // application connects as a low-privilege login role and assumes the
  // `authenticated` role per transaction so RLS applies.
  DATABASE_URL: z.string().url(),
  // Separate URL for background workers, which may assume `service_role`.
  DATABASE_ADMIN_URL: z.string().url().optional(),
  // Supabase's session pooler caps a project at 15 clients. The admin pool
  // takes a third of this on top, so 8 leaves headroom for psql, migrations and
  // a second running instance.
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(8),
  DATABASE_SSL: bool.default('true'),

  // --- Supabase -------------------------------------------------------------
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  // Never used in a request path. Restricted to trusted background jobs.
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  SUPABASE_STORAGE_BUCKET: z.string().default('documents'),

  // --- AI -------------------------------------------------------------------
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),
  AI_ENABLED: bool.default('true'),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().default(4096),

  // --- Email ----------------------------------------------------------------
  EMAIL_PROVIDER: z.enum(['resend', 'ses', 'noop']).default('noop'),
  EMAIL_FROM_ADDRESS: z.string().email().default('no-reply@example.com'),
  EMAIL_FROM_NAME: z.string().default('Velozity'),
  RESEND_API_KEY: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),
  AWS_SES_REGION: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),
  SES_WEBHOOK_SECRET: z.string().optional(),
  // Required for SES to emit delivery, bounce and complaint events at all; a
  // message sent without one is delivered but silently untracked.
  SES_CONFIGURATION_SET: z.string().optional(),

  // --- E-signature ----------------------------------------------------------
  SIGNATURE_PROVIDER: z.enum(['zoho_sign', 'manual']).default('manual'),
  ZOHO_SIGN_CLIENT_ID: z.string().optional(),
  ZOHO_SIGN_CLIENT_SECRET: z.string().optional(),
  ZOHO_SIGN_REFRESH_TOKEN: z.string().optional(),
  ZOHO_SIGN_API_BASE: z.string().url().default('https://sign.zoho.com/api/v1'),
  ZOHO_SIGN_ACCOUNTS_BASE: z.string().url().default('https://accounts.zoho.com'),
  ZOHO_SIGN_WEBHOOK_SECRET: z.string().optional(),

  // --- Observability --------------------------------------------------------
  SENTRY_DSN: z.string().optional(),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // --- Application ----------------------------------------------------------
  APP_URL: z.string().url().default('http://localhost:3000'),
  // Used to sign internal tokens (portal invitations, download grants).
  APP_SECRET: z.string().min(32).default('dev-only-insecure-secret-change-me-please-32'),
  RATE_LIMIT_ENABLED: bool.default('true'),
  SEED_DEMO_PASSWORD: z.string().default('Velozity!Demo2026'),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | null = null;

/**
 * In a .env file, `KEY=` means "not configured" — it is how every template
 * ships an optional setting. Zod disagrees: `.optional()` admits `undefined`,
 * not `''`, so an empty optional URL fails validation and takes the whole
 * environment down with it.
 *
 * Stripping empty values before parsing makes the file mean what its author
 * intended, and lets `.default()` apply where there is one.
 */
function withoutEmptyValues(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== '') out[key] = value;
  }
  return out;
}

/**
 * Validated server environment. Throws on first access if configuration is
 * missing, so a misconfigured deployment fails at boot rather than at the first
 * contract send.
 */
export function serverEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = serverSchema.safeParse(withoutEmptyValues(process.env));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Reset the memoised environment. Test-only. */
export function resetEnvCache(): void {
  cached = null;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}
