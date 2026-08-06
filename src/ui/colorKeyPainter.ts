/**
 * The colour key, painted into a 2D canvas for export.
 *
 * The DOM overlay is not part of the WebGPU canvas, so a screenshot or a
 * recording would otherwise ship a picture whose colours are unexplained —
 * which is exactly the figure the key exists to prevent. Both export paths
 * already compose through a 2D context, so this draws into the same one from
 * the same model the overlay reads.
 *
 * Sizes are in CSS pixels and multiplied by the export scale, so a key on a
 * 1920px recording is the same apparent size as the one on screen.
 */

import type { ColorKey } from '../mol/colorKey';

const PAD = 10;
const TITLE_SIZE = 11;
const ITEM_SIZE = 11;
const ROW = 16;
const SWATCH = 9;
const RAMP_WIDTH = 132;
const RAMP_HEIGHT = 8;

function css(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

export function paintColorKey(
  ctx: CanvasRenderingContext2D,
  key: ColorKey,
  canvasHeight: number,
  scale: number,
): void {
  if (!key) return;

  ctx.save();
  ctx.scale(scale, scale);
  const height = canvasHeight / scale;

  const font = (size: number, weight = '400') =>
    `${weight} ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, sans-serif`;

  ctx.font = font(TITLE_SIZE, '600');
  let boxWidth = ctx.measureText(key.title).width;
  let boxHeight = TITLE_SIZE + 8;

  ctx.font = font(ITEM_SIZE);
  if (key.kind === 'swatches') {
    for (const item of key.items) {
      boxWidth = Math.max(boxWidth, SWATCH + 6 + ctx.measureText(item.label).width);
    }
    boxHeight += key.items.length * ROW;
  } else {
    boxWidth = Math.max(boxWidth, RAMP_WIDTH);
    boxHeight += RAMP_HEIGHT + 6 + ITEM_SIZE + 2;
  }

  // Bottom left, matching the overlay, and inset so it never touches the edge.
  const w = boxWidth + PAD * 2;
  const h = boxHeight + PAD;
  const x = PAD;
  const y = height - PAD - h;

  ctx.fillStyle = 'rgba(10, 13, 18, 0.72)';
  roundRect(ctx, x, y, w, h, 4);
  ctx.fill();
  ctx.strokeStyle = 'rgba(120, 140, 170, 0.35)';
  ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, 4);
  ctx.stroke();

  const left = x + PAD;
  let cursor = y + PAD + TITLE_SIZE - 2;
  ctx.fillStyle = '#d5deea';
  ctx.font = font(TITLE_SIZE, '600');
  ctx.fillText(key.title, left, cursor);
  cursor += 8;

  ctx.font = font(ITEM_SIZE);
  if (key.kind === 'swatches') {
    for (const item of key.items) {
      ctx.fillStyle = css(item.color);
      roundRect(ctx, left, cursor + (ROW - SWATCH) / 2 - 2, SWATCH, SWATCH, 2);
      ctx.fill();
      ctx.fillStyle = '#eef3fa';
      ctx.fillText(item.label, left + SWATCH + 6, cursor + ROW - 6);
      cursor += ROW;
    }
  } else {
    const gradient = ctx.createLinearGradient(left, 0, left + RAMP_WIDTH, 0);
    key.stops.forEach((stop, i) => {
      gradient.addColorStop(i / (key.stops.length - 1), css(stop));
    });
    ctx.fillStyle = gradient;
    roundRect(ctx, left, cursor, RAMP_WIDTH, RAMP_HEIGHT, 2);
    ctx.fill();

    cursor += RAMP_HEIGHT + ITEM_SIZE + 2;
    ctx.fillStyle = '#b9c7db';
    const [low, mid, high] = key.labels;
    ctx.textAlign = 'left';
    ctx.fillText(low, left, cursor);
    ctx.textAlign = 'center';
    ctx.fillText(mid, left + RAMP_WIDTH / 2, cursor);
    ctx.textAlign = 'right';
    ctx.fillText(high, left + RAMP_WIDTH, cursor);
    ctx.textAlign = 'left';
  }

  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
