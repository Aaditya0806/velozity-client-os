/**
 * A no-op stand-in for the `server-only` package.
 *
 * `server-only` is a build-time guard: importing it from a Client Component is a
 * compile error, which is how modules holding secrets stay out of the browser
 * bundle. Next resolves it internally, so it exists only inside a Next build.
 *
 * The background worker, the migrator and the seeder are plain Node processes
 * that legitimately use the same modules — `lib/db`, `lib/config/env`, the
 * provider adapters — and there is no browser for them to leak into. Rather than
 * strip the guard from those modules and weaken it for the app, the scripts
 * resolve it here instead, via `tsconfig.scripts.json`.
 *
 * The app still uses the real one: Next reads the root tsconfig, which has no
 * such mapping.
 */
export {};
