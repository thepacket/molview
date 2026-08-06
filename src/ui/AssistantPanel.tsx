/**
 * The assistant panel: a transcript above a composer, sitting between the
 * viewport and the status bar.
 *
 * Height is published as a CSS custom property rather than set inline, so the
 * shell grid reflows the stage above it and the WebGPU canvas picks up the new
 * rectangle on its next frame without anything special.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot, ChevronDown, ChevronUp, Eraser, Send, Settings2, Square,
} from 'lucide-react';
import { applyAction } from '../ai/actions';
import { parseReply } from '../ai/parse';
import { sceneContext, systemPrompt } from '../ai/prompt';
import {
  ensureModels, getApiKey, getModel, requestCompletion, SETTINGS_EVENT,
  type ChatMessage, type Completion,
} from '../ai/openrouter';
import { useStore } from '../state/store';
import { Tip } from './controls';

const HEIGHT_KEY = 'molview-assistant-height';
const COLLAPSED_KEY = 'molview-assistant-collapsed';
const DEFAULT_HEIGHT = 280;
const MIN_HEIGHT = 160;
const COLLAPSED_HEIGHT = 32;

type Role = 'user' | 'assistant' | 'notice' | 'error';

interface Entry {
  id: number;
  role: Role;
  content: string;
}

const EXAMPLES = [
  'What is this structure and what should I be looking at?',
  'Show the haem groups as ball and stick and colour the protein by chain',
  'Measure the iron to proximal histidine distance',
  'Load 101M next to it and superpose them',
  'Colour by B-factor and explain what the spread means',
  'Show the biological assembly and describe its symmetry',
];

function readNumber(key: string, fallback: number): number {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? Number(raw) || fallback : fallback;
  } catch {
    return fallback;
  }
}

function clampHeight(px: number): number {
  return Math.min(Math.max(px, MIN_HEIGHT), Math.round(window.innerHeight * 0.72));
}

/**
 * Input and output separately, because they are not priced alike — output
 * typically costs several times input, so a single total hides the number that
 * drives the bill. Reasoning is called out when there is any: it is billed as
 * output but never appears in the reply.
 */
function formatUsage(usage: Completion): string {
  const n = (v: number) => v.toLocaleString();
  if (!usage.promptTokens && !usage.completionTokens) {
    return `${n(usage.totalTokens)} tokens`;
  }
  const reasoning = usage.reasoningTokens > 0
    ? ` (${n(usage.reasoningTokens)} reasoning)`
    : '';
  return `${n(usage.promptTokens)} in · ${n(usage.completionTokens)} out${reasoning}`;
}

export function AssistantPanel() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [model, setModelLabel] = useState(getModel());
  const [hasKey, setHasKey] = useState(!!getApiKey());
  const [collapsed, setCollapsed] = useState(() => {
    try { return sessionStorage.getItem(COLLAPSED_KEY) === '1'; } catch { return false; }
  });
  const [height, setHeight] = useState(() => readNumber(HEIGHT_KEY, DEFAULT_HEIGHT));

  const abortRef = useRef<AbortController | null>(null);
  const conversationRef = useRef<ChatMessage[]>([]);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);
  const setPanel = useStore((s) => s.setPanel);

  // The shell grid reads this; the canvas resizes itself from the DOM rect.
  useEffect(() => {
    document.documentElement.style.setProperty(
      '--assistant-h', `${collapsed ? COLLAPSED_HEIGHT : height}px`,
    );
  }, [height, collapsed]);

  useEffect(() => {
    const refresh = () => { setModelLabel(getModel()); setHasKey(!!getApiKey()); };
    window.addEventListener(SETTINGS_EVENT, refresh);
    return () => window.removeEventListener(SETTINGS_EVENT, refresh);
  }, []);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  const append = useCallback((role: Role, content: string) => {
    setEntries((prev) => [...prev, { id: nextId.current++, role, content }]);
  }, []);

  /**
   * Drops everything the assistant has accumulated: the visible transcript and
   * the rolling history sent with each turn. A request still in flight is
   * aborted too, since its reply would otherwise land in a transcript the user
   * has just emptied.
   */
  const clearContext = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    conversationRef.current = [];
    setEntries([]);
    setBusy(false);
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (collapsed) return;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);

    const move = (e: PointerEvent) => {
      // Measured from the bottom of the window, minus the status bar.
      setHeight(clampHeight(window.innerHeight - e.clientY - 24));
    };
    const end = (e: PointerEvent) => {
      target.releasePointerCapture(e.pointerId);
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      // Persist once, not on every move.
      setHeight((h) => {
        try { sessionStorage.setItem(HEIGHT_KEY, String(h)); } catch { /* ignore */ }
        return h;
      });
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  };

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      try { sessionStorage.setItem(COLLAPSED_KEY, next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };

  const submit = async () => {
    const text = draft.trim();
    if (!text || busy) return;

    if (!getApiKey()) {
      append('error', 'Add an OpenRouter API key in Settings first.');
      setPanel('settings');
      return;
    }

    setDraft('');
    append('user', text);
    setBusy(true);

    const controller = new AbortController();
    abortRef.current = controller;

    // The prompt's shape depends on whether this model can be schema-enforced,
    // so the catalogue has to be known before the prompt is built.
    await ensureModels();

    // A short rolling window keeps the request small; the scene is appended
    // fresh each turn because it is the part that actually changes.
    const history = conversationRef.current.slice(-6);
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt() },
      ...history,
      { role: 'user', content: `${text}\n\nSCENE:\n${sceneContext()}` },
    ];

    try {
      const completion = await requestCompletion(messages, controller.signal);
      const parsed = parseReply(completion.content);

      append('assistant', parsed.message);
      conversationRef.current = [
        ...history,
        { role: 'user', content: text },
        { role: 'assistant', content: parsed.message },
      ];

      for (const action of parsed.actions) {
        try {
          append('notice', await applyAction(action));
        } catch (err) {
          append('error', `Action failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (completion.totalTokens > 0) {
        append('notice', `${completion.model} · ${formatUsage(completion)}`);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') append('notice', 'Stopped.');
      else append('error', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  return (
    <section className="assistant" data-collapsed={collapsed}>
      <div
        className="assistant-splitter"
        onPointerDown={startResize}
        role="separator"
        aria-label="Resize the assistant"
      />

      <header className="assistant-header">
        <Bot size={13} className="assistant-icon" />
        <span className="assistant-title">Assistant</span>
        <span className="assistant-model">{hasKey ? model : 'no API key'}</span>
        <div className="assistant-tools">
          <Tip label="Forget the conversation so far">
            <button
              type="button"
              className="btn ghost small"
              aria-label="Clear conversation"
              disabled={entries.length === 0 && !busy}
              onClick={clearContext}
            >
              <Eraser size={11} /> Clear
            </button>
          </Tip>
          <Tip label="Assistant settings">
            <button
              type="button"
              className="pane-icon-btn"
              aria-label="Assistant settings"
              onClick={() => setPanel('settings')}
            >
              <Settings2 size={12} />
            </button>
          </Tip>
          <Tip label={collapsed ? 'Expand' : 'Collapse'}>
            <button
              type="button"
              className="pane-icon-btn"
              aria-label={collapsed ? 'Expand assistant' : 'Collapse assistant'}
              onClick={toggleCollapsed}
            >
              {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
          </Tip>
        </div>
      </header>

      <div className="assistant-transcript" ref={transcriptRef}>
        {entries.length === 0 && (
          <div className="assistant-empty">
            <p>
              Ask about what is on screen, or tell the assistant to change it. It
              can load entries, build representations, measure, superpose and more.
            </p>
            <div className="chip-row">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  className="chip"
                  onClick={() => setDraft(example)}
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        )}
        {entries.map((entry) => <Message key={entry.id} entry={entry} />)}
        {busy && <div className="assistant-row notice">Thinking…</div>}
      </div>

      <form
        className="assistant-composer"
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
      >
        <textarea
          rows={2}
          className="text-input"
          placeholder="Ask about the structure, or say what to show…"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
            e.stopPropagation();
          }}
        />
        {busy ? (
          <button
            type="button"
            className="btn"
            onClick={() => abortRef.current?.abort()}
          >
            <Square size={11} /> Stop
          </button>
        ) : (
          <button type="submit" className="btn primary" disabled={!draft.trim()}>
            <Send size={12} /> Send
          </button>
        )}
      </form>
    </section>
  );
}

function Message({ entry }: { entry: Entry }) {
  if (entry.role === 'assistant') return <AssistantMessage markdown={entry.content} />;
  return (
    <div className={`assistant-row ${entry.role}`}>
      {entry.role === 'user' && <span className="assistant-who">You</span>}
      <span>{entry.content}</span>
    </div>
  );
}

/**
 * Markdown and KaTeX are loaded on first use, which keeps roughly a hundred
 * kilobytes of stylesheet and parser out of the initial bundle.
 */
function AssistantMessage({ markdown }: { markdown: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void import('../ai/markdown').then(({ renderAiMarkdown }) => {
      const el = host.current;
      if (cancelled || !el) return;
      el.replaceChildren(renderAiMarkdown(markdown));
    });
    return () => { cancelled = true; };
  }, [markdown]);

  return <div className="assistant-row assistant-body" ref={host} />;
}
