// Deferred resolve: screen-space ambient occlusion, three-point lighting,
// depth-discontinuity outlines, depth fog and the background gradient.
//
// Doing lighting here (rather than in each geometry pass) is what lets
// impostors, cylinders and ribbons share exactly the same shading, so a
// spacefill atom and a ribbon read as parts of one object.

@group(1) @binding(0) var gAlbedo: texture_2d<f32>;
@group(1) @binding(1) var gNormal: texture_2d<f32>;
@group(1) @binding(2) var gDepth: texture_depth_2d;

struct VSOut {
  @builtin(position) position: vec4f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  // Oversized triangle covering the clip volume.
  var pts = array<vec2f, 3>(vec2f(-1.0, -3.0), vec2f(-1.0, 1.0), vec2f(3.0, 1.0));
  var out: VSOut;
  out.position = vec4f(pts[vi], 0.0, 1.0);
  return out;
}

fn viewPosFromDepth(ndc: vec2f, depth: f32) -> vec3f {
  let h = cam.invProj * vec4f(ndc, depth, 1.0);
  return h.xyz / h.w;
}

fn hash12(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 = p3 + dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

const AO_SAMPLES: i32 = 12;

fn ambientOcclusion(coord: vec2i, viewPos: vec3f, normal: vec3f) -> f32 {
  let radius = cam.ao.x;
  if (radius <= 0.0) {
    return 1.0;
  }

  // Poisson-ish hemisphere kernel, scaled so samples cluster near the origin.
  var kernel = array<vec3f, 12>(
    vec3f(0.2024, 0.0841, 0.2150), vec3f(-0.1650, 0.2287, 0.1123),
    vec3f(0.0731, -0.2765, 0.3010), vec3f(-0.3120, -0.1140, 0.2402),
    vec3f(0.4128, 0.2711, 0.4390), vec3f(-0.2408, 0.4501, 0.3121),
    vec3f(0.1188, -0.5216, 0.4855), vec3f(-0.5620, -0.1010, 0.5602),
    vec3f(0.6014, 0.3708, 0.2211), vec3f(-0.3345, 0.6624, 0.4013),
    vec3f(0.0821, -0.7180, 0.6501), vec3f(-0.7402, 0.1544, 0.5310),
  );
  let bias = cam.ao.z;
  let vp = cam.viewport;
  let angle = hash12(vec2f(coord)) * 6.2831853;
  let ca = cos(angle);
  let sa = sin(angle);

  // Build a tangent frame around the surface normal.
  var up = vec3f(0.0, 0.0, 1.0);
  if (abs(normal.z) > 0.9) {
    up = vec3f(1.0, 0.0, 0.0);
  }
  let tangent = normalize(cross(up, normal));
  let bitangent = cross(normal, tangent);

  var occlusion = 0.0;
  for (var i = 0; i < AO_SAMPLES; i = i + 1) {
    let k = kernel[i];
    // Rotate the kernel per pixel so banding turns into noise.
    let rk = vec3f(k.x * ca - k.y * sa, k.x * sa + k.y * ca, k.z);
    let dir = tangent * rk.x + bitangent * rk.y + normal * rk.z;
    let samplePos = viewPos + dir * radius;

    let clip = cam.proj * vec4f(samplePos, 1.0);
    if (clip.w <= 0.0) {
      continue;
    }
    let sndc = clip.xy / clip.w;
    if (abs(sndc.x) > 1.0 || abs(sndc.y) > 1.0) {
      continue;
    }

    let px = vec2i(
      i32(vp.x + (sndc.x * 0.5 + 0.5) * vp.z),
      i32(vp.y + (0.5 - sndc.y * 0.5) * vp.w),
    );
    let sampleDepth = textureLoad(gDepth, px, 0);
    if (sampleDepth >= 1.0) {
      continue;
    }
    let sampleView = viewPosFromDepth(sndc, sampleDepth);

    // Only count occluders in front of the sample point, and fade out
    // contributions from geometry far away in depth.
    if (sampleView.z > samplePos.z + bias) {
      let rangeCheck = smoothstep(0.0, 1.0, radius / max(abs(viewPos.z - sampleView.z), 1e-4));
      occlusion = occlusion + rangeCheck;
    }
  }

  let ao = 1.0 - (occlusion / f32(AO_SAMPLES)) * cam.ao.y;
  return clamp(ao, 0.0, 1.0);
}

fn edgeFactor(coord: vec2i, depth: f32, normal: vec3f) -> f32 {
  let strength = cam.ao.w;
  if (strength <= 0.0) {
    return 0.0;
  }
  let vp = cam.viewport;
  var maxDelta = 0.0;
  var normalDelta = 0.0;
  var offs = array<vec2i, 4>(
    vec2i(1, 0), vec2i(-1, 0), vec2i(0, 1), vec2i(0, -1),
  );

  for (var i = 0; i < 4; i = i + 1) {
    let p = coord + offs[i];
    if (p.x < i32(vp.x) || p.y < i32(vp.y)
      || p.x >= i32(vp.x + vp.z) || p.y >= i32(vp.y + vp.w)) {
      continue;
    }
    let d = textureLoad(gDepth, p, 0);
    // Linearise, then compare *relatively*: an absolute threshold in Ångström
    // would mark every pixel of a 1000 Å capsid as an edge while missing the
    // silhouettes on a 20 Å ligand.
    let a = cam.params.x * cam.params.y / (cam.params.y - depth * (cam.params.y - cam.params.x));
    let b = cam.params.x * cam.params.y / (cam.params.y - d * (cam.params.y - cam.params.x));
    maxDelta = max(maxDelta, abs(a - b) / max(a, 1e-4));

    let n = textureLoad(gNormal, p, 0);
    if (n.w > 0.5) {
      normalDelta = max(normalDelta, 1.0 - clamp(dot(normal, normalize(n.xyz)), 0.0, 1.0));
    }
  }

  let depthEdge = smoothstep(0.004, 0.02, maxDelta);
  let normalEdge = smoothstep(0.45, 0.95, normalDelta);
  return clamp(max(depthEdge, normalEdge * 0.8) * strength, 0.0, 1.0);
}

fn background(ndc: vec2f) -> vec3f {
  let base = cam.background.rgb;
  // Gentle radial falloff keeps four panes from looking like flat grey boxes.
  let r = length(ndc * vec2f(1.0, 0.85));
  let vignette = 1.0 - cam.background.a * smoothstep(0.2, 1.5, r);
  return base * vignette;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  let coord = vec2i(in.position.xy);
  let ndc = viewportNdc(in.position.xy);
  let bg = background(ndc);

  let normalSample = textureLoad(gNormal, coord, 0);
  if (normalSample.w < 0.5) {
    return vec4f(bg, 1.0);
  }

  let depth = textureLoad(gDepth, coord, 0);
  let albedo = textureLoad(gAlbedo, coord, 0).rgb;
  let normal = normalize(normalSample.xyz);
  let viewPos = viewPosFromDepth(ndc, depth);
  let viewDir = normalize(-viewPos);

  let ao = ambientOcclusion(coord, viewPos, normal);

  // Three-point rig in view space: the lights follow the camera, which is what
  // makes a molecule readable no matter how the user has rotated it.
  let keyDir = normalize(vec3f(0.45, 0.55, 0.75));
  let fillDir = normalize(vec3f(-0.6, 0.1, 0.45));
  let rimDir = normalize(vec3f(-0.2, -0.5, -0.6));

  let nKey = max(dot(normal, keyDir), 0.0);
  let nFill = max(dot(normal, fillDir), 0.0);
  let nRim = max(dot(normal, rimDir), 0.0);

  let halfKey = normalize(keyDir + viewDir);
  let spec = pow(max(dot(normal, halfKey), 0.0), 48.0) * 0.35;

  // Wrapped ambient: sky above, cooler bounce below.
  let hemi = mix(vec3f(0.16, 0.18, 0.24), vec3f(0.55, 0.58, 0.66), normal.y * 0.5 + 0.5);

  var color = albedo * (hemi * ao * 1.15
    + nKey * vec3f(1.0, 0.97, 0.92) * 0.85
    + nFill * vec3f(0.35, 0.45, 0.62) * 0.45
    + nRim * vec3f(0.5, 0.55, 0.75) * 0.3);
  color = color + vec3f(spec) * ao;

  // Contact darkening: makes cavities and packing read at a glance.
  color = color * mix(0.55, 1.0, ao);

  let edge = edgeFactor(coord, depth, normal);
  color = mix(color, bg * 0.35, edge);

  let dist = length(viewPos);
  let fog = 1.0 - exp(-cam.params.z * max(dist - cam.params.w, 0.0));
  color = mix(color, bg, clamp(fog, 0.0, 0.85));

  // Filmic-ish curve; keeps bright specular highlights from clipping flat.
  color = color / (color + vec3f(0.85)) * 1.6;
  return vec4f(pow(clamp(color, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 1.05)), 1.0);
}
