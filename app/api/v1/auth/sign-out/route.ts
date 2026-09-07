import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/auth/supabase';
import { getAuthUser } from '@/lib/auth/session';
import { withService } from '@/lib/db';
import { writeAudit } from '@/lib/audit';
import { newRequestId } from '@/lib/util/ids';

export async function POST(request: Request) {
  const requestId = newRequestId();
  const auth = await getAuthUser();

  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();

  if (auth) {
    await withService('record sign-out', (tx) =>
      writeAudit(tx, {
        orgId: null,
        action: 'auth.logout',
        category: 'auth',
        actorUserId: auth.id,
        summary: 'Signed out',
        userAgent: request.headers.get('user-agent'),
        requestId,
      }),
    ).catch(() => undefined);
  }

  return NextResponse.json({ data: { signed_out: true }, request_id: requestId });
}
