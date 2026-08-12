/**
 * The Ramachandran plot.
 *
 * The standard artefact for judging a backbone, and the app reported wwPDB's
 * outlier percentage for a long time without ever drawing the thing the
 * percentage counts. A number says how many residues are wrong; the plot says
 * which, and where — a cluster sitting just outside a contour is a different
 * problem from one point stranded in empty space.
 *
 * Points are drawn per category against that category's own contours, because
 * they are genuinely different distributions and overlaying them would put
 * glycine's left-handed density behind everything else's outliers. The summary
 * above the plot counts every category, so switching the view never changes
 * the verdict.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  bandOf, computeRamachandran, summarise,
  RAMA_CATEGORIES, type RamaCategory, type RamaPoint,
} from '../../mol/ramachandran';
import { RAMA_BIN, RAMA_CONTOURS, RAMA_GRID } from '../../mol/ramachandranData';
import { resNameOf } from '../../mol/structure';
import { useStore } from '../../state/store';
import { viewer } from '../../viewer/ViewerController';
import { Segmented } from '../controls';

const SIZE = 320;

const CATEGORY_LABEL: Record<RamaCategory, string> = {
  general: 'General',
  glycine: 'Gly',
  proline: 'Pro',
  preproline: 'pre-Pro',
  ilevaline: 'Ile/Val',
};

/** Decodes one category's run-length encoded grid for painting. */
function decodeGrid(category: RamaCategory): Uint8Array {
  const grid = new Uint8Array(RAMA_GRID * RAMA_GRID);
  const encoded = RAMA_CONTOURS[category];
  if (!encoded) return grid;
  let at = 0;
  for (const part of encoded.split(',')) {
    const colon = part.indexOf(':');
    const value = Number(part.slice(0, colon));
    const run = Number(part.slice(colon + 1));
    grid.fill(value, at, at + run);
    at += run;
  }
  return grid;
}

/** Data space (-180..180) to canvas pixels. Psi runs up, so its axis flips. */
function toPixel(phi: number, psi: number): [number, number] {
  return [((phi + 180) / 360) * SIZE, ((180 - psi) / 360) * SIZE];
}

export function RamachandranPlot({ slot }: { slot: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [category, setCategory] = useState<RamaCategory>('general');
  const [hover, setHover] = useState<RamaPoint | null>(null);

  const selectedResidue = useStore((s) => s.slots[slot].selectedResidue);
  const patchSlot = useStore((s) => s.patchSlot);
  const structure = viewer.getStructure(slot);

  const points = useMemo(
    () => (structure ? computeRamachandran(structure) : []),
    [structure],
  );
  const summary = useMemo(() => summarise(points), [points]);

  const shown = useMemo(
    () => points.filter((p) => p.category === category),
    [points, category],
  );

  // Every outlier, whatever its category — the list is the actionable half and
  // it should not depend on which background happens to be on screen.
  const outliers = useMemo(
    () => points.filter((p) => bandOf(p.phi, p.psi, p.category) === 'outlier'),
    [points],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !structure) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);

    // Contours, painted per pixel from the grid rather than as vector outlines:
    // the grid is the authority on what is inside, and tracing it would add a
    // second answer to the same question.
    const grid = decodeGrid(category);
    const image = ctx.createImageData(SIZE, SIZE);
    for (let y = 0; y < SIZE; y++) {
      const psi = 180 - (y / SIZE) * 360;
      const psiBin = Math.min(RAMA_GRID - 1, Math.floor((psi + 180) / RAMA_BIN));
      for (let x = 0; x < SIZE; x++) {
        const phi = (x / SIZE) * 360 - 180;
        const phiBin = Math.min(RAMA_GRID - 1, Math.floor((phi + 180) / RAMA_BIN));
        const band = grid[psiBin * RAMA_GRID + phiBin];
        const o = (y * SIZE + x) * 4;
        // Favoured is the most saturated, allowed a wash, outlier bare. The
        // ramp is deliberately shallow: the contours are a backdrop and the
        // residues are the subject.
        if (band === 2) { image.data[o] = 56; image.data[o + 1] = 96; image.data[o + 2] = 122; image.data[o + 3] = 255; }
        else if (band === 1) { image.data[o] = 32; image.data[o + 1] = 54; image.data[o + 2] = 70; image.data[o + 3] = 255; }
        else { image.data[o] = 17; image.data[o + 1] = 24; image.data[o + 2] = 32; image.data[o + 3] = 255; }
      }
    }
    ctx.putImageData(image, 0, 0);

    // Axes through the origin, which is where the eye reads phi and psi from.
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(SIZE / 2, 0); ctx.lineTo(SIZE / 2, SIZE);
    ctx.moveTo(0, SIZE / 2); ctx.lineTo(SIZE, SIZE / 2);
    ctx.stroke();

    for (const p of shown) {
      const [x, y] = toPixel(p.phi, p.psi);
      const band = bandOf(p.phi, p.psi, p.category);
      const selected = p.residue === selectedResidue;
      ctx.beginPath();
      ctx.arc(x, y, selected ? 4.5 : band === 'outlier' ? 3.2 : 2, 0, Math.PI * 2);
      if (selected) ctx.fillStyle = '#4cc9f0';
      else if (band === 'outlier') ctx.fillStyle = '#f4576c';
      else if (band === 'allowed') ctx.fillStyle = '#f7c948';
      else ctx.fillStyle = 'rgba(235, 245, 255, 0.85)';
      ctx.fill();
      if (selected || band === 'outlier') {
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
  }, [shown, category, selectedResidue, structure]);

  if (!structure) return null;
  if (points.length === 0) {
    return (
      <div className="panel-section">
        <div className="section-label"><span>Ramachandran</span></div>
        <p className="rama-note">
          No residue in this pane has both a phi and a psi — that needs a
          protein chain at least three residues long.
        </p>
      </div>
    );
  }

  const select = (p: RamaPoint) => {
    const name = resNameOf(structure, p.residue);
    const chain = structure.chainAuthId[structure.resChain[p.residue]];
    patchSlot(slot, {
      selectedResidue: p.residue,
      selectionLabel: `${name} ${structure.resSeq[p.residue]} · ${chain}`,
    });
    viewer.refreshOverlay(slot);
    viewer.focusResidue(slot, p.residue);
  };

  /** Nearest point to a click, in pixels, or null if nothing is close. */
  const pick = (clientX: number, clientY: number): RamaPoint | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const px = ((clientX - rect.left) / rect.width) * SIZE;
    const py = ((clientY - rect.top) / rect.height) * SIZE;
    let best: RamaPoint | null = null;
    let bestD = 8 * 8;
    for (const p of shown) {
      const [x, y] = toPixel(p.phi, p.psi);
      const d = (x - px) ** 2 + (y - py) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  };

  const describe = (p: RamaPoint) =>
    `${resNameOf(structure, p.residue)} ${structure.resSeq[p.residue]}`
    + ` · ${structure.chainAuthId[structure.resChain[p.residue]]}`
    + ` · φ ${p.phi.toFixed(0)}° ψ ${p.psi.toFixed(0)}°`;

  return (
    <div className="panel-section">
      <div className="section-label"><span>Ramachandran</span></div>

      <div className="rama-summary">
        <span><strong>{summary.favouredPercent.toFixed(1)}%</strong> favoured</span>
        <span className={summary.outliers > 0 ? 'rama-bad' : undefined}>
          <strong>{summary.outliers}</strong> outlier{summary.outliers === 1 ? '' : 's'}
          {' '}({summary.outlierPercent.toFixed(2)}%)
        </span>
        <span className="rama-dim">{summary.total} residues</span>
      </div>

      <Segmented
        value={category}
        options={RAMA_CATEGORIES.map((c) => ({
          value: c,
          label: `${CATEGORY_LABEL[c]} ${points.filter((p) => p.category === c).length}`,
        }))}
        onChange={(v) => setCategory(v)}
      />

      <div className="rama-canvas-wrap">
        <canvas
          ref={canvasRef}
          className="rama-canvas"
          onMouseMove={(e) => setHover(pick(e.clientX, e.clientY))}
          onMouseLeave={() => setHover(null)}
          onClick={(e) => {
            const p = pick(e.clientX, e.clientY);
            if (p) select(p);
          }}
        />
        <span className="rama-axis rama-axis-x">φ</span>
        <span className="rama-axis rama-axis-y">ψ</span>
      </div>

      <p className="rama-readout" data-empty={hover ? undefined : 'true'}>
        {hover ? describe(hover) : 'Hover a point for its residue and angles'}
      </p>

      <p className="rama-note">
        Contours enclose 98% and 99.95% of a reference set measured from 900
        structures at 1.5 Å or better. Click a point to select its residue.
      </p>

      {outliers.length > 0 && (
        <>
          <div className="rama-outlier-head">
            Outliers, all categories
          </div>
          <div className="rama-outliers">
            {outliers.slice(0, 12).map((p) => (
              <button
                key={p.residue}
                type="button"
                className="rama-outlier"
                data-selected={p.residue === selectedResidue}
                onClick={() => { setCategory(p.category); select(p); }}
              >
                <span>{resNameOf(structure, p.residue)} {structure.resSeq[p.residue]}</span>
                <span className="rama-dim">
                  {structure.chainAuthId[structure.resChain[p.residue]]}
                </span>
                <span className="rama-dim">
                  {p.phi.toFixed(0)}, {p.psi.toFixed(0)}
                </span>
              </button>
            ))}
          </div>
          {outliers.length > 12 && (
            <p className="rama-note">…and {outliers.length - 12} more.</p>
          )}
        </>
      )}
    </div>
  );
}
