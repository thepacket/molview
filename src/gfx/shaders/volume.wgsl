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
  // x = silhouette weighting, 0 = uniform opacity
  // y = 1 when this surface follows the pane's palette controls
  params: vec4f,
};

@group(1) @binding(0) var<uniform> style: Style;

/**
 * A molecular surface is part of the molecule and has to move with the pane's
 * saturation and intensity, or a chain-coloured envelope drifts away from the
 * cartoon inside it. A density contour is not: its blue, green and red carry
 * meaning — which map, and which sign of the difference — and desaturating
 * them would erase the distinction the colours exist to make.
 */
fn styleColor(vertexColor: vec3f) -> vec3f {
  let c = style.color.rgb * vertexColor;
  if (style.params.y > 0.5) {
    return adjustPalette(c);
  }
  return c;
}

struct Vertex {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  // White for a density contour, the colour of the atom underneath for a
  // molecular surface. Multiplied by the style colour either way.
  @location(2) color: vec3f,
};

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) normalView: vec3f,
  @location(1) viewZ: f32,
  @location(2) viewPos: vec3f,
  @location(3) color: vec3f,
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
  out.color = v.color;
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

  var color = styleColor(in.color) * (hemi * 0.9 + nKey * 0.75 + nFill * 0.3);

  // Silhouette weighting: a shell seen face-on fades and its rim stays solid,
  // which is how a soap bubble reads and is what stops a density contour
  // looking like coloured fog. It has to be dialled right down for a molecular
  // surface — that surface is all bumps, every bump has a rim, and at full
  // weight the whole envelope turns into lace.
  let viewDir = normalize(-in.viewPos);
  let facing = abs(dot(n, viewDir));
  let weight = mix(1.0, 1.0 - 0.65 * style.params.x, facing);
  let alpha = clamp(style.color.a * weight, 0.0, 1.0);

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
  return vec4f(fogged(styleColor(in.color) * lit, in.viewPos), style.color.a);
}
