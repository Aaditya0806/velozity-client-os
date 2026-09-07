/**
 * Configuration that is safe to reach the browser.
 *
 * Next.js inlines NEXT_PUBLIC_* at build time; nothing else belongs here.
 */
export const publicConfig = {
  appName: 'Velozity Business OS',
  appShortName: 'Velozity',
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000',
  sentryDsn: process.env.NEXT_PUBLIC_SENTRY_DSN ?? '',
} as const;
