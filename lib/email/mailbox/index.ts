import 'server-only';
import { AppError } from '@/lib/http/errors';
import { gmailProvider } from './gmail';
import { microsoftProvider } from './microsoft';
import type { MailboxProvider, MailboxProviderName } from './types';

const PROVIDERS: Record<MailboxProviderName, MailboxProvider> = {
  gmail: gmailProvider,
  microsoft: microsoftProvider,
};

export function mailboxProvider(name: string): MailboxProvider {
  const provider = PROVIDERS[name as MailboxProviderName];
  if (!provider) {
    throw new AppError('PROVIDER_UNAVAILABLE', `There is no mailbox provider named "${name}".`);
  }
  return provider;
}

export * from './types';
