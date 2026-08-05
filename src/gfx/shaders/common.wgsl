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
  // x = front clip distance in view space, w = enabled
  clip: vec4f,
};

@group(0) @binding(0) var<uniform> cam: Camera;

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
fn clippedView(viewZ: f32) -> bool {
  return cam.clip.w > 0.5 && viewZ > -cam.clip.x;
}
