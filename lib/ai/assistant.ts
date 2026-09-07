/**
 * The AI Command Centre.
 *
 * The model answers questions by calling read tools and composing what they
 * return. It cannot write, cannot compose SQL, and every answer carries the list
 * of tool calls that produced it, so a reader can check the working.
 */
import type { Tx } from '@/lib/db';
import type { RequestContext } from '@/lib/auth/session';
import { AppError } from '@/lib/http/errors';
import { callModel, type Anthropic, type ModelUsage } from './client';
import { toolsForUser, runTool } from './tools';
import { PROMPT_VERSION } from './prompts';
import { logger } from '@/lib/util/logger';

const MAX_TOOL_ROUNDS = 5;

const SYSTEM = `
You are the assistant inside Velozity Business OS, answering questions about
this organisation's clients, pipeline, contracts, delivery and revenue.

HOW YOU WORK

You have read-only tools. Call them to get facts; never guess a number, a date,
a client name or a status. If the tools do not give you what is needed, say so
plainly and name what is missing.

You cannot change anything. If asked to send, sign, approve, create or update
something, explain that you can only read, and point to where in the product the
person can do it themselves.

ANSWERING

Be concise and specific. Lead with the answer, then the supporting detail.
Use exact figures from tool results, with their currency. Give dates as they came
back. When a tool returns nothing, say that the result was empty rather than
implying the thing does not exist.

Never invent a client, a contract, an amount or a date. An unanswered question is
a better outcome than a plausible fabrication.

WHAT YOU CANNOT SEE

Tools return only what the person asking is permitted to see. If a tool reports a
permission problem, tell them their access does not cover it - do not speculate
about what the data might have been.
`.trim();

export interface AssistantAnswer {
  answer: string;
  toolCalls: Array<{
    tool: string;
    params: unknown;
    ok: boolean;
    rowCount: number | null;
    durationMs: number;
  }>;
  usage: { inputTokens: number; outputTokens: number; costUsd: string; model: string };
  promptVersion: string;
}

export async function ask(
  tx: Tx,
  ctx: RequestContext,
  question: string,
  history: Anthropic.MessageParam[] = [],
): Promise<AssistantAnswer> {
  if (!ctx.org.aiEnabled) {
    throw new AppError('AI_DISABLED', 'AI features are switched off for this organisation.');
  }
  ctx.permissions.require('ai:use:org');

  const tools = toolsForUser(ctx);
  const messages: Anthropic.MessageParam[] = [
    ...history,
    // The user's question is trusted input - they typed it. Content that comes
    // back from tools is our own data. Neither is untrusted third-party text,
    // which is why this path has no <untrusted_data> wrapper.
    { role: 'user', content: question },
  ];

  const toolCalls: AssistantAnswer['toolCalls'] = [];
  const totals = { inputTokens: 0, outputTokens: 0, cost: 0 };
  let lastUsage: ModelUsage | null = null;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await callModel({
      system: SYSTEM,
      messages,
      tools,
      maxTokens: 2048,
    });

    lastUsage = result.usage;
    totals.inputTokens += result.usage.inputTokens;
    totals.outputTokens += result.usage.outputTokens;
    totals.cost += Number.parseFloat(result.usage.costUsd);

    const toolUses = result.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
    );

    if (toolUses.length === 0) {
      const answer = result.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim();

      return {
        answer: answer || 'I could not produce an answer to that.',
        toolCalls,
        usage: {
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          costUsd: totals.cost.toFixed(6),
          model: result.usage.model,
        },
        promptVersion: PROMPT_VERSION,
      };
    }

    messages.push({ role: 'assistant', content: result.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const use of toolUses) {
      const started = Date.now();
      const outcome = await runTool(tx, ctx, use.name, use.input);
      const durationMs = Date.now() - started;

      const rowCount = outcome.ok && Array.isArray(outcome.data) ? outcome.data.length : null;

      toolCalls.push({
        tool: use.name,
        params: use.input,
        ok: outcome.ok,
        rowCount,
        durationMs,
      });

      logger.info('Assistant tool call', {
        org_id: ctx.org.id,
        user_id: ctx.user.id,
        tool: use.name,
        ok: outcome.ok,
        duration_ms: durationMs,
      });

      toolResults.push({
        type: 'tool_result',
        tool_use_id: use.id,
        is_error: !outcome.ok,
        content: outcome.ok
          ? JSON.stringify(outcome.data).slice(0, 60_000)
          : outcome.error,
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  // The model kept asking for tools without concluding. Say so rather than
  // returning a half-formed answer.
  return {
    answer:
      'I could not reach an answer within the allowed number of lookups. Try asking something more specific.',
    toolCalls,
    usage: {
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      costUsd: totals.cost.toFixed(6),
      model: lastUsage?.model ?? 'unknown',
    },
    promptVersion: PROMPT_VERSION,
  };
}

export async function saveExchange(
  tx: Tx,
  ctx: RequestContext,
  conversationId: string,
  question: string,
  answer: AssistantAnswer,
): Promise<void> {
  await tx.query(
    `insert into ai_messages (org_id, conversation_id, role, content, created_at)
     values ($1,$2,'user',$3, now())`,
    [ctx.org.id, conversationId, question],
  );

  await tx.query(
    `insert into ai_messages (
       org_id, conversation_id, role, content, tool_calls, model,
       input_tokens, output_tokens, cost_usd
     ) values ($1,$2,'assistant',$3,$4,$5,$6,$7,$8)`,
    [
      ctx.org.id, conversationId, answer.answer, JSON.stringify(answer.toolCalls),
      answer.usage.model, answer.usage.inputTokens, answer.usage.outputTokens,
      answer.usage.costUsd,
    ],
  );

  await tx.query(
    `update ai_conversations set updated_at = now() where id = $1`,
    [conversationId],
  );
}
