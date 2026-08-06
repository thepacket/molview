/**
 * Settings. Currently just the assistant's OpenRouter credentials and model.
 *
 * The key is typed by the user and never leaves this browser except in the
 * Authorization header of a request to openrouter.ai. It is held in this tab's
 * sessionStorage, so closing the tab discards it, and it is deliberately
 * excluded from projects and share links.
 */

import { useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, KeyRound, RefreshCw, Trash2 } from 'lucide-react';
import {
  DEFAULT_MODEL, fetchModels, getApiKey, getConfirmActions, getModel,
  getStructuredOutputs, setApiKey, setConfirmActions, setModel,
  setStructuredOutputs, type OpenRouterModel,
} from '../../ai/openrouter';
import { isColorBlindSafe, setColorBlindSafe } from '../../mol/coloring';
import { viewer } from '../../viewer/ViewerController';
import { Field, Toggle } from '../controls';

export function SettingsPanel() {
  const [key, setKey] = useState(getApiKey());
  const [saved, setSaved] = useState(false);
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [modelId, setModelId] = useState(getModel());
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [structured, setStructured] = useState(getStructuredOutputs());
  const [confirm, setConfirm] = useState(getConfirmActions());
  const [safePalette, setSafePalette] = useState(isColorBlindSafe());

  const load = (force = false) => {
    setLoading(true);
    setError(null);
    fetchModels(force)
      .then(setModels)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  // The whole catalogue, not a page of it: a list that silently stops after the
  // first n entries makes a model that is present look absent.
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return models;
    return models.filter((m) =>
      m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle));
  }, [models, filter]);

  const selectedSupports = models.length === 0
    ? null
    : models.find((m) => m.id === modelId)?.supportedParameters
      .includes('structured_outputs') ?? false;

  const commitKey = () => {
    setApiKey(key);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  };

  return (
    <>
      <div className="panel-section">
        <div className="section-label"><span>OpenRouter</span></div>

        <Field label="API key">
          <input
            className="text-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-or-v1-…"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commitKey(); }}
          />
        </Field>

        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            className="btn primary small"
            style={{ flex: 1 }}
            disabled={!key.trim()}
            onClick={commitKey}
          >
            {saved ? <><Check size={11} /> Saved</> : <><KeyRound size={11} /> Save key</>}
          </button>
          <button
            type="button"
            className="btn small"
            style={{ flex: 1 }}
            disabled={!getApiKey()}
            onClick={() => { setApiKey(''); setKey(''); }}
          >
            <Trash2 size={11} /> Clear
          </button>
        </div>

        <p style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 8, lineHeight: 1.5 }}>
          Kept in this tab only, and sent straight to openrouter.ai — MolView has
          no server to send it to. Closing the tab discards it. It is never
          written into a project or a shareable link.
        </p>
        <a
          className="link"
          href="https://openrouter.ai/keys"
          target="_blank"
          rel="noreferrer"
          style={{ fontSize: 10.5, display: 'inline-block', marginTop: 5 }}
        >
          Get a key <ExternalLink size={9} style={{ verticalAlign: -1 }} />
        </a>
      </div>

      <div className="panel-section">
        <div className="section-label">
          <span>Model</span>
          <button
            type="button"
            className="btn ghost small"
            disabled={loading}
            onClick={() => load(true)}
          >
            <RefreshCw size={11} /> Refresh
          </button>
        </div>

        <div className="current-project current-model" style={{ marginBottom: 7 }}>
          {modelId}
        </div>

        <input
          className="text-input"
          placeholder={`Filter ${models.length || ''} models…`}
          value={filter}
          spellCheck={false}
          onChange={(e) => setFilter(e.target.value)}
        />

        {error && (
          <p style={{ fontSize: 10.5, color: 'var(--error)', marginTop: 6 }}>{error}</p>
        )}
        {loading && (
          <p style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 6 }}>
            Loading the catalogue…
          </p>
        )}

        <div className="model-list">
          {visible.map((m) => (
            <button
              key={m.id}
              type="button"
              className="model-row"
              data-active={m.id === modelId}
              onClick={() => { setModel(m.id); setModelId(m.id); }}
            >
              <span className="model-name">{m.name}</span>
              <span className="model-id">{m.id}</span>
              {m.supportedParameters.includes('structured_outputs') && (
                <span className="chip accent">structured</span>
              )}
            </button>
          ))}
          {!loading && visible.length === 0 && (
            <p style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>Nothing matches.</p>
          )}
        </div>

        {models.length > 0 && (
          <p style={{ fontSize: 10, color: 'var(--text-faint)', marginTop: 5 }}>
            {filter.trim()
              ? `${visible.length} of ${models.length} models`
              : `${models.length} models`}
          </p>
        )}

        <p style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 8, lineHeight: 1.5 }}>
          Models marked <em>structured</em> can be held to the reply schema
          exactly. The default is {DEFAULT_MODEL}.
        </p>
      </div>

      <div className="panel-section">
        <div className="section-label"><span>Reply format</span></div>
        <Toggle
          label="Structured outputs"
          checked={structured}
          onChange={(v) => { setStructuredOutputs(v); setStructured(v); }}
          hint="Let the API enforce the reply schema instead of describing it in the prompt"
        />
        <p style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 7, lineHeight: 1.5 }}>
          {structured
            ? (selectedSupports === false
                ? `${modelId} does not advertise structured outputs, so the schema `
                  + 'is being described in the prompt instead. Replies may drift '
                  + 'from the expected shape.'
                : 'The API holds the model to the reply schema, so the prompt does '
                  + 'not restate it — about 140 tokens a turn cheaper, and the '
                  + 'reply shape is guaranteed rather than requested.')
            : 'The schema is spelled out in the prompt instead. Slower and more '
              + 'expensive, but it is the fallback when a provider mishandles '
              + 'schema-constrained requests.'}
        </p>
      </div>

      <div className="panel-section">
        <div className="section-label"><span>Accessibility</span></div>
        <Toggle
          label="Colour-blind-safe chain palette"
          checked={safePalette}
          onChange={(v) => {
            setColorBlindSafe(v);
            setSafePalette(v);
            // Colours are baked into the geometry buffers, so every pane has to
            // be rebuilt rather than merely redrawn.
            viewer.rebuildAll();
          }}
          hint="Swaps the chain palette for one that survives deuteranopia and protanopia"
        />
        <p style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 7, lineHeight: 1.5 }}>
          {safePalette
            ? 'Okabe and Ito\u2019s eight colours. Fewer than the default fourteen, so a '
              + 'structure with many chains repeats sooner \u2014 which is the honest cost of '
              + 'colours that stay distinguishable.'
            : 'The default palette runs cyan, orange, purple, green, pink. The green and '
              + 'pink collide under the commonest form of colour-vision deficiency, which '
              + 'affects about eight per cent of men.'}
        </p>
      </div>

      <div className="panel-section">
        <div className="section-label"><span>Actions</span></div>
        <Toggle
          label="Confirm before running"
          checked={confirm}
          onChange={(v) => { setConfirmActions(v); setConfirm(v); }}
          hint="Each reply's actions wait in the transcript until you approve them"
        />
        <p style={{ fontSize: 10.5, color: 'var(--text-faint)', marginTop: 7, lineHeight: 1.5 }}>
          {confirm
            ? 'Actions are listed with a tick each and run only when you say so. '
              + 'Untick the one that is wrong and keep the rest.'
            : 'Actions run as soon as they arrive. Everything the assistant can do '
              + 'is a reversible view change — nothing is written, sent or deleted '
              + 'anywhere — so the default is to let it work.'}
        </p>
      </div>
    </>
  );
}
