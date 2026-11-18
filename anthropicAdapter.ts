import { controlHeaders } from '../server/auth';

function anthropicError(message: string, status = 400, type = 'invalid_request_error'): Response {
  return new Response(
    JSON.stringify({ type: 'error', error: { type, message } }),
    {
      status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      },
    }
  );
}

function extractTextContent(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          if (typeof obj.text === 'string') return obj.text;
          if (typeof obj.content === 'string') return obj.content;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function formatAnthropicEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface AdapterMetrics {
  model: string;
  promptTokens: number;
  completionTokens: number;
  ttftMs: number | null;
  status: number;
}

export async function handleAnthropicMessages(
  req: Request,
  controlUrl: string,
  onComplete: (metrics: AdapterMetrics) => void
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return anthropicError('Request body must be valid JSON', 400);
  }

  const requestedModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'auto';
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  if (rawMessages.length === 0) {
    return anthropicError('messages array is required', 400);
  }

  const openaiMessages: Array<{ role: string; content: string }> = [];
  const sysText = extractTextContent(body.system);
  if (sysText) {
    openaiMessages.push({ role: 'system', content: sysText });
  }
  for (const m of rawMessages) {
    if (!m || typeof m !== 'object') continue;
    const msgObj = m as Record<string, unknown>;
    const role = msgObj.role === 'assistant' ? 'assistant' : 'user';
    const text = extractTextContent(msgObj.content);
    if (text) {
      openaiMessages.push({ role, content: text });
    }
  }

  const isStream = body.stream === true;
  const maxTokens = typeof body.max_tokens === 'number' ? body.max_tokens : 1024;
  const payload: Record<string, unknown> = {
    model: requestedModel,
    messages: openaiMessages,
    max_tokens: maxTokens,
    stream: isStream,
  };
  if (isStream) {
    payload.stream_options = { include_usage: true };
  }
  if (typeof body.temperature === 'number') payload.temperature = body.temperature;
  if (Array.isArray(body.stop_sequences)) payload.stop = body.stop_sequences;

  const startedAt = performance.now();
  const upstreamAbort = new AbortController();
  const onAbort = () => upstreamAbort.abort();
  req.signal.addEventListener('abort', onAbort, { once: true });

  let upstream: Response;
  try {
    upstream = await fetch(`${controlUrl}/api/v1/internal/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...controlHeaders() },
      body: JSON.stringify(payload),
      signal: upstreamAbort.signal,
    });
  } catch (err) {
    req.signal.removeEventListener('abort', onAbort);
    const msg = err instanceof Error ? err.message : String(err);
    onComplete({ model: requestedModel, promptTokens: 0, completionTokens: 0, ttftMs: null, status: 502 });
    return anthropicError(`Upstream error: ${msg}`, 502, 'api_error');
  }

  if (!upstream.ok || !upstream.body) {
    req.signal.removeEventListener('abort', onAbort);
    const text = await upstream.text();
    onComplete({
      model: requestedModel,
      promptTokens: 0,
      completionTokens: 0,
      ttftMs: null,
      status: upstream.status,
    });
    return anthropicError(text || `Upstream HTTP ${upstream.status}`, upstream.status, 'api_error');
  }

  if (!isStream) {
    try {
      const data = (await upstream.json()) as {
        id?: string;
        model?: string;
        choices?: Array<{
          finish_reason?: string;
          message?: { content?: string; reasoning_content?: string };
        }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = data.choices?.[0];
      const blocks: Array<Record<string, string>> = [];
      if (choice?.message?.reasoning_content) {
        blocks.push({ type: 'thinking', thinking: choice.message.reasoning_content });
      }
      blocks.push({ type: 'text', text: choice?.message?.content ?? '' });
      const promptTokens = data.usage?.prompt_tokens ?? 0;
      const completionTokens = data.usage?.completion_tokens ?? 0;
      const resolvedModel = data.model ?? requestedModel;
      onComplete({
        model: resolvedModel,
        promptTokens,
        completionTokens,
        ttftMs: null,
        status: 200,
      });

      return new Response(
        JSON.stringify({
          id: data.id ?? `msg_${Date.now().toString(36)}`,
          type: 'message',
          role: 'assistant',
          model: resolvedModel,
          content: blocks,
          stop_reason: choice?.finish_reason === 'length' ? 'max_tokens' : 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: promptTokens, output_tokens: completionTokens },
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    } finally {
      req.signal.removeEventListener('abort', onAbort);
    }
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const msgId = `msg_${Date.now().toString(36)}`;
  let lineBuf = '';
  let sentStart = false;
  let blockIndex = -1;
  let activeBlockType: 'thinking' | 'text' | null = null;
  let stopReason = 'end_turn';
  let resolvedModel = requestedModel;
  let promptTokens = 0;
  let completionTokens = 0;
  let ttftMs: number | null = null;
  let recorded = false;

  const finalize = (status = 200) => {
    if (recorded) return;
    recorded = true;
    req.signal.removeEventListener('abort', onAbort);
    onComplete({ model: resolvedModel, promptTokens, completionTokens, ttftMs, status });
  };

  const closeCurrentBlock = (enqueue: (s: string) => void) => {
    if (activeBlockType !== null) {
      enqueue(formatAnthropicEvent('content_block_stop', { type: 'content_block_stop', index: blockIndex }));
      activeBlockType = null;
    }
  };

  const ensureStart = (enqueue: (s: string) => void) => {
    if (sentStart) return;
    sentStart = true;
    enqueue(
      formatAnthropicEvent('message_start', {
        type: 'message_start',
        message: {
          id: msgId,
          type: 'message',
          role: 'assistant',
          model: resolvedModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })
    );
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let wrote = false;
      const enqueueStr = (s: string) => {
        wrote = true;
        controller.enqueue(encoder.encode(s));
      };
      try {
        while (!wrote) {
          const { done, value } = await reader.read();
          if (done) {
            ensureStart(enqueueStr);
            closeCurrentBlock(enqueueStr);
            enqueueStr(
              formatAnthropicEvent('message_delta', {
                type: 'message_delta',
                delta: { stop_reason: stopReason, stop_sequence: null },
                usage: { output_tokens: completionTokens },
              })
            );
            enqueueStr(formatAnthropicEvent('message_stop', { type: 'message_stop' }));
            finalize(200);
            controller.close();
            return;
          }

          lineBuf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let sep = lineBuf.indexOf('\n\n');
          while (sep !== -1) {
            const rawEv = lineBuf.slice(0, sep).trim();
            lineBuf = lineBuf.slice(sep + 2);
            sep = lineBuf.indexOf('\n\n');
            if (!rawEv.startsWith('data:')) continue;
            const payloadStr = rawEv.slice(5).trim();
            if (payloadStr === '[DONE]') continue;

            const parsed = JSON.parse(payloadStr) as {
              model?: string;
              usage?: { prompt_tokens?: number; completion_tokens?: number };
              choices?: Array<{
                finish_reason?: string | null;
                delta?: { content?: string; reasoning_content?: string };
              }>;
            };
            if (parsed.model) resolvedModel = parsed.model;
            if (parsed.usage) {
              promptTokens = parsed.usage.prompt_tokens ?? promptTokens;
              completionTokens = parsed.usage.completion_tokens ?? completionTokens;
            }
            const choice = parsed.choices?.[0];
            if (choice?.finish_reason === 'length') stopReason = 'max_tokens';

            const reasoning = choice?.delta?.reasoning_content;
            if (typeof reasoning === 'string' && reasoning.length > 0) {
              if (ttftMs === null) ttftMs = performance.now() - startedAt;
              ensureStart(enqueueStr);
              if (activeBlockType !== 'thinking') {
                closeCurrentBlock(enqueueStr);
                blockIndex += 1;
                activeBlockType = 'thinking';
                enqueueStr(
                  formatAnthropicEvent('content_block_start', {
                    type: 'content_block_start',
                    index: blockIndex,
                    content_block: { type: 'thinking', thinking: '' },
                  })
                );
              }
              enqueueStr(
                formatAnthropicEvent('content_block_delta', {
                  type: 'content_block_delta',
                  index: blockIndex,
                  delta: { type: 'thinking_delta', thinking: reasoning },
                })
              );
            }

            const content = choice?.delta?.content;
            if (typeof content === 'string' && content.length > 0) {
              if (ttftMs === null) ttftMs = performance.now() - startedAt;
              ensureStart(enqueueStr);
              if (activeBlockType !== 'text') {
                closeCurrentBlock(enqueueStr);
                blockIndex += 1;
                activeBlockType = 'text';
                enqueueStr(
                  formatAnthropicEvent('content_block_start', {
                    type: 'content_block_start',
                    index: blockIndex,
                    content_block: { type: 'text', text: '' },
                  })
                );
              }
              enqueueStr(
                formatAnthropicEvent('content_block_delta', {
                  type: 'content_block_delta',
                  index: blockIndex,
                  delta: { type: 'text_delta', text: content },
                })
              );
            }
          }
        }
      } catch (err) {
        if (!req.signal.aborted) {
          const msg = err instanceof Error ? err.message : String(err);
          enqueueStr(
            formatAnthropicEvent('error', {
              type: 'error',
              error: { type: 'api_error', message: msg },
            })
          );
        }
        finalize(502);
        controller.close();
      }
    },
    cancel() {
      upstreamAbort.abort();
      finalize(499);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
