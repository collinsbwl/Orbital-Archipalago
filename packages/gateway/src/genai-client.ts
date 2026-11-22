// Narrow client surface the GeminiGateway needs from @google/genai. Living behind
// an interface keeps tests fast (no network) and leaves room to pin an exact SDK
// version without rippling through callers.

import type { DecisionQuestion, ToolDeclaration } from '@orbital/contracts';

export interface GenerateArgs {
  model: string;
  cachedContent?: string;
  systemInstruction?: string;
  tools?: ToolDeclaration[];
  /** Serialised user messages: role 'user' or 'tool'. */
  contents: Array<
    | { role: 'user'; text: string }
    | { role: 'tool'; name: string; response: unknown }
  >;
  responseMimeType?: 'application/json' | 'text/plain';
  responseSchema?: Record<string, unknown>;
  thinkingBudget?: number;
  maxOutputTokens: number;
  signal: AbortSignal;
}

export interface FunctionCall {
  name: string;
  args: unknown;
}

export interface GenerateResult {
  /** Non-null when the model emitted plain text (`structured` and `text` modes). */
  text: string | null;
  /** Non-empty in `tools` mode when the model calls a function. */
  functionCalls: FunctionCall[];
  /** Gemini's `finishReason`. The gateway maps 'SAFETY' to `refused`. */
  finishReason: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'OTHER';
  usage: {
    promptTokenCount: number;
    cachedContentTokenCount: number;
    candidatesTokenCount: number;
    thoughtsTokenCount: number;
  };
}

export interface GenaiClient {
  generate(args: GenerateArgs): Promise<GenerateResult>;
  generateStream(args: GenerateArgs): AsyncIterable<{ text?: string; done?: GenerateResult }>;
}

// ---- Decisions API (gemini-decision-1) -----------------------------------

export interface DecisionCreateArgs {
  model: string;
  input: string;
  questions: Record<string, DecisionQuestion>;
  signal: AbortSignal;
}

export interface DecisionCreateResult {
  /** Raw answers keyed like `questions`. Absent when the input was blocked. */
  answers?: Record<string, unknown>;
  /** Set when the content filter blocked the input. */
  blockReason?: string;
  usage: { inputTokens: number };
}

export interface DecisionClient {
  create(args: DecisionCreateArgs): Promise<DecisionCreateResult>;
}
