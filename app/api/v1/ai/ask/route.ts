import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { ask } from '@/lib/ai/assistant';
import { RATE_LIMITS } from '@/lib/http/rate-limit';

export const POST = route(
  {
    permission: 'ai:use:org',
    rateLimit: RATE_LIMITS.ai,
    body: z.object({ question: z.string().trim().min(2).max(2000) }),
  },
  async ({ ctx, body, db, requestId }) => {
    // Read-only: the assistant's tools cannot write, and the transaction
    // enforces that rather than trusting them to behave.
    const answer = await db((tx) => ask(tx, ctx, body.question), { readOnly: true });

    return ok(
      {
        answer: answer.answer,
        tool_calls: answer.toolCalls,
        usage: answer.usage,
        prompt_version: answer.promptVersion,
      },
      requestId,
    );
  },
);
