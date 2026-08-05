// Cartoon / ribbon mesh. Geometry is generated on the CPU; this pass only
// transforms it into the G-buffer.

struct Vertex {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
};

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) normalView: vec3f,
  @location(1) color: vec3f,
  @location(2) viewZ: f32,
};

@vertex
fn vs(v: Vertex) -> VSOut {
  var out: VSOut;
  out.position = cam.viewProj * vec4f(v.position, 1.0);
  out.normalView = (cam.view * vec4f(v.normal, 0.0)).xyz;
  out.color = v.color;
  out.viewZ = (cam.view * vec4f(v.position, 1.0)).z;
  return out;
}

@fragment
fn fs(in: VSOut, @builtin(front_facing) frontFacing: bool) -> GBufferOut {
  if (clippedView(in.viewZ)) {
    discard;
  }
  // Ribbons are open surfaces at the caps; flip the normal on back faces so
  // the inside of a tube is lit instead of black.
  var n = normalize(in.normalView);
  if (!frontFacing) {
    n = -n;
  }
  var out: GBufferOut;
  out.albedo = vec4f(in.color, 1.0);
  out.normal = encodeNormal(n);
  return out;
}
