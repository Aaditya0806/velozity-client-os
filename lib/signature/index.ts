/**
 * Provider selection.
 *
 * The application never imports a concrete provider: it asks for one by name
 * and receives something satisfying the SignatureProvider contract.
 */
import type { SignatureProvider } from './types';
import { zohoSignProvider } from './zoho';
import { manualSignatureProvider } from './manual';
import { serverEnv } from '@/lib/config/env';
import { AppError } from '@/lib/http/errors';

export * from './types';

const PROVIDERS: Record<string, SignatureProvider> = {
  zoho_sign: zohoSignProvider,
  manual: manualSignatureProvider,
};

export function getSignatureProvider(name?: string): SignatureProvider {
  const key = name ?? serverEnv().SIGNATURE_PROVIDER;
  const provider = PROVIDERS[key];
  if (!provider) {
    throw new AppError('PROVIDER_UNAVAILABLE', `No signature provider is configured for "${key}".`);
  }
  return provider;
}

export function availableProviders(): string[] {
  return Object.keys(PROVIDERS);
}
