import { describe, expect, it, vi } from 'vitest';
import { GoogleGenaiClient, type GenAiLike } from '../src/google-client.js';

function fakeAi(overrides: Record<string, unknown> = {}): GenAiLike {
  return {
    models: {
      generateContent: vi.fn(async () => ({
        text: '{"actions":[]}',
        functionCalls: [{ name: 'submit_turn', args: { actions: [] } }],
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 60, candidatesTokenCount: 20, thoughtsTokenCount: 5 },
      })),
      generateContentStream: vi.fn(async () =>
        (async function* () {
          yield { text: 'Hello ' };
          yield { text: 'world', candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } };
        })(),
      ),
    },
    caches: { create: vi.fn(async () => ({ name: 'cachedContents/abc' })) },
    decisions: {
      create: vi.fn(async () => ({
        answers: { q: { type: 'noul', noul: 0.4, confidence: 0.6 } },
        usage: { total_input_tokens: 321, total_output_tokens: 0 },
      })),
    },
    ...overrides,
  } as unknown as GenAiLike;
}

const signal = new AbortController().signal;

describe('GoogleGenaiClient', () => {
  it('maps generateContent args and response', async () => {
    const ai = fakeAi();
    const client = new GoogleGenaiClient({ ai });
    const res = await client.generate({
      model: 'gemini-2.5-flash',
      systemInstruction: 'sys',
      tools: [{ name: 'peek', description: 'd', parameters: { type: 'object' } }],
      contents: [
        { role: 'user', text: 'ctx' },
        { role: 'tool', name: 'peek', response: { ok: true } },
      ],
      responseMimeType: 'application/json',
      thinkingBudget: 128,
      maxOutputTokens: 1000,
      signal,
    });
    expect(res).toEqual({
      text: '{"actions":[]}',
      functionCalls: [{ name: 'submit_turn', args: { actions: [] } }],
      finishReason: 'STOP',
      usage: { promptTokenCount: 100, cachedContentTokenCount: 60, candidatesTokenCount: 20, thoughtsTokenCount: 5 },
    });
    const call = (ai.models.generateContent as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.contents[1].parts[0].functionResponse).toEqual({ name: 'peek', response: { ok: true } });
    expect(call.config).toMatchObject({ systemInstruction: 'sys', maxOutputTokens: 1000, thinkingConfig: { thinkingBudget: 128 }, abortSignal: signal });
    expect(call.config.tools[0].functionDeclarations[0]).toMatchObject({ name: 'peek', parametersJsonSchema: { type: 'object' } });
  });

  it('streams text then a done chunk with the joined text', async () => {
    const client = new GoogleGenaiClient({ ai: fakeAi() });
    const chunks = [];
    for await (const c of client.generateStream({ model: 'm', contents: [{ role: 'user', text: 'x' }], maxOutputTokens: 10, signal })) chunks.push(c);
    expect(chunks.slice(0, 2)).toEqual([{ text: 'Hello ' }, { text: 'world' }]);
    expect(chunks[2]!.done).toMatchObject({ text: 'Hello world', finishReason: 'STOP', usage: { promptTokenCount: 10, candidatesTokenCount: 2 } });
  });

  it('creates caches with a ttl string', async () => {
    const ai = fakeAi();
    const out = await new GoogleGenaiClient({ ai }).caches.create({ model: 'm', systemInstruction: 's', tools: [], context: 'c', ttlSeconds: 600 });
    expect(out).toEqual({ name: 'cachedContents/abc' });
    expect((ai.caches.create as ReturnType<typeof vi.fn>).mock.calls[0]![0].config.ttl).toBe('600s');
  });

  it('maps decisions and disables SDK retries', async () => {
    const ai = fakeAi();
    const out = await new GoogleGenaiClient({ ai }).decisions.create({
      model: 'gemini-decision-1',
      input: 'state',
      questions: { q: { type: 'noul', instructions: 'Is it?' } },
      signal,
    });
    expect(out).toEqual({ answers: { q: { type: 'noul', noul: 0.4, confidence: 0.6 } }, blockReason: undefined, usage: { inputTokens: 321 } });
    const [body, opts] = (ai.decisions.create as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(body).toEqual({ model: 'gemini-decision-1', input: 'state', questions: { q: { type: 'noul', instructions: 'Is it?' } } });
    expect(opts).toMatchObject({ signal, retry_codes: [] });
  });

  it('surfaces prompt_feedback block reasons', async () => {
    const ai = fakeAi({ decisions: { create: async () => ({ prompt_feedback: { block_reason: 'safety' }, usage: { total_input_tokens: 5 } }) } });
    const out = await new GoogleGenaiClient({ ai }).decisions.create({ model: 'm', input: 'x', questions: { q: { type: 'noul', instructions: 'x' } }, signal });
    expect(out.blockReason).toBe('safety');
    expect(out.answers).toBeUndefined();
  });
});
