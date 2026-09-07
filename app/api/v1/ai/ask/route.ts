import { z } from 'zod';
import { route } from '@/lib/http/api';
import { ok } from '@/lib/http/response';
import { ask } from '@/lib/ai/assistant';
import { RATE_LIMITS } from '@/lib/http/rate-limit';

export const POST = route(
  {
    permission: 'ai:use:org',
    rateLimit: RATE_LIMITS.ai,
    body: z.object({
      question: z.string().trim().min(2).max(2000),
      // Prior turns, so a follow-up like "and last quarter?" resolves. Bounded
      // because the client decides what to send and an unbounded transcript is
      // an unbounded bill. Only the text is carried over: the tool results
      // behind an earlier answer are re-derived under this request's own RLS,
      // never replayed from something the browser handed back.
      history: z
        .array(
          z.object({
            role: z.enum(['user', 'assistant']),
            content: z.string().trim().min(1).max(8000),
          }),
        )
        .max(10)
        .optional(),
    }),
  },
  async ({ ctx, body, db, requestId }) => {
    // Read-only: the assistant's tools cannot write, and the transaction
    // enforces that rather than trusting them to behave.
    const answer = await db((tx) => ask(tx, ctx, body.question, body.history ?? []), {
      readOnly: true,
    });

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
