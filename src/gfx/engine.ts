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
import { CARTOON_STRIDE, CYLINDER_STRIDE, type SceneGeometry } from './geometry';
import type { Structure } from '../mol/structure';

import { LABEL_STRIDE, createFontAtlas, type FontAtlas } from './text';

import commonWgsl from './shaders/common.wgsl?raw';
import spheresWgsl from './shaders/spheres.wgsl?raw';
import cylindersWgsl from './shaders/cylinders.wgsl?raw';
import cartoonWgsl from './shaders/cartoon.wgsl?raw';
import compositeWgsl from './shaders/composite.wgsl?raw';
import labelsWgsl from './shaders/labels.wgsl?raw';

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

/** GPU resources for one geometry group and the transforms it repeats under. */
interface GpuGroup {
  spheres: GPUBuffer | null;
  sphereCount: number;
  sphereBind: GPUBindGroup | null;
  cylinders: GPUBuffer | null;
  cylinderCount: number;
  cylinderBind: GPUBindGroup | null;
  cartoonVertices: GPUBuffer | null;
  cartoonIndices: GPUBuffer | null;
  cartoonIndexCount: number;
  cartoonBind: GPUBindGroup | null;
  transformBuffer: GPUBuffer;
  transformCount: number;
  /** CPU copies kept for picking. */
  transforms: Float32Array;
  localMin: Float32Array;
  localMax: Float32Array;
  /** Atoms this group draws; null means all of them. */
  atomMask: Uint8Array | null;
}

interface Slot {
  camera: Camera;
  uniformBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  uniformData: Float32Array;
  groups: GpuGroup[];
  structure: Structure | null;
  visual: SlotVisualSettings;
  rect: ViewportRect;
  active: boolean;
  /** Screen-space text drawn over this pane, rebuilt when it changes. */
  labelBuffer: GPUBuffer | null;
  labelBind: GPUBindGroup | null;
  labelCount: number;
  /** Measurement and hydrogen-bond sticks, independent of the scene geometry. */
  overlayBuffer: GPUBuffer | null;
  overlayBind: GPUBindGroup | null;
  overlayCount: number;
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
  private labelPipeline!: GPURenderPipeline;
  private labelLayout!: GPUBindGroupLayout;
  private fontAtlas!: FontAtlas;

  private cameraLayout!: GPUBindGroupLayout;
  private gbufferLayout!: GPUBindGroupLayout;
  /** Instance data + transforms, for spheres and cylinders. */
  private instanceLayout!: GPUBindGroupLayout;
  /** Transforms only, for the cartoon mesh. */
  private transformLayout!: GPUBindGroupLayout;
  private gbufferBindGroup: GPUBindGroup | null = null;

  private albedoTexture: GPUTexture | null = null;
  private normalTexture: GPUTexture | null = null;
  private depthTexture: GPUTexture | null = null;

  private cylinderMesh!: { vertices: GPUBuffer; indices: GPUBuffer; indexCount: number };
  /** Single identity matrix, shared by every overlay draw. */
  private identityTransformBuffer!: GPUBuffer;

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

    this.fontAtlas = createFontAtlas(this.device);
    this.createLayouts();
    this.createPipelines();
    this.createCylinderMesh();
    this.identityTransformBuffer = this.createBuffer(
      Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
      GPUBufferUsage.STORAGE,
    );
    this.createSlots();
  }

  onDeviceLost: ((message: string) => void) | null = null;

  get canvasElement(): HTMLCanvasElement | null {
    return this.canvas ?? null;
  }

  /** Glyph metrics, needed by callers laying out label instances. */
  get fontAtlasRef(): FontAtlas {
    return this.fontAtlas;
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

    const storage: GPUBufferBindingLayout = { type: 'read-only-storage' };
    this.instanceLayout = this.device.createBindGroupLayout({
      label: 'instances',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: storage },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: storage },
      ],
    });
    this.transformLayout = this.device.createBindGroupLayout({
      label: 'transforms',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: storage }],
    });

    this.labelLayout = this.device.createBindGroupLayout({
      label: 'labels',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: storage },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
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
    const instancePipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.cameraLayout, this.instanceLayout],
    });
    const transformPipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.cameraLayout, this.transformLayout],
    });

    const sphereModule = this.module(spheresWgsl, 'spheres');
    this.spherePipeline = this.device.createRenderPipeline({
      label: 'sphere-impostors',
      layout: instancePipelineLayout,
      vertex: { module: sphereModule, entryPoint: 'vs' },
      fragment: { module: sphereModule, entryPoint: 'fs', targets: gbufferTargets },
      primitive: { topology: 'triangle-strip' },
      depthStencil,
    });

    const cylinderModule = this.module(cylindersWgsl, 'cylinders');
    this.cylinderPipeline = this.device.createRenderPipeline({
      label: 'cylinders',
      layout: instancePipelineLayout,
      vertex: {
        module: cylinderModule,
        entryPoint: 'vs',
        buffers: [{
          arrayStride: 24,
          stepMode: 'vertex',
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
          ],
        }],
      },
      fragment: { module: cylinderModule, entryPoint: 'fs', targets: gbufferTargets },
      primitive: { topology: 'triangle-list', cullMode: 'back' },
      depthStencil,
    });

    const cartoonModule = this.module(cartoonWgsl, 'cartoon');
    this.cartoonPipeline = this.device.createRenderPipeline({
      label: 'cartoon',
      layout: transformPipelineLayout,
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

    const labelModule = this.module(labelsWgsl, 'labels');
    this.labelPipeline = this.device.createRenderPipeline({
      label: 'labels',
      layout: this.device.createPipelineLayout({
        bindGroupLayouts: [this.cameraLayout, this.labelLayout],
      }),
      vertex: { module: labelModule, entryPoint: 'vs' },
      fragment: {
        module: labelModule,
        entryPoint: 'fs',
        targets: [{
          format: this.format,
          blend: {
            color: {
              srcFactor: 'src-alpha',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add',
            },
            alpha: {
              srcFactor: 'one',
              dstFactor: 'one-minus-src-alpha',
              operation: 'add',
            },
          },
        }],
      },
      primitive: { topology: 'triangle-strip' },
    });
  }

  /**
   * Overlay sticks drawn with the cylinder pipeline but owned separately from
   * the scene geometry, so adding a measurement does not rebuild the molecule.
   */
  setOverlay(slot: number, cylinders: Float32Array): void {
    const s = this.slots[slot];
    const count = Math.floor(cylinders.length / CYLINDER_STRIDE);

    if (count === 0) {
      s.overlayBuffer?.destroy();
      s.overlayBuffer = null;
      s.overlayBind = null;
      s.overlayCount = 0;
      return;
    }

    const bytes = count * CYLINDER_STRIDE * 4;
    if (!s.overlayBuffer || s.overlayBuffer.size < bytes) {
      s.overlayBuffer?.destroy();
      s.overlayBuffer = this.device.createBuffer({
        label: `overlay-${slot}`,
        size: Math.max(bytes, 4096),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      s.overlayBind = this.device.createBindGroup({
        layout: this.instanceLayout,
        entries: [
          { binding: 0, resource: { buffer: s.overlayBuffer } },
          { binding: 1, resource: { buffer: this.identityTransformBuffer } },
        ],
      });
    }

    this.device.queue.writeBuffer(
      s.overlayBuffer, 0,
      cylinders.buffer as ArrayBuffer, cylinders.byteOffset, bytes,
    );
    s.overlayCount = count;
  }

  /** Replaces a pane's label instances; pass an empty array to clear them. */
  setLabels(slot: number, instances: Float32Array): void {
    const s = this.slots[slot];
    const count = Math.floor(instances.length / LABEL_STRIDE);

    if (count === 0) {
      s.labelBuffer?.destroy();
      s.labelBuffer = null;
      s.labelBind = null;
      s.labelCount = 0;
      return;
    }

    const bytes = count * LABEL_STRIDE * 4;
    // Reuse the buffer while it is big enough; labels change on every hover.
    if (!s.labelBuffer || s.labelBuffer.size < bytes) {
      s.labelBuffer?.destroy();
      s.labelBuffer = this.device.createBuffer({
        label: `labels-${slot}`,
        size: Math.max(bytes, 4096),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      s.labelBind = this.device.createBindGroup({
        layout: this.labelLayout,
        entries: [
          { binding: 0, resource: { buffer: s.labelBuffer } },
          { binding: 1, resource: this.fontAtlas.view },
          { binding: 2, resource: this.fontAtlas.sampler },
        ],
      });
    }

    this.device.queue.writeBuffer(
      s.labelBuffer, 0,
      instances.buffer as ArrayBuffer, instances.byteOffset, bytes,
    );
    s.labelCount = count;
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
        groups: [],
        structure: null,
        visual: { ...DEFAULT_VISUAL_SETTINGS },
        rect: { x: 0, y: 0, width: 1, height: 1 },
        active: false,
        labelBuffer: null,
        labelBind: null,
        labelCount: 0,
        overlayBuffer: null,
        overlayBind: null,
        overlayCount: 0,
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

  private releaseGroups(slot: Slot): void {
    for (const g of slot.groups) {
      g.spheres?.destroy();
      g.cylinders?.destroy();
      g.cartoonVertices?.destroy();
      g.cartoonIndices?.destroy();
      g.transformBuffer.destroy();
    }
    slot.groups = [];
  }

  setGeometry(slot: number, geometry: SceneGeometry | null): void {
    const s = this.slots[slot];
    this.releaseGroups(s);
    s.active = geometry !== null && geometry.groups.length > 0;
    if (!geometry) return;

    for (const group of geometry.groups) {
      const transformBuffer = this.createBuffer(group.transforms, GPUBufferUsage.STORAGE);
      const gpu: GpuGroup = {
        spheres: null,
        sphereCount: group.sphereCount,
        sphereBind: null,
        cylinders: null,
        cylinderCount: group.cylinderCount,
        cylinderBind: null,
        cartoonVertices: null,
        cartoonIndices: null,
        cartoonIndexCount: 0,
        cartoonBind: null,
        transformBuffer,
        transformCount: group.transformCount,
        transforms: group.transforms,
        localMin: group.localMin,
        localMax: group.localMax,
        atomMask: group.atomMask,
      };

      if (group.sphereCount > 0) {
        gpu.spheres = this.createBuffer(group.spheres, GPUBufferUsage.STORAGE);
        gpu.sphereBind = this.device.createBindGroup({
          layout: this.instanceLayout,
          entries: [
            { binding: 0, resource: { buffer: gpu.spheres } },
            { binding: 1, resource: { buffer: transformBuffer } },
          ],
        });
      }
      if (group.cylinderCount > 0) {
        gpu.cylinders = this.createBuffer(group.cylinders, GPUBufferUsage.STORAGE);
        gpu.cylinderBind = this.device.createBindGroup({
          layout: this.instanceLayout,
          entries: [
            { binding: 0, resource: { buffer: gpu.cylinders } },
            { binding: 1, resource: { buffer: transformBuffer } },
          ],
        });
      }
      if (group.cartoon) {
        gpu.cartoonVertices = this.createBuffer(group.cartoon.vertices, GPUBufferUsage.VERTEX);
        gpu.cartoonIndices = this.createBuffer(group.cartoon.indices, GPUBufferUsage.INDEX);
        gpu.cartoonIndexCount = group.cartoon.indices.length;
        gpu.cartoonBind = this.device.createBindGroup({
          layout: this.transformLayout,
          entries: [{ binding: 0, resource: { buffer: transformBuffer } }],
        });
      }

      s.groups.push(gpu);
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
    // Labels lay themselves out in CSS pixels; the shader works in framebuffer
    // pixels, so it needs the ratio to keep text a constant apparent size.
    uniformData[85] = this.pixelRatio;
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

    const visible = this.slots.filter(
      (s) => (s.active || s.overlayCount > 0 || s.labelCount > 0)
        && s.rect.width > 0 && s.rect.height > 0,
    );
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

      for (const group of slot.groups) {
        // Instance counts are multiplied by the transform count; the shaders
        // divide back out to recover which copy they are drawing.
        if (group.cartoonIndexCount > 0 && group.cartoonVertices && group.cartoonIndices) {
          geometryPass.setPipeline(this.cartoonPipeline);
          geometryPass.setBindGroup(1, group.cartoonBind!);
          geometryPass.setVertexBuffer(0, group.cartoonVertices);
          geometryPass.setIndexBuffer(group.cartoonIndices, 'uint32');
          geometryPass.drawIndexed(group.cartoonIndexCount, group.transformCount);
        }

        if (group.cylinders) {
          geometryPass.setPipeline(this.cylinderPipeline);
          geometryPass.setBindGroup(1, group.cylinderBind!);
          geometryPass.setVertexBuffer(0, this.cylinderMesh.vertices);
          geometryPass.setIndexBuffer(this.cylinderMesh.indices, 'uint32');
          geometryPass.drawIndexed(
            this.cylinderMesh.indexCount, group.cylinderCount * group.transformCount,
          );
        }

        if (group.spheres) {
          geometryPass.setPipeline(this.spherePipeline);
          geometryPass.setBindGroup(1, group.sphereBind!);
          geometryPass.draw(4, group.sphereCount * group.transformCount);
        }
      }

      if (slot.overlayCount > 0 && slot.overlayBind) {
        geometryPass.setPipeline(this.cylinderPipeline);
        geometryPass.setBindGroup(1, slot.overlayBind);
        geometryPass.setVertexBuffer(0, this.cylinderMesh.vertices);
        geometryPass.setIndexBuffer(this.cylinderMesh.indices, 'uint32');
        geometryPass.drawIndexed(this.cylinderMesh.indexCount, slot.overlayCount);
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

    // Text goes on last, blended over the resolved image.
    for (const slot of visible) {
      if (slot.labelCount === 0 || !slot.labelBind) continue;
      const { rect } = slot;
      const vx = Math.floor(rect.x * px);
      const vy = Math.floor(rect.y * px);
      const vw = Math.min(Math.max(1, Math.floor(rect.width * px)), this.width - vx);
      const vh = Math.min(Math.max(1, Math.floor(rect.height * px)), this.height - vy);
      if (vw <= 0 || vh <= 0) continue;

      compositePass.setPipeline(this.labelPipeline);
      compositePass.setViewport(vx, vy, vw, vh, 0, 1);
      compositePass.setScissorRect(vx, vy, vw, vh);
      compositePass.setBindGroup(0, slot.bindGroup);
      compositePass.setBindGroup(1, slot.labelBind);
      compositePass.draw(4, slot.labelCount);
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

    // Scratch for the ray pushed into a copy's local frame.
    const lo = new Float32Array(3);
    const ld = new Float32Array(3);

    for (const group of s.groups) {
      // Bounding sphere of the group in its own frame.
      const cx = (group.localMin[0] + group.localMax[0]) / 2;
      const cy = (group.localMin[1] + group.localMax[1]) / 2;
      const cz = (group.localMin[2] + group.localMax[2]) / 2;
      const boundRadius = 0.5 * Math.hypot(
        group.localMax[0] - group.localMin[0],
        group.localMax[1] - group.localMin[1],
        group.localMax[2] - group.localMin[2],
      ) + radius;

      for (let t = 0; t < group.transformCount; t++) {
        const m = group.transforms;
        const o = t * 16;

        // Cull first: most assembly copies are nowhere near the cursor, and a
        // full atom scan per copy would be hopeless on a 60-fold capsid.
        const wcx = m[o] * cx + m[o + 4] * cy + m[o + 8] * cz + m[o + 12];
        const wcy = m[o + 1] * cx + m[o + 5] * cy + m[o + 9] * cz + m[o + 13];
        const wcz = m[o + 2] * cx + m[o + 6] * cy + m[o + 10] * cz + m[o + 14];
        const dx0 = wcx - near[0], dy0 = wcy - near[1], dz0 = wcz - near[2];
        const along = dx0 * rx + dy0 * ry + dz0 * rz;
        const perpSq = dx0 * dx0 + dy0 * dy0 + dz0 * dz0 - along * along;
        if (perpSq > boundRadius * boundRadius) continue;

        // Rigid inverse: transpose the rotation, undo the translation.
        const px0 = near[0] - m[o + 12], py0 = near[1] - m[o + 13], pz0 = near[2] - m[o + 14];
        lo[0] = m[o] * px0 + m[o + 1] * py0 + m[o + 2] * pz0;
        lo[1] = m[o + 4] * px0 + m[o + 5] * py0 + m[o + 6] * pz0;
        lo[2] = m[o + 8] * px0 + m[o + 9] * py0 + m[o + 10] * pz0;
        ld[0] = m[o] * rx + m[o + 1] * ry + m[o + 2] * rz;
        ld[1] = m[o + 4] * rx + m[o + 5] * ry + m[o + 6] * rz;
        ld[2] = m[o + 8] * rx + m[o + 9] * ry + m[o + 10] * rz;

        const mask = group.atomMask;
        for (let i = 0; i < atomCount; i++) {
          if (mask && !mask[i]) continue;
          const ox = x[i] - lo[0], oy = y[i] - lo[1], oz = z[i] - lo[2];
          const tt = ox * ld[0] + oy * ld[1] + oz * ld[2];
          if (tt <= 0 || tt >= bestT) continue;
          const qx = ox - ld[0] * tt, qy = oy - ld[1] * tt, qz = oz - ld[2] * tt;
          if (qx * qx + qy * qy + qz * qz > radius * radius) continue;
          bestT = tt;
          bestAtom = i;
        }
      }
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
      this.releaseGroups(s);
      s.labelBuffer?.destroy();
      s.overlayBuffer?.destroy();
      s.uniformBuffer.destroy();
    }
    this.albedoTexture?.destroy();
    this.normalTexture?.destroy();
    this.depthTexture?.destroy();
    this.fontAtlas?.texture.destroy();
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
