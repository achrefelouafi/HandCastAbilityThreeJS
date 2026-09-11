import {
  AdditiveBlending,
  AddEquation,
  BufferAttribute,
  Color,
  CustomBlending,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  FrontSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  NormalBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  Sphere,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';

/**
 * THE SERPENT TIDE FIELD — every material the phoenix and its pyre draw with.
 *
 * Seven layers off the breakdown sheet, one factory each, and one shared piece
 * of shading under all of them: **fire is a temperature, not a palette.** Every
 * layer here computes a normalised heat, turns it into kelvin between
 * `uTempEdge` and `uTempCore`, and radiates a Planckian colour at a power that
 * goes as a high exponent of that temperature. That single decision is what
 * makes the white-hot rim of the bird, the orange body of a serpent and the
 * deep red fringe of a flame tongue read as the same fire — they *are* the same
 * fire, at different temperatures — and it is why the whole field holds
 * together at any exposure. The editor's four colour stops are blended in on
 * top through `uPalette`, so the look can be pushed without the physics
 * fighting it.
 *
 * The noise is the flame field from the volumetric fireball: value noise on a
 * hashed lattice, five octaves, each one domain-warped by the one before it
 * and each one drifting upward faster than the last. Plain fbm makes clouds;
 * this makes tongues. See `flameFbm` for the details and the two outputs the
 * layers read off it.
 *
 *   1. body + aura   the bird — a skinned fresnel of fire (`createPhoenixBody`,
 *                    `createPhoenixAura`)
 *   2. serpents      ribbons on a parametric S-curve round the pyre, placed
 *                    entirely in the vertex shader (`createSerpentMaterial`)
 *   3. skirt         the wispy flame waves: a cylinder torn into tongues
 *   4. ground        scorch, cracked crust, sub-surface glow — one quad,
 *                    premultiplied so it darkens *and* glows
 *   5. heat          a distortion column over the field
 *   6. embers        the shared particle engine, dressed by the ability
 *   7. fireballs     instanced comet billboards the bird spits
 */

export const PHOENIX_MAX_SERPENTS = 6;
export const PHOENIX_MAX_FIREBALLS = 24;

/* ------------------------------------------------------------------ */
/* shared shading                                                      */
/* ------------------------------------------------------------------ */

/** Uniform declarations every fire layer shares. Paired with FIRE_GLSL. */
const FIRE_UNIFORMS_GLSL = /* glsl */ `
  uniform float uTempCore;
  uniform float uTempEdge;
  uniform float uEmissionCurve;
  uniform float uPalette;
  uniform vec3  uColorCore;
  uniform vec3  uColorMid;
  uniform vec3  uColorEdge;
  uniform vec3  uColorEmber;
`;

const FIRE_GLSL = /* glsl */ `
  /* Trilinear value noise on a hashed lattice: a third of the cost of simplex,
     and indistinguishable once four octaves of it are warped and sheared. */
  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash13(i);
    float b = hash13(i + vec3(1.0, 0.0, 0.0));
    float c = hash13(i + vec3(0.0, 1.0, 0.0));
    float d = hash13(i + vec3(1.0, 1.0, 0.0));
    float e = hash13(i + vec3(0.0, 0.0, 1.0));
    float g = hash13(i + vec3(1.0, 0.0, 1.0));
    float h = hash13(i + vec3(0.0, 1.0, 1.0));
    float k = hash13(i + vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(a, b, f.x), mix(c, d, f.x), f.y),
      mix(mix(e, g, f.x), mix(h, k, f.x), f.y),
      f.z
    );
  }

  /* Rotated between octaves so the lattice never lines its features up. */
  const mat3 OCTAVE_ROT = mat3(
     0.00,  0.80,  0.60,
    -0.80,  0.36, -0.48,
    -0.60, -0.48,  0.64
  );

  /**
   * Turbulent flame field, 0..1.
   *
   * Progressive domain warping folds the field over itself, and every octave
   * drifts upward faster than the last, so fine detail outruns the coarse
   * shapes it rides on and tears into upward-licking tongues. The ridge is the
   * two finest octaves alone, for shredding a fringe into strands.
   */
  float flameFbm(vec3 p, float rise, float warp, out float ridge) {
    float v = 0.0;
    float a = 0.5;
    float norm = 0.0;
    float scale = 1.0;
    ridge = 0.0;
    for (int i = 0; i < 4; i++) {
      float n = vnoise(p);
      v += a * n;
      norm += a;
      if (i >= 2) ridge = max(ridge, 1.0 - abs(n * 2.0 - 1.0));
      p = OCTAVE_ROT * p * 2.17 + (n - 0.5) * warp * vec3(1.7, 0.9, 1.3);
      scale *= 2.17;
      p.y -= rise * scale * (1.0 + 0.6 * float(i));
      a *= 0.55;
    }
    return v / max(norm, 1e-4);
  }

  /* Planckian radiator (Tanner Helland's fit), returned linear. */
  vec3 blackbody(float kelvin) {
    float t = clamp(kelvin, 1000.0, 12000.0) * 0.01;
    vec3 c;
    if (t <= 66.0) {
      c.r = 1.0;
      c.g = 0.3900816 * log(t) - 0.6318414;
      c.b = t <= 19.0 ? 0.0 : 0.5432068 * log(t - 10.0) - 1.1962540;
    } else {
      c.r = 1.2929362 * pow(t - 60.0, -0.1332047);
      c.g = 1.1298909 * pow(t - 60.0, -0.0755148);
      c.b = 1.0;
    }
    c = clamp(c, 0.0, 1.0);
    return c * c * (0.6 + 0.4 * c);
  }

  /**
   * Heat (0 fringe .. 1 core) to radiance. The radiator carries the dynamic
   * range — a white core many times brighter than the red gas beside it — and
   * the authored ramp is blended over it by uPalette.
   */
  vec3 fireColor(float heat) {
    heat = clamp(heat, 0.0, 1.0);
    float kelvin = mix(uTempEdge, uTempCore, heat);
    vec3 radiator = blackbody(kelvin) * pow(kelvin / max(uTempCore, 1.0), uEmissionCurve);
    vec3 artistic = gradient4(uColorCore, uColorMid, uColorEdge, uColorEmber, 1.0 - heat);
    return mix(radiator, artistic, clamp(uPalette, 0.0, 1.0));
  }
`;

const fireUniforms = () => ({
  uTempCore: { value: 3600 },
  uTempEdge: { value: 1500 },
  uEmissionCurve: { value: 2.4 },
  uPalette: { value: 0.3 },
  uColorCore: { value: new Color(1, 0.96, 0.82) },
  uColorMid: { value: new Color(1, 0.62, 0.14) },
  uColorEdge: { value: new Color(1, 0.22, 0.04) },
  uColorEmber: { value: new Color(0.25, 0.04, 0.01) }
});

/* ------------------------------------------------------------------ */
/* 1 · the bird                                                        */
/* ------------------------------------------------------------------ */

/**
 * The skinned vertex stage both bird materials share.
 *
 * Three's own skinning chunks: the renderer defines USE_SKINNING and binds the
 * bone texture for any material on a SkinnedMesh, so a raw ShaderMaterial
 * skins exactly as MeshStandardMaterial would. `uInflate` pushes the surface
 * out along its skinned normal — zero for the body, a few centimetres for the
 * aura shells that carry the fire off the silhouette.
 */
const BIRD_VERTEX = /* glsl */ `
  uniform float uInflate;

  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec2 vUv;

  #include <skinning_pars_vertex>

  void main() {
    vUv = uv;
    #include <beginnormal_vertex>
    #include <skinbase_vertex>
    #include <skinnormal_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>

    // uInflate is handed over in the mesh's own units, so the stand-off is
    // the same number of metres whatever the export was authored in.
    transformed += normalize(objectNormal) * uInflate;
    vec4 world = modelMatrix * vec4(transformed, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * objectNormal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

/** Shared by the body and the aura: the reveal, the cut-out, the burn-out. */
const BIRD_COMMON_GLSL = /* glsl */ `
  uniform sampler2D uMap;
  uniform sampler2D uEmissiveMap;
  uniform float uTime;
  uniform float uSeed;
  uniform float uFlameScale;
  uniform float uFlameRise;
  uniform float uLick;
  uniform float uFeatherBurn;
  uniform float uRevealY;
  uniform float uRevealWidth;
  uniform float uDissolve;
  uniform float uGlobalGlow;
  uniform vec3  uRevealColor;
  uniform float uRevealGlow;

  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec2 vUv;

  ${noiseGLSL}
  ${commonGLSL}
  ${FIRE_GLSL}

  /**
   * Everything a fragment of the bird has to decide before it is shaded.
   * Returns false when the fragment is gone — above the reveal plane, cut out
   * by the feather mask, or burnt away.
   */
  bool birdSurface(out vec4 base, out vec3 emis, out float fres, out float flame, out float ridge, out float edge) {
    base = texture2D(uMap, vUv);
    emis = texture2D(uEmissiveMap, vUv).rgb;

    vec3 N = normalize(vNormal);
    if (!gl_FrontFacing) N = -N;
    vec3 V = normalize(cameraPosition - vWorld);
    float facing = abs(dot(N, V));
    fres = 1.0 - facing;

    // The flames climb the body in world space, and are dragged upward harder
    // at the rim, so tongues lick off the silhouette instead of mottling it.
    vec3 p = vWorld * uFlameScale + vec3(uSeed, 0.0, uSeed * 0.5);
    p.y -= uTime * uFlameRise * uFlameScale;
    p.y -= fres * fres * uLick;
    flame = flameFbm(p, uTime * 0.12, 0.35, ridge);

    // The reveal: nothing under the plane, a molten line just above it.
    float above = vWorld.y - uRevealY;
    if (above < 0.0) return false;
    float revealEdge = 1.0 - smoothstep(0.0, max(uRevealWidth, 1e-3), above);

    // The plumage cut-out, gnawed at by the flames.
    float cut = 0.5 + uFeatherBurn * (flame - 0.5);
    if (base.a < cut) return false;

    // The burn-out: the body goes to embers from its coolest parts first.
    float dn = snoise01(vWorld * 2.6 + vec3(uSeed, uTime * 0.25, 0.0)) * 0.7 + flame * 0.3;
    vec2 dm = dissolveMask(dn, uDissolve * 1.15, 0.12);
    if (uDissolve > 0.0 && dm.x < 0.5) return false;

    edge = max(revealEdge, dm.y);
    return true;
  }
`;

const BODY_FRAGMENT = /* glsl */ `
  ${FIRE_UNIFORMS_GLSL}
  uniform float uBodyHeat;
  uniform float uRimPower;
  uniform float uRimStrength;
  uniform float uFlameStrength;
  uniform float uEmission;
  uniform float uPaintShow;

  ${BIRD_COMMON_GLSL}

  void main() {
    vec4 base; vec3 emis; float fres, flame, ridge, edge;
    if (!birdSurface(base, emis, fres, flame, ridge, edge)) discard;

    float rim = pow(fres, uRimPower);

    // Heat is read off three things: how bright the painted plumage is (the
    // export's own light and dark feathers become hot and cool ones), the
    // flames climbing the body, and the rim — the fresnel of fire.
    float lum = dot(base.rgb, vec3(0.299, 0.587, 0.114));
    float elum = max(emis.r, max(emis.g, emis.b));
    float heat = uBodyHeat * (0.35 + 0.65 * lum)
               + elum * 0.3
               + (flame - 0.5) * uFlameStrength
               + rim * uRimStrength * (0.55 + 0.7 * flame);

    vec3 col = fireColor(heat) * uEmission;
    // The painted plumage shows through where the body runs coolest.
    float cool = 1.0 - clamp(heat, 0.0, 1.0);
    col += base.rgb * cool * cool * uPaintShow;
    // The molten edges: the line it rises through, and the burn as it goes.
    col = mix(col, uRevealColor * uRevealGlow, edge);

    gl_FragColor = vec4(col * uGlobalGlow, 1.0);
  }
`;

const AURA_FRAGMENT = /* glsl */ `
  ${FIRE_UNIFORMS_GLSL}
  uniform float uRimPower;
  uniform float uAuraStrength;
  uniform float uAuraThreshold;
  uniform float uEmission;
  uniform float uOpacity;

  ${BIRD_COMMON_GLSL}

  void main() {
    vec4 base; vec3 emis; float fres, flame, ridge, edge;
    if (!birdSurface(base, emis, fres, flame, ridge, edge)) discard;

    float rim = pow(fres, uRimPower);
    // Tongues rather than a glow: the rim is carved by the flame field and the
    // ridged strands, so what leaves the silhouette is fire, not haze.
    float tongue = smoothstep(uAuraThreshold - 0.22, uAuraThreshold + 0.22, flame * 0.75 + ridge * 0.35);
    float a = rim * tongue * uAuraStrength + edge * 0.8;
    if (a < 0.003) discard;

    float heat = rim * 0.85 + (flame - 0.5) * 0.6 + edge;
    vec3 col = fireColor(heat) * uEmission * a;
    col = mix(col, uRevealColor * uRevealGlow * 0.5, edge);

    gl_FragColor = vec4(col * uGlobalGlow * uOpacity, a * uOpacity);
  }
`;

const birdUniforms = (map, emissiveMap) => ({
  uMap: { value: map },
  uEmissiveMap: { value: emissiveMap ?? map },
  uInflate: { value: 0 },
  uSeed: { value: Math.random() * 10 },
  uFlameScale: { value: 1.6 },
  uFlameRise: { value: 1.8 },
  uLick: { value: 1.2 },
  uFeatherBurn: { value: 0.35 },
  uRevealY: { value: -1e3 },
  uRevealWidth: { value: 0.18 },
  uDissolve: { value: 0 },
  uRevealColor: { value: new Color(1, 0.9, 0.6) },
  uRevealGlow: { value: 6 },
  uRimPower: { value: 2.4 },
  uEmission: { value: 2.2 }
});

/**
 * The body: opaque, so it sorts against every fire layer around it, and shaded
 * as a radiator whose temperature is the plumage, the flames and the rim.
 */
export function createPhoenixBodyMaterial(map, emissiveMap) {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      ...fireUniforms(),
      ...birdUniforms(map, emissiveMap),
      uBodyHeat: { value: 0.55 },
      uRimStrength: { value: 1.4 },
      uFlameStrength: { value: 0.6 },
      uPaintShow: { value: 0.3 }
    }),
    vertexShader: BIRD_VERTEX,
    fragmentShader: BODY_FRAGMENT,
    side: DoubleSide,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    toneMapped: false
  });
}

/**
 * A fire shell standing a few centimetres off the body, additive, carrying the
 * tongues that leave the silhouette. Two of these at different stand-offs give
 * the rim depth: a tight bright one and a looser, sparser one outside it.
 */
export function createPhoenixAuraMaterial(map, emissiveMap) {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      ...fireUniforms(),
      ...birdUniforms(map, emissiveMap),
      uAuraStrength: { value: 1.2 },
      uAuraThreshold: { value: 0.5 },
      uOpacity: { value: 1 }
    }),
    vertexShader: BIRD_VERTEX,
    fragmentShader: AURA_FRAGMENT,
    side: FrontSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    toneMapped: false
  });
}

/* ------------------------------------------------------------------ */
/* 2 · the serpentine fire trails                                      */
/* ------------------------------------------------------------------ */

/**
 * Two strips per serpent: a camera-facing ribbon carrying the flame, and a
 * flat pool of light on the floor under it. Both are the same instanced strip
 * with `aLayer` telling the vertex stage which one it is placing.
 */
export function createSerpentGeometry(segments = 160) {
  const verts = (segments + 1) * 2;
  const s = new Float32Array(verts);
  const v = new Float32Array(verts);
  const position = new Float32Array(verts * 3);
  for (let i = 0; i <= segments; i++) {
    for (let side = 0; side < 2; side++) {
      const k = i * 2 + side;
      s[k] = i / segments;
      v[k] = side;
    }
  }
  const index = new Uint16Array(segments * 6);
  for (let i = 0; i < segments; i++) {
    const a = i * 2;
    index.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
  }

  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('aS', new BufferAttribute(s, 1));
  geometry.setAttribute('aV', new BufferAttribute(v, 1));
  geometry.setIndex(new BufferAttribute(index, 1));

  const count = PHOENIX_MAX_SERPENTS * 2;
  const serpent = new Float32Array(count);
  const layer = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    serpent[i] = Math.floor(i / 2);
    layer[i] = i % 2;
  }
  geometry.setAttribute('aSerpent', new InstancedBufferAttribute(serpent, 1));
  geometry.setAttribute('aLayer', new InstancedBufferAttribute(layer, 1));
  geometry.instanceCount = count;
  geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
  return geometry;
}

const SERPENT_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform float uCount;
  uniform float uRadius;
  uniform float uWeave;
  uniform float uWaves;
  uniform float uHeight;
  uniform float uLift;
  uniform float uLength;
  uniform float uSpeed;
  uniform float uWidth;
  uniform float uFloorWidth;
  uniform float uReveal;
  uniform float uSpin;

  attribute float aS;
  attribute float aV;
  attribute float aSerpent;
  attribute float aLayer;

  varying vec2  vST;
  varying float vLayer;
  varying float vSeed;
  varying float vArc;
  varying vec3  vWorld;

  /* The path: a lap round the pyre, swung in and out by uWaves S-bends and
     rising and dipping out of step with them, so no two moments repeat. */
  vec3 pathAt(float theta, float seed, float t) {
    float bend = sin(theta * uWaves + seed * 2.39 + t * 0.55);
    float r = uRadius * (1.0 + uWeave * bend);
    float y = uLift + uHeight * (0.5 + 0.5 * sin(theta * uWaves * 1.5 + seed * 4.1 - t * 1.3));
    return vec3(cos(theta) * r, y, sin(theta) * r);
  }

  void main() {
    vLayer = aLayer;
    vSeed = aSerpent;
    float live = step(aSerpent + 0.5, uCount);

    // The heads share the lap, spaced evenly round it; the trail is what is
    // behind each one, grown out of the head as the field ignites.
    float head = uTime * uSpeed * TAU + aSerpent * (TAU / max(uCount, 1.0)) + uSpin;
    float length = uLength * TAU * uReveal;
    float theta = head - (1.0 - aS) * length;

    vec3 p = pathAt(theta, aSerpent, uTime);
    vec3 p2 = pathAt(theta + 0.012, aSerpent, uTime);
    vec3 tangent = normalize(mat3(modelMatrix) * (p2 - p));
    vec3 world = (modelMatrix * vec4(p, 1.0)).xyz;

    if (aLayer < 0.5) {
      // Camera-facing, and always the same way up, so the flames' "up" is up.
      vec3 toEye = normalize(cameraPosition - world);
      vec3 side = normalize(cross(tangent, toEye));
      if (side.y < 0.0) side = -side;
      float w = uWidth * (0.3 + 0.7 * smoothstep(1.0, 0.78, aS)) * smoothstep(0.0, 0.5, aS);
      world += side * (aV - 0.5) * w;
    } else {
      // The pool on the floor: flat, wider, welded to the ground.
      vec3 side = normalize(cross(tangent, vec3(0.0, 1.0, 0.0)));
      float w = uFloorWidth * smoothstep(0.0, 0.35, aS) * (0.55 + 0.45 * smoothstep(1.0, 0.85, aS));
      world += side * (aV - 0.5) * w;
      world.y = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).y + 0.035;
    }

    vWorld = world;
    vST = vec2(aS, aV);
    vArc = theta;
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
    if (live < 0.5 || uReveal <= 0.001) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  }
`;

const SERPENT_FRAGMENT = /* glsl */ `
  ${FIRE_UNIFORMS_GLSL}
  uniform float uTime;
  uniform float uRadius;
  uniform float uNoiseScale;
  uniform float uFlow;
  uniform float uRise;
  uniform float uShred;
  uniform float uHeadGlow;
  uniform float uIntensity;
  uniform float uFloorGlow;
  uniform float uOpacity;
  uniform float uFade;
  uniform float uGlobalGlow;

  varying vec2  vST;
  varying float vLayer;
  varying float vSeed;
  varying float vArc;
  varying vec3  vWorld;

  ${noiseGLSL}
  ${commonGLSL}
  ${FIRE_GLSL}

  void main() {
    float s = vST.x;                       // 0 tail → 1 head
    float across = abs(vST.y - 0.5) * 2.0; // 0 spine → 1 edge

    // The noise domain is the path itself, so the fire is carried by the
    // serpent rather than swum through; it streams back from the head.
    vec3 np = vec3(vArc * uRadius * 0.9 + uTime * uFlow, vST.y * 1.6 + vSeed * 3.7, vSeed * 11.0) * uNoiseScale;
    float ridge;
    float n = flameFbm(np, uTime * uRise, 0.3, ridge);
    float tail = 1.0 - s;

    float d;
    float heat;
    if (vLayer < 0.5) {
      // Solid along the spine, shredded at the edges, torn to strands by the
      // tail — and pointed at the head, where the serpent is all one hot core.
      float field = (1.0 - across * across) - 0.48
                  + (n - 0.5) * uShred * (0.5 + 0.9 * across)
                  - tail * 0.55 * (0.4 + 0.6 * ridge);
      d = smoothstep(0.0, 0.22, field);
      d *= smoothstep(0.0, 0.1, s);
      heat = (1.0 - across) * (0.28 + 0.42 * s)
           + (n - 0.5) * 0.35
           + uHeadGlow * smoothstep(0.75, 1.0, s) * (1.0 - across * across);
    } else {
      // The floor pool: soft, breathing with the flame above it.
      float bell = 1.0 - across * across;
      d = bell * bell * (0.35 + 0.65 * n) * smoothstep(0.0, 0.3, s) * uFloorGlow;
      heat = 0.25 + 0.35 * bell * s + (n - 0.5) * 0.2;
    }

    vec3 col = fireColor(heat) * uIntensity * d;
    gl_FragColor = vec4(col * uGlobalGlow * uFade * uOpacity, d * uOpacity * uFade);
  }
`;

export function createSerpentMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      ...fireUniforms(),
      uCount: { value: 3 },
      uRadius: { value: 3.5 },
      uWeave: { value: 0.35 },
      uWaves: { value: 3 },
      uHeight: { value: 0.35 },
      uLift: { value: 0.3 },
      uLength: { value: 0.42 },
      uSpeed: { value: 0.28 },
      uWidth: { value: 0.55 },
      uFloorWidth: { value: 1.2 },
      uReveal: { value: 0 },
      uSpin: { value: 0 },
      uNoiseScale: { value: 1.4 },
      uFlow: { value: 1.2 },
      uRise: { value: 0.9 },
      uShred: { value: 1.1 },
      uHeadGlow: { value: 1.6 },
      uIntensity: { value: 2.2 },
      uFloorGlow: { value: 0.5 },
      uOpacity: { value: 1 },
      uFade: { value: 1 }
    }),
    vertexShader: SERPENT_VERTEX,
    fragmentShader: SERPENT_FRAGMENT,
    side: DoubleSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    toneMapped: false
  });
}

/* ------------------------------------------------------------------ */
/* 3 · the wispy flame waves                                           */
/* ------------------------------------------------------------------ */

export function createSkirtGeometry() {
  // Unit cylinder, open at both ends; the vertex stage sizes it.
  const geometry = new CylinderGeometry(1, 1, 1, 96, 12, true);
  geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
  return geometry;
}

const SKIRT_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform float uRadius;
  uniform float uHeight;
  uniform float uFlare;
  uniform float uBreathe;
  uniform float uReveal;

  varying vec3  vWorld;
  varying vec3  vNormal;
  varying float vY;
  varying float vTheta;

  void main() {
    float y = position.y + 0.5;
    vY = y;
    vTheta = atan(position.z, position.x);

    // The sheet breathes and its top flares out and leans with the rising gas.
    float breathe = 1.0 + uBreathe * (sin(uTime * 2.1 + vTheta * 3.0) * 0.6 + sin(uTime * 3.7 - vTheta * 5.0) * 0.4);
    float flare = 1.0 + uFlare * y * y;
    float r = uRadius * breathe * flare * uReveal;
    vec3 p = vec3(position.x * r, y * uHeight * uReveal, position.z * r);

    vec4 world = modelMatrix * vec4(p, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * vec3(position.x, 0.0, position.z));
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const SKIRT_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586

  ${FIRE_UNIFORMS_GLSL}
  uniform float uTime;
  uniform float uSeed;
  uniform float uNoiseScale;
  uniform float uRise;
  uniform float uShred;
  uniform float uWisp;
  uniform float uWaveSpeed;
  uniform float uWaveDepth;
  uniform float uHeat;
  uniform float uIntensity;
  uniform float uOpacity;
  uniform float uFade;
  uniform float uGlobalGlow;

  varying vec3  vWorld;
  varying vec3  vNormal;
  varying float vY;
  varying float vTheta;

  ${noiseGLSL}
  ${commonGLSL}
  ${FIRE_GLSL}

  void main() {
    float y = vY;

    // World-space noise, so there is no seam where the cylinder closes.
    vec3 np = vWorld * uNoiseScale + vec3(uSeed, 0.0, uSeed);
    np.y -= uTime * uRise * uNoiseScale;
    float ridge;
    float n = flameFbm(np, uTime * 0.3, 0.35, ridge);

    // Solid at the foot, torn into tongues by the top, with ridged wisps
    // taking over the last of it.
    float field = (1.0 - y) * 0.95 - 0.42
                + (n - 0.5) * uShred * (0.7 + y)
                + (ridge - 0.5) * uWisp * (0.3 + y);
    float d = smoothstep(0.0, 0.18, field) * smoothstep(0.0, 0.08, y);

    // Waves rolling up the sheet and round it.
    float wave = 1.0 - uWaveDepth + uWaveDepth * (0.5 + 0.5 * sin(y * 5.0 - uTime * uWaveSpeed * TAU + vTheta * 2.0));
    d *= wave;

    // A surface standing in for a volume: soften it where it turns edge-on,
    // or the cylinder's silhouette draws as a hard vertical line.
    vec3 V = normalize(cameraPosition - vWorld);
    float facing = abs(dot(normalize(vNormal), V));
    d *= mix(0.45, 1.0, facing);
    if (d < 0.003) discard;

    float heat = ((1.0 - y) * 0.6 + (n - 0.5) * 0.6 + 0.18) * uHeat;
    vec3 col = fireColor(heat) * uIntensity * d;
    gl_FragColor = vec4(col * uGlobalGlow * uFade * uOpacity, d * uOpacity * uFade);
  }
`;

export function createSkirtMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      ...fireUniforms(),
      uSeed: { value: Math.random() * 10 },
      uRadius: { value: 2.8 },
      uHeight: { value: 1.6 },
      uFlare: { value: 0.25 },
      uBreathe: { value: 0.07 },
      uReveal: { value: 0 },
      uNoiseScale: { value: 0.9 },
      uRise: { value: 1.4 },
      uShred: { value: 1.2 },
      uWisp: { value: 0.6 },
      uWaveSpeed: { value: 0.9 },
      uWaveDepth: { value: 0.3 },
      uHeat: { value: 1 },
      uIntensity: { value: 1.6 },
      uOpacity: { value: 0.9 },
      uFade: { value: 1 }
    }),
    vertexShader: SKIRT_VERTEX,
    fragmentShader: SKIRT_FRAGMENT,
    side: DoubleSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    toneMapped: false
  });
}

/* ------------------------------------------------------------------ */
/* 4 + 7 · the ground: scorch, cracked crust, sub-surface glow         */
/* ------------------------------------------------------------------ */

const GROUND_VERTEX = /* glsl */ `
  uniform float uSize;
  varying vec2 vLocal;
  void main() {
    // A flat-rotated quad has no y of its own to read: the plane frame is uv.
    vLocal = (uv - 0.5) * uSize;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const GROUND_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uRadius;
  uniform float uSpread;
  uniform float uFade;
  uniform float uScorch;
  uniform float uCrackScale;
  uniform float uCrackWidth;
  uniform float uCrackGlow;
  uniform float uCrackReach;
  uniform float uPulse;
  uniform float uPulseSpeed;
  uniform float uGlowRadius;
  uniform float uGlowIntensity;
  uniform float uEmberGlow;
  uniform float uFlash;
  uniform float uGlobalGlow;
  uniform vec3  uColorGlow;
  uniform vec3  uColorCrack;
  uniform vec3  uColorScorch;

  varying vec2 vLocal;

  ${noiseGLSL}

  /* Voronoi with the second-nearest cell kept: the plates are the cells and
     the cracks between them are where F2 - F1 goes to zero. */
  vec3 plates(vec2 p) {
    vec2 n = floor(p);
    vec2 f = fract(p);
    float f1 = 8.0;
    float f2 = 8.0;
    float id = 0.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(float(i), float(j));
        vec2 o = hash21(dot(n + g, vec2(7.13, 113.17)));
        vec2 r = g + o - f;
        float d = dot(r, r);
        if (d < f1) { f2 = f1; f1 = d; id = hash11(dot(n + g, vec2(31.7, 57.1))); }
        else if (d < f2) { f2 = d; }
      }
    }
    return vec3(sqrt(f2) - sqrt(f1), id, sqrt(f1));
  }

  void main() {
    float dist = length(vLocal);
    float R = max(uRadius * uSpread, 0.01);

    // The burn: a ragged disc, darkest at the middle.
    float mottle = snoise01(vec3(vLocal * 0.7, uSeed));
    float inside = 1.0 - smoothstep(R * (0.5 + 0.3 * mottle), R * (0.85 + 0.25 * mottle), dist);
    float grain = 0.55 + 0.45 * snoise01(vec3(vLocal * 3.1, uSeed + 3.0));
    float scorch = inside * uScorch * grain;

    // The crust, split into plates by heat from below. The lattice is warped
    // so the plates are shards, not hexagons, and the cracks are widest at
    // the centre where the stone has taken the most.
    vec2 cp = vLocal * uCrackScale + vec2(uSeed * 10.0, uSeed * 7.0);
    cp += (snoise01(vec3(vLocal * 1.5, uSeed + 9.0)) - 0.5) * 0.7;
    vec3 vor = plates(cp);
    float reach = 1.0 - smoothstep(R * uCrackReach * 0.5, R * uCrackReach, dist);
    float width = uCrackWidth * (0.5 + 0.8 * reach);
    float crack = (1.0 - smoothstep(0.0, width, vor.x)) * reach * inside;
    // Heat rolling out from the centre along the cracks.
    float pulse = 1.0 - uPulse + uPulse * (0.5 + 0.5 * sin(uTime * uPulseSpeed - dist * 1.7 + vor.y * 4.0));
    crack *= pulse;

    // Lit from underneath: a broad glow the whole field sits on, breathing.
    float breath = 1.0 - uPulse * 0.35 + uPulse * 0.35 * sin(uTime * uPulseSpeed * 0.7 + 1.0);
    float glowR = max(uGlowRadius * uSpread, 0.01);
    float glow = exp(-dist * dist / (glowR * glowR * 0.45)) * uGlowIntensity * breath;
    // Embers cooling in the crust.
    float specks = snoise01(vec3(vLocal * 11.0, uSeed + uTime * 0.15));
    float ember = smoothstep(0.84, 0.95, specks) * inside * uEmberGlow
                * (0.6 + 0.4 * sin(uTime * 6.0 + specks * 60.0));

    // The cracks are what the eye reads; the glow is what the crust sits on.
    vec3 col = uColorGlow * glow * (0.35 + 0.65 * (1.0 - scorch))
             + uColorCrack * crack * uCrackGlow * (0.7 + 0.5 * glow)
             + uColorCrack * ember
             + uColorScorch * scorch
             + uColorGlow * uFlash * inside;
    col *= uFade * uGlobalGlow;

    // Premultiplied over: the colour adds, the alpha darkens the stone.
    float alpha = clamp(scorch * uFade + glow * 0.1 * uFade, 0.0, 1.0);
    if (alpha < 0.002 && max(col.r, max(col.g, col.b)) < 0.002) discard;
    gl_FragColor = vec4(col, alpha);
  }
`;

export function createPhoenixGroundMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uSize: { value: 12 },
      uSeed: { value: Math.random() * 10 },
      uRadius: { value: 5 },
      uSpread: { value: 0 },
      uFade: { value: 1 },
      uScorch: { value: 0.85 },
      uCrackScale: { value: 1.4 },
      uCrackWidth: { value: 0.08 },
      uCrackGlow: { value: 2.4 },
      uCrackReach: { value: 0.75 },
      uPulse: { value: 0.35 },
      uPulseSpeed: { value: 1.6 },
      uGlowRadius: { value: 5.5 },
      uGlowIntensity: { value: 1.4 },
      uEmberGlow: { value: 1.2 },
      uFlash: { value: 0 },
      uColorGlow: { value: new Color(1, 0.36, 0.06) },
      uColorCrack: { value: new Color(1, 0.55, 0.12) },
      uColorScorch: { value: new Color(0.02, 0.01, 0.005) }
    }),
    vertexShader: GROUND_VERTEX,
    fragmentShader: GROUND_FRAGMENT,
    side: DoubleSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneMinusSrcAlphaFactor,
    toneMapped: false
  });
}

/* ------------------------------------------------------------------ */
/* 5 · the heat distortion field                                       */
/* ------------------------------------------------------------------ */

const HEAT_VERTEX = /* glsl */ `
  uniform float uWidth;
  uniform float uHeight;

  varying vec2 vUv;
  varying vec2 vLocal;

  void main() {
    vUv = uv;
    // Camera-facing, standing on the field's centre: the corners are laid out
    // in view space, the noise stays in the field's own frame.
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vLocal = vec2((uv.x - 0.5) * uWidth, uv.y * uHeight);
    mv.xy += vLocal;
    gl_Position = projectionMatrix * mv;
  }
`;

const HEAT_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uStrength;
  uniform float uScale;
  uniform float uSpeed;
  uniform float uSeed;
  uniform float uFade;
  uniform float uShaderIntensity;

  varying vec2 vUv;
  varying vec2 vLocal;

  ${noiseGLSL}

  void main() {
    // Hot air climbs: the field scrolls up and is stretched vertically so the
    // structures are columns rather than blobs.
    vec3 np = vec3(vLocal.x * uScale, vLocal.y * uScale * 0.45 - uTime * uSpeed, uSeed);
    float nx = snoise(np);
    float ny = snoise(np + vec3(19.3, 7.7, 31.1));

    vec2 c = vec2((vUv.x - 0.5) * 2.0, vUv.y);
    // Strongest low over the pyre, thinning with height, feathered at the
    // sides so the warp never shows a border.
    float mask = (1.0 - smoothstep(0.35, 1.0, abs(c.x)))
               * (1.0 - smoothstep(0.25, 1.0, c.y))
               * smoothstep(0.0, 0.08, c.y);
    float strength = uStrength * uShaderIntensity * mask * uFade;
    if (strength < 0.002) discard;

    gl_FragColor = vec4(vec2(nx, ny) * 0.5 + 0.5, strength, mask * uFade);
  }
`;

export function createHeatFieldMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uWidth: { value: 10 },
      uHeight: { value: 5 },
      uStrength: { value: 0.8 },
      uScale: { value: 0.7 },
      uSpeed: { value: 1.2 },
      uSeed: { value: Math.random() * 10 },
      uFade: { value: 1 }
    }),
    vertexShader: HEAT_VERTEX,
    fragmentShader: HEAT_FRAGMENT,
    side: DoubleSide,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: NormalBlending,
    toneMapped: false
  });
}

/* ------------------------------------------------------------------ */
/* 7 · the fireballs                                                   */
/* ------------------------------------------------------------------ */

/**
 * One quad per fireball, instanced. The CPU writes position, velocity and a
 * few scalars per round each frame; the vertex stage lays the quad out along
 * the round's screen-projected heading so the tail trails behind it.
 */
export function createFireballGeometry(max = PHOENIX_MAX_FIREBALLS) {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3)
  );
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

  const pos = new InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(DynamicDrawUsage);
  const vel = new InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(DynamicDrawUsage);
  // x size, y tail, z age (negative = dead), w seed
  const data = new InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(DynamicDrawUsage);
  for (let i = 0; i < max; i++) {
    data.setW(i, Math.random());
    data.setZ(i, -1);
  }

  geometry.setAttribute('aPos', pos);
  geometry.setAttribute('aVel', vel);
  geometry.setAttribute('aData', data);
  geometry.instanceCount = max;
  geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
  return geometry;
}

const FIREBALL_VERTEX = /* glsl */ `
  attribute vec3 aPos;
  attribute vec3 aVel;
  attribute vec4 aData;

  varying vec2  vLocal;
  varying float vSize;
  varying float vTail;
  varying float vAge;
  varying float vSeed;
  varying float vViewZ;
  varying vec4  vClip;

  void main() {
    vSize = aData.x;
    vTail = aData.y;
    vAge = aData.z;
    vSeed = aData.w;
    if (aData.z < 0.0) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      return;
    }

    vec3 vp = (viewMatrix * vec4(aPos, 1.0)).xyz;
    vec3 vv = mat3(viewMatrix) * aVel;
    float speed = length(vv);
    vec2 dir2 = vv.xy;
    float onScreen = length(dir2);
    dir2 = onScreen > 1e-4 ? dir2 / onScreen : vec2(0.0, 1.0);
    vec2 side2 = vec2(-dir2.y, dir2.x);

    // The tail foreshortens as the round flies toward or away from the eye.
    float fore = speed > 1e-4 ? onScreen / speed : 1.0;
    float back = vTail * mix(0.3, 1.0, fore);
    float front = vSize * 1.3;
    float halfW = vSize * 1.3;

    float along = mix(-back, front, uv.y);
    float across = (uv.x - 0.5) * 2.0 * halfW;
    vLocal = vec2(across, along);
    vp.xy += dir2 * along + side2 * across;

    vViewZ = vp.z;
    vClip = projectionMatrix * vec4(vp, 1.0);
    gl_Position = vClip;
  }
`;

const FIREBALL_FRAGMENT = /* glsl */ `
  ${FIRE_UNIFORMS_GLSL}
  uniform float uTime;
  uniform float uIntensity;
  uniform float uShred;
  uniform float uNoiseScale;
  uniform float uFlow;
  uniform float uHalo;
  uniform float uOpacity;
  uniform float uGlobalGlow;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  varying vec2  vLocal;
  varying float vSize;
  varying float vTail;
  varying float vAge;
  varying float vSeed;
  varying float vViewZ;
  varying vec4  vClip;

  ${noiseGLSL}
  ${commonGLSL}
  ${FIRE_GLSL}

  void main() {
    float r = max(vSize, 1e-3);
    float along = vLocal.y;   // + toward the nose
    float across = vLocal.x;

    // A comet: a round head, and a tail that tapers off behind it and is
    // torn into tongues by noise streaming back down it.
    float tailNess = clamp(-along / max(vTail, 1e-3), 0.0, 1.0);
    float tailR = r * pow(1.0 - tailNess, 0.55) * 1.05;
    float sd = along >= 0.0
             ? length(vLocal) - r
             : abs(across) - tailR;
    float q = -sd / r;                         // 1 on the axis, 0 at the surface, negative outside

    vec3 np = vec3(across * 2.2, along * 1.1 + uTime * uFlow, vSeed * 17.0 + vAge * 0.35) * uNoiseScale / r;
    float ridge;
    float n = flameFbm(np, uTime * 0.6, 0.35, ridge);
    // Whole at the head, shredded in the tail.
    float shred = uShred * mix(0.3, 1.3, tailNess);
    float field = q + 0.12 + (n - 0.5) * shred - (ridge - 0.5) * 0.35 * tailNess;
    float d = smoothstep(0.0, 0.4, field);

    // A soft halo round the head, for the light it throws.
    float halo = exp(-max(length(vLocal) - r * 0.3, 0.0) * 2.2 / r) * uHalo;

    // Hottest on the axis at the head; the tail cools as it thins.
    float heat = clamp(q * 0.6 + 0.45, 0.0, 1.0) * (1.0 - tailNess * 0.75)
               + smoothstep(0.0, 1.0, q) * (1.0 - tailNess) * 0.3
               + (n - 0.5) * 0.25;

    float soft = softFade(uSceneDepth, screenUVFromClip(vClip), vViewZ, uCameraNear, uCameraFar, r * 0.8);
    float a = (d + halo * 0.4) * soft;
    if (a < 0.003) discard;

    vec3 col = (fireColor(heat) * d + uColorMid * halo * 0.5) * uIntensity * soft;
    gl_FragColor = vec4(col * uGlobalGlow * uOpacity, a * uOpacity);
  }
`;

export function createFireballMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      ...fireUniforms(),
      uIntensity: { value: 2.6 },
      uShred: { value: 1.0 },
      uNoiseScale: { value: 2.0 },
      uFlow: { value: 6 },
      uHalo: { value: 0.8 },
      uOpacity: { value: 1 }
    }),
    vertexShader: FIREBALL_VERTEX,
    fragmentShader: FIREBALL_FRAGMENT,
    side: DoubleSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    toneMapped: false
  });
}
