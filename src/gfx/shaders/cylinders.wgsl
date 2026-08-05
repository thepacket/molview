// Instanced cylinder mesh for bonds. Each instance orients a unit tube
// (radius 1, spanning z = 0..1) onto the segment between two atoms.

struct Vertex {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
};

struct Instance {
  @location(2) startRadius: vec4f,
  @location(3) endPick: vec4f,
  @location(4) color: vec4f,
};

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) normalView: vec3f,
  @location(1) color: vec3f,
  @location(2) viewZ: f32,
};

@vertex
fn vs(v: Vertex, inst: Instance) -> VSOut {
  let start = inst.startRadius.xyz;
  let radius = inst.startRadius.w;
  let axis = inst.endPick.xyz - start;
  let height = max(length(axis), 1e-5);
  let zAxis = axis / height;

  // Any vector not parallel to the axis works as a seed for the frame.
  var seed = vec3f(0.0, 0.0, 1.0);
  if (abs(zAxis.z) > 0.9) {
    seed = vec3f(0.0, 1.0, 0.0);
  }
  let xAxis = normalize(cross(seed, zAxis));
  let yAxis = cross(zAxis, xAxis);

  let local = vec3f(v.position.xy * radius, v.position.z * height);
  let world = start + xAxis * local.x + yAxis * local.y + zAxis * local.z;
  let worldNormal = xAxis * v.normal.x + yAxis * v.normal.y + zAxis * v.normal.z;

  var out: VSOut;
  out.position = cam.viewProj * vec4f(world, 1.0);
  out.normalView = (cam.view * vec4f(worldNormal, 0.0)).xyz;
  out.color = inst.color.rgb;
  out.viewZ = (cam.view * vec4f(world, 1.0)).z;
  return out;
}

@fragment
fn fs(in: VSOut) -> GBufferOut {
  if (clippedView(in.viewZ)) {
    discard;
  }
  var out: GBufferOut;
  out.albedo = vec4f(in.color, 1.0);
  out.normal = encodeNormal(in.normalView);
  return out;
}
