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

  it('sends a tool turn as raw model content then one message with every function response', async () => {
    const ai = fakeAi();
    const raw = { role: 'model', parts: [{ functionCall: { name: 'a', args: {} }, thoughtSignature: 'sig' }, { functionCall: { name: 'b', args: {} } }] };
    await new GoogleGenaiClient({ ai }).generate({
      model: 'm',
      contents: [
        { role: 'user', text: 'state' },
        { role: 'model', functionCalls: [{ name: 'a', args: {} }, { name: 'b', args: {} }], raw },
        { role: 'tool', name: 'a', id: 'i1', response: { x: 1 } },
        { role: 'tool', name: 'b', response: 7 },
      ],
      maxOutputTokens: 10,
      signal,
    });
    const contents = (ai.models.generateContent as ReturnType<typeof vi.fn>).mock.calls[0]![0].contents;
    expect(contents).toHaveLength(3);
    expect(contents[1]).toBe(raw);
    expect(contents[2]).toEqual({
      role: 'user',
      parts: [
        { functionResponse: { name: 'a', id: 'i1', response: { x: 1 } } },
        { functionResponse: { name: 'b', response: { result: 7 } } },
      ],
    });
  });

  it('rebuilds a model turn from function calls when there is no raw content', async () => {
    const ai = fakeAi();
    await new GoogleGenaiClient({ ai }).generate({
      model: 'm',
      contents: [{ role: 'model', functionCalls: [{ name: 'a', args: { q: 1 }, id: 'z' }] }, { role: 'tool', name: 'a', id: 'z', response: {} }],
      maxOutputTokens: 10,
      signal,
    });
    const contents = (ai.models.generateContent as ReturnType<typeof vi.fn>).mock.calls[0]![0].contents;
    expect(contents[0]).toEqual({ role: 'model', parts: [{ functionCall: { name: 'a', args: { q: 1 }, id: 'z' } }] });
  });

  it('returns the raw model content and call ids', async () => {
    const content = { role: 'model', parts: [{ functionCall: { name: 'f', args: {}, id: 'q' } }] };
    const ai = fakeAi({
      models: {
        generateContent: async () => ({ functionCalls: [{ name: 'f', args: {}, id: 'q' }], candidates: [{ finishReason: 'STOP', content }], usageMetadata: {} }),
        generateContentStream: async () => (async function* () {})(),
      },
    });
    const res = await new GoogleGenaiClient({ ai }).generate({ model: 'm', contents: [{ role: 'user', text: 'x' }], maxOutputTokens: 1, signal });
    expect(res.functionCalls).toEqual([{ name: 'f', args: {}, id: 'q' }]);
    expect(res.modelContent).toBe(content);
  });

  it('sends schemas through the JSON-schema fields with unsupported keywords folded away', async () => {
    const ai = fakeAi();
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['qty', 'reason'],
      properties: {
        qty: { type: 'integer', minimum: 0, exclusiveMinimum: true },
        reason: { type: 'string', maxLength: 500, pattern: '^.*$' },
        maybe: { type: 'string', nullable: true },
        tags: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 5 },
      },
    };
    await new GoogleGenaiClient({ ai }).generate({
      model: 'm', contents: [{ role: 'user', text: 'x' }], responseMimeType: 'application/json', responseSchema: schema,
      tools: [{ name: 'submit_turn', description: 'd', parameters: schema }], maxOutputTokens: 1, signal,
    });
    const config = (ai.models.generateContent as ReturnType<typeof vi.fn>).mock.calls[0]![0].config;
    const expected = {
      type: 'object',
      additionalProperties: false,
      required: ['qty', 'reason'],
      properties: {
        qty: { type: 'integer', minimum: 1 },
        reason: { type: 'string', description: '(at most 500 characters)' },
        maybe: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        tags: { type: 'array', items: { type: 'string', description: '(at least 1 characters)' }, maxItems: 5 },
      },
    };
    expect(config.responseSchema).toBeUndefined();
    expect(config.responseJsonSchema).toEqual(expected);
    expect(config.tools[0].functionDeclarations[0].parametersJsonSchema).toEqual(expected);
  });
});
