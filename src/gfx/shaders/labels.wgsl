// Screen-aligned text and measurement markers.
//
// Runs after the deferred resolve, straight onto the swap chain with alpha
// blending, so it never touches the G-buffer. Labels are always drawn on top:
// a distance readout hidden inside the molecule would be useless.

struct Label {
  world: vec4f,
  // xy = pixel offset from the projected anchor, zw = size in pixels
  rect: vec4f,
  uv: vec4f,
  color: vec4f,
};

@group(1) @binding(0) var<storage, read> labels: array<Label>;
@group(1) @binding(1) var atlas: texture_2d<f32>;
@group(1) @binding(2) var atlasSampler: sampler;

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VSOut {
  let label = labels[ii];
  var corners = array<vec2f, 4>(
    vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 1.0),
  );
  let corner = corners[vi];

  var out: VSOut;
  let clip = cam.viewProj * label.world;
  if (clip.w <= 0.0) {
    // Behind the camera: collapse the quad so it contributes nothing.
    out.position = vec4f(2.0, 2.0, 0.0, 1.0);
    out.uv = vec2f(0.0);
    out.color = vec4f(0.0);
    return out;
  }

  let ndc = clip.xy / clip.w;
  let vp = cam.viewport.zw;
  // Anchor in viewport pixels, then lay the quad out in pixel space so text
  // keeps a constant size regardless of distance.
  let anchorPx = vec2f((ndc.x * 0.5 + 0.5) * vp.x, (0.5 - ndc.y * 0.5) * vp.y);
  // rect is authored in CSS pixels; scale into framebuffer pixels.
  let scale = max(cam.clip.y, 1.0);
  let px = anchorPx + label.rect.xy * scale + corner * label.rect.zw * scale;

  out.position = vec4f(px.x / vp.x * 2.0 - 1.0, 1.0 - px.y / vp.y * 2.0, 0.0, 1.0);
  out.uv = mix(label.uv.xy, label.uv.zw, corner);
  out.color = label.color;
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let texel = textureSample(atlas, atlasSampler, in.uv);
  let alpha = texel.a * in.color.a;
  if (alpha < 0.004) {
    discard;
  }
  return vec4f(in.color.rgb, alpha);
}
