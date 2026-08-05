/**
 * WebGPU renderer.
 *
 * One canvas, one G-buffer, up to four independent viewports drawn into it.
 * Geometry for every pane goes through a single render pass (viewport +
 * scissor per pane, camera uniforms swapped between them), then one deferred
 * resolve pass shades them all. Four molecules therefore cost four sets of
 * draw calls but only one set of render targets.
 */

import { Camera } from './camera';
import { CARTOON_STRIDE, CYLINDER_STRIDE, SPHERE_STRIDE, type SceneGeometry } from './geometry';
import type { Structure } from '../mol/structure';

import commonWgsl from './shaders/common.wgsl?raw';
import spheresWgsl from './shaders/spheres.wgsl?raw';
import cylindersWgsl from './shaders/cylinders.wgsl?raw';
import cartoonWgsl from './shaders/cartoon.wgsl?raw';
import compositeWgsl from './shaders/composite.wgsl?raw';

export const MAX_SLOTS = 4;
const UNIFORM_BYTES = 352;
const CYLINDER_SIDES = 10;

export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SlotVisualSettings {
  background: [number, number, number];
  aoRadius: number;
  aoIntensity: number;
  outline: number;
  fogDensity: number;
  orthographic: boolean;
  /** Front clipping plane offset from the camera target, in Å. 0 disables. */
  clipNear: number;
}

export const DEFAULT_VISUAL_SETTINGS: SlotVisualSettings = {
  background: [0.043, 0.051, 0.071],
  aoRadius: 4.5,
  aoIntensity: 1.0,
  outline: 0.85,
  fogDensity: 0.006,
  orthographic: false,
  clipNear: 0,
};

interface GpuBufferSet {
  buffer: GPUBuffer;
  count: number;
}

interface Slot {
  camera: Camera;
  uniformBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  uniformData: Float32Array;
  spheres: GpuBufferSet | null;
  cylinders: GpuBufferSet | null;
  cartoonVertices: GPUBuffer | null;
  cartoonIndices: GPUBuffer | null;
  cartoonIndexCount: number;
  structure: Structure | null;
  visual: SlotVisualSettings;
  rect: ViewportRect;
  active: boolean;
}

export interface PickResult {
  atomIndex: number;
  residueIndex: number;
  distance: number;
}

export class WebGpuUnavailableError extends Error {}

export class Engine {
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private format!: GPUTextureFormat;
  private canvas!: HTMLCanvasElement;

  private spherePipeline!: GPURenderPipeline;
  private cylinderPipeline!: GPURenderPipeline;
  private cartoonPipeline!: GPURenderPipeline;
  private compositePipeline!: GPURenderPipeline;

  private cameraLayout!: GPUBindGroupLayout;
  private gbufferLayout!: GPUBindGroupLayout;
  private gbufferBindGroup: GPUBindGroup | null = null;

  private albedoTexture: GPUTexture | null = null;
  private normalTexture: GPUTexture | null = null;
  private depthTexture: GPUTexture | null = null;

  private cylinderMesh!: { vertices: GPUBuffer; indices: GPUBuffer; indexCount: number };

  private slots: Slot[] = [];
  private width = 1;
  private height = 1;
  pixelRatio = 1;

  /** Set by the render loop; lets the UI show a live frame time. */
  lastFrameMs = 0;
  adapterInfo = '';

  async init(canvas: HTMLCanvasElement): Promise<void> {
    if (!('gpu' in navigator)) {
      throw new WebGpuUnavailableError(
        'WebGPU is not available in this browser. Chrome 113+, Edge 113+, or Safari 18+ is required.',
      );
    }

    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      throw new WebGpuUnavailableError('No suitable GPU adapter was found.');
    }

    // Large assemblies routinely exceed the default 128 MiB storage limits.
    const wanted: GPUDeviceDescriptor = {
      requiredLimits: {
        maxBufferSize: Math.min(adapter.limits.maxBufferSize, 1 << 30),
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      },
    };

    this.device = await adapter.requestDevice(wanted).catch(() => adapter.requestDevice());
    const info = adapter.info ?? (await (adapter as unknown as {
      requestAdapterInfo?: () => Promise<GPUAdapterInfo>;
    }).requestAdapterInfo?.());
    this.adapterInfo = [info?.vendor, info?.architecture, info?.description]
      .filter(Boolean)
      .join(' ') || 'WebGPU device';

    this.device.lost.then((reason) => {
      // Surfaced by the shell so the user gets an explanation, not a black pane.
      this.onDeviceLost?.(reason.message || 'GPU device lost');
    });

    this.canvas = canvas;
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new WebGpuUnavailableError('Could not create a WebGPU canvas context.');
    this.context = ctx;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'opaque',
    });

    this.createLayouts();
    this.createPipelines();
    this.createCylinderMesh();
    this.createSlots();
  }

  onDeviceLost: ((message: string) => void) | null = null;

  get canvasElement(): HTMLCanvasElement | null {
    return this.canvas ?? null;
  }

  private createLayouts(): void {
    this.cameraLayout = this.device.createBindGroupLayout({
      label: 'camera',
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      }],
    });

    this.gbufferLayout = this.device.createBindGroupLayout({
      label: 'gbuffer',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'float' },
        },
        {
          binding: 2,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'depth' },
        },
      ],
    });
  }

  private module(source: string, label: string): GPUShaderModule {
    return this.device.createShaderModule({ label, code: `${commonWgsl}\n${source}` });
  }

  private createPipelines(): void {
    const gbufferTargets: GPUColorTargetState[] = [
      { format: 'rgba8unorm' },
      { format: 'rgba16float' },
    ];
    const depthStencil: GPUDepthStencilState = {
      format: 'depth32float',
      depthWriteEnabled: true,
      depthCompare: 'less',
    };
    const cameraPipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.cameraLayout],
    });

    const sphereModule = this.module(spheresWgsl, 'spheres');
    this.spherePipeline = this.device.createRenderPipeline({
      label: 'sphere-impostors',
      layout: cameraPipelineLayout,
      vertex: {
        module: sphereModule,
        entryPoint: 'vs',
        buffers: [{
          arrayStride: SPHERE_STRIDE * 4,
          stepMode: 'instance',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x4' },
            { shaderLocation: 1, offset: 16, format: 'float32x4' },
          ],
        }],
      },
      fragment: { module: sphereModule, entryPoint: 'fs', targets: gbufferTargets },
      primitive: { topology: 'triangle-strip' },
      depthStencil,
    });

    const cylinderModule = this.module(cylindersWgsl, 'cylinders');
    this.cylinderPipeline = this.device.createRenderPipeline({
      label: 'cylinders',
      layout: cameraPipelineLayout,
      vertex: {
        module: cylinderModule,
        entryPoint: 'vs',
        buffers: [
          {
            arrayStride: 24,
            stepMode: 'vertex',
            attributes: [
              { shaderLocation: 0, offset: 0, format: 'float32x3' },
              { shaderLocation: 1, offset: 12, format: 'float32x3' },
            ],
          },
          {
            arrayStride: CYLINDER_STRIDE * 4,
            stepMode: 'instance',
            attributes: [
              { shaderLocation: 2, offset: 0, format: 'float32x4' },
              { shaderLocation: 3, offset: 16, format: 'float32x4' },
              { shaderLocation: 4, offset: 32, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: { module: cylinderModule, entryPoint: 'fs', targets: gbufferTargets },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil,
    });

    const cartoonModule = this.module(cartoonWgsl, 'cartoon');
    this.cartoonPipeline = this.device.createRenderPipeline({
      label: 'cartoon',
      layout: cameraPipelineLayout,
      vertex: {
        module: cartoonModule,
        entryPoint: 'vs',
        buffers: [{
          arrayStride: CARTOON_STRIDE * 4,
          stepMode: 'vertex',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
            { shaderLocation: 2, offset: 24, format: 'float32x3' },
          ],
        }],
      },
      fragment: { module: cartoonModule, entryPoint: 'fs', targets: gbufferTargets },
      // Ribbons are two-sided surfaces; the fragment shader flips the normal.
      primitive: { topology: 'triangle-list' },
      depthStencil,
    });

    const compositeModule = this.module(compositeWgsl, 'composite');
    this.compositePipeline = this.device.createRenderPipeline({
      label: 'composite',
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.cameraLayout, this.gbufferLayout],
      }),
      vertex: { module: compositeModule, entryPoint: 'vs' },
      fragment: {
        module: compositeModule,
        entryPoint: 'fs',
        targets: [{ format: this.format }],
      },
      primitive: { topology: 'triangle-list' },
    });
  }

  private createCylinderMesh(): void {
    const sides = CYLINDER_SIDES;
    const vertices = new Float32Array(sides * 2 * 6);
    for (let i = 0; i < sides; i++) {
      const theta = (i / sides) * Math.PI * 2;
      const cx = Math.cos(theta);
      const cy = Math.sin(theta);
      for (let end = 0; end < 2; end++) {
        const o = (i * 2 + end) * 6;
        vertices[o] = cx; vertices[o + 1] = cy; vertices[o + 2] = end;
        vertices[o + 3] = cx; vertices[o + 4] = cy; vertices[o + 5] = 0;
      }
    }

    const indices = new Uint32Array(sides * 6);
    for (let i = 0; i < sides; i++) {
      const a = i * 2;
      const b = ((i + 1) % sides) * 2;
      const o = i * 6;
      indices[o] = a; indices[o + 1] = b; indices[o + 2] = a + 1;
      indices[o + 3] = a + 1; indices[o + 4] = b; indices[o + 5] = b + 1;
    }

    this.cylinderMesh = {
      vertices: this.createBuffer(vertices, GPUBufferUsage.VERTEX),
      indices: this.createBuffer(indices, GPUBufferUsage.INDEX),
      indexCount: indices.length,
    };
  }

  private createBuffer(data: Float32Array | Uint32Array, usage: GPUBufferUsageFlags): GPUBuffer {
    const buffer = this.device.createBuffer({
      size: Math.max(data.byteLength, 4),
      usage: usage | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buffer, 0, data as unknown as BufferSource);
    return buffer;
  }

  private createSlots(): void {
    for (let i = 0; i < MAX_SLOTS; i++) {
      const uniformBuffer = this.device.createBuffer({
        label: `camera-${i}`,
        size: UNIFORM_BYTES,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.slots.push({
        camera: new Camera(),
        uniformBuffer,
        bindGroup: this.device.createBindGroup({
          layout: this.cameraLayout,
          entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
        }),
        uniformData: new Float32Array(UNIFORM_BYTES / 4),
        spheres: null,
        cylinders: null,
        cartoonVertices: null,
        cartoonIndices: null,
        cartoonIndexCount: 0,
        structure: null,
        visual: { ...DEFAULT_VISUAL_SETTINGS },
        rect: { x: 0, y: 0, width: 1, height: 1 },
        active: false,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Slot management
  // -------------------------------------------------------------------------

  getCamera(slot: number): Camera {
    return this.slots[slot].camera;
  }

  setVisualSettings(slot: number, visual: SlotVisualSettings): void {
    this.slots[slot].visual = visual;
    this.slots[slot].camera.orthographicMode = visual.orthographic;
  }

  setStructure(slot: number, structure: Structure | null): void {
    this.slots[slot].structure = structure;
  }

  setGeometry(slot: number, geometry: SceneGeometry | null): void {
    const s = this.slots[slot];
    s.spheres?.buffer.destroy();
    s.cylinders?.buffer.destroy();
    s.cartoonVertices?.destroy();
    s.cartoonIndices?.destroy();
    s.spheres = null;
    s.cylinders = null;
    s.cartoonVertices = null;
    s.cartoonIndices = null;
    s.cartoonIndexCount = 0;
    s.active = geometry !== null;
    if (!geometry) return;

    if (geometry.sphereCount > 0) {
      s.spheres = {
        buffer: this.createBuffer(geometry.spheres, GPUBufferUsage.VERTEX),
        count: geometry.sphereCount,
      };
    }
    if (geometry.cylinderCount > 0) {
      s.cylinders = {
        buffer: this.createBuffer(geometry.cylinders, GPUBufferUsage.VERTEX),
        count: geometry.cylinderCount,
      };
    }
    if (geometry.cartoon) {
      s.cartoonVertices = this.createBuffer(geometry.cartoon.vertices, GPUBufferUsage.VERTEX);
      s.cartoonIndices = this.createBuffer(geometry.cartoon.indices, GPUBufferUsage.INDEX);
      s.cartoonIndexCount = geometry.cartoon.indices.length;
    }

    s.camera.sceneRadius = geometry.radius;
  }

  setLayout(rects: (ViewportRect | null)[]): void {
    for (let i = 0; i < MAX_SLOTS; i++) {
      const r = rects[i];
      this.slots[i].rect = r ?? { x: 0, y: 0, width: 0, height: 0 };
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  resize(cssWidth: number, cssHeight: number, pixelRatio: number): boolean {
    this.pixelRatio = pixelRatio;
    const width = Math.max(1, Math.floor(cssWidth * pixelRatio));
    const height = Math.max(1, Math.floor(cssHeight * pixelRatio));
    if (width === this.width && height === this.height && this.albedoTexture) return false;

    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;

    this.albedoTexture?.destroy();
    this.normalTexture?.destroy();
    this.depthTexture?.destroy();

    const size = { width, height };
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    this.albedoTexture = this.device.createTexture({ size, format: 'rgba8unorm', usage });
    this.normalTexture = this.device.createTexture({ size, format: 'rgba16float', usage });
    this.depthTexture = this.device.createTexture({ size, format: 'depth32float', usage });

    this.gbufferBindGroup = this.device.createBindGroup({
      layout: this.gbufferLayout,
      entries: [
        { binding: 0, resource: this.albedoTexture.createView() },
        { binding: 1, resource: this.normalTexture.createView() },
        { binding: 2, resource: this.depthTexture.createView() },
      ],
    });
    return true;
  }

  private writeUniforms(slot: Slot): void {
    const { camera, uniformData, visual, rect } = slot;
    const px = this.pixelRatio;
    const vx = Math.floor(rect.x * px);
    const vy = Math.floor(rect.y * px);
    const vw = Math.max(1, Math.floor(rect.width * px));
    const vh = Math.max(1, Math.floor(rect.height * px));

    camera.update(vw, vh);

    uniformData.set(camera.view, 0);
    uniformData.set(camera.projection, 16);
    uniformData.set(camera.viewProjection, 32);
    uniformData.set(camera.inverseProjection, 48);

    uniformData[64] = camera.position[0];
    uniformData[65] = camera.position[1];
    uniformData[66] = camera.position[2];
    uniformData[67] = 1;

    uniformData[68] = vx;
    uniformData[69] = vy;
    uniformData[70] = vw;
    uniformData[71] = vh;

    uniformData[72] = camera.near;
    uniformData[73] = camera.far;
    // Fog density is normalised against the size of the structure, so the same
    // slider value reads the same on a 20 Å ligand and a 1000 Å capsid.
    uniformData[74] = (visual.fogDensity * 100) / Math.max(camera.sceneRadius, 1);
    // Fog starts once we are past the front of the molecule.
    uniformData[75] = Math.max(camera.distance - camera.sceneRadius, 0);

    uniformData[76] = visual.background[0];
    uniformData[77] = visual.background[1];
    uniformData[78] = visual.background[2];
    uniformData[79] = 0.55;

    // On very large assemblies an atom-scale occlusion radius projects to less
    // than a pixel and only produces noise; give it a floor tied to the scene.
    uniformData[80] = visual.aoRadius > 0
      ? Math.max(visual.aoRadius, camera.sceneRadius * 0.02)
      : 0;
    uniformData[81] = visual.aoIntensity;
    uniformData[82] = 0.02;
    uniformData[83] = visual.outline;

    // Front clip plane, as a distance from the camera. Measured from the front
    // of the structure so the slider sweeps through the molecule itself rather
    // than through empty space.
    uniformData[84] = camera.distance - camera.sceneRadius + visual.clipNear;
    uniformData[85] = 0;
    uniformData[86] = 0;
    uniformData[87] = visual.clipNear > 0 ? 1 : 0;

    this.device.queue.writeBuffer(slot.uniformBuffer, 0, uniformData as unknown as BufferSource);
  }

  /** True when something is still animating and another frame is warranted. */
  render(): boolean {
    if (!this.albedoTexture || !this.normalTexture || !this.depthTexture || !this.gbufferBindGroup) {
      return false;
    }
    const start = performance.now();
    const px = this.pixelRatio;

    const visible = this.slots.filter((s) => s.active && s.rect.width > 0 && s.rect.height > 0);
    for (const slot of visible) this.writeUniforms(slot);

    const encoder = this.device.createCommandEncoder();

    const geometryPass = encoder.beginRenderPass({
      label: 'gbuffer',
      colorAttachments: [
        {
          view: this.albedoTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
        {
          view: this.normalTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    });

    for (const slot of visible) {
      const { rect } = slot;
      const vx = Math.floor(rect.x * px);
      const vy = Math.floor(rect.y * px);
      const vw = Math.min(Math.max(1, Math.floor(rect.width * px)), this.width - vx);
      const vh = Math.min(Math.max(1, Math.floor(rect.height * px)), this.height - vy);
      if (vw <= 0 || vh <= 0) continue;

      geometryPass.setViewport(vx, vy, vw, vh, 0, 1);
      geometryPass.setScissorRect(vx, vy, vw, vh);
      geometryPass.setBindGroup(0, slot.bindGroup);

      if (slot.cartoonIndexCount > 0 && slot.cartoonVertices && slot.cartoonIndices) {
        geometryPass.setPipeline(this.cartoonPipeline);
        geometryPass.setVertexBuffer(0, slot.cartoonVertices);
        geometryPass.setIndexBuffer(slot.cartoonIndices, 'uint32');
        geometryPass.drawIndexed(slot.cartoonIndexCount);
      }

      if (slot.cylinders) {
        geometryPass.setPipeline(this.cylinderPipeline);
        geometryPass.setVertexBuffer(0, this.cylinderMesh.vertices);
        geometryPass.setVertexBuffer(1, slot.cylinders.buffer);
        geometryPass.setIndexBuffer(this.cylinderMesh.indices, 'uint32');
        geometryPass.drawIndexed(this.cylinderMesh.indexCount, slot.cylinders.count);
      }

      if (slot.spheres) {
        geometryPass.setPipeline(this.spherePipeline);
        geometryPass.setVertexBuffer(0, slot.spheres.buffer);
        geometryPass.draw(4, slot.spheres.count);
      }
    }
    geometryPass.end();

    const compositePass = encoder.beginRenderPass({
      label: 'composite',
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0.02, g: 0.025, b: 0.035, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    compositePass.setPipeline(this.compositePipeline);
    compositePass.setBindGroup(1, this.gbufferBindGroup);

    for (const slot of visible) {
      const { rect } = slot;
      const vx = Math.floor(rect.x * px);
      const vy = Math.floor(rect.y * px);
      const vw = Math.min(Math.max(1, Math.floor(rect.width * px)), this.width - vx);
      const vh = Math.min(Math.max(1, Math.floor(rect.height * px)), this.height - vy);
      if (vw <= 0 || vh <= 0) continue;

      compositePass.setViewport(vx, vy, vw, vh, 0, 1);
      compositePass.setScissorRect(vx, vy, vw, vh);
      compositePass.setBindGroup(0, slot.bindGroup);
      compositePass.draw(3);
    }
    compositePass.end();

    this.device.queue.submit([encoder.finish()]);
    this.lastFrameMs = performance.now() - start;

    return visible.some((s) => s.camera.isAnimating);
  }

  // -------------------------------------------------------------------------
  // Picking
  // -------------------------------------------------------------------------

  /**
   * Ray-casts against atom centres on the CPU. Doing this without a GPU
   * readback keeps hover feedback synchronous, and it works identically no
   * matter which representation is on screen.
   */
  pick(slot: number, localX: number, localY: number): PickResult | null {
    const s = this.slots[slot];
    const structure = s.structure;
    if (!structure || !s.active) return null;

    const { rect, camera } = s;
    if (rect.width <= 0 || rect.height <= 0) return null;

    const ndcX = (localX / rect.width) * 2 - 1;
    const ndcY = 1 - (localY / rect.height) * 2;

    // Unproject two points and build the world-space ray between them.
    const near = unproject(camera, ndcX, ndcY, 0);
    const far = unproject(camera, ndcX, ndcY, 1);
    const dx = far[0] - near[0], dy = far[1] - near[1], dz = far[2] - near[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    const rx = dx / len, ry = dy / len, rz = dz / len;

    // Pick radius grows with zoom so distant structures stay clickable.
    const worldPerPixel = (2 * Math.tan(camera.fovY / 2) * camera.distance) / rect.height;
    const radius = Math.max(1.5, worldPerPixel * 4);

    let bestT = Infinity;
    let bestAtom = -1;
    const { x, y, z, atomCount } = structure;

    for (let i = 0; i < atomCount; i++) {
      const ox = x[i] - near[0], oy = y[i] - near[1], oz = z[i] - near[2];
      const t = ox * rx + oy * ry + oz * rz;
      if (t <= 0 || t >= bestT) continue;
      const px = ox - rx * t, py = oy - ry * t, pz = oz - rz * t;
      if (px * px + py * py + pz * pz > radius * radius) continue;
      bestT = t;
      bestAtom = i;
    }

    if (bestAtom < 0) return null;
    return {
      atomIndex: bestAtom,
      residueIndex: structure.atomResidue[bestAtom],
      distance: bestT,
    };
  }

  destroy(): void {
    for (const s of this.slots) {
      s.spheres?.buffer.destroy();
      s.cylinders?.buffer.destroy();
      s.cartoonVertices?.destroy();
      s.cartoonIndices?.destroy();
      s.uniformBuffer.destroy();
    }
    this.albedoTexture?.destroy();
    this.normalTexture?.destroy();
    this.depthTexture?.destroy();
    this.device?.destroy();
  }
}

function unproject(camera: Camera, ndcX: number, ndcY: number, ndcZ: number): Float32Array {
  // View space first, then rotate/translate into world space using the
  // camera basis stored in the view matrix.
  const inv = camera.inverseProjection;
  const w = inv[3] * ndcX + inv[7] * ndcY + inv[11] * ndcZ + inv[15];
  const vx = (inv[0] * ndcX + inv[4] * ndcY + inv[8] * ndcZ + inv[12]) / w;
  const vy = (inv[1] * ndcX + inv[5] * ndcY + inv[9] * ndcZ + inv[13]) / w;
  const vz = (inv[2] * ndcX + inv[6] * ndcY + inv[10] * ndcZ + inv[14]) / w;

  // view matrix is orthonormal rotation R plus translation; invert directly.
  const v = camera.view;
  const out = new Float32Array(3);
  const tx = vx - v[12], ty = vy - v[13], tz = vz - v[14];
  out[0] = v[0] * tx + v[1] * ty + v[2] * tz;
  out[1] = v[4] * tx + v[5] * ty + v[6] * tz;
  out[2] = v[8] * tx + v[9] * ty + v[10] * tz;
  return out;
}
