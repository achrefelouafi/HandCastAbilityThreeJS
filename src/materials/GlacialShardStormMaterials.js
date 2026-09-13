import {
  AddEquation,
  AdditiveBlending,
  BackSide,
  Color,
  CustomBlending,
  DoubleSide,
  FrontSide,
  NormalBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { frame, sharedUniforms } from '../core/FrameUniforms.js';
import { GLACIAL_SPINE_GLSL } from './GlacialSpine.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate } from '../utils/math.js';

/**
 * GLACIAL SHARD STORM — the five layers of the breakdown, one material each.
 *
 * The sheet names five things and this file draws five things:
 *
 *  1. **the subsurface ice mesh** — one crystal, drawn twice. Its *back faces*
 *     first: the facets you see through a translucent gem are the inside of
 *     its far wall, flat-shaded from the inside with the deep glacial blue,
 *     their edges the internal facet lines of the reference. Then its *front
 *     faces* over them, translucent: an ice fresnel with the stage probe in
 *     it, one tight sun highlight, light scattered through the thin nose
 *     toward the eye, fracture planes a little way inside seen through the
 *     surface at a refracted parallax, and a frost lattice etched over the
 *     rear facets. It is a solid, it writes depth, and it is the nose of the
 *     shot.
 *  2. **the fluid frost vapour** — two draws. *Streaks*: soft sprites laid
 *     down where the crystal passed, advected by curl noise so they coil,
 *     each one stretched along its own motion so the ones still sheathing the
 *     crystal are drawn out into streamers and the ones left behind bloom
 *     into puffs. They are *lit*: two samples of the same noise a little way
 *     apart give a light side and a shadow side to every puff, which is what
 *     separates vapour from a fog card. *Silks*: a few broad strips wound
 *     loosely about the wake and eroded into long streamers.
 *  3. **the ordered frost lattice** — snowflakes. A six-fold dendrite signed
 *     distance field drawn on sprites tumbling in the wake, no two alike:
 *     the arm width, the count and reach of the side branches, the hexagonal
 *     plate and the ring are all rolled per flake.
 *  4. **the glinting ice shards** — bipyramid splinters struck off the
 *     crystal and left tumbling in the wake, flat-shaded ice with the light
 *     coming through their tips, and a four-rayed glint pinned to each one
 *     that flashes as its facets turn through the key.
 *  5. **the refractive distortion** — nothing drawn. A proxy on the
 *     distortion layer that lenses the frame through the crystal like a ball
 *     of glass, throws a bow wave ahead of its nose, sheds rings behind it,
 *     and fires one big ring on the strike.
 *
 * Every placement here is a pure function of the instance index, the clock,
 * how far the head has flown and `settings.glacial`. There is no particle
 * system, no history buffer and nothing written per frame beyond uniforms,
 * which is what lets every slider in the editor re-fly a cast that is
 * already in the air, paused included.
 */

/* ------------------------------------------------------------------ */
/* shared                                                              */
/* ------------------------------------------------------------------ */

/** Rodrigues, as a matrix. */
const ROTATION_GLSL = /* glsl */ `
#ifndef GLACIAL_ROTATION_INCLUDED
#define GLACIAL_ROTATION_INCLUDED
mat3 rotationAbout(vec3 axis, float angle) {
  float s = sin(angle);
  float c = cos(angle);
  float t = 1.0 - c;
  return mat3(
    t * axis.x * axis.x + c,          t * axis.x * axis.y + s * axis.z, t * axis.x * axis.z - s * axis.y,
    t * axis.x * axis.y - s * axis.z, t * axis.y * axis.y + c,          t * axis.y * axis.z + s * axis.x,
    t * axis.x * axis.z + s * axis.y, t * axis.y * axis.z - s * axis.x, t * axis.z * axis.z + c
  );
}
#endif
`;

/**
 * How ice is lit. Included by the crystal and the shards.
 *
 * Declares its own uniforms; a material that includes it must carry them
 * (`iceUniforms()`), and `syncIceLook` writes them from the shared block of
 * the settings. Needs the builtin viewMatrix.
 */
const ICE_GLSL = /* glsl */ `
#ifndef GLACIAL_ICE_INCLUDED
#define GLACIAL_ICE_INCLUDED
uniform vec3  uColorDeep;    // the glacial blue seen into the thick of it
uniform vec3  uColorIce;     // the body
uniform vec3  uColorFrost;   // white where the air is trapped, and the edges
uniform vec3  uColorGlow;    // the cold light inside
uniform sampler2D uEnvMap;
uniform float uEnvStrength;
uniform vec3  uSunColor;
uniform float uSunSpec;
uniform float uGloss;
uniform float uScreenKey;    // how far the key swings from the sun to the camera
uniform float uRim;
uniform float uRimPower;
uniform float uDispersion;   // the rim splits cyan against violet
uniform float uEdge;         // the hairline along every facet boundary
uniform float uEdgeWidth;    // ... in pixels
uniform vec3  uLightDir;     // shared: toward the sun

vec2 glacialEquirect(vec3 d) {
  float u = atan(d.z, d.x) * 0.15915494309 + 0.5;
  float v = asin(clamp(d.y, -1.0, 1.0)) * 0.31830988618 + 0.5;
  return vec2(u, v);
}

/* The stage probe, seen in the ice. */
vec3 glacialEnv(vec3 dir) {
  return texture2D(uEnvMap, glacialEquirect(dir)).rgb * uEnvStrength;
}

/*
 * The key, swung toward the camera. A crystal lit only by the overhead sun
 * lands its visible facets on one value and reads as a cut-out; a key that
 * sits upper-left of the view guarantees a lit face and a shadow face on
 * every facet from every angle.
 */
vec3 glacialKey(vec3 V) {
  vec3 camRight = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
  vec3 camUp = normalize(vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]));
  vec3 screenKey = normalize(-camRight * 0.55 + camUp * 0.72 + V * 0.4);
  return normalize(mix(normalize(uLightDir), screenKey, clamp(uScreenKey, 0.0, 1.0)));
}

/* Ice has an index of 1.31: almost nothing head-on, everything at a graze. */
float glacialFresnel(float NdotV, float power) {
  return 0.02 + 0.98 * pow(1.0 - NdotV, max(power, 0.05));
}

/* One exponent per channel: grazing facets go cyan on one flank, violet on the other. */
vec3 glacialRim(float NdotV) {
  float f = 1.0 - NdotV;
  return vec3(
    pow(f, max(uRimPower * (1.0 + uDispersion * 0.45), 0.05)),
    pow(f, max(uRimPower, 0.05)),
    pow(f, max(uRimPower * (1.0 - uDispersion * 0.35), 0.05))
  ) * uRim;
}

/* One tight sun highlight. */
vec3 glacialSpecular(vec3 N, vec3 V, vec3 L) {
  vec3 H = normalize(L + V);
  return uSunColor * pow(max(dot(N, H), 0.0), max(uGloss, 1.0)) * uSunSpec;
}

/* Constant width in pixels, whatever the distance. This is why it cannot be a texture. */
float glacialEdge(vec3 bary) {
  float e = min(min(bary.x, bary.y), bary.z);
  float w = fwidth(e) * max(uEdgeWidth, 0.1);
  return 1.0 - smoothstep(0.0, w, e);
}
#endif
`;

function iceUniforms() {
  return {
    uColorDeep: { value: new Color(0.06, 0.24, 0.43) },
    uColorIce: { value: new Color(0.37, 0.69, 0.91) },
    uColorFrost: { value: new Color(0.93, 0.97, 1.0) },
    uColorGlow: { value: new Color(0.66, 0.93, 1.0) },
    uEnvMap: frame.uEnvMap,
    uEnvStrength: { value: 1 },
    uSunColor: { value: new Color(1, 0.95, 0.9) },
    uSunSpec: { value: 1 },
    uGloss: { value: 90 },
    uScreenKey: { value: 0.75 },
    uRim: { value: 0.6 },
    uRimPower: { value: 3 },
    uDispersion: { value: 0.6 },
    uEdge: { value: 0.6 },
    uEdgeWidth: { value: 1.1 }
  };
}

function syncIceLook(u) {
  const c = settings.glacial;
  const g = settings.global;
  const env = settings.environment;
  u.uColorDeep.value.copy(getColor(c.colorDeep));
  u.uColorIce.value.copy(getColor(c.colorIce));
  u.uColorFrost.value.copy(getColor(c.colorFrost));
  u.uColorGlow.value.copy(getColor(c.colorGlow));
  u.uEnvStrength.value = c.iceEnv * env.envIntensity;
  u.uSunColor.value.copy(getColor(env.sunColor));
  u.uSunSpec.value = c.iceSunSpec * saturate(env.sunIntensity / 3);
  u.uGloss.value = c.iceGloss;
  u.uScreenKey.value = c.iceScreenKey;
  u.uRim.value = c.iceRim * g.fresnel;
  u.uRimPower.value = c.iceRimPower;
  u.uDispersion.value = c.iceDispersion;
  u.uEdge.value = c.iceEdge;
  u.uEdgeWidth.value = c.iceEdgeWidth;
}

/**
 * A snowflake, as a signed distance. Included by the lattice sprites and by
 * the crystal, which etches the same lattice over its rear facets.
 *
 * Six-fold: the plane is folded into one thirtieth of a turn and one arm is
 * drawn there - a tapering spar, side branches leaving it parallel to the
 * neighbouring arms, a hexagonal plate at the centre and, on some, a ring.
 * The fold mirrors all of it round the flake. p is in flake radii; every
 * proportion is rolled off the seed so no two flakes are the same.
 */
const LATTICE_GLSL = /* glsl */ `
#ifndef GLACIAL_LATTICE_INCLUDED
#define GLACIAL_LATTICE_INCLUDED
float snowflakeSDF(vec2 p, float seed) {
  float r1 = hash11(seed + 1.3);
  float r2 = hash11(seed + 2.7);
  float r3 = hash11(seed + 4.1);
  float r4 = hash11(seed + 5.9);

  const float SECTOR = 1.0471975511965976;   // a sixth of a turn
  float a = atan(p.y, p.x);
  float rr = length(p);
  a = abs(mod(a + SECTOR * 0.5, SECTOR) - SECTOR * 0.5);
  vec2 q = vec2(cos(a), sin(a)) * rr;

  // The spar: tapering to its tip.
  float armW = 0.035 + 0.03 * r1;
  float d = max(abs(q.y) - armW * (1.0 - 0.45 * q.x), q.x - 1.0);

  // Side branches, each leaving the spar at sixty degrees.
  float branches = 2.0 + floor(r2 * 3.0);
  for (int i = 0; i < 4; i++) {
    if (float(i) >= branches) break;
    float t = 0.22 + (float(i) + 0.5 * r3) / branches * 0.66;
    float len = (0.46 - 0.07 * float(i)) * (0.7 + 0.5 * r4) * (1.0 - t * 0.45);
    vec2 b = q - vec2(t, 0.0);
    vec2 br = vec2(b.x * 0.5 + b.y * 0.8660254, -b.x * 0.8660254 + b.y * 0.5);
    float bw = armW * 0.7 * (1.0 - br.x / max(len, 0.01) * 0.6);
    float bd = max(abs(br.y) - bw, max(-br.x, br.x - len));
    d = min(d, bd);
  }

  // The plate: a hexagon with its points on the arms.
  float coreR = 0.1 + 0.16 * r3;
  float hd = dot(q, vec2(0.8660254, 0.5)) - coreR * 0.8660254;
  d = min(d, hd);

  // And on some, a ring.
  if (r4 > 0.45) {
    float ringR = 0.42 + 0.22 * r1;
    float ringW = 0.018 + 0.012 * r2;
    float hr = abs(dot(q, vec2(0.8660254, 0.5)) - ringR * 0.8660254) - ringW;
    d = min(d, hr);
  }
  return d;
}
#endif
`;

/**
 * Premultiplied-over. The vapour layers output rgb already multiplied by
 * alpha, so a pale body covers what is behind it while a glow with no alpha
 * simply adds - one blend mode that both veils and lights.
 */
const PREMULTIPLIED = {
  blending: CustomBlending,
  blendEquation: AddEquation,
  blendSrc: OneFactor,
  blendDst: OneMinusSrcAlphaFactor,
  blendSrcAlpha: OneFactor,
  blendDstAlpha: OneMinusSrcAlphaFactor
};

/* ------------------------------------------------------------------ */
/* 1 · the subsurface ice mesh                                         */
/* ------------------------------------------------------------------ */

const CORE_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  attribute vec3  aBary;
  attribute float aAxis;
  attribute float aFace;
  attribute vec3  aPivot;

  uniform float uTime;
  uniform float uLength;       // metres, nose to rear
  uniform float uRadius;       // girdle radius, metres
  uniform float uLead;         // metres the nose runs ahead of the front
  uniform float uRoll;         // turns/second it rolls about its own axis
  uniform float uWobble;       // radians the nose wanders off the tangent
  uniform float uWobbleSpeed;
  uniform float uBurst;        // 0..1 through the strike
  uniform float uBurstTime;    // seconds since it
  uniform float uBurstSpeed;   // metres/second the facets fly at
  uniform float uBurstSpin;    // turns/second they tumble
  uniform float uBurstDrag;
  uniform float uBurstGravity;
  uniform float uGrow;         // 0..1 - drawn out of the hand

  varying vec3  vBary;
  varying vec3  vNormal;
  varying vec3  vWorld;
  varying vec3  vLocal;        // the vertex on the unit crystal
  varying vec3  vLocalNormal;
  varying vec3  vFrameT;       // the crystal's axes, in world space
  varying vec3  vFrameS;
  varying vec3  vFrameU;
  varying float vAxis;         // 0 at the nose, 1 at the rear
  varying float vViewZ;

  ${noiseGLSL}
  ${GLACIAL_SPINE_GLSL}
  ${ROTATION_GLSL}

  void main() {
    float s = uFront + uLead;
    vec3 tangent, side, up;
    glacialFrame(s, tangent, side, up);
    vec3 nose = glacialSpine(s);

    /* ---- the crystal's own frame: nose forward, rolling, nodding ---- */
    // Local x runs nose to rear, so the body's axis is minus the tangent.
    vec3 T = -tangent;
    float wobA = uWobble * sin(uTime * uWobbleSpeed + uSeed);
    float wobB = uWobble * 0.7 * sin(uTime * uWobbleSpeed * 0.73 + uSeed * 1.7 + 2.0);
    mat3 nod = rotationAbout(side, wobB) * rotationAbout(up, wobA);
    T = nod * T;
    vec3 S = nod * side;
    vec3 U = nod * up;
    // Rolling about its own axis, slowly: the facets turn through the key.
    mat3 roll = rotationAbout(T, uTime * uRoll * TAU + uSeed);
    S = roll * S;
    U = roll * U;
    mat3 frame = mat3(T, S, U);
    vec3 scale = vec3(uLength, uRadius, uRadius) * uGrow;

    /* ---- the strike: taken apart facet by facet ---- */
    vec3 pl = position;
    vec3 nl = normal;
    vec3 fly = vec3(0.0);
    if (uBurst > 0.0) {
      float fb = aFace * 2.31 + uSeed;
      float f1 = hash11(fb + 1.7);
      vec3  f3 = hash31(fb + 3.9);
      vec3 spinAxis = normalize(f3 * 2.0 - 1.0 + vec3(1e-4));
      mat3 rot = rotationAbout(spinAxis, uBurstSpin * uBurstTime * TAU * (0.4 + f1));
      // Gone by scale, never by alpha: the depth buffer stays honest while
      // the pieces cross each other.
      float shrink = 1.0 - smoothstep(0.3, 1.0, uBurst);
      pl = aPivot + rot * ((position - aPivot) * shrink);
      nl = rot * normal;
      vec3 dirL = normalize(normal + (aPivot - vec3(0.5, 0.0, 0.0)) * 0.9 + (f3 - 0.5) * 0.7);
      float drag = max(uBurstDrag, 0.01);
      float travel = uBurstSpeed * (0.4 + f1) * (1.0 - exp(-drag * uBurstTime)) / drag;
      fly = normalize(frame * dirL) * travel - vec3(0.0, 0.5 * uBurstGravity * uBurstTime * uBurstTime, 0.0);
    }

    vec3 world = nose + frame * (pl * scale) + fly;
    vec3 worldNormal = normalize(frame * (nl / max(scale, vec3(1e-5))));

    vBary = aBary;
    vNormal = worldNormal;
    vWorld = world;
    vLocal = position;
    vLocalNormal = nl;
    vFrameT = T;
    vFrameS = S;
    vFrameU = U;
    vAxis = aAxis;

    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const CORE_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586
  #define PI  3.141592653589793

  uniform float uTime;
  uniform float uLength;
  uniform float uRadius;
  uniform float uOpacity;      // how much the surface veils the inside
  uniform float uInnerLevel;   // brightness of the inner facets
  uniform float uInnerEdge;    // ... and their edges
  uniform float uCoreGlow;     // the cold light in the thick of it
  uniform float uNoseGlow;     // the nose is brilliant
  uniform float uNosePow;
  uniform float uSSS;          // light scattered through it toward the eye
  uniform float uSSSPower;
  uniform float uSSSDistort;
  uniform float uInner;        // the fracture planes inside
  uniform float uInnerScale;
  uniform float uInnerDepth;   // metres in they sit
  uniform float uInnerWidth;
  uniform float uHaze;         // trapped air, deeper still
  uniform float uHazeScale;
  uniform float uFrostEtch;    // the lattice on the rear facets
  uniform float uFrostStart;   // where along the axis it begins
  uniform float uFrostScale;   // flakes per crystal radius
  uniform float uPulse;        // the light inside breathes
  uniform float uPulseSpeed;
  uniform float uBurst;
  uniform float uBurstHeat;
  uniform float uIntensity;
  uniform float uRolloff;
  uniform float uSoftFade;
  uniform float uFade;
  uniform float uSeedLocal;

  uniform sampler2D uSceneDepth;
  uniform vec2  uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uShaderIntensity;
  uniform float uGlobalGlow;

  varying vec3  vBary;
  varying vec3  vNormal;
  varying vec3  vWorld;
  varying vec3  vLocal;
  varying vec3  vLocalNormal;
  varying vec3  vFrameT;
  varying vec3  vFrameS;
  varying vec3  vFrameU;
  varying float vAxis;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}
  ${ICE_GLSL}
  ${LATTICE_GLSL}

  /* F2 - F1 Voronoi in the plane: cells with a distance to their edges. */
  float voronoiEdge(vec2 p) {
    vec2 n = floor(p);
    vec2 f = fract(p);
    float d1 = 8.0;
    float d2 = 8.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(float(i), float(j));
        vec2 o = hash21(dot(n + g, vec2(7.13, 113.17)));
        vec2 r = g + o - f;
        float d = dot(r, r);
        if (d < d1) {
          d2 = d1;
          d1 = d;
        } else if (d < d2) {
          d2 = d;
        }
      }
    }
    return sqrt(d2) - sqrt(d1);
  }

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(cameraPosition - vWorld);
    #ifdef BACK_FACE
      // The inside of the far wall, seen from inside the crystal.
      N = -N;
    #endif
    vec3 K = glacialKey(V);
    float NdotV = clamp(dot(N, V), 0.0, 1.0);
    float NdotK = dot(N, K);

    // Thin at the nose and the rear, thick through the girdle.
    float thick = pow(sin(clamp(vAxis, 0.0, 1.0) * PI), 0.7);
    float nose = pow(1.0 - clamp(vAxis, 0.0, 1.0), max(uNosePow, 0.05));
    float breath = 1.0 + uPulse * sin(uTime * uPulseSpeed + vAxis * 4.0);
    float edge = glacialEdge(vBary);

    #ifdef BACK_FACE
      /* ================= the inside: the far facets, lit from within ====== */
      float lambert = 0.5 + 0.5 * NdotK;
      vec3 color = mix(uColorDeep, uColorIce, 0.25 + 0.55 * lambert) * uInnerLevel;
      // Deep where it is thick, and the cold light pooled there.
      color = mix(color, uColorDeep, thick * 0.35);
      color += uColorGlow * uCoreGlow * thick * breath * 0.6;
      color += mix(uColorGlow, uColorFrost, 0.6) * nose * uNoseGlow * 0.6;
      // The internal facet lines: the far wall's edges, seen through.
      color += uColorFrost * edge * uInnerEdge;
      color *= uIntensity * uShaderIntensity;
      color /= 1.0 + color * uRolloff;

      float flash = smoothstep(0.0, 0.1, uBurst) * (1.0 - smoothstep(0.1, 0.6, uBurst));
      color = mix(color, uColorFrost, clamp(flash * uBurstHeat, 0.0, 1.0));

      vec2 screenUV = gl_FragCoord.xy / uResolution;
      float alpha = softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
      if (alpha < 0.02) discard;
      gl_FragColor = vec4(color * uGlobalGlow * uFade, alpha);
    #else
      /* ================= the surface, over the inside ==================== */
      float fres = glacialFresnel(NdotV, uRimPower);
      float lambert = 0.5 + 0.5 * NdotK;

      // The body tint, lightest where the ice is thin.
      vec3 body = mix(uColorDeep, uColorIce, 0.3 + 0.7 * lambert);
      body = mix(body, uColorFrost, (1.0 - thick) * 0.35);

      /* ---- what is inside, seen through the surface ---- */
      // A ray into the ice, bent by its index, in the crystal's own frame.
      vec3 R = refract(-V, N, 1.0 / 1.31);
      vec3 Rl = vec3(dot(R, vFrameT), dot(R, vFrameS), dot(R, vFrameU)) / vec3(uLength, uRadius, uRadius);
      vec3 pin = vLocal + Rl * uInnerDepth;
      // Fracture planes: two families of cells, their edges the planes.
      float e1 = voronoiEdge(pin.xy * vec2(uInnerScale * 0.6, uInnerScale) + uSeedLocal);
      float e2 = voronoiEdge(pin.xz * vec2(uInnerScale * 0.6, uInnerScale) + uSeedLocal + 7.0);
      float crack = max(1.0 - smoothstep(0.0, uInnerWidth, e1), 1.0 - smoothstep(0.0, uInnerWidth, e2));
      crack *= 0.35 + 0.65 * thick;
      // And deeper still, a haze of trapped air.
      vec3 pdeep = vLocal + Rl * uInnerDepth * 2.2;
      float haze = smoothstep(0.35, 0.9, fbm3(pdeep * uHazeScale + uSeedLocal * 3.0) * 0.5 + 0.5);
      body = mix(body, uColorFrost * 0.85, haze * uHaze);

      /* ---- light scattered through it toward the eye ---- */
      vec3 Lt = normalize(-K + N * uSSSDistort);
      float sss = pow(clamp(dot(V, -Lt), 0.0, 1.0), max(uSSSPower, 0.1)) * uSSS * (1.0 - thick * 0.5);

      /* ---- the frost lattice etched over the rear facets ---- */
      // Evaluated everywhere and weighted after: the derivative the hairline
      // needs is only defined in uniform control flow.
      float frostW = smoothstep(uFrostStart, 1.0, vAxis) * uFrostEtch;
      // The facet's own plane, in local units, tiled and rolled per cell.
      vec3 nl = normalize(vLocalNormal);
      vec3 tu = normalize(cross(nl, vec3(0.13, 1.0, 0.21)));
      vec3 tv = cross(nl, tu);
      vec2 fp = vec2(dot(vLocal, tu), dot(vLocal, tv)) * uFrostScale;
      vec2 cell = floor(fp);
      vec2 fc = fract(fp) - 0.5;
      float cs = hash11(dot(cell, vec2(3.7, 11.3)) + uSeedLocal);
      float ang = cs * TAU;
      vec2 fr = vec2(fc.x * cos(ang) - fc.y * sin(ang), fc.x * sin(ang) + fc.y * cos(ang));
      float sd = snowflakeSDF(fr * 2.4, cs * 40.0);
      float fw = fwidth(sd) * 1.2;
      float etch = (1.0 - smoothstep(0.0, fw + 0.02, sd)) * step(0.3, cs);

      /* ---- assemble the body: matter, held under the bloom threshold ---- */
      vec3 color = body * (0.55 + 0.45 * lambert);
      color += uColorGlow * uCoreGlow * thick * breath * 0.35;
      color += uColorFrost * crack * uInner;
      color += uColorGlow * sss;
      color += uColorFrost * etch * frostW;
      color *= uIntensity * uShaderIntensity;
      color /= 1.0 + color * uRolloff;

      /* ---- and the light on it, which is allowed to bloom ---- */
      vec3 refl = reflect(-V, N);
      color += glacialEnv(refl) * fres;
      color += glacialSpecular(N, V, K);
      color += glacialRim(NdotV) * uColorFrost;
      color += uColorFrost * edge * uEdge;
      color += mix(uColorGlow, uColorFrost, 0.7) * nose * uNoseGlow * breath;

      float flash = smoothstep(0.0, 0.1, uBurst) * (1.0 - smoothstep(0.1, 0.6, uBurst));
      color = mix(color, uColorFrost, clamp(flash * uBurstHeat, 0.0, 1.0));

      // The surface veils the inside more where the ice is thick, where the
      // view grazes it, and where it is frosted.
      float alpha = uOpacity * mix(0.55, 1.0, thick);
      alpha = clamp(alpha + fres * 0.5 + crack * uInner * 0.3 + etch * frostW * 0.5 + haze * uHaze * 0.3, 0.0, 1.0);
      alpha = max(alpha, nose * 0.8);
      vec2 screenUV = gl_FragCoord.xy / uResolution;
      alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
      if (alpha < 0.02) discard;

      gl_FragColor = vec4(color * uGlobalGlow * uFade, alpha);
    #endif
  }
`;

/**
 * The crystal. Built twice per cast - `back: true` for the inside, drawn
 * first, and `back: false` for the surface over it.
 *
 * @param {object} spine shared uniform block from `createGlacialSpineUniforms()`
 * @param {object} ice   shared ice look block from `createIceLookUniforms()`
 * @param {boolean} back
 * @returns {THREE.ShaderMaterial} with `userData.sync({ burst, burstTime, grow, fade })`
 */
export function createGlacialCoreMaterial(spine, ice, back) {
  const material = new ShaderMaterial({
    name: back ? 'GlacialCoreInside' : 'GlacialCoreSurface',
    transparent: true,
    // A solid: both passes write depth, so the front sorts over the inside
    // and everything behind the crystal is hidden by it.
    depthWrite: true,
    depthTest: true,
    blending: NormalBlending,
    side: back ? BackSide : FrontSide,
    toneMapped: false,
    defines: back ? { BACK_FACE: 1 } : {},
    uniforms: sharedUniforms({
      ...spine,
      ...ice,

      uLength: { value: 2.6 },
      uRadius: { value: 0.55 },
      uLead: { value: 0.4 },
      uRoll: { value: 0.12 },
      uWobble: { value: 0.04 },
      uWobbleSpeed: { value: 2.2 },
      uBurst: { value: 0 },
      uBurstTime: { value: 0 },
      uBurstSpeed: { value: 8 },
      uBurstSpin: { value: 2 },
      uBurstDrag: { value: 2 },
      uBurstGravity: { value: 6 },
      uGrow: { value: 1 },

      uOpacity: { value: 0.55 },
      uInnerLevel: { value: 0.8 },
      uInnerEdge: { value: 0.35 },
      uCoreGlow: { value: 0.5 },
      uNoseGlow: { value: 1.6 },
      uNosePow: { value: 4 },
      uSSS: { value: 0.7 },
      uSSSPower: { value: 3 },
      uSSSDistort: { value: 0.4 },
      uInner: { value: 0.5 },
      uInnerScale: { value: 3 },
      uInnerDepth: { value: 0.25 },
      uInnerWidth: { value: 0.06 },
      uHaze: { value: 0.35 },
      uHazeScale: { value: 2.5 },
      uFrostEtch: { value: 0.7 },
      uFrostStart: { value: 0.45 },
      uFrostScale: { value: 2.5 },
      uPulse: { value: 0.15 },
      uPulseSpeed: { value: 2.5 },
      uBurstHeat: { value: 1 },
      uIntensity: { value: 1 },
      uRolloff: { value: 0.5 },
      uSoftFade: { value: 0.25 },
      uFade: { value: 1 },
      uSeedLocal: { value: 0 }
    }),
    vertexShader: CORE_VERTEX,
    fragmentShader: CORE_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.glacial;
    const g = settings.global;
    const u = material.uniforms;

    u.uBurst.value = state.burst;
    u.uBurstTime.value = state.burstTime;
    u.uGrow.value = state.grow;
    u.uFade.value = state.fade;
    u.uSeedLocal.value = state.seed;

    u.uLength.value = c.coreLength;
    u.uRadius.value = c.coreRadius;
    u.uLead.value = c.coreLead;
    u.uRoll.value = c.coreRoll * g.animationSpeed;
    u.uWobble.value = c.coreWobble * g.noiseStrength;
    u.uWobbleSpeed.value = c.coreWobbleSpeed * g.noiseSpeed;
    u.uBurstSpeed.value = c.coreBurstSpeed * g.explosionIntensity;
    u.uBurstSpin.value = c.coreBurstSpin;
    u.uBurstDrag.value = c.coreBurstDrag;
    u.uBurstGravity.value = c.coreBurstGravity;

    u.uOpacity.value = c.coreOpacity * g.opacity;
    u.uInnerLevel.value = c.coreInnerLevel;
    u.uInnerEdge.value = c.coreInnerEdge;
    u.uCoreGlow.value = c.coreGlow;
    u.uNoseGlow.value = c.coreNoseGlow;
    u.uNosePow.value = c.coreNosePow;
    u.uSSS.value = c.coreScatter;
    u.uSSSPower.value = c.coreScatterPower;
    u.uSSSDistort.value = c.coreScatterDistort;
    u.uInner.value = c.coreFractures;
    u.uInnerScale.value = c.coreFractureScale * g.noiseFrequency;
    u.uInnerDepth.value = c.coreFractureDepth;
    u.uInnerWidth.value = c.coreFractureWidth;
    u.uHaze.value = c.coreHaze;
    u.uHazeScale.value = c.coreHazeScale * g.noiseFrequency;
    u.uFrostEtch.value = c.coreFrostEtch;
    u.uFrostStart.value = c.coreFrostStart;
    u.uFrostScale.value = c.coreFrostScale;
    u.uPulse.value = c.corePulse;
    u.uPulseSpeed.value = c.corePulseSpeed * g.noiseSpeed;
    u.uBurstHeat.value = c.coreBurstHeat;
    u.uIntensity.value = c.coreIntensity;
    u.uRolloff.value = c.coreRolloff;
    u.uSoftFade.value = c.coreSoftFade;

    syncIceLook(u);
  };

  return material;
}

/** The ice look block one cast's crystal and shards share by identity. */
export function createIceLookUniforms() {
  return iceUniforms();
}

/* ------------------------------------------------------------------ */
/* 2a · the fluid frost vapour: the streaks                            */
/* ------------------------------------------------------------------ */

const VAPOR_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  attribute float aSprite;

  uniform float uTime;
  uniform float uTrail;        // how many slots are the trail; the rest are the strike's gout
  uniform float uLife;         // seconds one puff lasts, and its spawn period
  uniform float uHeadSpeed;    // metres/second the head is making - unwinds history
  uniform float uLead;         // metres ahead of the front it is shed (negative: off the crystal's rear)
  uniform float uRadius;       // how far off the axis it is born, metres
  uniform float uCarry;        // fraction of the head's speed the trail keeps - little, it lingers
  uniform float uSheath;       // fraction of the slots that sheath the crystal instead
  uniform float uSheathCarry;  // ... and how much of its speed those keep - nearly all
  uniform float uSheathBack;   // metres along the crystal the sheath is born over
  uniform float uSheathRadius; // x the crystal's radius
  uniform float uRise;         // metres/second it climbs
  uniform float uSpread;       // metres/second it spreads outward, dragged to a stop
  uniform float uDrag;
  uniform float uCurl;         // metres/second the curl field advects it
  uniform float uCurlScale;
  uniform float uCurlSpeed;
  uniform float uSize;         // half-size at birth, metres
  uniform float uGrow;         // ... and how much it swells over its life, x
  uniform float uSizeVariance;
  uniform float uStretch;      // how far a puff is drawn out along its motion, per m/s
  uniform float uStretchMax;
  uniform float uSpin;
  uniform float uBurstLife;
  uniform float uBurstThrow;
  uniform float uBurstDrag;
  uniform float uBurstSize;
  uniform vec3  uImpact;
  uniform float uStopped;
  uniform float uFade;

  varying vec2  vUv;
  varying float vSeed;
  varying float vLife;
  varying float vSheath;
  varying float vAspect;
  varying float vViewZ;

  ${noiseGLSL}
  ${GLACIAL_SPINE_GLSL}

  /** Where a trail puff is, age seconds after it was shed. */
  vec3 vaporAt(float age, float carry, float lead, float radius, float r1, float r2, float r3, float sheath) {
    float flightAge = max(age - uStopped, 0.0);
    float slip = (1.0 - carry) * uHeadSpeed * flightAge;
    float sNow = uFront + lead - slip;

    vec3 tangent, side, up;
    glacialFrame(sNow, tangent, side, up);
    vec3 root = glacialSpine(sNow);

    float a = r1 * TAU;
    vec3 radial = side * cos(a) + up * sin(a);
    float drag = max(uDrag, 0.001);
    float travel = uSpread * (0.4 + r2) * (1.0 - exp(-drag * age)) / drag * (1.0 - sheath * 0.7);

    vec3 p = root + radial * (radius + travel) + vec3(0.0, uRise * age, 0.0);
    // Curl advection: the field is anchored to the path, so the coils it
    // lays down stay where they were laid.
    vec3 curl = curlNoise(root * uCurlScale + vec3(uSeed * 0.1) + vec3(0.0, uTime * uCurlSpeed, 0.0) + radial * 0.7);
    p += curl * uCurl * age * (1.0 - sheath * 0.75);
    return p;
  }

  void main() {
    vec3 center = vec3(0.0);
    vec3 velocity = vec3(0.0);
    float size = 0.0;
    float life = 0.0;
    float sheath = 0.0;
    float seed = 0.0;
    float spin = 0.0;

    if (aSprite < uTrail + 0.5) {
      /* ---- the trail, and the sheath ---- */
      float period = max(uLife, 0.05);
      float phase = hash11(aSprite * 1.37 + uSeed * 0.31);
      float loop = uTime / period + phase;
      float generation = floor(loop);
      life = fract(loop);
      float age = life * period;

      float base = aSprite * 3.71 + generation * 17.13 + uSeed;
      float r1 = hash11(base + 1.7);
      float r2 = hash11(base + 5.3);
      float r3 = hash11(base + 9.1);
      float r4 = hash11(base + 13.9);
      float r5 = hash11(base + 21.7);
      float r6 = hash11(base + 29.3);

      sheath = step(r6, uSheath);
      float carry = mix(uCarry, uSheathCarry, sheath);
      float lead = uLead - sheath * r5 * uSheathBack;
      float radius = uRadius * (0.3 + 0.7 * r3) * mix(1.0, uSheathRadius, sheath);

      float flightAge = max(age - uStopped, 0.0);
      float sBirth = uFront + lead - flightAge * uHeadSpeed;
      float born = step(0.0, sBirth) * step(uStopped, age);

      const float DT = 0.04;
      center = vaporAt(age, carry, lead, radius, r1, r2, r3, sheath);
      vec3 ahead = vaporAt(age + DT, carry, lead, radius, r1, r2, r3, sheath);
      velocity = (ahead - center) / DT;

      float grow = smoothstep(0.0, 0.1, life);
      float roll = mix(1.0 - uSizeVariance, 1.0 + uSizeVariance, r4);
      size = uSize * roll * (1.0 + uGrow * smoothstep(0.0, 1.0, life)) * grow * born * mix(1.0, 0.55, sheath);
      seed = r5 * 10.0 + r1;
      spin = r2 * TAU + age * uSpin * TAU * (r4 - 0.5) * 2.0;
    } else {
      /* ---- the gout thrown on the strike ---- */
      float i = aSprite - uTrail - 1.0;
      float base = i * 5.13 + uSeed + 77.0;
      float r1 = hash11(base + 1.7);
      float r2 = hash11(base + 5.3);
      vec3  r5 = hash31(base + 21.7);
      float r4 = hash11(base + 13.9);

      float age = max(uStopped - r1 * 0.08, 0.0);
      float period = max(uBurstLife, 0.05);
      life = age / period;
      float born = step(0.0001, uStopped) * step(life, 1.0);

      vec3 dir = normalize(r5 * 2.0 - 1.0 + vec3(0.0, 0.25, 0.0) + vec3(1e-4));
      float speed = uBurstThrow * (0.3 + r2 * 1.2);
      float drag = max(uBurstDrag, 0.001);
      float travel = speed * (1.0 - exp(-drag * age)) / drag;
      center = uImpact + dir * travel + vec3(0.0, uRise * age, 0.0);
      velocity = dir * speed * exp(-drag * age);

      float env = smoothstep(0.0, 0.08, life);
      size = uBurstSize * mix(1.0 - uSizeVariance, 1.0 + uSizeVariance, r4) * (1.0 + uGrow * life) * env * born;
      seed = base;
      spin = r4 * TAU;
    }

    /* ---- laid out in view space, drawn out along its own motion ---- */
    vec4 mv = viewMatrix * vec4(center, 1.0);
    vec2 vv = (viewMatrix * vec4(velocity, 0.0)).xy;
    float speed = length(vv);
    vec2 axisX = speed > 1e-3 ? vv / speed : vec2(cos(spin), sin(spin));
    vec2 axisY = vec2(-axisX.y, axisX.x);
    float aspect = 1.0 + min(uStretch * speed, uStretchMax);
    mv.xy += axisX * (position.x * size * aspect) + axisY * (position.y * size);

    vUv = position.xy;
    vSeed = seed;
    vLife = life;
    vSheath = sheath;
    vAspect = aspect;
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const VAPOR_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform float uErode;        // how much of a puff the noise eats
  uniform float uErodeOut;     // ... more as it dies
  uniform float uNoiseScale;
  uniform float uNoiseSpeed;
  uniform float uFlow;         // the noise streams back along the streak
  uniform float uLit;          // contrast between the lit and the shadow side
  uniform float uInnerGlow;    // lit by the crystal while young
  uniform float uSheathGlow;   // ... and the sheath, always
  uniform float uOpacity;
  uniform float uSoftFade;
  uniform float uFade;
  uniform vec3  uColorShade;   // the shadow side of a puff
  uniform vec3  uColorLit;     // ... and the lit side
  uniform vec3  uColorGlow;

  uniform sampler2D uSceneDepth;
  uniform vec2  uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uShaderIntensity;
  uniform float uGlobalGlow;

  varying vec2  vUv;
  varying float vSeed;
  varying float vLife;
  varying float vSheath;
  varying float vAspect;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  float puff(vec2 p, float d) {
    float disc = 1.0 - smoothstep(0.15, 1.0, d);
    vec3 np = vec3(p * vec2(vAspect, 1.0) * uNoiseScale - vec2(uTime * uFlow, 0.0) + vSeed * 7.3, uTime * uNoiseSpeed + vSeed);
    float n = snoise01(np) * 0.62 + snoise01(np * 2.3 + 11.0) * 0.38;
    float erode = uErode + vLife * uErodeOut;
    return disc * smoothstep(erode - 0.28, erode + 0.28, n * (0.5 + 0.5 * disc));
  }

  void main() {
    vec2 p = vUv;
    float d = length(p);
    if (d > 1.0) discard;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    float depthFade = softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);

    // Two samples, a little apart along the key: the difference is which
    // side of the puff faces the light.
    const vec2 KEY = vec2(-0.6, 0.8);
    float density = puff(p, d);
    float toward = puff(p + KEY * 0.28, length(p + KEY * 0.28));
    float lit = clamp(0.5 + (toward - density) * uLit, 0.0, 1.0);

    float env = smoothstep(0.0, 0.1, vLife) * (1.0 - smoothstep(0.55, 1.0, vLife));
    float alpha = clamp(density, 0.0, 1.0) * uOpacity * env * uFade * depthFade;
    if (alpha < 0.003) discard;

    vec3 col = mix(uColorShade, uColorLit, lit);
    col = mix(col, uColorLit, vSheath * 0.35);
    vec3 glow = uColorGlow * pow(density, 2.0) * (uInnerGlow * (1.0 - vLife) + uSheathGlow * vSheath) * uShaderIntensity;
    glow *= env * uFade * depthFade;

    gl_FragColor = vec4((col * alpha + glow) * uGlobalGlow, alpha);
  }
`;

/**
 * @param {object} spine shared uniform block from `createGlacialSpineUniforms()`
 * @returns {THREE.ShaderMaterial} with
 *   `userData.sync({ trail, headSpeed, stopped, impact, fade })`
 */
export function createGlacialVaporMaterial(spine) {
  const material = new ShaderMaterial({
    name: 'GlacialVapor',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    ...PREMULTIPLIED,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...spine,

      uTrail: { value: 400 },
      uLife: { value: 2.2 },
      uHeadSpeed: { value: 26 },
      uLead: { value: -1.6 },
      uRadius: { value: 0.55 },
      uCarry: { value: 0.1 },
      uSheath: { value: 0.3 },
      uSheathCarry: { value: 0.93 },
      uSheathBack: { value: 1.8 },
      uSheathRadius: { value: 0.9 },
      uRise: { value: 0.25 },
      uSpread: { value: 0.9 },
      uDrag: { value: 1.4 },
      uCurl: { value: 0.7 },
      uCurlScale: { value: 0.9 },
      uCurlSpeed: { value: 0.3 },
      uSize: { value: 0.32 },
      uGrow: { value: 2.2 },
      uSizeVariance: { value: 0.5 },
      uStretch: { value: 0.12 },
      uStretchMax: { value: 3.5 },
      uSpin: { value: 0.1 },
      uBurstLife: { value: 1.6 },
      uBurstThrow: { value: 7 },
      uBurstDrag: { value: 2.2 },
      uBurstSize: { value: 0.5 },
      uImpact: { value: new Vector3() },
      uStopped: { value: 0 },
      uFade: { value: 1 },

      uErode: { value: 0.45 },
      uErodeOut: { value: 0.35 },
      uNoiseScale: { value: 1.6 },
      uNoiseSpeed: { value: 0.4 },
      uFlow: { value: 0.6 },
      uLit: { value: 2.2 },
      uInnerGlow: { value: 0.5 },
      uSheathGlow: { value: 0.6 },
      uOpacity: { value: 0.55 },
      uSoftFade: { value: 0.6 },
      uColorShade: { value: new Color(0.36, 0.55, 0.78) },
      uColorLit: { value: new Color(0.9, 0.96, 1.0) },
      uColorGlow: { value: new Color(0.6, 0.9, 1.0) }
    }),
    vertexShader: VAPOR_VERTEX,
    fragmentShader: VAPOR_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.glacial;
    const g = settings.global;
    const u = material.uniforms;

    u.uTrail.value = state.trail;
    u.uHeadSpeed.value = state.headSpeed;
    u.uStopped.value = state.stopped;
    u.uImpact.value.copy(state.impact);
    u.uFade.value = state.fade;

    u.uLife.value = c.vaporLife * g.particleLifetime;
    u.uLead.value = c.vaporLead;
    u.uRadius.value = c.vaporRadius;
    u.uCarry.value = c.vaporCarry;
    u.uSheath.value = c.vaporSheath;
    u.uSheathCarry.value = c.vaporSheathCarry;
    u.uSheathBack.value = c.vaporSheathBack;
    u.uSheathRadius.value = c.vaporSheathRadius;
    u.uRise.value = c.vaporRise * g.particleSpeed;
    u.uSpread.value = c.vaporSpread * g.particleSpeed;
    u.uDrag.value = c.vaporDrag;
    u.uCurl.value = c.vaporCurl * g.turbulence;
    u.uCurlScale.value = c.vaporCurlScale * g.noiseFrequency;
    u.uCurlSpeed.value = c.vaporCurlSpeed * g.noiseSpeed;
    u.uSize.value = c.vaporSize * g.particleSize;
    u.uGrow.value = c.vaporGrow;
    u.uSizeVariance.value = c.vaporSizeVariance * g.randomness;
    u.uStretch.value = c.vaporStretch;
    u.uStretchMax.value = c.vaporStretchMax;
    u.uSpin.value = c.vaporSpin * g.animationSpeed;
    u.uBurstLife.value = c.vaporBurstLife * g.particleLifetime;
    u.uBurstThrow.value = c.vaporBurstThrow * g.particleSpeed * g.explosionIntensity;
    u.uBurstDrag.value = c.vaporBurstDrag;
    u.uBurstSize.value = c.vaporBurstSize * g.particleSize;

    u.uErode.value = c.vaporErode;
    u.uErodeOut.value = c.vaporErodeOut;
    u.uNoiseScale.value = c.vaporNoiseScale * g.noiseFrequency;
    u.uNoiseSpeed.value = c.vaporNoiseSpeed * g.noiseSpeed;
    u.uFlow.value = c.vaporFlow * g.noiseSpeed;
    u.uLit.value = c.vaporLit;
    u.uInnerGlow.value = c.vaporInnerGlow;
    u.uSheathGlow.value = c.vaporSheathGlow;
    u.uOpacity.value = c.vaporOpacity * g.opacity;
    u.uSoftFade.value = c.vaporSoftFade;
    u.uColorShade.value.copy(getColor(c.colorVaporShade));
    u.uColorLit.value.copy(getColor(c.colorVaporLit));
    u.uColorGlow.value.copy(getColor(c.colorVaporGlow));
  };

  return material;
}

/* ------------------------------------------------------------------ */
/* 2b · the fluid frost vapour: the silks                              */
/* ------------------------------------------------------------------ */

const SILK_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586
  #define PI  3.141592653589793

  attribute float aStrand;

  uniform float uTime;
  uniform float uStrands;
  uniform float uSpan;         // metres of path the silks reach back over
  uniform float uLead;         // where they start, metres ahead of the front (negative: off the crystal)
  uniform float uRadius;       // how far off the axis a silk bows at the tail, metres
  uniform float uHeadRadius;   // ... x that, at the head - the wake opens
  uniform float uFlatten;      // vertical component of the bow, x the lateral
  uniform float uCoil;         // turns one silk makes over the span
  uniform float uSpin;         // turns/second the weave rolls
  uniform float uBow;          // how sharply the silks converge at the ends
  uniform float uWander;
  uniform float uWanderScale;
  uniform float uWanderSpeed;
  uniform float uWidth;        // half-width at its broadest, metres
  uniform float uWidthBow;
  uniform float uFade;

  varying float vT;
  varying float vV;
  varying float vStrand;
  varying float vSeed;
  varying float vViewZ;

  ${noiseGLSL}
  ${GLACIAL_SPINE_GLSL}

  vec3 silkAt(float t, float phase, float radius, float coil) {
    float s = max(uFront + uLead - t * uSpan, 0.0);

    vec3 tangent, side, up;
    glacialFrame(s, tangent, side, up);
    vec3 axis = glacialSpine(s);

    float profile = pow(sin(clamp(t, 0.0, 1.0) * PI), max(uBow, 0.05));
    float open = mix(uHeadRadius, 1.0, t);

    float a = phase + t * coil * TAU - uTime * uSpin * TAU;
    vec3 offset = (side * cos(a) + up * sin(a) * uFlatten) * radius * open * profile;

    float n1 = snoise(vec3(t * uWanderScale, uTime * uWanderSpeed, phase * 3.1));
    float n2 = snoise(vec3(t * uWanderScale + 19.3, uTime * uWanderSpeed, phase * 3.1 + 7.7));
    offset += (side * n1 + up * n2) * uWander * profile;

    return axis + offset;
  }

  void main() {
    float strand = aStrand;
    float roll = hash11(strand * 4.11 + uSeed);
    float roll2 = hash11(strand * 8.37 + uSeed + 13.1);

    float phase = (strand / max(uStrands, 1.0)) * TAU + roll * 1.1 + uSeed;
    float handed = mod(strand, 2.0) < 1.0 ? 1.0 : -1.0;
    float radius = uRadius * (0.7 + roll * 0.7);
    float coil = uCoil * (0.6 + roll2 * 1.0) * handed;

    float t = clamp(position.x, 0.0, 1.0);
    const float H = 0.01;
    vec3 p0 = silkAt(t, phase, radius, coil);
    vec3 p1 = silkAt(min(t + H, 1.0), phase, radius, coil);
    vec3 tangent = normalize(p1 - p0 + 1e-6);

    vec3 toEye = normalize(cameraPosition - p0);
    vec3 broad = cross(tangent, toEye);
    if (dot(broad, broad) < 1e-8) broad = vec3(0.0, 1.0, 0.0);
    broad = normalize(broad);

    float taper = pow(sin(clamp(t, 0.0, 1.0) * PI), max(uWidthBow, 0.05));
    float halfWidth = uWidth * taper * uFade * (0.7 + roll * 0.6);
    halfWidth *= step(0.0, uFront + uLead - t * uSpan);

    vec3 world = p0 + broad * (position.y * halfWidth);

    vT = t;
    vV = position.y;
    vStrand = strand;
    vSeed = uSeed;

    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const SILK_FRAGMENT = /* glsl */ `
  #define PI 3.141592653589793

  uniform float uTime;
  uniform float uSoft;         // falloff across the strip
  uniform float uErode;        // how far the noise eats the silk into streamers
  uniform float uTailErode;    // ... more toward the tail
  uniform float uFiberScale;
  uniform float uFlow;         // the streamers run back along the silk
  uniform float uLit;
  uniform float uHeadGlow;
  uniform float uOpacity;
  uniform float uSoftFade;
  uniform float uFade;
  uniform vec3  uColorShade;
  uniform vec3  uColorLit;
  uniform vec3  uColorGlow;

  uniform sampler2D uSceneDepth;
  uniform vec2  uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uShaderIntensity;
  uniform float uGlobalGlow;

  varying float vT;
  varying float vV;
  varying float vStrand;
  varying float vSeed;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  float silk(float t, float v) {
    float across = clamp(1.0 - abs(v), 0.0, 1.0);
    float body = pow(across, max(uSoft, 0.05));
    float flow = fbm3(vec3(t * uFiberScale - uTime * uFlow, v * 1.6 + vStrand * 3.0, vStrand * 7.0 + vSeed)) * 0.5 + 0.5;
    float erode = uErode + t * uTailErode;
    return body * smoothstep(erode - 0.22, erode + 0.22, flow);
  }

  void main() {
    float density = silk(vT, vV);
    float toward = silk(vT - 0.02, vV + 0.3);
    float lit = clamp(0.5 + (toward - density) * uLit, 0.0, 1.0);

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    float depthFade = softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    float alpha = clamp(density, 0.0, 1.0) * uOpacity * uFade * depthFade;
    if (alpha < 0.003) discard;

    vec3 col = mix(uColorShade, uColorLit, lit);
    vec3 glow = uColorGlow * density * pow(1.0 - vT, 3.0) * uHeadGlow * uShaderIntensity * uFade * depthFade;

    gl_FragColor = vec4((col * alpha + glow) * uGlobalGlow, alpha);
  }
`;

/**
 * @param {object} spine shared uniform block from `createGlacialSpineUniforms()`
 * @returns {THREE.ShaderMaterial} with `userData.sync({ strands, span, fade })`
 */
export function createGlacialSilkMaterial(spine) {
  const material = new ShaderMaterial({
    name: 'GlacialSilk',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    ...PREMULTIPLIED,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...spine,

      uStrands: { value: 5 },
      uSpan: { value: 16 },
      uLead: { value: -1.2 },
      uRadius: { value: 1.3 },
      uHeadRadius: { value: 0.3 },
      uFlatten: { value: 0.8 },
      uCoil: { value: 0.7 },
      uSpin: { value: 0.1 },
      uBow: { value: 0.5 },
      uWander: { value: 0.3 },
      uWanderScale: { value: 1.5 },
      uWanderSpeed: { value: 0.4 },
      uWidth: { value: 0.55 },
      uWidthBow: { value: 0.4 },
      uFade: { value: 1 },

      uSoft: { value: 1.4 },
      uErode: { value: 0.45 },
      uTailErode: { value: 0.3 },
      uFiberScale: { value: 5 },
      uFlow: { value: 0.5 },
      uLit: { value: 2 },
      uHeadGlow: { value: 0.6 },
      uOpacity: { value: 0.4 },
      uSoftFade: { value: 0.6 },
      uColorShade: { value: new Color(0.36, 0.55, 0.78) },
      uColorLit: { value: new Color(0.9, 0.96, 1.0) },
      uColorGlow: { value: new Color(0.6, 0.9, 1.0) }
    }),
    vertexShader: SILK_VERTEX,
    fragmentShader: SILK_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.glacial;
    const g = settings.global;
    const u = material.uniforms;

    u.uStrands.value = state.strands;
    u.uSpan.value = state.span;
    u.uFade.value = state.fade;

    u.uLead.value = c.silkLead;
    u.uRadius.value = c.silkRadius;
    u.uHeadRadius.value = c.silkHeadRadius;
    u.uFlatten.value = c.silkFlatten;
    u.uCoil.value = c.silkCoil;
    u.uSpin.value = c.silkSpin * g.animationSpeed;
    u.uBow.value = c.silkBow;
    u.uWander.value = c.silkWander * g.noiseStrength;
    u.uWanderScale.value = c.silkWanderScale * g.noiseFrequency;
    u.uWanderSpeed.value = c.silkWanderSpeed * g.noiseSpeed;
    u.uWidth.value = c.silkWidth;
    u.uWidthBow.value = c.silkWidthBow;

    u.uSoft.value = c.silkSoft;
    u.uErode.value = c.silkErode;
    u.uTailErode.value = c.silkTailErode;
    u.uFiberScale.value = c.silkFiberScale * g.noiseFrequency;
    u.uFlow.value = c.silkFlow * g.noiseSpeed;
    u.uLit.value = c.silkLit;
    u.uHeadGlow.value = c.silkHeadGlow;
    u.uOpacity.value = c.silkOpacity * g.opacity;
    u.uSoftFade.value = c.silkSoftFade;
    u.uColorShade.value.copy(getColor(c.colorVaporShade));
    u.uColorLit.value.copy(getColor(c.colorVaporLit));
    u.uColorGlow.value.copy(getColor(c.colorVaporGlow));
  };

  return material;
}

/* ------------------------------------------------------------------ */
/* 3 · the ordered frost lattice                                       */
/* ------------------------------------------------------------------ */

const LATTICE_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  attribute float aSprite;

  uniform float uTime;
  uniform float uTrail;        // how many slots are the trail; the rest are the strike's shell
  uniform float uLife;
  uniform float uHeadSpeed;
  uniform float uLead;
  uniform float uRadius;
  uniform float uCarry;
  uniform float uFall;         // metres/second a flake settles
  uniform float uSpread;
  uniform float uDrag;
  uniform float uSize;         // radius of a small flake, metres
  uniform float uSizeVariance;
  uniform float uBig;          // fraction that are large
  uniform float uBigScale;     // ... and how much larger, x
  uniform float uSpin;         // turns/second in its own plane
  uniform float uTumble;       // turns/second it flips through the view
  uniform float uBurstLife;
  uniform float uBurstThrow;
  uniform float uBurstDrag;
  uniform vec3  uImpact;
  uniform float uStopped;
  uniform float uFade;

  varying vec2  vUv;
  varying float vSeed;
  varying float vLife;
  varying float vBig;
  varying float vViewZ;

  ${noiseGLSL}
  ${GLACIAL_SPINE_GLSL}

  void main() {
    vec3 center = vec3(0.0);
    float size = 0.0;
    float life = 0.0;
    float seed = 0.0;
    float spin = 0.0;
    float tilt = 0.0;
    float big = 0.0;

    if (aSprite < uTrail + 0.5) {
      float period = max(uLife, 0.05);
      float phase = hash11(aSprite * 1.37 + uSeed * 0.31);
      float loop = uTime / period + phase;
      float generation = floor(loop);
      life = fract(loop);
      float age = life * period;

      float base = aSprite * 3.71 + generation * 17.13 + uSeed;
      float r1 = hash11(base + 1.7);
      float r2 = hash11(base + 5.3);
      float r3 = hash11(base + 9.1);
      float r4 = hash11(base + 13.9);
      vec3  r5 = hash31(base + 21.7);
      float r6 = hash11(base + 29.3);

      float flightAge = max(age - uStopped, 0.0);
      float sBirth = uFront + uLead - flightAge * uHeadSpeed;
      float born = step(0.0, sBirth) * step(uStopped, age);
      float slip = (1.0 - uCarry) * uHeadSpeed * flightAge;
      float sNow = uFront + uLead - slip;

      vec3 tangent, side, up;
      glacialFrame(sNow, tangent, side, up);
      vec3 root = glacialSpine(sNow);

      float a = r1 * TAU;
      vec3 radial = side * cos(a) + up * sin(a);
      float drag = max(uDrag, 0.001);
      float travel = uSpread * (0.3 + r2) * (1.0 - exp(-drag * age)) / drag;
      // A flake settles and sways as it does.
      float sway = sin(age * 2.1 + r3 * TAU) * 0.15 * age;
      center = root + radial * (uRadius * (0.2 + 0.8 * r3) + travel) + side * sway
             - vec3(0.0, uFall * age * (0.6 + r4 * 0.8), 0.0);

      big = step(r6, uBig);
      float grow = smoothstep(0.0, 0.08, life);
      float roll = mix(1.0 - uSizeVariance, 1.0 + uSizeVariance, r4);
      size = uSize * roll * mix(1.0, uBigScale, big) * grow * born;
      seed = base;
      spin = r5.x * TAU + age * uSpin * TAU * (r5.y - 0.5) * 2.0;
      tilt = r5.z * TAU + age * uTumble * TAU * (0.5 + r2);
    } else {
      float i = aSprite - uTrail - 1.0;
      float base = i * 5.13 + uSeed + 91.0;
      float r1 = hash11(base + 1.7);
      float r2 = hash11(base + 5.3);
      float r4 = hash11(base + 13.9);
      vec3  r5 = hash31(base + 21.7);
      float r6 = hash11(base + 29.3);

      float age = max(uStopped - r1 * 0.06, 0.0);
      float period = max(uBurstLife, 0.05);
      life = age / period;
      float born = step(0.0001, uStopped) * step(life, 1.0);

      vec3 dir = normalize(r5 * 2.0 - 1.0 + vec3(1e-4));
      float speed = uBurstThrow * (0.3 + r2 * 1.2);
      float drag = max(uBurstDrag, 0.001);
      float travel = speed * (1.0 - exp(-drag * age)) / drag;
      center = uImpact + dir * travel - vec3(0.0, uFall * age * age * 0.5, 0.0);

      big = step(r6, uBig);
      float env = smoothstep(0.0, 0.06, life);
      size = uSize * mix(1.0 - uSizeVariance, 1.0 + uSizeVariance, r4) * mix(1.0, uBigScale, big) * env * born;
      seed = base;
      spin = r4 * TAU + age * uSpin * TAU * (r5.y - 0.5) * 2.0;
      tilt = r5.z * TAU + age * uTumble * TAU * (0.5 + r2);
    }

    // A disc flipping through the view is an ellipse: squash it along one
    // axis by how far it has turned, and let that axis turn with the spin.
    float squash = 0.18 + 0.82 * abs(cos(tilt));
    vec2 q = position.xy * vec2(1.0, squash);
    float cs = cos(spin);
    float sn = sin(spin);
    q = vec2(q.x * cs - q.y * sn, q.x * sn + q.y * cs);

    vec4 mv = viewMatrix * vec4(center, 1.0);
    mv.xy += q * size;

    vUv = position.xy;
    vSeed = seed;
    vLife = life;
    vBig = big;
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const LATTICE_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform float uFill;         // the pale body of the flake
  uniform float uEdgeGlow;     // ... and the light along its lines
  uniform float uSoft;         // how soft the fill's edge is, flake radii
  uniform float uTwinkle;
  uniform float uTwinkleSpeed;
  uniform float uSoftFade;
  uniform float uFade;
  uniform vec3  uColorBody;
  uniform vec3  uColorEdge;

  uniform sampler2D uSceneDepth;
  uniform vec2  uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uShaderIntensity;
  uniform float uGlobalGlow;

  varying vec2  vUv;
  varying float vSeed;
  varying float vLife;
  varying float vBig;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}
  ${LATTICE_GLSL}

  void main() {
    vec2 p = vUv;
    if (dot(p, p) > 1.0) discard;

    float sd = snowflakeSDF(p * 1.04, vSeed);
    float fw = fwidth(sd);
    float fill = 1.0 - smoothstep(0.0, fw + uSoft, sd);
    float line = 1.0 - smoothstep(0.0, fw * 1.6 + 0.004, abs(sd));

    float env = smoothstep(0.0, 0.1, vLife) * (1.0 - smoothstep(0.6, 1.0, vLife));
    float tw = mix(1.0, 0.5 + 0.5 * sin(uTime * uTwinkleSpeed + vSeed * TAU), uTwinkle);

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    float depthFade = softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);

    float alpha = fill * uFill * env * uFade * depthFade;
    vec3 glow = uColorEdge * line * uEdgeGlow * tw * mix(1.0, 1.4, vBig) * uShaderIntensity * env * uFade * depthFade;
    if (alpha < 0.003 && max(glow.r, max(glow.g, glow.b)) < 0.003) discard;

    gl_FragColor = vec4((uColorBody * alpha + glow) * uGlobalGlow, alpha);
  }
`;

/**
 * @param {object} spine shared uniform block from `createGlacialSpineUniforms()`
 * @returns {THREE.ShaderMaterial} with
 *   `userData.sync({ trail, headSpeed, stopped, impact, fade })`
 */
export function createGlacialLatticeMaterial(spine) {
  const material = new ShaderMaterial({
    name: 'GlacialLattice',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    ...PREMULTIPLIED,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...spine,

      uTrail: { value: 90 },
      uLife: { value: 2.4 },
      uHeadSpeed: { value: 26 },
      uLead: { value: -1.5 },
      uRadius: { value: 0.8 },
      uCarry: { value: 0.08 },
      uFall: { value: 0.2 },
      uSpread: { value: 0.5 },
      uDrag: { value: 1.2 },
      uSize: { value: 0.16 },
      uSizeVariance: { value: 0.4 },
      uBig: { value: 0.18 },
      uBigScale: { value: 3 },
      uSpin: { value: 0.15 },
      uTumble: { value: 0.2 },
      uBurstLife: { value: 1.6 },
      uBurstThrow: { value: 6 },
      uBurstDrag: { value: 2 },
      uImpact: { value: new Vector3() },
      uStopped: { value: 0 },
      uFade: { value: 1 },

      uFill: { value: 0.35 },
      uEdgeGlow: { value: 1.2 },
      uSoft: { value: 0.03 },
      uTwinkle: { value: 0.5 },
      uTwinkleSpeed: { value: 3 },
      uSoftFade: { value: 0.3 },
      uColorBody: { value: new Color(0.7, 0.86, 1.0) },
      uColorEdge: { value: new Color(0.85, 0.96, 1.0) }
    }),
    vertexShader: LATTICE_VERTEX,
    fragmentShader: LATTICE_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.glacial;
    const g = settings.global;
    const u = material.uniforms;

    u.uTrail.value = state.trail;
    u.uHeadSpeed.value = state.headSpeed;
    u.uStopped.value = state.stopped;
    u.uImpact.value.copy(state.impact);
    u.uFade.value = state.fade;

    u.uLife.value = c.latticeLife * g.particleLifetime;
    u.uLead.value = c.latticeLead;
    u.uRadius.value = c.latticeRadius;
    u.uCarry.value = c.latticeCarry;
    u.uFall.value = c.latticeFall * g.particleSpeed;
    u.uSpread.value = c.latticeSpread * g.particleSpeed;
    u.uDrag.value = c.latticeDrag;
    u.uSize.value = c.latticeSize * g.particleSize;
    u.uSizeVariance.value = c.latticeSizeVariance * g.randomness;
    u.uBig.value = c.latticeBig;
    u.uBigScale.value = c.latticeBigScale;
    u.uSpin.value = c.latticeSpin * g.animationSpeed;
    u.uTumble.value = c.latticeTumble * g.animationSpeed;
    u.uBurstLife.value = c.latticeBurstLife * g.particleLifetime;
    u.uBurstThrow.value = c.latticeBurstThrow * g.particleSpeed * g.explosionIntensity;
    u.uBurstDrag.value = c.latticeBurstDrag;

    u.uFill.value = c.latticeFill * g.opacity;
    u.uEdgeGlow.value = c.latticeEdgeGlow;
    u.uSoft.value = c.latticeSoft;
    u.uTwinkle.value = c.latticeTwinkle * g.randomness;
    u.uTwinkleSpeed.value = c.latticeTwinkleSpeed * g.noiseSpeed;
    u.uSoftFade.value = c.latticeSoftFade;
    u.uColorBody.value.copy(getColor(c.colorLattice));
    u.uColorEdge.value.copy(getColor(c.colorLatticeEdge));
  };

  return material;
}

/* ------------------------------------------------------------------ */
/* 4 · the glinting ice shards                                         */
/* ------------------------------------------------------------------ */

/**
 * Where every shard is. Included by the shard mesh and by the glint sprite,
 * so a glint sits exactly on the shard that threw it. Declares the uniforms
 * it reads; both materials carry them and sync them from the same settings.
 */
const SHARD_PLACE_GLSL = /* glsl */ `
#ifndef GLACIAL_SHARD_PLACE_INCLUDED
#define GLACIAL_SHARD_PLACE_INCLUDED
  uniform float uTrail;        // how many slots are the trail; the rest are the strike's shell
  uniform float uLife;
  uniform float uHeadSpeed;
  uniform float uLead;
  uniform float uRadius;
  uniform float uThrow;
  uniform float uForward;
  uniform float uSpread;
  uniform float uCarry;
  uniform float uDrag;
  uniform float uGravity;
  uniform float uSize;
  uniform float uSizeVariance;
  uniform float uSpin;
  uniform float uGrowIn;
  uniform float uShrinkOut;
  uniform float uBurstLife;
  uniform float uBurstThrow;
  uniform float uBurstDrag;
  uniform float uBurstSize;
  uniform vec3  uImpact;
  uniform float uStopped;
  uniform float uSalt;         // this draw's own rolls: two variants must not fly the same arcs

  /**
   * Resolve one shard: its centre, its size (0 when it is not there), its
   * life, a tumble axis and angle, and two rolls for the fragment.
   */
  void shardPlace(float idx, out vec3 center, out float size, out float life,
                  out vec3 spinAxis, out float spinAngle, out float rollA, out float rollB) {
    if (idx < uTrail + 0.5) {
      /* ---- struck off the crystal and left in the wake ---- */
      float period = max(uLife, 0.05);
      float phase = hash11(idx * 1.37 + uSeed * 0.31 + uSalt);
      float loop = uTime / period + phase;
      float generation = floor(loop);
      life = fract(loop);
      float age = life * period;

      float base = idx * 3.71 + generation * 17.13 + uSeed + uSalt;
      float r1 = hash11(base + 1.7);
      float r2 = hash11(base + 5.3);
      float r3 = hash11(base + 9.1);
      float r4 = hash11(base + 13.9);
      vec3  r5 = hash31(base + 21.7);

      float flightAge = max(age - uStopped, 0.0);
      float sBirth = uFront + uLead - flightAge * uHeadSpeed;
      float born = step(0.0, sBirth) * step(uStopped, age);
      float slip = (1.0 - uCarry) * uHeadSpeed * flightAge;
      float sNow = uFront + uLead - slip;

      vec3 tangent, side, up;
      glacialFrame(sNow, tangent, side, up);
      vec3 root = glacialSpine(sNow);

      float a = r1 * TAU;
      vec3 radial = side * cos(a) + up * sin(a);
      vec3 launch = normalize(tangent * uForward + radial * uSpread + 1e-5);
      float speed = uThrow * (0.35 + r2 * 1.3);
      float drag = max(uDrag, 0.001);
      float travel = speed * (1.0 - exp(-drag * age)) / drag;

      center = root + radial * uRadius * (0.15 + r3) + launch * travel
             - vec3(0.0, 0.5 * uGravity * age * age, 0.0);

      float grow = smoothstep(0.0, max(uGrowIn, 0.01), life);
      float die = 1.0 - smoothstep(uShrinkOut, 1.0, life);
      float roll = mix(1.0 - uSizeVariance, 1.0 + uSizeVariance, r4 * r4);
      size = uSize * roll * grow * die * born;

      spinAxis = normalize(r5 * 2.0 - 1.0 + vec3(1e-4));
      spinAngle = (0.4 + r2 * 1.4) * uSpin * TAU * age + r1 * TAU;
      rollA = r2;
      rollB = r3;
    } else {
      /* ---- the shell thrown on the strike ---- */
      float i = idx - uTrail - 1.0;
      float base = i * 5.13 + uSeed + 53.0 + uSalt;
      float r1 = hash11(base + 1.7);
      float r2 = hash11(base + 5.3);
      float r3 = hash11(base + 9.1);
      float r4 = hash11(base + 13.9);
      vec3  r5 = hash31(base + 21.7);

      float age = max(uStopped - r1 * 0.05, 0.0);
      float period = max(uBurstLife, 0.05);
      life = age / period;
      float born = step(0.0001, uStopped) * step(life, 1.0);

      vec3 dir = normalize(r5 * 2.0 - 1.0 + uDir * 0.3 + vec3(1e-4));
      float speed = uBurstThrow * (0.3 + r2 * 1.2);
      float drag = max(uBurstDrag, 0.001);
      float travel = speed * (1.0 - exp(-drag * age)) / drag;

      center = uImpact + dir * travel - vec3(0.0, 0.5 * uGravity * age * age, 0.0);

      float env = smoothstep(0.0, 0.05, life) * (1.0 - smoothstep(0.5, 1.0, life));
      size = uBurstSize * mix(1.0 - uSizeVariance, 1.0 + uSizeVariance, r4 * r4) * env * born;

      spinAxis = normalize(r5.zxy * 2.0 - 1.0 + vec3(1e-4));
      spinAngle = (0.6 + r2 * 1.6) * uSpin * TAU * age + r3 * TAU;
      rollA = r2;
      rollB = r3;
    }
  }
#endif
`;

function shardPlaceUniforms() {
  return {
    uTrail: { value: 120 },
    uLife: { value: 1.8 },
    uHeadSpeed: { value: 26 },
    uLead: { value: -1.4 },
    uRadius: { value: 0.5 },
    uThrow: { value: 2 },
    uForward: { value: 0.2 },
    uSpread: { value: 0.9 },
    uCarry: { value: 0.35 },
    uDrag: { value: 1 },
    uGravity: { value: 1.5 },
    uSize: { value: 0.11 },
    uSizeVariance: { value: 0.6 },
    uSpin: { value: 0.8 },
    uGrowIn: { value: 0.06 },
    uShrinkOut: { value: 0.65 },
    uBurstLife: { value: 1.4 },
    uBurstThrow: { value: 11 },
    uBurstDrag: { value: 2 },
    uBurstSize: { value: 0.14 },
    uImpact: { value: new Vector3() },
    uStopped: { value: 0 },
    uSalt: { value: 0 }
  };
}

function syncShardPlace(u, state) {
  const c = settings.glacial;
  const g = settings.global;

  u.uTrail.value = state.trail;
  u.uHeadSpeed.value = state.headSpeed;
  u.uStopped.value = state.stopped;
  u.uImpact.value.copy(state.impact);

  u.uLife.value = c.shardLife * g.particleLifetime;
  u.uLead.value = c.shardLead;
  u.uRadius.value = c.shardRadius;
  u.uThrow.value = c.shardThrow * g.particleSpeed;
  u.uForward.value = c.shardForward;
  u.uSpread.value = c.shardSpread;
  u.uCarry.value = c.shardCarry;
  u.uDrag.value = c.shardDrag;
  u.uGravity.value = c.shardGravity;
  u.uSize.value = c.shardSize * g.particleSize;
  u.uSizeVariance.value = c.shardSizeVariance * g.randomness;
  u.uSpin.value = c.shardSpin * g.animationSpeed;
  u.uGrowIn.value = c.shardGrowIn;
  u.uShrinkOut.value = c.shardShrinkOut;
  u.uBurstLife.value = c.shardBurstLife * g.particleLifetime;
  u.uBurstThrow.value = c.shardBurstThrow * g.particleSpeed * g.explosionIntensity;
  u.uBurstDrag.value = c.shardBurstDrag;
  u.uBurstSize.value = c.shardBurstSize * g.particleSize;
}

const SHARD_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  attribute float aShard;
  attribute vec3  aBary;
  attribute float aFacing;

  uniform float uTime;
  uniform float uLong;         // how slender the slenderest shard is
  uniform float uFade;

  varying vec3  vBary;
  varying vec3  vNormal;
  varying vec3  vWorld;
  varying float vAxis;
  varying float vLife;
  varying float vRoll;
  varying float vViewZ;

  ${noiseGLSL}
  ${GLACIAL_SPINE_GLSL}
  ${ROTATION_GLSL}
  ${SHARD_PLACE_GLSL}

  void main() {
    vec3 center;
    float size, life, spinAngle, rollA, rollB;
    vec3 spinAxis;
    shardPlace(aShard, center, size, life, spinAxis, spinAngle, rollA, rollB);
    size *= uFade;

    float slender = rollB;
    vec3 scale = vec3(size * mix(1.0, 0.65, slender), size * mix(1.0, uLong, slender), size * mix(1.0, 0.65, slender));
    mat3 rot = rotationAbout(spinAxis, spinAngle);

    vec3 world = center + rot * (position * scale);
    vec3 worldNormal = normalize(rot * (normal / max(scale, vec3(1e-5))));

    vBary = aBary;
    vNormal = worldNormal;
    vWorld = world;
    vAxis = position.y;
    vLife = life;
    vRoll = rollA;

    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const SHARD_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uBands;
  uniform float uPosterize;
  uniform float uTip;          // light through the two points
  uniform float uTipStart;
  uniform float uBack;         // light through the shadow side
  uniform float uBackPower;
  uniform float uTwinkle;
  uniform float uTwinkleSpeed;
  uniform float uFlash;        // white the instant it is struck off
  uniform float uFlashLife;
  uniform float uIntensity;
  uniform float uRolloff;
  uniform float uSoftFade;
  uniform float uFade;

  uniform sampler2D uSceneDepth;
  uniform vec2  uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uShaderIntensity;
  uniform float uGlobalGlow;

  varying vec3  vBary;
  varying vec3  vNormal;
  varying vec3  vWorld;
  varying float vAxis;
  varying float vLife;
  varying float vRoll;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}
  ${ICE_GLSL}

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(cameraPosition - vWorld);
    vec3 K = glacialKey(V);
    float NdotV = clamp(dot(N, V), 0.0, 1.0);

    /* ---- flat facets, stepped: a splinter is a small solid ---- */
    float lambert = dot(N, K) * 0.5 + 0.5;
    float steps = max(uBands, 1.0);
    float banded = floor(lambert * steps + 0.5) / steps;
    float lit = mix(lambert, banded, uPosterize);

    vec3 color = mix(uColorDeep, uColorIce, smoothstep(0.3, 0.66, lit));
    color = mix(color, uColorFrost, smoothstep(0.68, 0.99, lit) * 0.8);

    /* ---- light through the thin side and the two points ---- */
    float back = pow(clamp(dot(-N, K), 0.0, 1.0), max(uBackPower, 0.1));
    color += uColorGlow * back * uBack;
    float tip = smoothstep(uTipStart, 1.0, abs(vAxis));
    color += uColorGlow * tip * uTip;

    color *= uIntensity * uShaderIntensity;
    color /= 1.0 + color * uRolloff;

    /* ---- the light on it ---- */
    float fres = glacialFresnel(NdotV, uRimPower);
    color += glacialEnv(reflect(-V, N)) * fres * 0.6;
    color += glacialRim(NdotV) * uColorFrost;
    color += uColorFrost * glacialEdge(vBary) * uEdge;
    // A glint that blinks per facet as the shard turns.
    float twinkle = snoise01(N * 6.0 + vec3(vRoll * 30.0, uTime * uTwinkleSpeed, 0.0));
    color += glacialSpecular(N, V, K) * mix(1.0, smoothstep(0.35, 0.95, twinkle), uTwinkle);

    float flash = pow(1.0 - clamp(vLife / max(uFlashLife, 0.01), 0.0, 1.0), 3.0);
    color = mix(color, uColorFrost, clamp(flash * uFlash, 0.0, 1.0));

    // Never fades - it shrinks - so alpha is flat and the depth buffer sorts
    // the field against itself.
    float alpha = uFade;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.02) discard;

    gl_FragColor = vec4(color * uGlobalGlow, alpha);
  }
`;

/**
 * @param {object} spine shared uniform block from `createGlacialSpineUniforms()`
 * @param {object} ice   shared ice look block from `createIceLookUniforms()`
 * @param {number} salt  this variant's own rolls - the gems and the splinters
 *                       are two draws of this, and must not fly the same arcs
 * @returns {THREE.ShaderMaterial} with
 *   `userData.sync({ trail, headSpeed, stopped, impact, fade })`
 */
export function createGlacialShardMaterial(spine, ice, salt = 0) {
  const material = new ShaderMaterial({
    name: 'GlacialShard',
    transparent: true,
    depthWrite: true,
    depthTest: true,
    blending: NormalBlending,
    side: FrontSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...spine,
      ...ice,
      ...shardPlaceUniforms(),

      uLong: { value: 2.2 },
      uFade: { value: 1 },

      uBands: { value: 3 },
      uPosterize: { value: 0.7 },
      uTip: { value: 0.6 },
      uTipStart: { value: 0.5 },
      uBack: { value: 0.5 },
      uBackPower: { value: 2 },
      uTwinkle: { value: 0.7 },
      uTwinkleSpeed: { value: 1.5 },
      uFlash: { value: 0.8 },
      uFlashLife: { value: 0.12 },
      uIntensity: { value: 1 },
      uRolloff: { value: 0.5 },
      uSoftFade: { value: 0.2 }
    }),
    vertexShader: SHARD_VERTEX,
    fragmentShader: SHARD_FRAGMENT
  });
  material.uniforms.uSalt.value = salt;

  material.userData.sync = (state) => {
    const c = settings.glacial;
    const g = settings.global;
    const u = material.uniforms;

    syncShardPlace(u, state);
    u.uFade.value = state.fade;

    u.uLong.value = c.shardLong;
    u.uBands.value = c.shardBands;
    u.uPosterize.value = c.shardPosterize;
    u.uTip.value = c.shardTip;
    u.uTipStart.value = c.shardTipStart;
    u.uBack.value = c.shardBack;
    u.uBackPower.value = c.shardBackPower;
    u.uTwinkle.value = c.shardTwinkle * g.randomness;
    u.uTwinkleSpeed.value = c.shardTwinkleSpeed * g.noiseSpeed;
    u.uFlash.value = c.shardFlash;
    u.uFlashLife.value = c.shardFlashLife;
    u.uIntensity.value = c.shardIntensity;
    u.uRolloff.value = c.shardRolloff;
    u.uSoftFade.value = c.shardSoftFade;

    syncIceLook(u);
  };

  return material;
}

const GLINT_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  attribute float aSprite;

  uniform float uTime;
  uniform float uGlintSize;    // x the shard's size
  uniform float uGlintChance;  // how often a facet catches the key
  uniform float uGlintSpeed;
  uniform float uFade;

  varying vec2  vUv;
  varying float vSeed;
  varying float vBright;
  varying float vViewZ;

  ${noiseGLSL}
  ${GLACIAL_SPINE_GLSL}
  ${SHARD_PLACE_GLSL}

  void main() {
    vec3 center;
    float size, life, spinAngle, rollA, rollB;
    vec3 spinAxis;
    shardPlace(aSprite, center, size, life, spinAxis, spinAngle, rollA, rollB);

    // A facet catches the key when the shard has turned onto it: rare, sharp
    // and brief, keyed off the same tumble the shard is making.
    float catchLight = snoise01(vec3(spinAngle * 0.35, aSprite * 0.71, uTime * uGlintSpeed + rollB * 9.0));
    float bright = pow(smoothstep(1.0 - uGlintChance, 1.0, catchLight), 2.0);
    bright *= smoothstep(0.02, 0.15, life) * (1.0 - smoothstep(0.6, 0.95, life));

    float quad = size * uGlintSize * (0.6 + bright * 0.8) * uFade * step(0.001, bright);

    float spin = rollA * TAU;
    float cs = cos(spin);
    float sn = sin(spin);
    vec2 q = vec2(position.x * cs - position.y * sn, position.x * sn + position.y * cs);

    vec4 mv = viewMatrix * vec4(center, 1.0);
    // A hair toward the eye, so it draws over the shard that threw it.
    mv.z += 0.03;
    mv.xy += q * quad;

    vUv = position.xy;
    vSeed = aSprite * 1.3 + rollA;
    vBright = bright;
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const GLINT_FRAGMENT = /* glsl */ `
  uniform float uCoreTight;
  uniform float uRays;
  uniform float uRaySharp;
  uniform float uIntensity;
  uniform float uSoftFade;
  uniform float uFade;
  uniform vec3  uColorCore;
  uniform vec3  uColorRays;

  uniform sampler2D uSceneDepth;
  uniform vec2  uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uShaderIntensity;
  uniform float uGlobalGlow;

  varying vec2  vUv;
  varying float vSeed;
  varying float vBright;
  varying float vViewZ;

  ${commonGLSL}

  void main() {
    vec2 p = vUv;
    float d = length(p);
    float core = exp(-d * d * uCoreTight);
    float rx = pow(max(1.0 - abs(p.x), 0.0), 2.0) * exp(-abs(p.y) * uRaySharp);
    float ry = pow(max(1.0 - abs(p.y), 0.0), 2.0) * exp(-abs(p.x) * uRaySharp);
    float energy = (core + (rx + ry) * uRays) * vBright;
    if (energy < 0.003) discard;

    vec3 color = mix(uColorRays, uColorCore, clamp(core * 1.5, 0.0, 1.0));
    color *= energy * uIntensity * uShaderIntensity;

    float alpha = clamp(energy, 0.0, 1.0) * uFade;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    color *= uGlobalGlow;
    color /= 1.0 + color * 0.15;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * @param {object} spine shared uniform block from `createGlacialSpineUniforms()`
 * @param {number} salt  the same salt as the shard draw the glints ride
 * @returns {THREE.ShaderMaterial} with
 *   `userData.sync({ trail, headSpeed, stopped, impact, fade })`
 */
export function createGlacialGlintMaterial(spine, salt = 0) {
  const material = new ShaderMaterial({
    name: 'GlacialGlint',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...spine,
      ...shardPlaceUniforms(),

      uGlintSize: { value: 4 },
      uGlintChance: { value: 0.3 },
      uGlintSpeed: { value: 2 },
      uFade: { value: 1 },

      uCoreTight: { value: 12 },
      uRays: { value: 1 },
      uRaySharp: { value: 16 },
      uIntensity: { value: 2.2 },
      uSoftFade: { value: 0.15 },
      uColorCore: { value: new Color(1, 1, 1) },
      uColorRays: { value: new Color(0.75, 0.92, 1) }
    }),
    vertexShader: GLINT_VERTEX,
    fragmentShader: GLINT_FRAGMENT
  });
  material.uniforms.uSalt.value = salt;

  material.userData.sync = (state) => {
    const c = settings.glacial;
    const g = settings.global;
    const u = material.uniforms;

    syncShardPlace(u, state);
    u.uFade.value = state.fade;

    u.uGlintSize.value = c.glintSize;
    u.uGlintChance.value = c.glintChance;
    u.uGlintSpeed.value = c.glintSpeed * g.noiseSpeed;
    u.uCoreTight.value = c.glintCoreTight;
    u.uRays.value = c.glintRays;
    u.uRaySharp.value = c.glintRaySharp;
    u.uIntensity.value = c.glintIntensity;
    u.uSoftFade.value = c.glintSoftFade;
    u.uColorCore.value.copy(getColor(c.colorGlintCore));
    u.uColorRays.value.copy(getColor(c.colorGlint));
  };

  return material;
}

/* ------------------------------------------------------------------ */
/* 5 · the refractive distortion                                       */
/* ------------------------------------------------------------------ */

const WARP_VERTEX = /* glsl */ `
  uniform float uWidth;
  uniform vec3  uHeading;

  varying vec2 vUv;
  varying vec2 vDirView;

  void main() {
    vUv = uv;

    // Which way forward is on screen: the bow wave stands ahead of the nose.
    vec2 dv = (viewMatrix * vec4(uHeading, 0.0)).xy;
    vDirView = length(dv) > 1e-4 ? normalize(dv) : vec2(0.0, 1.0);

    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mv.xy += position.xy * uWidth;
    gl_Position = projectionMatrix * mv;
  }
`;

const WARP_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSeedLocal;
  uniform float uLens;         // the glass ball: the frame pulled in toward the crystal
  uniform float uLensSize;     // its radius, x the quad
  uniform float uLensPower;
  uniform float uBow;          // the wave standing ahead of the nose
  uniform float uBowRadius;
  uniform float uBowWidth;
  uniform float uRing;         // the rings it sheds
  uniform float uRingRate;
  uniform float uRingWidth;
  uniform float uBurst;        // 0..1 - how much of the strike's ring is left
  uniform float uBurstFront;   // 0..1 - where that ring has got to
  uniform float uBurstWidth;
  uniform float uStrength;
  uniform float uFade;
  uniform float uShaderIntensity;

  varying vec2 vUv;
  varying vec2 vDirView;

  ${noiseGLSL}

  void main() {
    vec2 c = (vUv - 0.5) * 2.0;
    float d = length(c);
    if (d > 1.0) discard;
    float edge = 1.0 - smoothstep(0.72, 1.0, d);
    vec2 radial = d > 1e-4 ? c / d : vec2(0.0, 1.0);

    /* --- the glass ball --- */
    // A sphere bends the frame in toward its centre, harder toward its rim.
    float inside = 1.0 - smoothstep(0.0, max(uLensSize, 0.01), d);
    float lens = pow(inside, max(uLensPower, 0.2)) * (d / max(uLensSize, 0.01));
    lens *= uLens;

    /* --- the bow wave ahead of the nose --- */
    float ahead = dot(radial, vDirView);
    float bd = d - uBowRadius;
    float bow = exp(-(bd * bd) / max(1e-4, uBowWidth * uBowWidth)) * smoothstep(-0.2, 0.7, ahead) * uBow;

    /* --- the rings it sheds --- */
    float front = fract(uTime * uRingRate + uSeedLocal);
    float rd = d - front;
    float ring = exp(-(rd * rd) / max(1e-4, uRingWidth * uRingWidth)) * (1.0 - front) * uRing;

    /* --- and the one the strike fires --- */
    float sd = d - uBurstFront;
    float burst = uBurst * exp(-(sd * sd) / max(1e-4, uBurstWidth * uBurstWidth));

    vec2 offset = (-radial * lens + radial * (bow + ring * sin(rd * 12.0))) * uFade + radial * burst * sin(sd * 9.0);
    offset = clamp(offset, vec2(-1.0), vec2(1.0));

    // The ball of glass goes with the crystal; the ring it fired does not.
    float mask = clamp((lens + bow + ring) * uFade + burst, 0.0, 1.0) * edge;
    if (mask < 0.003) discard;

    gl_FragColor = vec4(offset * 0.5 + 0.5, uStrength * uShaderIntensity, mask);
  }
`;

/**
 * @returns {THREE.ShaderMaterial} with `userData.sync(state)`, where state is
 *   `{ heading, size, seed, burst, burstFront, fade }`
 */
export function createGlacialWarpMaterial() {
  const material = new ShaderMaterial({
    name: 'GlacialWarp',
    transparent: true,
    depthWrite: false,
    // Off, like every other distortion proxy: the buffer is a full-screen
    // instruction to the composer, not a thing standing in the world.
    depthTest: false,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uWidth: { value: 4 },
      uHeading: { value: new Vector3(0, 0, 1) },
      uSeedLocal: { value: 0 },
      uLens: { value: 0.7 },
      uLensSize: { value: 0.45 },
      uLensPower: { value: 1.4 },
      uBow: { value: 0.5 },
      uBowRadius: { value: 0.55 },
      uBowWidth: { value: 0.08 },
      uRing: { value: 0.35 },
      uRingRate: { value: 1.4 },
      uRingWidth: { value: 0.1 },
      uBurst: { value: 0 },
      uBurstFront: { value: 0 },
      uBurstWidth: { value: 0.2 },
      uStrength: { value: 1 },
      uFade: { value: 1 }
    }),
    vertexShader: WARP_VERTEX,
    fragmentShader: WARP_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.glacial;
    const g = settings.global;
    const u = material.uniforms;

    u.uHeading.value.copy(state.heading);
    u.uWidth.value = state.size;
    u.uSeedLocal.value = state.seed;
    u.uBurst.value = state.burst;
    u.uBurstFront.value = state.burstFront;
    u.uFade.value = state.fade;

    u.uLens.value = c.warpLens;
    u.uLensSize.value = c.warpLensSize;
    u.uLensPower.value = c.warpLensPower;
    u.uBow.value = c.warpBow;
    u.uBowRadius.value = c.warpBowRadius;
    u.uBowWidth.value = c.warpBowWidth;
    u.uRing.value = c.warpRing;
    u.uRingRate.value = c.warpRingRate * g.animationSpeed;
    u.uRingWidth.value = c.warpRingWidth;
    u.uBurstWidth.value = c.warpBurstWidth;
    u.uStrength.value = c.warpStrength * g.distortion;
  };

  return material;
}
