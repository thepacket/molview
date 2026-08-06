/**
 * The system prompt, and the compacted scene description sent with each turn.
 *
 * The command list is described twice on purpose: once machine-readable, as the
 * enum inside the injected JSON schema, and once in prose so the model knows
 * what each action is *for*. Structures are summarised — chain names and counts,
 * never coordinates.
 */

import { ACTION_REFERENCE } from './actionTypes';
import { responseSchemaForPrompt, structuredOutputsActive } from './openrouter';
import { COLOR_SCHEME_LABELS } from '../mol/coloring';
import { validationForPrompt } from '../rcsb/validation';
import { MolKind } from '../mol/structure';
import { SELECTION_KEYWORDS } from '../mol/selection';
import { LAYOUT_SLOT_COUNT, useStore } from '../state/store';
import { viewer } from '../viewer/ViewerController';

function actionTable(): string {
  return ACTION_REFERENCE
    .map((a) => `- ${a.type} — value: ${a.value}. ${a.note}`)
    .join('\n');
}

export function systemPrompt(): string {
  // When the API is enforcing the schema there is no reason to restate it in
  // the prompt; a one-line description saves ~140 tokens a turn.
  const grammar = structuredOutputsActive()
    ? `Return exactly one JSON object with two keys: "message", a Markdown
string, and "actions", an array of {type, reason, value} objects using the
action types listed above. The API enforces this shape.`
    : `Return exactly one JSON object matching this schema: ${responseSchemaForPrompt()}`;

  return `You are a structural biologist working alongside someone using MolView, a
molecular viewer for the RCSB Protein Data Bank. You know protein and nucleic
acid structure, folds and motifs, ligand binding, symmetry and biological
assemblies, crystallographic and cryo-EM practice, and how to read a structure
critically.

Answer as a knowledgeable colleague would: get to the point, say what is
actually visible in the data, and separate what the structure shows from what
is inference. If a question rests on a wrong premise, say so. If something
cannot be determined from the coordinates at hand, say that rather than
guessing. Do not pad replies with restatements of the question.

You can also drive the viewer. SCENE describes what is currently loaded.

Selections use MolView's grammar:
  /A,B          chains by auth id
  :1-140,200    residues by sequence number
  :HEM          residues by component name
  @CA,N,C,O     atoms by name
  /A:1-140@CA   the three intersected
Combine with and / or / not and parentheses. Juxtaposition means intersection,
so "protein /A" is "protein and /A". Category keywords: ${SELECTION_KEYWORDS.join(', ')}.
Colour schemes: ${Object.keys(COLOR_SCHEME_LABELS).join(', ')}.

Actions available:
${actionTable()}

Output grammar:
${grammar}
- message is the user-facing part, in Markdown. Use GitHub-style tables when
  comparing things. Write equations in LaTeX with $...$ inline and $$...$$ for
  display.
- Because message is a JSON string, escape every LaTeX backslash as two JSON
  backslashes: emit $$\\\\mathrm{RMSD}=\\\\sqrt{N^{-1}\\\\sum_i d_i^2}$$ in the JSON source.
- actions change the viewer. Emit one only when the user asks to show, change,
  load, measure, or move something; a suggestion belongs in message alone. Give
  each action a short reason. Actions run in order, and later ones see the
  effect of earlier ones — so load before you style, and set the active pane
  before acting on it.
- After your actions run, their results come back as a RESULTS message. Read
  it: it says what a search found and which actions were rejected, and it is
  the difference between answering from the structure and guessing.
- Only reference panes, entries, chains and assemblies that appear in SCENE.
- Never wrap the JSON object in Markdown fences, and put no prose outside it.`;
}

/** A compact description of what is on screen. Counts and names, no coordinates. */
export function sceneContext(): string {
  const state = useStore.getState();
  const paneCount = LAYOUT_SLOT_COUNT[state.layout];

  const panes = [];
  for (let i = 0; i < paneCount; i++) {
    const slot = state.slots[i];
    const structure = viewer.getStructure(i);
    if (!structure || slot.status !== 'ready') {
      panes.push({ pane: i + 1, empty: true });
      continue;
    }

    // Chains as the user sees them: one entry per auth id.
    const chains = new Map<string, { kind: string; residues: number }>();
    for (let c = 0; c < structure.chainCount; c++) {
      const id = structure.chainAuthId[c];
      const residues = structure.chainResStart[c + 1] - structure.chainResStart[c];
      const kind = kindName(structure.chainKind[c]);
      const existing = chains.get(id);
      if (existing) existing.residues += residues;
      else chains.set(id, { kind, residues });
    }

    const ligands = new Set<string>();
    for (let r = 0; r < structure.residueCount && ligands.size < 12; r++) {
      if (structure.resKind[r] === MolKind.Ligand) {
        ligands.add(structure.nameTable[structure.resNameId[r]]);
      }
    }

    panes.push({
      pane: i + 1,
      active: i === state.activeSlot,
      entry: slot.entryId,
      title: slot.detail?.title,
      method: slot.detail?.method,
      resolution: slot.detail?.resolution,
      atoms: slot.stats?.atoms,
      // Only when a metric is actually middling or poor, so a sound structure
      // costs nothing per turn and a weak one cannot be read uncritically.
      modelQuality: slot.detail
        ? validationForPrompt(slot.detail.validation, slot.detail.method) ?? undefined
        : undefined,
      chains: [...chains].map(([id, c]) => `${id}:${c.kind}:${c.residues}`),
      ligands: [...ligands],
      assembly: slot.assemblyId || 'asymmetric unit',
      assembliesAvailable: structure.assemblies.map((a) => `${a.id} (${a.totalCopies}x)`),
      models: structure.modelCount,
      showingAllModels: structure.modelNum === 0,
      components: state.slots[i].components.map((c) => `${c.name}="${c.selection}"`),
      colorScheme: slot.colorScheme,
      measurements: slot.measurements.map((m) => `${m.kind} ${m.label}`),
      superposedOnto: slot.superposedOnto === null ? undefined : slot.superposedOnto + 1,
      rmsd: slot.superposeRmsd ?? undefined,
      overlaying: slot.overlaySlots.map((s) => s + 1),
      // Named rather than implied: a model and an experiment answer different
      // questions, and treating a prediction as a measurement is the mistake
      // this key exists to prevent.
      predicted: slot.prediction
        ? `AlphaFold model of ${slot.prediction.accession}, mean pLDDT `
          + `${slot.prediction.meanPlddt.toFixed(0)}`
        : undefined,
      surface: slot.surface.status === 'ready'
        ? slot.surface.selection || 'everything drawn'
        : undefined,
      // Only when a map is up: the absence of the key is what tells the model
      // there is none, and it can ask for one with the density action.
      density: slot.density.status === 'ready'
        ? `${slot.density.source} at ${slot.density.level} sigma`
          + `${slot.density.showDifference ? ', Fo-Fc shown' : ''}`
        : undefined,
    });
  }

  return JSON.stringify({ layout: state.layout, activePane: state.activeSlot + 1, panes });
}

function kindName(kind: number): string {
  switch (kind) {
    case MolKind.Protein: return 'protein';
    case MolKind.Nucleic: return 'nucleic';
    case MolKind.Water: return 'water';
    case MolKind.Ion: return 'ion';
    default: return 'ligand';
  }
}
