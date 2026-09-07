'use client';

import * as React from 'react';
import { Send, Loader2, Wrench } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';

interface ToolCall {
  tool: string;
  ok: boolean;
  rowCount: number | null;
  durationMs: number;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  error?: boolean;
}

/** Turns carried into each request. Ten is the server's cap. */
const HISTORY_TURNS = 10;

const SUGGESTIONS = [
  'Which clients are at risk?',
  'What is awaiting signature?',
  'Show me the pipeline for this quarter',
  'Which contracts expire in the next 90 days?',
];

export function Assistant({ configured = true }: { configured?: boolean }) {
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [input, setInput] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const endRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const ask = async (question: string) => {
    if (!question.trim() || loading || !configured) return;

    // Captured before the optimistic append, so the new question is not also
    // sent as the last line of its own history.
    const history = messages
      .filter((message) => !message.error && message.content.trim().length > 0)
      .slice(-HISTORY_TURNS)
      .map((message) => ({ role: message.role, content: message.content.slice(0, 8000) }));

    setMessages((current) => [...current, { role: 'user', content: question }]);
    setInput('');
    setLoading(true);

    try {
      const response = await fetch('/api/v1/ai/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, history }),
      });

      const body = (await response.json()) as {
        data?: { answer: string; tool_calls: ToolCall[] };
        error?: { message: string };
        request_id: string;
      };

      if (!response.ok) {
        setMessages((current) => [
          ...current,
          {
            role: 'assistant',
            content: body.error?.message ?? 'The assistant could not answer that.',
            error: true,
          },
        ]);
        return;
      }

      setMessages((current) => [
        ...current,
        {
          role: 'assistant',
          content: body.data?.answer ?? '',
          toolCalls: body.data?.tool_calls ?? [],
        },
      ]);
    } catch {
      setMessages((current) => [
        ...current,
        { role: 'assistant', content: 'Could not reach the assistant.', error: true },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardContent className="p-0">
        <div className="scrollbar-thin max-h-[28rem] min-h-64 overflow-y-auto p-5">
          {messages.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm text-muted-foreground">
                Ask a question about your clients, pipeline, contracts or delivery.
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((suggestion) => (
                  <Button
                    key={suggestion}
                    variant="outline"
                    size="sm"
                    disabled={!configured}
                    onClick={() => void ask(suggestion)}
                  >
                    {suggestion}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              {messages.map((message, index) => (
                <div key={index} className={message.role === 'user' ? 'flex justify-end' : ''}>
                  <div
                    className={
                      message.role === 'user'
                        ? 'max-w-[80%] rounded-lg bg-primary px-3.5 py-2.5 text-sm text-primary-foreground'
                        : 'max-w-full'
                    }
                  >
                    <p
                      className={
                        message.error
                          ? 'whitespace-pre-wrap text-sm text-destructive'
                          : 'whitespace-pre-wrap text-sm'
                      }
                    >
                      {message.content}
                    </p>

                    {/*
                      The tools that produced the answer. Showing the working is
                      what makes an answer checkable rather than merely fluent.
                    */}
                    {message.toolCalls && message.toolCalls.length > 0 ? (
                      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                        <Wrench className="h-3 w-3 text-muted-foreground" aria-hidden />
                        <span className="text-2xs uppercase tracking-wide text-muted-foreground">
                          Sources
                        </span>
                        {message.toolCalls.map((call, i) => (
                          <Badge key={i} variant={call.ok ? 'neutral' : 'danger'}>
                            {call.tool}
                            {call.rowCount !== null ? ` · ${call.rowCount}` : ''}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}

              {loading ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  Looking that up…
                </p>
              ) : null}
              <div ref={endRef} />
            </div>
          )}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void ask(input);
          }}
          className="flex items-center gap-2 border-t p-3"
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              configured
                ? 'Ask about clients, deals, contracts, delivery…'
                : 'Set ANTHROPIC_API_KEY in .env to enable the assistant'
            }
            disabled={loading || !configured}
            aria-label="Ask the assistant"
          />
          <Button type="submit" size="icon" disabled={loading || !configured || !input.trim()}>
            <Send className="h-4 w-4" aria-hidden />
            <span className="sr-only">Send</span>
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
