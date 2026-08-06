/**
 * Choosing the first view of a structure.
 *
 * A deposited coordinate frame is an accident of crystallography, not a
 * decision about how the molecule should be seen, so opening a structure with
 * the identity orientation shows whatever the depositor's cell happened to
 * give: 1BNA arrives as a double helix seen straight down its axis, GroEL as a
 * barrel end-on. Both are the least informative view available.
 *
 * The fix is the one every serious viewer has: rotate the largest extent across
 * the screen, the next largest up it, and leave the thinnest direction pointing
 * at the camera.
 */

import type { Quat } from './math';

/** Enough points to fix an axis; a ribosome does not need all 237k. */
const MAX_SAMPLES = 4000;

/** Below this ratio of longest to shortest extent, a shape has no long axis. */
const ISOTROPY_LIMIT = 1.15;

/**
 * Principal axes of a point cloud, largest variance first, as an orthonormal
 * right-handed basis.
 */
function principalAxes(
  points: Float64Array, count: number,
): { axes: number[][]; values: number[] } {
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < count; i++) {
    cx += points[i * 3]; cy += points[i * 3 + 1]; cz += points[i * 3 + 2];
  }
  cx /= count; cy /= count; cz /= count;

  // Symmetric covariance matrix.
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < count; i++) {
    const dx = points[i * 3] - cx, dy = points[i * 3 + 1] - cy, dz = points[i * 3 + 2] - cz;
    xx += dx * dx; xy += dx * dy; xz += dx * dz;
    yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }

  // Jacobi rotation on a 3x3 symmetric matrix: small, exact enough, and it
  // cannot fail the way a closed-form cubic does on degenerate shapes.
  const a = [[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 24; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
    }
    if (off < 1e-12) break;
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-14) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }

  const order = [0, 1, 2].sort((i, j) => a[j][j] - a[i][i]);
  const values = order.map((i) => Math.max(0, a[i][i]) / count);
  const axes = order.map((i) => {
    const ax = [v[0][i], v[1][i], v[2][i]];
    const len = Math.hypot(ax[0], ax[1], ax[2]) || 1;
    return [ax[0] / len, ax[1] / len, ax[2] / len];
  });

  // Right-handed, so the view does not come out mirrored.
  const [e0, e1] = axes;
  const cross = [
    e0[1] * e1[2] - e0[2] * e1[1],
    e0[2] * e1[0] - e0[0] * e1[2],
    e0[0] * e1[1] - e0[1] * e1[0],
  ];
  if (cross[0] * axes[2][0] + cross[1] * axes[2][1] + cross[2] * axes[2][2] < 0) {
    axes[2] = [-axes[2][0], -axes[2][1], -axes[2][2]];
  }
  return { axes, values };
}

/**
 * The camera's rows are its basis in world space — right, up, then the
 * direction back towards the eye — so the axes go straight in as rows and the
 * matrix converts to a quaternion.
 */
function quatFromRows(right: number[], up: number[], back: number[]): Quat {
  const m = [right, up, back];
  const trace = m[0][0] + m[1][1] + m[2][2];
  const q = new Float32Array(4) as unknown as Quat;
  if (trace > 0) {
    const w = Math.sqrt(1 + trace) / 2;
    const k = 1 / (4 * w);
    q[0] = (m[2][1] - m[1][2]) * k;
    q[1] = (m[0][2] - m[2][0]) * k;
    q[2] = (m[1][0] - m[0][1]) * k;
    q[3] = w;
  } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const x = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) / 2;
    const k = 1 / (4 * x);
    q[0] = x;
    q[1] = (m[0][1] + m[1][0]) * k;
    q[2] = (m[0][2] + m[2][0]) * k;
    q[3] = (m[2][1] - m[1][2]) * k;
  } else if (m[1][1] > m[2][2]) {
    const y = Math.sqrt(1 - m[0][0] + m[1][1] - m[2][2]) / 2;
    const k = 1 / (4 * y);
    q[0] = (m[0][1] + m[1][0]) * k;
    q[1] = y;
    q[2] = (m[1][2] + m[2][1]) * k;
    q[3] = (m[0][2] - m[2][0]) * k;
  } else {
    const z = Math.sqrt(1 - m[0][0] - m[1][1] + m[2][2]) / 2;
    const k = 1 / (4 * z);
    q[0] = (m[0][2] + m[2][0]) * k;
    q[1] = (m[1][2] + m[2][1]) * k;
    q[2] = z;
    q[3] = (m[1][0] - m[0][1]) * k;
  }
  const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  q[0] /= len; q[1] /= len; q[2] /= len; q[3] /= len;
  return q;
}

/**
 * Samples atoms through every assembly transform, so a capsid is judged on the
 * shape it actually presents rather than on its asymmetric unit.
 */
export interface Pose {
  /** Null when the shape is too round for its axes to mean anything. */
  orientation: Quat | null;
  /** Half-extents along the camera's right, up and back axes. */
  half: [number, number, number];
  centre: [number, number, number];
}

export function orientationFor(
  x: Float32Array, y: Float32Array, z: Float32Array, atomCount: number,
  transforms: Float32Array, transformCount: number,
): Pose | null {
  if (atomCount < 8) return null;

  const copies = Math.max(1, transformCount);
  const perCopy = Math.max(1, Math.floor(MAX_SAMPLES / copies));
  const stride = Math.max(1, Math.floor(atomCount / perCopy));

  const pts: number[] = [];
  for (let t = 0; t < copies; t++) {
    const o = t * 16;
    const identity = transformCount === 0;
    for (let a = 0; a < atomCount; a += stride) {
      const px = x[a], py = y[a], pz = z[a];
      if (identity) {
        pts.push(px, py, pz);
      } else {
        pts.push(
          transforms[o] * px + transforms[o + 4] * py + transforms[o + 8] * pz + transforms[o + 12],
          transforms[o + 1] * px + transforms[o + 5] * py + transforms[o + 9] * pz + transforms[o + 13],
          transforms[o + 2] * px + transforms[o + 6] * py + transforms[o + 10] * pz + transforms[o + 14],
        );
      }
    }
  }

  const count = pts.length / 3;
  if (count < 8) return null;
  const { axes, values } = principalAxes(Float64Array.from(pts), count);

  // A capsid is a ball: its axes are noise, and rotating by them would land a
  // different way round on every load for no gain. It still wants fitting to
  // the pane, though, so fall through with the world axes instead.
  const longest = Math.sqrt(values[0]);
  const shortest = Math.sqrt(values[2]);
  const round = shortest <= 0 || longest / shortest < ISOTROPY_LIMIT;
  const frame = round
    ? [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
    : axes;

  // Extents along the axes we are about to look down, so the caller can fit
  // the pane rather than a sphere drawn round the whole thing.
  const mid = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    mid[0] += pts[i * 3]; mid[1] += pts[i * 3 + 1]; mid[2] += pts[i * 3 + 2];
  }
  mid[0] /= count; mid[1] /= count; mid[2] /= count;

  const half: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    const dx = pts[i * 3] - mid[0], dy = pts[i * 3 + 1] - mid[1], dz = pts[i * 3 + 2] - mid[2];
    for (let k = 0; k < 3; k++) {
      const d = Math.abs(dx * frame[k][0] + dy * frame[k][1] + dz * frame[k][2]);
      if (d > half[k]) half[k] = d;
    }
  }

  return {
    orientation: round ? null : quatFromRows(axes[0], axes[1], axes[2]),
    half,
    centre: [mid[0], mid[1], mid[2]],
  };
}
