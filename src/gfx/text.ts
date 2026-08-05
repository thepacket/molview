/**
 * Bitmap font atlas, rasterised at runtime with Canvas 2D.
 *
 * Generating the atlas in the browser avoids shipping a font file and keeps the
 * glyph metrics honest for whatever monospace face the platform actually has.
 * A monospace face also makes layout trivial: one advance for every glyph.
 *
 * The atlas reserves an opaque block so background pills can be drawn through
 * the same pipeline as the text — one pass, one texture, no second shader.
 */

const FIRST_CHAR = 32;
const LAST_CHAR = 126;
const CELL_COLUMNS = 16;
const FONT_PIXELS = 40;
const PADDING = 4;

export interface Glyph {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface FontAtlas {
  texture: GPUTexture;
  view: GPUTextureView;
  sampler: GPUSampler;
  glyphs: Map<number, Glyph>;
  /** Solid opaque region, for background quads. */
  solid: Glyph;
  /** Glyph box in pixels at the atlas's native size. */
  cellWidth: number;
  cellHeight: number;
  /** Horizontal advance as a fraction of the rendered glyph height. */
  advanceRatio: number;
}

export function createFontAtlas(device: GPUDevice): FontAtlas {
  const count = LAST_CHAR - FIRST_CHAR + 1;
  const rows = Math.ceil(count / CELL_COLUMNS) + 1; // extra row holds the solid block

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  if (!ctx) throw new Error('Could not create a 2D context for the font atlas');

  const font = `600 ${FONT_PIXELS}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  ctx.font = font;
  const advance = ctx.measureText('M').width;

  const cellWidth = Math.ceil(advance) + PADDING * 2;
  const cellHeight = FONT_PIXELS + PADDING * 2;

  canvas.width = CELL_COLUMNS * cellWidth;
  canvas.height = rows * cellHeight;

  // Resizing the canvas resets the context state.
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';

  const glyphs = new Map<number, Glyph>();
  for (let i = 0; i < count; i++) {
    const col = i % CELL_COLUMNS;
    const row = Math.floor(i / CELL_COLUMNS);
    const x = col * cellWidth;
    const y = row * cellHeight;
    ctx.fillText(String.fromCharCode(FIRST_CHAR + i), x + cellWidth / 2, y + cellHeight / 2);
    glyphs.set(FIRST_CHAR + i, {
      u0: x / canvas.width,
      v0: y / canvas.height,
      u1: (x + cellWidth) / canvas.width,
      v1: (y + cellHeight) / canvas.height,
    });
  }

  // Opaque block in the spare row.
  const solidY = (rows - 1) * cellHeight;
  ctx.fillRect(0, solidY, cellWidth, cellHeight);
  const inset = 2 / canvas.width;
  const solid: Glyph = {
    u0: inset,
    v0: solidY / canvas.height + inset,
    u1: cellWidth / canvas.width - inset,
    v1: (solidY + cellHeight) / canvas.height - inset,
  };

  const texture = device.createTexture({
    label: 'font-atlas',
    size: { width: canvas.width, height: canvas.height },
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING
      | GPUTextureUsage.COPY_DST
      | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture(
    { source: canvas },
    { texture },
    { width: canvas.width, height: canvas.height },
  );

  return {
    texture,
    view: texture.createView(),
    sampler: device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    }),
    glyphs,
    solid,
    cellWidth,
    cellHeight,
    advanceRatio: advance / FONT_PIXELS,
  };
}

// ---------------------------------------------------------------------------
// Label instance building
// ---------------------------------------------------------------------------

/** world(3) pad(1) | offsetPx(2) sizePx(2) | uv(4) | rgba(4) */
export const LABEL_STRIDE = 16;

export interface LabelRequest {
  text: string;
  /** Anchor in world space. */
  x: number;
  y: number;
  z: number;
  color: [number, number, number, number];
  /** Pixel offset from the anchor, before centring. */
  offsetX?: number;
  offsetY?: number;
  fontSize?: number;
  background?: [number, number, number, number];
}

const DEFAULT_FONT_SIZE = 13;

/**
 * Lays labels out in pixel space around their anchor and emits one instance per
 * glyph, plus one for the background pill.
 */
export function buildLabelInstances(
  atlas: FontAtlas, labels: readonly LabelRequest[],
): Float32Array {
  let glyphCount = 0;
  for (const label of labels) {
    glyphCount += label.text.length + (label.background ? 1 : 0);
  }

  const data = new Float32Array(glyphCount * LABEL_STRIDE);
  let o = 0;

  const push = (
    label: LabelRequest, glyph: Glyph,
    offsetX: number, offsetY: number, width: number, height: number,
    color: [number, number, number, number],
  ) => {
    // w must be 1: the shader multiplies this by viewProj as a point, and a
    // zero here would silently drop the translation and collapse every label.
    data[o] = label.x; data[o + 1] = label.y; data[o + 2] = label.z; data[o + 3] = 1;
    data[o + 4] = offsetX; data[o + 5] = offsetY;
    data[o + 6] = width; data[o + 7] = height;
    data[o + 8] = glyph.u0; data[o + 9] = glyph.v0;
    data[o + 10] = glyph.u1; data[o + 11] = glyph.v1;
    data[o + 12] = color[0]; data[o + 13] = color[1];
    data[o + 14] = color[2]; data[o + 15] = color[3];
    o += LABEL_STRIDE;
  };

  for (const label of labels) {
    const size = label.fontSize ?? DEFAULT_FONT_SIZE;
    const cellW = size * (atlas.cellWidth / atlas.cellHeight);
    const advance = cellW * 0.62;
    const totalWidth = advance * label.text.length;

    const anchorX = (label.offsetX ?? 0) - totalWidth / 2;
    const anchorY = (label.offsetY ?? 0) - size / 2;

    if (label.background) {
      const padX = 4;
      const padY = 2;
      push(
        label, atlas.solid,
        anchorX - padX, anchorY - padY,
        totalWidth + padX * 2, size + padY * 2,
        label.background,
      );
    }

    for (let i = 0; i < label.text.length; i++) {
      const glyph = atlas.glyphs.get(label.text.charCodeAt(i));
      if (!glyph) continue;
      push(
        label, glyph,
        anchorX + i * advance - (cellW - advance) / 2, anchorY,
        cellW, size,
        label.color,
      );
    }
  }

  return data.subarray(0, o);
}
