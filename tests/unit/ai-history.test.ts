/**
 * The Messages API rejects a transcript that does not begin with a user turn
 * and alternate strictly. The browser supplies that transcript, so it arrives
 * malformed in ordinary use — sliced to the last ten entries regardless of
 * where a pair began, and with failed turns removed. A 400 on every follow-up
 * question is the failure being prevented here.
 */
import { describe, it, expect } from 'vitest';
import { normaliseHistory } from '@/lib/ai/assistant';
import type { Anthropic } from '@/lib/ai/client';

const user = (content: string): Anthropic.MessageParam => ({ role: 'user', content });
const assistant = (content: string): Anthropic.MessageParam => ({ role: 'assistant', content });

const roles = (messages: Anthropic.MessageParam[]) => messages.map((m) => m.role);

describe('normaliseHistory', () => {
  it('keeps a well-formed transcript unchanged', () => {
    const history = [user('a'), assistant('b'), user('c'), assistant('d')];
    expect(normaliseHistory(history)).toEqual(history);
  });

  it('drops a leading assistant turn left by slicing mid-pair', () => {
    const result = normaliseHistory([assistant('orphan'), user('a'), assistant('b')]);
    expect(roles(result)).toEqual(['user', 'assistant']);
    expect(result[0]).toEqual(user('a'));
  });

  it('collapses adjacent same-role turns left by dropping a failed answer', () => {
    // The assistant reply between these two questions errored and was filtered
    // out client-side, leaving two user turns in a row.
    const result = normaliseHistory([user('first'), user('second'), assistant('b')]);
    expect(roles(result)).toEqual(['user', 'assistant']);
    // The later of the two is the question actually still standing.
    expect(result[0]).toEqual(user('second'));
  });

  it('ends on an assistant turn so the new question alternates', () => {
    const result = normaliseHistory([user('a'), assistant('b'), user('dangling')]);
    expect(roles(result)).toEqual(['user', 'assistant']);
  });

  it('returns nothing for a transcript with no usable pair', () => {
    expect(normaliseHistory([assistant('a')])).toEqual([]);
    expect(normaliseHistory([user('a')])).toEqual([]);
    expect(normaliseHistory([])).toEqual([]);
  });

  it('always produces a transcript the API will accept', () => {
    // Every shape the client can produce, checked against the two rules the
    // API enforces rather than against a hand-written expectation.
    const shapes: Anthropic.MessageParam[][] = [
      [assistant('a'), assistant('b'), user('c')],
      [user('a'), user('b'), user('c')],
      [assistant('a'), user('b'), user('c'), assistant('d'), assistant('e')],
      [user('a'), assistant('b'), assistant('c'), user('d')],
    ];

    for (const shape of shapes) {
      const result = normaliseHistory(shape);
      if (result.length === 0) continue;
      expect(result[0]!.role, `opens on a user turn: ${JSON.stringify(shape)}`).toBe('user');
      expect(result[result.length - 1]!.role, 'ends on an assistant turn').toBe('assistant');
      for (let i = 1; i < result.length; i++) {
        expect(result[i]!.role, 'alternates').not.toBe(result[i - 1]!.role);
      }
    }
  });
});
