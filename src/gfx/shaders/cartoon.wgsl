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

// One matrix per assembly copy; the mesh is drawn once per transform.
@group(1) @binding(0) var<storage, read> transforms: array<mat4x4f>;

@vertex
fn vs(v: Vertex, @builtin(instance_index) ii: u32) -> VSOut {
  let model = transforms[ii];
  let world = (cam.scene * model * vec4f(v.position, 1.0)).xyz;
  let worldNormal = (cam.scene * model * vec4f(v.normal, 0.0)).xyz;
  let viewPos = cam.view * vec4f(world, 1.0);

  var out: VSOut;
  out.position = cam.proj * viewPos;
  out.normalView = (cam.view * vec4f(worldNormal, 0.0)).xyz;
  out.color = symmetryTint(v.color, ii);
  out.viewZ = viewPos.z;
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
