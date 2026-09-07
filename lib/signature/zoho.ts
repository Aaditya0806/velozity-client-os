/**
 * Zoho Sign adapter.
 *
 * Credentials come from environment configuration and are never stored in
 * application tables. The access token is refreshed on demand and held only in
 * memory.
 */
import 'server-only';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  SignatureProvider, PreparedDocument, Signer, SignatureOptions,
  ProviderRequest, SignatureStatus, WebhookVerification, SignatureEvent,
} from './types';
import { serverEnv } from '@/lib/config/env';
import { AppError } from '@/lib/http/errors';
import { logger } from '@/lib/util/logger';

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

async function accessToken(): Promise<string> {
  const env = serverEnv();
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.accessToken;
  }

  if (!env.ZOHO_SIGN_CLIENT_ID || !env.ZOHO_SIGN_CLIENT_SECRET || !env.ZOHO_SIGN_REFRESH_TOKEN) {
    throw new AppError(
      'PROVIDER_UNAVAILABLE',
      'Zoho Sign is not configured. Set the Zoho Sign credentials to enable e-signature.',
    );
  }

  const params = new URLSearchParams({
    refresh_token: env.ZOHO_SIGN_REFRESH_TOKEN,
    client_id: env.ZOHO_SIGN_CLIENT_ID,
    client_secret: env.ZOHO_SIGN_CLIENT_SECRET,
    grant_type: 'refresh_token',
  });

  const response = await fetch(`${env.ZOHO_SIGN_ACCOUNTS_BASE}/oauth/v2/token?${params}`, {
    method: 'POST',
  });

  if (!response.ok) {
    throw new AppError('PROVIDER_UNAVAILABLE', 'Could not authenticate with Zoho Sign.', {
      details: { status: response.status },
    });
  }

  const data = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) {
    throw new AppError('PROVIDER_ERROR', 'Zoho Sign returned no access token.');
  }

  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return tokenCache.accessToken;
}

async function zohoFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const env = serverEnv();
  const token = await accessToken();
  const response = await fetch(`${env.ZOHO_SIGN_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Zoho-oauthtoken ${token}`,
      ...(init.headers ?? {}),
    },
  });

  if (response.status === 401) {
    // The token was rejected; drop it so the next call refreshes.
    tokenCache = null;
  }
  return response;
}

const STATUS_MAP: Record<string, SignatureStatus['status']> = {
  draft: 'created',
  inprogress: 'sent',
  viewed: 'viewed',
  completed: 'completed',
  declined: 'declined',
  expired: 'expired',
  recalled: 'voided',
  failed: 'failed',
};

export const zohoSignProvider: SignatureProvider = {
  name: 'zoho_sign',

  async createRequest(
    doc: PreparedDocument,
    signers: Signer[],
    opts: SignatureOptions,
  ): Promise<ProviderRequest> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(doc.content)], { type: doc.mimeType }), doc.name);

    const uploadResponse = await zohoFetch('/requests', { method: 'POST', body: form });
    if (!uploadResponse.ok) {
      const text = await uploadResponse.text();
      logger.error('Zoho Sign upload failed', { status: uploadResponse.status, body: text.slice(0, 500) });
      throw new AppError('PROVIDER_ERROR', 'Zoho Sign rejected the document upload.', {
        details: { status: uploadResponse.status },
      });
    }

    const uploaded = (await uploadResponse.json()) as {
      requests?: { request_id?: string; document_ids?: Array<{ document_id?: string }> };
    };
    const requestId = uploaded.requests?.request_id;
    const documentId = uploaded.requests?.document_ids?.[0]?.document_id;

    if (!requestId || !documentId) {
      throw new AppError('PROVIDER_ERROR', 'Zoho Sign returned an unexpected upload response.');
    }

    const actions = signers.map((signer) => ({
      recipient_name: signer.name,
      recipient_email: signer.email,
      action_type: signer.party === 'witness' ? 'APPROVE' : 'SIGN',
      signing_order: signer.order,
      verify_recipient: false,
      private_notes: signer.role ?? '',
    }));

    const details = {
      requests: {
        request_name: opts.subject,
        actions,
        expiration_days: opts.expiresInDays ?? 30,
        is_sequential: signers.some((s, i, arr) => i > 0 && s.order !== arr[0]?.order),
        notes: opts.message ?? '',
        ...(opts.referenceId ? { description: opts.referenceId } : {}),
      },
    };

    const submitForm = new FormData();
    submitForm.append('data', JSON.stringify(details));

    const submitResponse = await zohoFetch(`/requests/${requestId}/submit`, {
      method: 'POST',
      body: submitForm,
    });

    if (!submitResponse.ok) {
      const text = await submitResponse.text();
      logger.error('Zoho Sign submit failed', { status: submitResponse.status, body: text.slice(0, 500) });
      throw new AppError('PROVIDER_ERROR', 'Zoho Sign rejected the signature request.', {
        details: { status: submitResponse.status },
      });
    }

    const submitted = (await submitResponse.json()) as {
      requests?: { request_status?: string; actions?: Array<{ recipient_email?: string; action_id?: string }> };
    };

    const signerIds: Record<string, string> = {};
    for (const action of submitted.requests?.actions ?? []) {
      if (action.recipient_email && action.action_id) {
        signerIds[action.recipient_email.toLowerCase()] = action.action_id;
      }
    }

    return {
      providerRequestId: requestId,
      status: STATUS_MAP[submitted.requests?.request_status ?? 'inprogress'] ?? 'sent',
      signerIds,
      raw: submitted,
    };
  },

  async getStatus(providerRequestId: string): Promise<SignatureStatus> {
    const response = await zohoFetch(`/requests/${providerRequestId}`);
    if (!response.ok) {
      throw new AppError('PROVIDER_ERROR', 'Could not read the signature request status.', {
        details: { status: response.status },
      });
    }

    const data = (await response.json()) as {
      requests?: {
        request_status?: string;
        completed_time?: string;
        actions?: Array<{
          recipient_email?: string;
          action_status?: string;
          signed_time?: string;
          reason?: string;
        }>;
      };
    };

    const signerStatus: Record<string, SignatureStatus['signers'][number]['status']> = {
      NOTSENT: 'pending',
      SENT: 'sent',
      VIEWED: 'viewed',
      SIGNED: 'signed',
      APPROVED: 'signed',
      DECLINED: 'declined',
      BOUNCED: 'bounced',
    };

    return {
      status: STATUS_MAP[data.requests?.request_status ?? ''] ?? 'failed',
      completedAt: data.requests?.completed_time,
      signers: (data.requests?.actions ?? []).map((a) => ({
        email: a.recipient_email ?? '',
        status: signerStatus[a.action_status ?? 'NOTSENT'] ?? 'pending',
        signedAt: a.signed_time,
        declineReason: a.reason,
      })),
      raw: data,
    };
  },

  async downloadExecuted(providerRequestId: string): Promise<Buffer> {
    const response = await zohoFetch(`/requests/${providerRequestId}/pdf`);
    if (!response.ok) {
      throw new AppError('PROVIDER_ERROR', 'Could not download the executed document.', {
        details: { status: response.status },
      });
    }
    return Buffer.from(await response.arrayBuffer());
  },

  /**
   * Signature verification.
   *
   * An event that fails this is stored for forensics and never processed, so an
   * attacker who can reach the endpoint cannot mark a contract executed.
   */
  verifyWebhook(rawBody: Buffer, headers: Headers): WebhookVerification {
    const env = serverEnv();
    const secret = env.ZOHO_SIGN_WEBHOOK_SECRET;

    if (!secret) {
      return {
        valid: false,
        reason: 'ZOHO_SIGN_WEBHOOK_SECRET is not configured; webhooks cannot be trusted.',
      };
    }

    const provided =
      headers.get('x-zs-webhook-signature') ??
      headers.get('x-zoho-signature') ??
      headers.get('x-hub-signature-256');

    if (!provided) {
      return { valid: false, reason: 'No signature header was present on the request.' };
    }

    const normalised = provided.replace(/^sha256=/i, '').trim().toLowerCase();
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');

    const a = Buffer.from(normalised, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) {
      return { valid: false, reason: 'Signature length mismatch.' };
    }
    if (!timingSafeEqual(a, b)) {
      return { valid: false, reason: 'Signature did not match the expected value.' };
    }
    return { valid: true };
  },

  parseWebhook(payload: unknown): SignatureEvent[] {
    const body = payload as {
      notifications?: {
        performed_at?: string;
        operation_type?: string;
        activity?: string;
        request_id?: string;
        action_id?: string;
        performed_by_email?: string;
      };
      requests?: { request_id?: string; request_status?: string };
      event_id?: string;
    };

    const notification = body.notifications;
    const requestId = notification?.request_id ?? body.requests?.request_id;
    if (!requestId) return [];

    const operation = (notification?.operation_type ?? notification?.activity ?? '').toUpperCase();

    const typeMap: Record<string, SignatureEvent['type']> = {
      REQUESTSUBMITTED: 'sent',
      REQUESTVIEWED: 'viewed',
      REQUESTSIGNINGSUCCESS: 'signed',
      REQUESTCOMPLETED: 'completed',
      REQUESTDECLINED: 'declined',
      REQUESTEXPIRED: 'expired',
      REQUESTRECALLED: 'voided',
      REQUESTFORWARDED: 'sent',
    };

    const type = typeMap[operation];
    if (!type) return [];

    const occurredAt = notification?.performed_at
      ? new Date(Number(notification.performed_at)).toISOString()
      : new Date().toISOString();

    return [
      {
        // Zoho does not always supply an event id, so one is derived
        // deterministically. Two deliveries of the same event collapse to the
        // same key and the second is ignored.
        providerEventId:
          body.event_id ?? `${requestId}:${operation}:${notification?.action_id ?? 'request'}:${notification?.performed_at ?? ''}`,
        providerRequestId: requestId,
        type,
        signerEmail: notification?.performed_by_email,
        providerSignerId: notification?.action_id,
        occurredAt,
        raw: payload,
      },
    ];
  },

  async void(providerRequestId: string, reason: string): Promise<void> {
    const form = new FormData();
    form.append('data', JSON.stringify({ requests: { reason } }));

    const response = await zohoFetch(`/requests/${providerRequestId}/recall`, {
      method: 'POST',
      body: form,
    });

    if (!response.ok) {
      throw new AppError('PROVIDER_ERROR', 'Could not void the signature request.', {
        details: { status: response.status },
      });
    }
  },
};
