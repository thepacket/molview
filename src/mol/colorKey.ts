/**
 * What the colours in a pane mean, as data.
 *
 * Described once here rather than in the overlay component, because the key
 * has to exist twice: as HTML over the canvas, and painted into the 2D canvas
 * that screenshots and recordings are composed in. A figure whose colours are
 * unexplained is the commonest way a good picture fails to be evidence, and an
 * on-screen legend that vanishes from the exported PNG is worse than none.
 */

import { MolKind, type Structure } from './structure';
import {
  BASE_COLORS, chainPalette, COLOR_SCHEME_LABELS, type ColorScheme,
} from './coloring';
import { ELEMENT_COLORS, ELEMENT_SYMBOLS, elementIndex } from './elements';
import { PLDDT_BANDS } from '../rcsb/alphafold';

export interface KeySwatch {
  label: string;
  color: number;
}

export type ColorKey =
  | { kind: 'swatches'; title: string; items: KeySwatch[] }
  | { kind: 'ramp'; title: string; stops: number[]; labels: [string, string] }
  | null;

/**
 * Ramp keys carry only their two ends. A middle label would say what the ramp
 * measures, which is what the title already says, and three labels across
 * 132 pixels run into each other.
 */
/** The ramp `rainbow()` walks; repeated here so the key cannot drift from it. */
const RAINBOW_STOPS = [0x3b4cc0, 0x39b8d8, 0x5ddb6f, 0xf5d13a, 0xe8483c];

const SS_KEY: KeySwatch[] = [
  { label: 'Helix', color: 0xf4576c },
  { label: 'Sheet', color: 0xf7c948 },
  { label: 'Turn', color: 0x64d2a0 },
  { label: 'Coil', color: 0x9aa5b5 },
];

/** The elements worth naming; everything rarer is left to the CPK convention. */
const ELEMENT_KEY = ['C', 'N', 'O', 'S', 'P', 'FE', 'ZN', 'MG'];

/**
 * The pane's saturation and intensity, applied to a swatch.
 *
 * The legend has to be the colour the picture actually is, not the colour the
 * scheme nominally assigns — and it matters most in an export, where the key
 * is painted into the image beside the molecule it is explaining.
 */
function adjust(color: number, saturation: number, intensity: number): number {
  if (saturation === 1 && intensity === 1) return color;
  const r = (color >> 16) & 0xff, g = (color >> 8) & 0xff, b = color & 0xff;
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const ch = (v: number) => Math.round(
    Math.min(Math.max(luma + (v - luma) * saturation, 0) * intensity, 255),
  );
  return (ch(r) << 16) | (ch(g) << 8) | ch(b);
}

export interface ColorKeyOptions {
  paletteOffset: number;
  uniformColor: number;
  saturation?: number;
  intensity?: number;
}

export function colorKeyFor(
  s: Structure,
  scheme: ColorScheme,
  options: ColorKeyOptions,
): ColorKey {
  const key = buildKey(s, scheme, options);
  const saturation = options.saturation ?? 1;
  const intensity = options.intensity ?? 1;
  if (!key || (saturation === 1 && intensity === 1)) return key;
  return key.kind === 'swatches'
    ? { ...key, items: key.items.map((i) => ({ ...i, color: adjust(i.color, saturation, intensity) })) }
    : { ...key, stops: key.stops.map((c) => adjust(c, saturation, intensity)) };
}

function buildKey(
  s: Structure,
  scheme: ColorScheme,
  options: ColorKeyOptions,
): ColorKey {
  const title = COLOR_SCHEME_LABELS[scheme];

  switch (scheme) {
    case 'chain': {
      // One row per auth chain id, in the order the palette assigns them —
      // which is by chain index, so the key and the picture agree even where
      // two chains share an id.
      const seen = new Map<string, number>();
      for (let c = 0; c < s.chainCount; c++) {
        const id = s.chainAuthId[c];
        if (!seen.has(id)) {
          seen.set(id, chainPalette()[(c + options.paletteOffset) % chainPalette().length]);
        }
      }
      return {
        kind: 'swatches',
        title,
        items: [...seen].map(([label, color]) => ({ label, color })),
      };
    }

    case 'entity': {
      const ids = new Map<string, number>();
      const items: KeySwatch[] = [];
      for (let c = 0; c < s.chainCount; c++) {
        const key = s.chainEntity[c] || s.chainLabelId[c];
        if (ids.has(key)) continue;
        const index = ids.size;
        ids.set(key, index);
        items.push({
          label: `Entity ${key}`,
          color: chainPalette()[(index + options.paletteOffset) % chainPalette().length],
        });
      }
      return { kind: 'swatches', title, items };
    }

    case 'secondary':
      return { kind: 'swatches', title, items: SS_KEY };

    case 'base': {
      // Only the bases actually present: a key listing T for an RNA structure
      // is a small lie about what is on screen.
      const present = new Set<string>();
      for (let r = 0; r < s.residueCount; r++) {
        if (s.resKind[r] !== MolKind.Nucleic) continue;
        present.add(s.nameTable[s.resNameId[r]]);
      }
      const items = [...present]
        .filter((name) => name in BASE_COLORS)
        .sort()
        .map((name) => ({ label: name, color: BASE_COLORS[name] }));
      return items.length > 0 ? { kind: 'swatches', title, items } : null;
    }

    case 'element':
      return {
        kind: 'swatches',
        title,
        items: ELEMENT_KEY
          .map((symbol) => ({ symbol, index: elementIndex(symbol) }))
          .filter(({ index }) => hasElement(s, index))
          .map(({ symbol, index }) => ({
            label: ELEMENT_SYMBOLS[index] ?? symbol,
            color: ELEMENT_COLORS[index],
          })),
      };

    case 'bfactor':
      return {
        kind: 'ramp',
        title,
        // Reversed, because the scheme itself is: low B is the confident end
        // and gets the warm colour.
        stops: [...RAINBOW_STOPS].reverse(),
        labels: [`${s.bMin.toFixed(0)}`, `${s.bMax.toFixed(0)}`],
      };

    case 'rainbow':
      return {
        kind: 'ramp', title, stops: RAINBOW_STOPS, labels: ['N terminus', 'C terminus'],
      };

    case 'hydrophobicity':
      return {
        kind: 'ramp',
        title,
        stops: RAINBOW_STOPS,
        labels: ['polar', 'nonpolar'],
      };

    case 'plddt':
      return {
        kind: 'swatches',
        title,
        items: PLDDT_BANDS.map((band) => ({
          label: `${band.label} (${band.min === 0 ? '< 50' : `> ${band.min}`})`,
          color: band.color,
        })),
      };

    case 'pathogenicity':
      return {
        kind: 'ramp',
        title,
        stops: RAINBOW_STOPS,
        labels: ['benign', 'pathogenic'],
      };

    case 'rsrz':
      return {
        kind: 'ramp', title, stops: RAINBOW_STOPS, labels: ['0 σ · fits', '4 σ+'],
      };

    case 'outliers':
      return {
        kind: 'ramp', title, stops: RAINBOW_STOPS, labels: ['no faults', '6+'],
      };

    // Residue type has twenty-odd entries and uniform has one; neither is a key
    // worth the space it would take over the picture.
    default:
      return null;
  }
}

function hasElement(s: Structure, index: number): boolean {
  for (let a = 0; a < s.atomCount; a++) if (s.element[a] === index) return true;
  return false;
}
