// Isosurfaces from experimental density, drawn forward and blended over the
// resolved image rather than through the G-buffer.
//
// The G-buffer holds one surface per pixel, which is the whole point of a
// deferred renderer and exactly wrong for a map: density has to be seen
// through, and what is behind it is the model it is evidence for. So this runs
// after the composite, reads the same depth buffer to be occluded correctly by
// the molecule, and writes no depth of its own — a map sheet never hides
// another map sheet.
//
// Lighting is a reduced version of the composite's rig: key, fill and the same
// hemispheric ambient, minus occlusion and shadows. A contour is a level set,
// not an object, and giving it contact shadows makes it read as a solid shell.

struct Style {
  // rgb colour, a = opacity
  color: vec4f,
  // x = fog density, y = fog start, z unused, w unused
  params: vec4f,
};

@group(1) @binding(0) var<uniform> style: Style;

struct Vertex {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
};

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) normalView: vec3f,
  @location(1) viewZ: f32,
  @location(2) viewPos: vec3f,
};

@vertex
fn vs(v: Vertex) -> VSOut {
  let world = (cam.scene * vec4f(v.position, 1.0)).xyz;
  let worldNormal = (cam.scene * vec4f(v.normal, 0.0)).xyz;
  let viewPos = cam.view * vec4f(world, 1.0);

  var out: VSOut;
  out.position = cam.proj * viewPos;
  out.normalView = (cam.view * vec4f(worldNormal, 0.0)).xyz;
  out.viewZ = viewPos.z;
  out.viewPos = viewPos.xyz;
  return out;
}

fn fogged(color: vec3f, viewPos: vec3f) -> vec3f {
  let dist = length(viewPos);
  let fog = 1.0 - exp(-cam.params.z * max(dist - cam.params.w, 0.0));
  return mix(color, cam.background.rgb, clamp(fog, 0.0, 0.85));
}

@fragment
fn fsSolid(in: VSOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4f {
  if (clippedView(in.viewZ)) {
    discard;
  }
  var n = normalize(in.normalView);
  if (!frontFacing) {
    n = -n;
  }

  let keyDir = normalize(vec3f(0.45, 0.55, 0.75));
  let fillDir = normalize(vec3f(-0.6, 0.1, 0.45));
  let nKey = max(dot(n, keyDir), 0.0);
  let nFill = max(dot(n, fillDir), 0.0);
  let hemi = mix(vec3f(0.16, 0.18, 0.24), vec3f(0.55, 0.58, 0.66), n.y * 0.5 + 0.5);

  var color = style.color.rgb * (hemi * 0.9 + nKey * 0.75 + nFill * 0.3);

  // Silhouette-weighted opacity. A shell seen face-on is nearly transparent
  // and its rim nearly solid, which is how a soap bubble reads and is why a
  // constant-alpha surface looks like coloured fog instead of a boundary.
  let viewDir = normalize(-in.viewPos);
  let facing = abs(dot(n, viewDir));
  let alpha = clamp(style.color.a * mix(1.0, 0.35, facing), 0.0, 1.0);

  return vec4f(fogged(color, in.viewPos), alpha);
}

@fragment
fn fsWire(in: VSOut) -> @location(0) vec4f {
  if (clippedView(in.viewZ)) {
    discard;
  }
  // A line has no meaningful facing, so shade it by how much of the surface
  // it belongs to turns away — just enough to give the mesh depth.
  let n = normalize(in.normalView);
  let lit = 0.55 + 0.45 * abs(dot(n, normalize(vec3f(0.45, 0.55, 0.75))));
  return vec4f(fogged(style.color.rgb * lit, in.viewPos), style.color.a);
}
