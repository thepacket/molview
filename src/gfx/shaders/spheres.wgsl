// Ray-traced sphere impostors: four vertices per atom, exact silhouette and
// exact depth from the fragment shader. At spacefill scale this is the only
// way to draw a few hundred thousand atoms without drowning in triangles.

struct Instance {
  @location(0) centerRadius: vec4f,
  @location(1) colorPick: vec4f,
};

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) centerView: vec3f,
  @location(1) radius: f32,
  @location(2) color: vec3f,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, inst: Instance) -> VSOut {
  let center = inst.centerRadius.xyz;
  let radius = inst.centerRadius.w;
  let centerView = (cam.view * vec4f(center, 1.0)).xyz;

  var corners = array<vec2f, 4>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0),
  );

  // A perspective sphere's silhouette is larger than its radius; expand the
  // quad so the ray test never clips the edge of the sphere.
  let d = length(centerView);
  var scale = 1.05;
  if (d > radius * 1.001) {
    scale = d / sqrt(max(d * d - radius * radius, 1e-4));
  } else {
    scale = 2.0;
  }

  let offset = corners[vi] * radius * scale;
  let posView = centerView + vec3f(offset, 0.0);

  var out: VSOut;
  out.position = cam.proj * vec4f(posView, 1.0);
  out.centerView = centerView;
  out.radius = radius;
  out.color = inst.colorPick.xyz;
  return out;
}

struct FSOut {
  @location(0) albedo: vec4f,
  @location(1) normal: vec4f,
  @builtin(frag_depth) depth: f32,
};

@fragment
fn fs(in: VSOut) -> FSOut {
  let ray = viewRay(viewportNdc(in.position.xy));

  let oc = in.centerView - ray.origin;
  let b = dot(ray.dir, oc);
  let c = dot(oc, oc) - in.radius * in.radius;
  let disc = b * b - c;
  if (disc < 0.0) {
    discard;
  }

  var t = b - sqrt(disc);
  if (t < 0.0) {
    discard;
  }

  var hitView = ray.origin + ray.dir * t;
  var facing = 1.0;
  if (clippedView(hitView.z)) {
    // Step through to the far intersection so the cut surface stays solid
    // rather than opening a hole into the interior.
    t = b + sqrt(disc);
    hitView = ray.origin + ray.dir * t;
    if (clippedView(hitView.z)) {
      discard;
    }
    facing = -1.0;
  }
  let normal = (hitView - in.centerView) / in.radius * facing;

  let clipPos = cam.proj * vec4f(hitView, 1.0);

  var out: FSOut;
  out.albedo = vec4f(in.color, 1.0);
  out.normal = encodeNormal(normal);
  out.depth = clipPos.z / clipPos.w;
  return out;
}
