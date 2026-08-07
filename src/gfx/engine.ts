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
import volumeWgsl from './shaders/volume.wgsl?raw';

import { ISOSURFACE_STRIDE, type IsoMesh } from './isosurface';
import { isColorBlindSafe as colorBlindSafe } from '../mol/coloring';

export const MAX_SLOTS = 4;
const IDENTITY_MATRIX = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
// 112 floats: the camera block, a 4x4 scene transform, shadow and palette.
const UNIFORM_BYTES = 448;
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
  /**
   * Clipping slab, as distances in Å measured inward from the front and back
   * of the structure. 0 on either side leaves that side unclipped, so the pair
   * (0, 0) is "no clipping" and the numbers mean the same thing whatever the
   * structure's size.
   */
  clipNear: number;
  clipFar: number;
  /** Tint each assembly copy by its operator index. */
  colorBySymmetry: boolean;
  /** Contact shadow strength along the key light, 0 disables. */
  shadow: number;
  /**
   * Palette adjustment applied to every material colour before lighting.
   * 1 leaves the scheme as authored; 0 saturation is greyscale. The default
   * is not 1 — see DEFAULT_VISUAL_SETTINGS.
   */
  saturation: number;
  intensity: number;
}

export const DEFAULT_VISUAL_SETTINGS: SlotVisualSettings = {
  background: [0.043, 0.051, 0.071],
  aoRadius: 4.5,
  aoIntensity: 1.0,
  outline: 0.85,
  fogDensity: 0.006,
  shadow: 0.55,
  // The schemes are authored at 1, and at 1 they read as washed out against a
  // near-black canvas: element and chain colours were chosen to be
  // distinguishable, not vivid, and the fog and hemispheric ambient both pull
  // them further towards the background. 2 is what the panes are actually
  // meant to look like; 1 is where a "reset" now returns to only in the sense
  // of returning to this default.
  saturation: 2,
  intensity: 2,
  orthographic: false,
  clipNear: 0,
  clipFar: 0,
  colorBySymmetry: false,
};

/** How one density isosurface is drawn. */
export interface VolumeStyle {
  color: [number, number, number];
  /** 0-1. Ignored in wireframe, where the mesh is see-through by construction. */
  opacity: number;
  wireframe: boolean;
  /**
   * How much more opaque the surface is at its silhouette than face-on. A thin
   * shell like a density contour wants this high; a molecular surface, which
   * is a boundary rather than a shell, wants it near zero.
   */
  silhouette: number;
  /** Whether the pane's saturation and intensity apply. Surfaces yes, maps no. */
  followsPalette: boolean;
}

/** GPU resources for one isosurface. */
interface GpuVolume {
  vertices: GPUBuffer;
  triangles: GPUBuffer;
  triangleIndexCount: number;
  lines: GPUBuffer;
  lineIndexCount: number;
  styleBuffer: GPUBuffer;
  styleBind: GPUBindGroup;
  wireframe: boolean;
}

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
  /**
   * One buffer per possible source slot. They all carry this pane's camera;
   * they differ only in the scene transform, which is what lets a pane draw
   * another pane's structure in its own superposed frame.
   */
  uniformBuffers: GPUBuffer[];
  bindGroups: GPUBindGroup[];
  /** Other slots whose geometry is drawn into this pane. */
  overlaySources: number[];
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
  /** Rigid transform placing this pane's structure in a shared frame. */
  sceneTransform: Float32Array;
  sceneInverse: Float32Array;
  /** Measurement and hydrogen-bond sticks, independent of the scene geometry. */
  overlayBuffer: GPUBuffer | null;
  overlayBind: GPUBindGroup | null;
  overlayCount: number;
  /** Density isosurfaces, drawn forward after the deferred resolve. */
  volumes: GpuVolume[];
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
  private volumeSolidPipeline!: GPURenderPipeline;
  private volumeBackPipeline!: GPURenderPipeline;
  private volumeWirePipeline!: GPURenderPipeline;
  private volumeStyleLayout!: GPUBindGroupLayout;
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

    this.volumeStyleLayout = this.device.createBindGroupLayout({
      label: 'volume-style',
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      }],
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

    // The resolve pass now carries the depth buffer as a read-only attachment
    // so the forward passes after it can depth-test against the molecule.
    // Read-only is what lets the same texture stay bound as a sampled
    // texture for the composite's own occlusion and shadow marching.
    const forwardDepth: GPUDepthStencilState = {
      format: 'depth32float',
      depthWriteEnabled: false,
      depthCompare: 'less',
    };
    const overlayDepth: GPUDepthStencilState = { ...forwardDepth, depthCompare: 'always' };
    const alphaBlend: GPUBlendState = {
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
    };

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
      depthStencil: overlayDepth,
    });

    const volumeModule = this.module(volumeWgsl, 'volume');
    const volumeLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.cameraLayout, this.volumeStyleLayout],
    });
    const volumeVertex: GPUVertexState = {
      module: volumeModule,
      entryPoint: 'vs',
      buffers: [{
        arrayStride: ISOSURFACE_STRIDE * 4,
        stepMode: 'vertex',
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x3' },
          { shaderLocation: 2, offset: 24, format: 'float32x3' },
        ],
      }],
    };

    // Both faces are drawn, but in two passes rather than one. Without depth
    // sorting, a single two-sided draw blends whichever triangle the index
    // buffer reached first, which on a bumpy surface is visible as a crawling
    // texture. Back faces then front faces is the painter's order for a closed
    // surface, and it is exactly two draw calls.
    const solid = (label: string, cullMode: GPUCullMode) =>
      this.device.createRenderPipeline({
        label,
        layout: volumeLayout,
        vertex: volumeVertex,
        fragment: {
          module: volumeModule,
          entryPoint: 'fsSolid',
          targets: [{ format: this.format, blend: alphaBlend }],
        },
        primitive: { topology: 'triangle-list', cullMode },
        depthStencil: forwardDepth,
      });
    // Winding is not controlled by the mesh generator — normals come from the
    // field gradient — so "front" here means whichever side the rasteriser
    // calls front, and the two passes together still cover both.
    this.volumeBackPipeline = solid('volume-back', 'front');
    this.volumeSolidPipeline = solid('volume-front', 'back');

    this.volumeWirePipeline = this.device.createRenderPipeline({
      label: 'volume-wire',
      layout: volumeLayout,
      vertex: volumeVertex,
      fragment: {
        module: volumeModule,
        entryPoint: 'fsWire',
        targets: [{ format: this.format, blend: alphaBlend }],
      },
      primitive: { topology: 'line-list' },
      depthStencil: forwardDepth,
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
        targets: [{ format: this.format, blend: alphaBlend }],
      },
      primitive: { topology: 'triangle-strip' },
      depthStencil: overlayDepth,
    });
  }

  /**
   * Replaces a pane's density isosurfaces. Meshes are generated on the CPU and
   * handed over whole; contour changes rebuild them, which is why the contour
   * control debounces.
   */
  setVolumes(slot: number, entries: { mesh: IsoMesh; style: VolumeStyle }[]): void {
    const s = this.slots[slot];
    this.releaseVolumes(s);

    for (const { mesh, style } of entries) {
      if (mesh.vertexCount === 0) continue;
      const styleBuffer = this.device.createBuffer({
        label: 'volume-style',
        size: 32,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(styleBuffer, 0, Float32Array.from([
        style.color[0], style.color[1], style.color[2],
        style.wireframe ? 1 : style.opacity,
        style.silhouette, style.followsPalette ? 1 : 0, 0, 0,
      ]));

      s.volumes.push({
        vertices: this.createBuffer(mesh.vertices, GPUBufferUsage.VERTEX),
        triangles: this.createBuffer(mesh.triangles, GPUBufferUsage.INDEX),
        triangleIndexCount: mesh.triangles.length,
        lines: this.createBuffer(mesh.lines, GPUBufferUsage.INDEX),
        lineIndexCount: mesh.lines.length,
        styleBuffer,
        styleBind: this.device.createBindGroup({
          layout: this.volumeStyleLayout,
          entries: [{ binding: 0, resource: { buffer: styleBuffer } }],
        }),
        wireframe: style.wireframe,
      });
    }
  }

  private releaseVolumes(slot: Slot): void {
    for (const v of slot.volumes) {
      v.vertices.destroy();
      v.triangles.destroy();
      v.lines.destroy();
      v.styleBuffer.destroy();
    }
    slot.volumes = [];
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
      const uniformBuffers: GPUBuffer[] = [];
      const bindGroups: GPUBindGroup[] = [];
      for (let source = 0; source < MAX_SLOTS; source++) {
        const buffer = this.device.createBuffer({
          label: `camera-${i}-source-${source}`,
          size: UNIFORM_BYTES,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        uniformBuffers.push(buffer);
        bindGroups.push(this.device.createBindGroup({
          layout: this.cameraLayout,
          entries: [{ binding: 0, resource: { buffer } }],
        }));
      }
      this.slots.push({
        camera: new Camera(),
        uniformBuffers,
        bindGroups,
        overlaySources: [],
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
        volumes: [],
        sceneTransform: IDENTITY_MATRIX.slice(),
        sceneInverse: IDENTITY_MATRIX.slice(),
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

  /**
   * Places a pane's structure in another pane's frame. The matrix must be a
   * rigid motion; the inverse is taken by transposing the rotation, which is
   * also what keeps picking correct without a general matrix inverse.
   */
  setSceneTransform(slot: number, matrix: Float32Array): void {
    const s = this.slots[slot];
    s.sceneTransform.set(matrix);

    const inv = s.sceneInverse;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) inv[c * 4 + r] = matrix[r * 4 + c];
    }
    inv[3] = 0; inv[7] = 0; inv[11] = 0; inv[15] = 1;
    const tx = matrix[12], ty = matrix[13], tz = matrix[14];
    inv[12] = -(inv[0] * tx + inv[4] * ty + inv[8] * tz);
    inv[13] = -(inv[1] * tx + inv[5] * ty + inv[9] * tz);
    inv[14] = -(inv[2] * tx + inv[6] * ty + inv[10] * tz);
  }

  getSceneTransform(slot: number): Float32Array {
    return this.slots[slot].sceneTransform;
  }

  /** Other slots whose geometry should also be drawn inside this pane. */
  setOverlaySources(slot: number, sources: number[]): void {
    this.slots[slot].overlaySources = [...sources];
  }

  getOverlaySources(slot: number): number[] {
    return this.slots[slot].overlaySources;
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

    // Labels lay themselves out in CSS pixels; the shader works in framebuffer
    // pixels, so it needs the ratio to keep text a constant apparent size.
    uniformData[85] = this.pixelRatio;
    uniformData[86] = visual.colorBySymmetry ? 1 : 0;

    // Contact shadows march the depth buffer, so their reach is in world units
    // and has to follow the scene: 8% of the radius keeps the same look on a
    // ligand and on a capsid.
    // The colour-blind-safe palette is exempt from both, and pinned to 1.
    //
    // Not a special case so much as the same rule the density maps follow: a
    // colour that carries meaning must not be retuned for looks. Those eight
    // colours are chosen so the closest pair stays apart under deuteranopia,
    // and the pane's default of 2 destroys exactly that — the composite clamps
    // to 0..1, so on any fragment facing the key light all eight clip, and
    // #e69f00 and #f0e442 come out identical under simulation. Measured: 24-60
    // units of separation at 1, and 0.0 at 2.
    const palette = colorBlindSafe() ? 1 : 0;
    uniformData[108] = palette ? 1 : visual.saturation;
    uniformData[109] = palette ? 1 : visual.intensity;

    uniformData[104] = visual.shadow;
    uniformData[105] = Math.max(camera.sceneRadius * 0.25, 4);

    // One variant per source slot. The scene transform differs, which is what
    // puts a superposed guest in the right place — and so do the clip planes.
    //
    // Clipping belongs to the structure, not to the pane it is being shown in.
    // Sectioning pane 1 used to cut a guest overlaid from pane 2 as well, even
    // with pane 2's own clip at zero, because every source variant inherited
    // the host's planes. That makes the commonest reason to overlay — a
    // sectioned structure against an intact reference — impossible to draw.
    // Cutting both is still available: set clipping on both panes.
    //
    // The plane is measured from the front of *this* pane's scene either way,
    // since it is this pane's camera doing the looking; only the decision to
    // cut, and by how much, comes from the source.
    const front = camera.distance - camera.sceneRadius;
    const back = camera.distance + camera.sceneRadius;
    for (let source = 0; source < MAX_SLOTS; source++) {
      const sourceVisual = this.slots[source].visual;
      uniformData[84] = front + sourceVisual.clipNear;
      uniformData[87] = sourceVisual.clipNear > 0 ? 1 : 0;
      uniformData[106] = back - sourceVisual.clipFar;
      uniformData[107] = sourceVisual.clipFar > 0 ? 1 : 0;
      uniformData.set(this.slots[source].sceneTransform, 88);
      this.device.queue.writeBuffer(
        slot.uniformBuffers[source], 0, uniformData as unknown as BufferSource,
      );
    }
  }

  /** True when something is still animating and another frame is warranted. */
  render(): boolean {
    if (!this.albedoTexture || !this.normalTexture || !this.depthTexture || !this.gbufferBindGroup) {
      return false;
    }
    const start = performance.now();
    const px = this.pixelRatio;

    const visible = this.slots.filter(
      (s) => (s.active || s.overlayCount > 0 || s.labelCount > 0
          || s.overlaySources.length > 0 || s.volumes.length > 0)
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

      // The pane's own structure, then anything overlaid onto it. Each source
      // is drawn with this pane's camera but its own scene transform, which is
      // what puts a superposed structure in the right place.
      const paneIndex = this.slots.indexOf(slot);
      const sources = [paneIndex, ...slot.overlaySources.filter((s) => s !== paneIndex)];

      for (const source of sources) {
      const sourceSlot = this.slots[source];
      if (!sourceSlot.active) continue;
      geometryPass.setBindGroup(0, slot.bindGroups[source]);

      for (const group of sourceSlot.groups) {
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
      }

      geometryPass.setBindGroup(0, slot.bindGroups[paneIndex]);
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
      // Carried through read-only: the forward passes below depth-test the
      // molecule out of the way, and the composite keeps sampling it.
      depthStencilAttachment: {
        view: this.depthTexture.createView(),
        depthReadOnly: true,
      },
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
      compositePass.setBindGroup(0, slot.bindGroups[this.slots.indexOf(slot)]);
      compositePass.draw(3);
    }

    // Density over the resolved molecule, before text.
    for (const slot of visible) {
      if (slot.volumes.length === 0) continue;
      const { rect } = slot;
      const vx = Math.floor(rect.x * px);
      const vy = Math.floor(rect.y * px);
      const vw = Math.min(Math.max(1, Math.floor(rect.width * px)), this.width - vx);
      const vh = Math.min(Math.max(1, Math.floor(rect.height * px)), this.height - vy);
      if (vw <= 0 || vh <= 0) continue;

      compositePass.setViewport(vx, vy, vw, vh, 0, 1);
      compositePass.setScissorRect(vx, vy, vw, vh);
      compositePass.setBindGroup(0, slot.bindGroups[this.slots.indexOf(slot)]);

      for (const v of slot.volumes) {
        const wire = v.wireframe;
        if (wire ? v.lineIndexCount === 0 : v.triangleIndexCount === 0) continue;
        compositePass.setBindGroup(1, v.styleBind);
        compositePass.setVertexBuffer(0, v.vertices);
        compositePass.setIndexBuffer(wire ? v.lines : v.triangles, 'uint32');
        if (wire) {
          compositePass.setPipeline(this.volumeWirePipeline);
          compositePass.drawIndexed(v.lineIndexCount);
        } else {
          for (const pipeline of [this.volumeBackPipeline, this.volumeSolidPipeline]) {
            compositePass.setPipeline(pipeline);
            compositePass.drawIndexed(v.triangleIndexCount);
          }
        }
      }
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
      compositePass.setBindGroup(0, slot.bindGroups[this.slots.indexOf(slot)]);
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
    // Atoms are stored in the structure's own frame, so undo any superposition
    // transform before testing against them.
    const inv = s.sceneInverse;
    const nx = inv[0] * near[0] + inv[4] * near[1] + inv[8] * near[2] + inv[12];
    const ny = inv[1] * near[0] + inv[5] * near[1] + inv[9] * near[2] + inv[13];
    const nz = inv[2] * near[0] + inv[6] * near[1] + inv[10] * near[2] + inv[14];
    const fx = inv[0] * far[0] + inv[4] * far[1] + inv[8] * far[2] + inv[12];
    const fy = inv[1] * far[0] + inv[5] * far[1] + inv[9] * far[2] + inv[13];
    const fz = inv[2] * far[0] + inv[6] * far[1] + inv[10] * far[2] + inv[14];
    near[0] = nx; near[1] = ny; near[2] = nz;

    const dx = fx - near[0], dy = fy - near[1], dz = fz - near[2];
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
      this.releaseVolumes(s);
      s.labelBuffer?.destroy();
      s.overlayBuffer?.destroy();
      for (const buffer of s.uniformBuffers) buffer.destroy();
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
