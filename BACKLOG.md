# Backlog

Forward work, roughly in the order it would pay off. Current limitations of what
already exists are documented at the end of [README.md](README.md) instead.

---

## 1. Projects: save / load / export / import

A **project** is the full state of a session as JSON. Four operations:

| Operation | Mechanism |
| --- | --- |
| Save | persist in the browser (Web Storage / IndexedDB), named slots |
| Load | restore from browser storage, with a project picker |
| Export | download as a `.molview.json` file |
| Import | read a dropped/chosen file, or paste JSON text directly |

**Save and export are distinct.** Saving never downloads a file: it writes to
browser-local storage and the project reappears in the picker on the next visit.
Export is the only operation that crosses the file-system boundary.

### Decided: storage

**IndexedDB**, not `localStorage` — the latter is synchronous, capped near 5 MB,
and stores strings only, all of which become problems the moment a project
embeds coordinates. No library; a small promise wrapper over the raw API is
enough for one object store.

```
database  molview            (version 1)
store     projects           keyPath "id", index on "updatedAt"
record    { id, name, createdAt, updatedAt, format, state }
```

### Decided: format

A single JSON document, readable rather than golfed, with an integer `format`
field from the first release so old projects can be migrated rather than
rejected:

```jsonc
{
  "format": 1,
  "app": "molview",
  "created": "2026-08-05T12:00:00Z",
  "session": { "layout": "quad", "activeSlot": 0, "linkedCameras": false },
  "panes": [
    {
      "entryId": "4HHB",
      "assemblyId": "1",
      "representation": { /* styles, radii, hiddenChains as an array */ },
      "colorScheme": "chain",
      "visual": { /* ao, outline, fog, clip, background */ },
      "camera": { "target": [x, y, z], "orientation": [x, y, z, w], "distance": 0 }
    }
  ]
}
```

The same document is what export writes and import reads, so a project is
portable between browsers without a second serialiser. URL sharing gets its own
compact encoding later rather than distorting this one.

### What the JSON holds

Everything needed to reconstruct the view:

- **Session** — layout mode, active pane, linked-camera flag, panel visibility
- **Per pane** — entry id, assembly id, representation (polymer/ligand style,
  atom scale, bond radius, water/ion/hydrogen flags, hidden chains), colour
  scheme and uniform colour, visual settings (AO, outline, fog, clip,
  orthographic, background), selection, spin state
- **Per camera** — target, orientation quaternion, distance
- **Search** — filters and history (optional; arguably session noise, not project state)

### What it deliberately does *not* hold

Coordinates. A project references entries by PDB id and refetches them —
otherwise a four-pane project of decent structures is hundreds of megabytes.

### Known wrinkles

- **Locally-opened files have no id to refetch.** A project containing one is
  either unrestorable, or has to embed the source. Options: refuse to include
  them, warn and restore the pane empty, or embed BinaryCIF as base64 behind an
  explicit "include coordinates" opt-in. Needs a decision.
- **`hiddenChains` is a `Set`** and won't survive `JSON.stringify` — needs
  explicit conversion both ways.
- **Camera state lives in the engine, not the store** (`Camera.getState()` /
  `setState()`), so serialisation has to reach across that boundary.
- **Format needs a version field** from day one, plus a policy for loading
  older versions.
- Restoring should await all entry loads before applying cameras, or the
  auto-framing on load will overwrite the saved view.

### Natural extension

The same serialiser gives **shareable links** — scene state compressed into the
URL. That is something a desktop tool structurally cannot do, and it is the
strongest argument for MolView2 being a browser app rather than a worse
ChimeraX. Worth designing the project format with URL-encoding in mind (keep it
small, short keys, omit defaults).

---

## 2. Smaller wins

- **Overlay two structures in one pane**: superposition already puts panes in a
  shared frame, but drawing both in a single viewport would make the comparison
  direct rather than side-by-side.
- **Per-chain alignment choice**: superposition picks the longest polymer chain
  in each pane; the chains should be selectable.
- **Ensemble overlay**: models can be stepped through one at a time, but drawing
  several at once is the usual way to read NMR spread.
- **Two structures in one pane**: superposition puts panes in a shared frame,
  but overlaying both in a single viewport would make the comparison direct.
- **Per-chain alignment choice**: superposition currently picks the longest
  polymer chain in each pane; the chains should be selectable.

---

## Done

- **Biological assemblies** (`b8daf53`) — operator expressions applied on the
  GPU; a 49k-atom asymmetric unit becomes a 900-chain capsid for the cost of
  sixty matrices.
- **Selection model** (`f1801fc`) — an atom-specification language and ordered
  draw components, replacing the per-pane global representation.
- **Measurements, contacts and labels** (`6ccf946`) — runtime font atlas and a
  blended label pass, distances/angles/torsions, and geometric hydrogen bonds.
- **Structural superposition** (`1462ed5`) — sequence-guided alignment (Gotoh,
  BLOSUM62) plus Kabsch fitting with iterative pruning, applied as a per-pane
  scene transform so coordinates are never rewritten.
- **Nucleotide base slabs** (`2928528`) — bases fitted in their own ring plane,
  so a double helix reads as one instead of as two bare tubes.
- **Smaller wins** (`d5f2e7a`) — lighting presets, colour by symmetry operator,
  download-size warnings, and NMR model selection.

---

## Not planned

Modeller, dockprep, mutation, docking — these need scientific backends there is
no case for reimplementing. VR. And the full ChimeraX command surface: hundreds
of commands built over decades, and chasing it is mimicry rather than design.

Molecular surfaces (SES/Gaussian) are genuinely wanted but structurally awkward:
the deferred pipeline is opaque-only, and a surface you cannot see the cartoon
through is half a feature. It needs order-independent transparency or a second
forward pass before it is worth starting.
