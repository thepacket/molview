/**
 * Trackball camera. Orientation is a quaternion so there is no gimbal lock and
 * no accumulated drift when the user keeps spinning a structure around.
 */

import {
  invert, lookAt, mat4, mat4FromQuat, multiply, orthographic, perspective,
  quat, quatFromAxisAngle, quatMultiply, quatNormalize, quatRotateInverse, slerp,
  type Mat4, type Quat, type Vec3,
} from './math';

export interface CameraState {
  target: [number, number, number];
  orientation: [number, number, number, number];
  distance: number;
}

const UP = Float32Array.from([0, 1, 0]);

export class Camera {
  readonly target: Vec3 = Float32Array.from([0, 0, 0]);
  readonly orientation: Quat = quat();
  distance = 100;
  fovY = (35 * Math.PI) / 180;
  orthographicMode = false;
  /** Radius of the content, used to keep the depth range tight. */
  sceneRadius = 50;

  readonly view: Mat4 = mat4();
  readonly projection: Mat4 = mat4();
  readonly viewProjection: Mat4 = mat4();
  readonly inverseProjection: Mat4 = mat4();
  readonly position: Vec3 = Float32Array.from([0, 0, 100]);
  near = 1;
  far = 1000;

  private rotationMatrix: Mat4 = mat4();
  private eye: Vec3 = new Float32Array(3);
  private up: Vec3 = new Float32Array(3);
  private scratch: Quat = quat();

  private animation: {
    from: CameraState;
    to: CameraState;
    start: number;
    duration: number;
  } | null = null;

  getState(): CameraState {
    return {
      target: [this.target[0], this.target[1], this.target[2]],
      orientation: [
        this.orientation[0], this.orientation[1],
        this.orientation[2], this.orientation[3],
      ],
      distance: this.distance,
    };
  }

  setState(s: CameraState): void {
    this.target.set(s.target);
    this.orientation.set(s.orientation);
    this.distance = s.distance;
    this.animation = null;
  }

  /** Eased flight to a new pose; returns true while still moving. */
  animateTo(to: CameraState, duration = 600): void {
    this.animation = { from: this.getState(), to, start: performance.now(), duration };
  }

  get isAnimating(): boolean {
    return this.animation !== null;
  }

  private tickAnimation(): void {
    const anim = this.animation;
    if (!anim) return;
    const raw = (performance.now() - anim.start) / anim.duration;
    if (raw >= 1) {
      this.setState(anim.to);
      return;
    }
    // smoothstep in, ease out
    const t = raw * raw * (3 - 2 * raw);
    for (let i = 0; i < 3; i++) {
      this.target[i] = anim.from.target[i] + (anim.to.target[i] - anim.from.target[i]) * t;
    }
    this.distance = anim.from.distance + (anim.to.distance - anim.from.distance) * t;
    slerp(
      this.orientation,
      Float32Array.from(anim.from.orientation),
      Float32Array.from(anim.to.orientation),
      t,
    );
  }

  rotate(deltaX: number, deltaY: number): void {
    this.animation = null;
    // Screen-space axes rotate the model, so dragging always feels direct
    // regardless of the current orientation.
    quatFromAxisAngle(this.scratch, 0, 1, 0, deltaX);
    quatMultiply(this.orientation, this.scratch, this.orientation);
    quatFromAxisAngle(this.scratch, 1, 0, 0, deltaY);
    quatMultiply(this.orientation, this.scratch, this.orientation);
    quatNormalize(this.orientation);
  }

  roll(delta: number): void {
    this.animation = null;
    quatFromAxisAngle(this.scratch, 0, 0, 1, delta);
    quatMultiply(this.orientation, this.scratch, this.orientation);
    quatNormalize(this.orientation);
  }

  /** Pan in screen space, scaled so the content tracks the cursor. */
  pan(deltaX: number, deltaY: number, viewportHeight: number): void {
    this.animation = null;
    const worldPerPixel = (2 * Math.tan(this.fovY / 2) * this.distance) / viewportHeight;
    const local = new Float32Array(3);
    quatRotateInverse(local, this.orientation, [-deltaX * worldPerPixel, deltaY * worldPerPixel, 0]);
    this.target[0] += local[0];
    this.target[1] += local[1];
    this.target[2] += local[2];
  }

  zoom(factor: number): void {
    this.animation = null;
    this.distance = Math.min(
      Math.max(this.distance * factor, this.sceneRadius * 0.02),
      this.sceneRadius * 40,
    );
  }

  /** Frames a sphere; the default view for a freshly loaded structure. */
  /**
   * Fits half-extents already measured along the camera's own axes, against the
   * pane's real aspect ratio.
   *
   * `frame` fits a bounding sphere, which is the right answer for a ball and a
   * poor one for anything long: GroEL lying across a wide pane was sized as
   * though its length had to fit vertically, and used half the frame.
   */
  fitExtents(
    center: ArrayLike<number>, halfWidth: number, halfHeight: number,
    halfDepth: number, aspect: number, animate = false,
  ): void {
    const tan = Math.tan(this.fovY / 2);
    const forHeight = halfHeight / tan;
    const forWidth = halfWidth / (tan * Math.max(aspect, 0.05));
    const distance = Math.max(forHeight, forWidth) * 1.06 + halfDepth;
    const state: CameraState = {
      target: [center[0], center[1], center[2]],
      orientation: [
        this.orientation[0], this.orientation[1],
        this.orientation[2], this.orientation[3],
      ],
      distance,
    };
    if (animate) this.animateTo(state);
    else this.setState(state);
  }

  frame(center: ArrayLike<number>, radius: number, animate = false): void {
    const distance = (radius * 1.15) / Math.sin(this.fovY / 2);
    const state: CameraState = {
      target: [center[0], center[1], center[2]],
      orientation: [
        this.orientation[0], this.orientation[1],
        this.orientation[2], this.orientation[3],
      ],
      distance,
    };
    if (animate) this.animateTo(state);
    else this.setState(state);
  }

  update(width: number, height: number): void {
    this.tickAnimation();

    mat4FromQuat(this.rotationMatrix, this.orientation);
    // Camera basis is the inverse (transpose) of the model rotation.
    const rm = this.rotationMatrix;
    const backX = rm[2], backY = rm[6], backZ = rm[10];
    this.up[0] = rm[1]; this.up[1] = rm[5]; this.up[2] = rm[9];

    this.eye[0] = this.target[0] + backX * this.distance;
    this.eye[1] = this.target[1] + backY * this.distance;
    this.eye[2] = this.target[2] + backZ * this.distance;
    this.position.set(this.eye);

    lookAt(this.view, this.eye, this.target, this.up[1] === 0 && this.up[0] === 0 && this.up[2] === 0 ? UP : this.up);

    // Keep near/far hugging the content: depth precision is what makes
    // impostor surfaces intersect cleanly.
    const margin = this.sceneRadius * 1.5;
    this.near = Math.max(this.distance - margin, this.sceneRadius * 0.005, 0.05);
    this.far = this.distance + margin;

    const aspect = width / Math.max(height, 1);
    if (this.orthographicMode) {
      const halfHeight = Math.tan(this.fovY / 2) * this.distance;
      orthographic(this.projection, halfHeight * aspect, halfHeight, this.near, this.far);
    } else {
      perspective(this.projection, this.fovY, aspect, this.near, this.far);
    }

    invert(this.inverseProjection, this.projection);
    multiply(this.viewProjection, this.projection, this.view);
  }
}
