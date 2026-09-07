# =============================================================================
# Velozity Business OS — environment configuration
#
# Copy to .env and fill in. Never commit a real .env.
# Variables prefixed NEXT_PUBLIC_ are inlined into the browser bundle; nothing
# secret may ever carry that prefix.
# =============================================================================

NODE_ENV=development

# --- Database ----------------------------------------------------------------
# Direct PostgreSQL connection. On Supabase this is Settings → Database →
# Connection string (use the session pooler for serverless deployments).
# The application connects with this role and assumes `authenticated` per
# transaction, so RLS applies to every user-facing query.
DATABASE_URL=postgresql://postgres.tvwfijhofphtjthagkva:Supabase%4012345@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres

# Optional separate connection for background workers that assume service_role.
# Falls back to DATABASE_URL when unset.
DATABASE_ADMIN_URL=

DATABASE_POOL_MAX=10
# Set false only for a local database without TLS.
DATABASE_SSL=true

# --- Supabase ----------------------------------------------------------------
SUPABASE_URL=https://tvwfijhofphtjthagkva.supabase.co
SUPABASE_ANON_KEY=sb_publishable_xgv7wXZjrW8-2iWjm-eKHw_3Fz1Rj22
# Bypasses RLS entirely. Used only by background jobs and storage operations
# that have already performed their own permission check. Never sent to a client.
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR2d2ZpamhvZnBodGp0aGFna3ZhIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4ODUzNzY4NCwiZXhwIjoyMTA0MTEzNjg0fQ.Ply2cMa9gyrPl8bzdSbrxNwIwPYdoJTYAx4lBMY_miM
SUPABASE_STORAGE_BUCKET=documents

NEXT_PUBLIC_SUPABASE_URL=https://tvwfijhofphtjthagkva.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_xgv7wXZjrW8-2iWjm-eKHw_3Fz1Rj22

# --- AI ----------------------------------------------------------------------
# Server-side only. There is no code path that exposes this to the browser.
ANTHROPIC_API_KEY=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
ANTHROPIC_MODEL=claude-sonnet-5
AI_ENABLED=true
AI_MAX_OUTPUT_TOKENS=4096

# --- Email -------------------------------------------------------------------
# noop writes the message to the database and logs it without sending, which is
# the right default for development.
EMAIL_PROVIDER=noop
EMAIL_FROM_ADDRESS=no-reply@yourdomain.com
EMAIL_FROM_NAME=Velozity

RESEND_API_KEY=
RESEND_WEBHOOK_SECRET=

AWS_SES_REGION=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
SES_WEBHOOK_SECRET=

# --- E-signature -------------------------------------------------------------
# `manual` records the request and lets an operator mark signatures by hand,
# so the whole legal workflow is exercisable without a provider account.
SIGNATURE_PROVIDER=manual

ZOHO_SIGN_CLIENT_ID=
ZOHO_SIGN_CLIENT_SECRET=
ZOHO_SIGN_REFRESH_TOKEN=
ZOHO_SIGN_API_BASE=https://sign.zoho.com/api/v1
ZOHO_SIGN_ACCOUNTS_BASE=https://accounts.zoho.com
# Required before any Zoho webhook is processed. An unverified webhook can
# never mark a contract executed.
ZOHO_SIGN_WEBHOOK_SECRET=

# --- Observability -----------------------------------------------------------
SENTRY_DSN=
NEXT_PUBLIC_SENTRY_DSN=
LOG_LEVEL=info

# --- Application -------------------------------------------------------------
APP_URL=http://localhost:3000
NEXT_PUBLIC_APP_URL=http://localhost:3000

# At least 32 characters. Signs internal tokens (portal invitations, download
# grants). Rotate by generating a new value: openssl rand -base64 48
APP_SECRET=Cnvrwsox+1fIourWyy32cDZ5ZT0+joOoS9qey95Pw5BdcpX/QF/UCea4cBYVutVP

RATE_LIMIT_ENABLED=true

# Password assigned to seeded demo users. Development only.
SEED_DEMO_PASSWORD=Velozity!Demo2026
