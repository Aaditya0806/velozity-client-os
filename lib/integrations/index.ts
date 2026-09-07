import 'server-only';
import { AppError } from '@/lib/http/errors';
import { slackProvider } from './slack';
import { whatsappProvider } from './whatsapp';
import type { ChannelProvider, ChannelProviderName } from './types';

const PROVIDERS: Record<ChannelProviderName, ChannelProvider> = {
  slack: slackProvider,
  whatsapp: whatsappProvider,
};

export function channelProvider(name: string): ChannelProvider {
  const provider = PROVIDERS[name as ChannelProviderName];
  if (!provider) {
    throw new AppError('PROVIDER_UNAVAILABLE', `There is no channel provider named "${name}".`);
  }
  return provider;
}

export * from './types';
