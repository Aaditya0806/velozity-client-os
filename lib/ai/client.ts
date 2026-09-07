/**
 * The Anthropic client.
 *
 * Server-side only. The API key never reaches a bundle, and every call passes
 * through here so that the organisation kill switch, the cost accounting and the
 * prompt-injection framing are impossible to bypass by calling the SDK directly.
 */
import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { serverEnv } from '@/lib/config/env';
import { AppError } from '@/lib/http/errors';
import { logger } from '@/lib/util/logger';

let client: Anthropic | null = null;

export function anthropic(): Anthropic {
  const env = serverEnv();
  if (!env.ANTHROPIC_API_KEY) {
    throw new AppError(
      'AI_DISABLED',
      'AI is not configured. Set ANTHROPIC_API_KEY to enable AI features.',
    );
  }
  client ??= new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 });
  return client;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
  latencyMs: number;
  model: string;
}

/**
 * Published per-million-token prices, used for cost accounting on each action.
 * A model absent from this table is charged at zero rather than guessed at, and
 * the omission is logged.
 */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 15, output: 75 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 },
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): string {
  const price = PRICING[model];
  if (!price) {
    logger.warn('No pricing entry for model; cost recorded as zero', { model });
    return '0.000000';
  }
  const cost = (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output;
  return cost.toFixed(6);
}

export interface CallOptions {
  system: string;
  messages: Anthropic.MessageParam[];
  maxTokens?: number;
  temperature?: number;
  tools?: Anthropic.Tool[];
  toolChoice?: Anthropic.ToolChoice;
}

export interface CallResult {
  content: Anthropic.ContentBlock[];
  stopReason: string | null;
  usage: ModelUsage;
}

export async function callModel(options: CallOptions): Promise<CallResult> {
  const env = serverEnv();
  const model = env.ANTHROPIC_MODEL;
  const started = Date.now();

  try {
    const response = await anthropic().messages.create({
      model,
      max_tokens: options.maxTokens ?? env.AI_MAX_OUTPUT_TOKENS,
      temperature: options.temperature ?? 0,
      system: options.system,
      messages: options.messages,
      ...(options.tools ? { tools: options.tools } : {}),
      ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
    });

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;

    return {
      content: response.content,
      stopReason: response.stop_reason,
      usage: {
        inputTokens,
        outputTokens,
        costUsd: estimateCost(model, inputTokens, outputTokens),
        latencyMs: Date.now() - started,
        model,
      },
    };
  } catch (error) {
    logger.error('Model call failed', { model, error });

    if (error instanceof Anthropic.APIError) {
      if (error.status === 429) {
        throw new AppError('RATE_LIMITED', 'The AI service is rate limited. Please retry shortly.', {
          cause: error,
        });
      }
      if (typeof error.status === 'number' && error.status >= 500) {
        throw new AppError('PROVIDER_UNAVAILABLE', 'The AI service is temporarily unavailable.', {
          cause: error,
        });
      }
    }
    throw new AppError('PROVIDER_ERROR', 'The AI request could not be completed.', { cause: error });
  }
}

export { Anthropic };
