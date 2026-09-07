import { NextResponse } from 'next/server';
import { withService } from '@/lib/db';
import { logger } from '@/lib/util/logger';

/**
 * Liveness and database reachability.
 *
 * The response deliberately says nothing beyond up or down — it is unauthenticated,
 * so it must not describe the deployment. The reason for a failure is logged
 * server-side instead: a health check that reports "degraded" and keeps the
 * cause to itself gives an operator nowhere to start.
 */
export async function GET() {
  try {
    await withService('health check', (tx) => tx.query('select 1'));
    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    logger.error('Health check failed', { error });
    return NextResponse.json({ status: 'degraded' }, { status: 503 });
  }
}
