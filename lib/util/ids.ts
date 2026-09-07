import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/** Request correlation id, echoed in every API response as `request_id`. */
export function newRequestId(): string {
  return `req_${randomBytes(12).toString('hex')}`;
}

export function newId(): string {
  return randomUUID();
}

export function sha256Hex(input: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Constant-time comparison for signatures and tokens. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // Still burn a comparison so the failure is not distinguishable by timing.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
