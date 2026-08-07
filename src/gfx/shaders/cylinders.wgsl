// Instanced cylinder mesh for bonds. Each instance orients a unit tube
// (radius 1, spanning z = 0..1) onto the segment between two atoms.

struct Vertex {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
};

struct Instance {
  startRadius: vec4f,
  endPick: vec4f,
  color: vec4f,
};

// See spheres.wgsl: storage instancing lets one draw cover every assembly copy.
@group(1) @binding(0) var<storage, read> cylinders: array<Instance>;
@group(1) @binding(1) var<storage, read> transforms: array<mat4x4f>;

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) normalView: vec3f,
  @location(1) color: vec3f,
  @location(2) viewZ: f32,
};

@vertex
fn vs(v: Vertex, @builtin(instance_index) ii: u32) -> VSOut {
  let n = arrayLength(&cylinders);
  let inst = cylinders[ii % n];
  let model = transforms[ii / n];

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
  let localWorld = start + xAxis * local.x + yAxis * local.y + zAxis * local.z;
  let localNormal = xAxis * v.normal.x + yAxis * v.normal.y + zAxis * v.normal.z;

  let world = (cam.scene * model * vec4f(localWorld, 1.0)).xyz;
  let worldNormal = (cam.scene * model * vec4f(localNormal, 0.0)).xyz;

  let viewPos = cam.view * vec4f(world, 1.0);

  var out: VSOut;
  out.position = cam.proj * viewPos;
  out.normalView = (cam.view * vec4f(worldNormal, 0.0)).xyz;
  out.color = symmetryTint(inst.color.rgb, ii / n);
  out.viewZ = viewPos.z;
  return out;
}

@fragment
fn fs(in: VSOut) -> GBufferOut {
  if (clippedView(in.viewZ)) {
    discard;
  }
  var out: GBufferOut;
  out.albedo = vec4f(adjustPalette(in.color), 1.0);
  out.normal = encodeNormal(in.normalView);
  return out;
}
