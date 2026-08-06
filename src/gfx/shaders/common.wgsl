// Shared camera block and G-buffer helpers. Prepended to every shader module.

struct Camera {
  view: mat4x4f,
  proj: mat4x4f,
  viewProj: mat4x4f,
  invProj: mat4x4f,
  cameraPos: vec4f,
  // x, y, width, height of this viewport in framebuffer pixels
  viewport: vec4f,
  // near, far, fogDensity, clipRadius
  params: vec4f,
  // rgb background, a = vignette strength
  background: vec4f,
  // radius, intensity, bias, outlineStrength
  ao: vec4f,
  // x = front clip distance, y = device pixel ratio, z = symmetry tint, w = clip enabled
  clip: vec4f,
  // Rigid transform applied to everything in this pane, for superposition.
  scene: mat4x4f,
  // x = contact shadow strength, y = its reach in world units,
  // z = rear clip distance, w = rear clip enabled
  shadow: vec4f,
  // x = colour saturation, y = colour intensity, z and w spare
  palette: vec4f,
};

@group(0) @binding(0) var<uniform> cam: Camera;

/**
 * The pane's saturation and intensity, applied to a material colour before it
 * is lit.
 *
 * Before lighting rather than after, because these are meant to adjust the
 * *palette* — what colour the molecule is — not the exposure of the finished
 * image. Applying them at the end would fight the tone curve and wash out the
 * specular highlights instead of muting the hues.
 *
 * Saturation above 1 extrapolates away from grey and can push a channel
 * negative, hence the clamp.
 */
fn adjustPalette(c: vec3f) -> vec3f {
  let luma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  return max(mix(vec3f(luma), c, cam.palette.x) * cam.palette.y, vec3f(0.0));
}

struct GBufferOut {
  @location(0) albedo: vec4f,
  @location(1) normal: vec4f,
};

// Normalised device coords for a fragment, relative to this viewport.
fn viewportNdc(fragPos: vec2f) -> vec2f {
  let vp = cam.viewport;
  return vec2f(
    (fragPos.x - vp.x) / vp.z * 2.0 - 1.0,
    1.0 - (fragPos.y - vp.y) / vp.w * 2.0,
  );
}

// View-space ray through a fragment. Works for perspective and orthographic.
struct Ray {
  origin: vec3f,
  dir: vec3f,
};

fn viewRay(ndc: vec2f) -> Ray {
  let nearH = cam.invProj * vec4f(ndc, 0.0, 1.0);
  let farH = cam.invProj * vec4f(ndc, 1.0, 1.0);
  let p0 = nearH.xyz / nearH.w;
  let p1 = farH.xyz / farH.w;
  var r: Ray;
  r.origin = p0;
  r.dir = normalize(p1 - p0);
  return r;
}

fn encodeNormal(n: vec3f) -> vec4f {
  return vec4f(normalize(n), 1.0);
}

// Front clipping plane, perpendicular to the view direction. Slicing away the
// near half of a large assembly is often the only way to see its interior.
// View space looks down -z, so anything nearer than the plane has a larger z.
// Tints a copy by its assembly operator index. Without this every symmetry
// mate is the same colour and a 60-fold capsid reads as undifferentiated mush.
fn symmetryTint(base: vec3f, copyIndex: u32) -> vec3f {
  if (cam.clip.z < 0.5) {
    return base;
  }
  let t = fract(f32(copyIndex) * 0.6180339887);
  let hue = 0.5 + 0.5 * cos(6.2831853 * (t + vec3f(0.0, 0.33, 0.67)));
  return mix(base, hue, 0.7);
}

fn clippedView(viewZ: f32) -> bool {
  if (cam.clip.w > 0.5 && viewZ > -cam.clip.x) {
    return true;
  }
  // The rear plane cuts away what is behind the slab, which is what lets a
  // thin section through a large assembly read as a section rather than as a
  // silhouette against everything behind it.
  return cam.shadow.w > 0.5 && viewZ < -cam.shadow.z;
}
