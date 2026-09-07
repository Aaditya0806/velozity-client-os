/**
 * Resolving a connection's credential.
 *
 * `integration_connections.secret_ref` names an environment variable rather than
 * holding a token. That is the whole design: a token that was never written to
 * the database cannot be read out of a backup, a replica, a support export, or
 * a `select *` by anyone who talked their way into a read role.
 *
 * The cost is that adding a connection requires a deployment change. That is
 * the right trade for a credential that can post as your company.
 */
import 'server-only';
import { AppError } from '@/lib/http/errors';

/** Only these characters, so a ref can never reach beyond the environment. */
const REF = /^[A-Z][A-Z0-9_]{2,63}$/;

export function resolveSecret(secretRef: string | null, connectionName: string): string {
  if (!secretRef) {
    throw new AppError(
      'PROVIDER_UNAVAILABLE',
      `The connection "${connectionName}" names no secret. Set secret_ref to an environment variable holding its token.`,
    );
  }

  if (!REF.test(secretRef)) {
    throw new AppError(
      'PROVIDER_UNAVAILABLE',
      `"${secretRef}" is not a valid secret reference. Use an upper-case environment variable name.`,
    );
  }

  const value = process.env[secretRef];
  if (!value || value.trim() === '') {
    throw new AppError(
      'PROVIDER_UNAVAILABLE',
      `The connection "${connectionName}" refers to ${secretRef}, which is not set in this environment.`,
    );
  }

  return value.trim();
}
