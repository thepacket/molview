/**
 * OpenRouter client.
 *
 * Called straight from the browser. The key is held in this tab's
 * sessionStorage and sent only to openrouter.ai — nothing in MolView proxies
 * it, and it is never written into a project, a share link, or a log.
 */

import { ACTION_TYPES } from './actionTypes';

const KEY_STORAGE = 'molview-openrouter-key';
const MODEL_STORAGE = 'molview-openrouter-model';
const STRUCTURED_STORAGE = 'molview-openrouter-structured';
const CONFIRM_STORAGE = 'molview-assistant-confirm';
export const SETTINGS_EVENT = 'molview:openrouter-settings';

/** A capable default; the picker is populated from the live catalogue. */
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5';

export interface OpenRouterModel {
  id: string;
  name: string;
  provider: string;
  supportedParameters: string[];
}

function sessionGet(key: string): string {
  try {
    return sessionStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function sessionSet(key: string, value: string): void {
  try {
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    // A browser with storage disabled still works, just not across reloads.
  }
  window.dispatchEvent(new CustomEvent(SETTINGS_EVENT));
}

export function getApiKey(): string { return sessionGet(KEY_STORAGE); }
export function setApiKey(key: string): void { sessionSet(KEY_STORAGE, key.trim()); }
export function getModel(): string { return sessionGet(MODEL_STORAGE) || DEFAULT_MODEL; }
export function setModel(model: string): void { sessionSet(MODEL_STORAGE, model.trim()); }

/**
 * Whether to let the API enforce the reply shape. On by default: Claude and
 * GPT models support it, and it lets the prompt drop the schema text.
 */
export function getStructuredOutputs(): boolean {
  return sessionGet(STRUCTURED_STORAGE) !== '0';
}

export function setStructuredOutputs(enabled: boolean): void {
  sessionSet(STRUCTURED_STORAGE, enabled ? '' : '0');
}

/**
 * Whether actions wait for approval before they run.
 *
 * Off by default, and that is a considered position rather than laziness:
 * everything the assistant can do is a reversible view change, so a
 * confirmation on each one is a click that protects against nothing. It exists
 * because "an AI moved my scene without asking" is a reasonable thing to
 * object to even when nothing was at stake, and because watching what a weak
 * model *wanted* to do is the fastest way to understand why it went wrong.
 */
export function getConfirmActions(): boolean {
  return sessionGet(CONFIRM_STORAGE) === '1';
}

export function setConfirmActions(enabled: boolean): void {
  sessionSet(CONFIRM_STORAGE, enabled ? '1' : '');
}

/** Whether the catalogue says this model can be held to a JSON schema. */
export function modelSupportsStructured(modelId: string): boolean | null {
  if (!modelsCache) return null;
  const entry = modelsCache.find((m) => m.id === modelId);
  if (!entry) return null;
  return entry.supportedParameters.includes('structured_outputs');
}

/**
 * True when this turn will actually be schema-enforced, which is what decides
 * whether the prompt has to carry the schema itself.
 *
 * Answers false while the catalogue is unknown, so the schema goes in the
 * prompt rather than being dropped on a model that cannot be constrained.
 * Callers that are about to build a prompt should `await ensureModels()` first.
 */
export function structuredOutputsActive(): boolean {
  return getStructuredOutputs() && modelSupportsStructured(getModel()) === true;
}

/** Warms the catalogue so the support check can answer. Never throws. */
export async function ensureModels(): Promise<void> {
  try { await fetchModels(); } catch { /* the request path falls back anyway */ }
}

function attributionHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'X-OpenRouter-Title': 'MolView',
    Authorization: `Bearer ${getApiKey()}`,
  };
  if (location.protocol.startsWith('http')) headers['HTTP-Referer'] = location.origin;
  return headers;
}

// ---------------------------------------------------------------------------
// Model catalogue
// ---------------------------------------------------------------------------

let modelsCache: OpenRouterModel[] | null = null;

export async function fetchModels(force = false): Promise<OpenRouterModel[]> {
  if (modelsCache && !force) return modelsCache;

  const response = await fetch('https://openrouter.ai/api/v1/models');
  if (!response.ok) throw new Error(`Could not list models (${response.status})`);
  const json = await response.json();

  const models: OpenRouterModel[] = (json.data ?? [])
    .map((m: Record<string, unknown>) => ({
      id: String(m.id),
      name: String(m.name ?? m.id),
      provider: String(m.id).split('/')[0].replace(/^~/, ''),
      supportedParameters: Array.isArray(m.supported_parameters)
        ? (m.supported_parameters as string[])
        : [],
    }))
    .sort((a: OpenRouterModel, b: OpenRouterModel) => a.name.localeCompare(b.name));

  modelsCache = models;
  return models;
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/** The reply envelope: prose for the user, plus actions for the viewer. */
const RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['message', 'actions'],
  properties: {
    message: {
      type: 'string',
      description: 'User-facing Markdown. Use Markdown tables and LaTeX equations when useful.',
    },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'reason', 'value'],
        properties: {
          type: { enum: [...ACTION_TYPES] },
          reason: { type: 'string' },
          value: {
            type: ['string', 'null'],
            description: 'Instruction value, or null when the instruction needs none.',
          },
        },
      },
    },
  },
} as const;

export function responseSchemaForPrompt(): string {
  return JSON.stringify(RESPONSE_SCHEMA);
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface Completion {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  /**
   * Reasoning is requested with `exclude: true`, so it never reaches `content`
   * — but it is billed as output all the same. It is counted inside
   * `completionTokens`; this is the part of that figure you cannot read.
   */
  reasoningTokens: number;
  totalTokens: number;
}

export async function requestCompletion(
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<Completion> {
  const key = getApiKey();
  if (!key) throw new Error('Add an OpenRouter API key in Settings first.');

  const model = getModel();
  const catalogue = await fetchModels().catch(() => [] as OpenRouterModel[]);
  const entry = catalogue.find((m) => m.id === model);
  const supports = (parameter: string) =>
    !entry || entry.supportedParameters.includes(parameter);

  const body: Record<string, unknown> = { model, messages, stream: false };

  // Structured output where the model can do it and the user wants it; a plain
  // JSON mode otherwise; prompt-only grammar as the last resort.
  if (getStructuredOutputs() && entry?.supportedParameters.includes('structured_outputs')) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'molview_response', strict: true, schema: RESPONSE_SCHEMA },
    };
    body.provider = { require_parameters: true };
  } else if (getStructuredOutputs() && entry?.supportedParameters.includes('response_format')) {
    body.response_format = { type: 'json_object' };
  }

  const reasoning = entry?.supportedParameters.includes('reasoning');
  if (reasoning) body.reasoning = { effort: 'low', exclude: true };

  // A truncated reply loses the closing brace and becomes unparseable, so the
  // cap is generous rather than tight.
  const cap = reasoning ? 3200 : 2400;
  if (supports('max_completion_tokens')) body.max_completion_tokens = cap;
  else body.max_tokens = cap;

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: attributionHeaders(),
    body: JSON.stringify(body),
    signal,
  });

  const json = await response.json().catch(() => null);
  if (!response.ok || json?.error) throw new Error(formatError(response.status, json));

  const choice = json?.choices?.[0];
  const raw = choice?.message?.content;
  const content = typeof raw === 'string'
    ? raw
    : Array.isArray(raw)
      ? raw.map((part: { text?: string }) => part?.text ?? '').join('')
      : '';

  // A provider failure arrives as HTTP 200 with the error inside the choice, so
  // it has to be read here as well as at the top level.
  if (choice?.error) throw new Error(formatError(response.status, choice));
  if (!content.trim()) throw new Error(formatEmptyReply(choice, json));
  if (choice?.finish_reason === 'length' || choice?.finish_reason === 'max_tokens') {
    throw new Error('The reply was cut off before it finished. Ask for something shorter.');
  }

  const usage = json?.usage ?? {};
  return {
    content,
    model: json?.model ?? model,
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
  };
}

/**
 * An empty reply is a symptom, not a cause. Everything the response says about
 * why it came back empty is reported here rather than collapsed into one
 * sentence — a refusal, a content filter, a truncation that left nothing behind,
 * a reasoning model that spent its whole budget thinking.
 */
function formatEmptyReply(choice: unknown, json: unknown): string {
  const c = choice as {
    message?: { refusal?: unknown; reasoning?: unknown };
    finish_reason?: unknown;
    native_finish_reason?: unknown;
  } | undefined;

  const refusal = c?.message?.refusal;
  if (typeof refusal === 'string' && refusal.trim()) {
    return `The model declined: ${refusal.trim()}`;
  }

  const finish = typeof c?.finish_reason === 'string' ? c.finish_reason : '';
  const native = typeof c?.native_finish_reason === 'string' ? c.native_finish_reason : '';

  if (finish === 'content_filter') {
    return 'The provider’s content filter blocked the reply.';
  }
  if (finish === 'length' || finish === 'max_tokens') {
    return 'The model hit the token cap before writing anything. On a reasoning '
      + 'model, lower the reasoning effort or ask something narrower.';
  }

  const usage = (json as { usage?: Record<string, number> } | null)?.usage;
  const reasoning = (usage as { completion_tokens_details?: { reasoning_tokens?: number } })
    ?.completion_tokens_details?.reasoning_tokens ?? 0;
  if (reasoning > 0) {
    return `The model returned ${reasoning} reasoning tokens and no reply. `
      + 'It spent the whole output budget thinking; ask something narrower.';
  }

  // Nothing explained itself, so say exactly what came back instead of guessing.
  // The message's field names are the useful part: they say whether the reply
  // went somewhere other than content, such as tool_calls or reasoning.
  const fields = c?.message && typeof c.message === 'object'
    ? Object.keys(c.message).filter((k) => k !== 'role').join(', ')
    : '';

  const detail = [
    finish && `finish_reason: ${finish}`,
    native && native !== finish && `provider: ${native}`,
    fields && `message fields: ${fields}`,
    !c && 'no choices in the response',
  ].filter(Boolean).join(', ');

  return detail
    ? `The model returned an empty reply (${detail}).`
    : 'The model returned an empty reply, and said nothing about why.';
}

function formatError(status: number, json: unknown): string {
  const error = (json as { error?: Record<string, unknown> })?.error;
  if (!error) {
    if (status === 401) return 'OpenRouter rejected the API key.';
    if (status === 402) return 'That OpenRouter account is out of credit.';
    if (status === 429) return 'OpenRouter is rate limiting this key. Wait a moment.';
    return `OpenRouter returned ${status}.`;
  }
  const parts = [String(error.message ?? `OpenRouter returned ${status}`)];
  const metadata = error.metadata as Record<string, unknown> | undefined;
  if (metadata?.provider_name) parts.push(`(provider: ${String(metadata.provider_name)})`);
  if (typeof metadata?.raw === 'string' && metadata.raw) {
    parts.push(metadata.raw.slice(0, 500));
  }
  return parts.join(' ');
}
