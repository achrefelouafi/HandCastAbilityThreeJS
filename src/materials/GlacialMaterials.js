import {
  AddEquation,
  AdditiveBlending,
  Color,
  CustomBlending,
  DoubleSide,
  MeshDepthMaterial,
  MeshPhysicalMaterial,
  NormalBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  RGBADepthPacking,
  ShaderMaterial
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame, sharedUniforms } from '../core/FrameUniforms.js';
import { ICE_MAX_CHUNKS } from '../effects/IceStatue.js';
import { patchOnBeforeCompile } from '../utils/shaderPatch.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate } from '../utils/math.js';

/**
 * THE GLACIAL PRISON — every material the aura draws with.
 *
 * Six layers off the breakdown sheet and one idea under all of them: **it is
 * all the same ice.** The wall, the floor, the crystals and the bodies frozen
 * inside share one palette (`iceUniforms`) and one way of being lit
 * (`ICE_GLSL`): a deep glacial blue that clear ice lets you see into, a paler
 * body where it is thick, a frost white where air has been trapped in it, and
 * the cold light of the aura itself lighting all of it from below. Every
 * surface reflects the stage's own HDR probe through the same equirect
 * lookup and takes the same sun highlight, so a shard of a shattered body
 * lying on the frozen floor is visibly a piece of the floor's material.
 *
 *   1 wall   the ice cylinder: a translucent shell with vertical striations,
 *            frost patches, a fresnel rim, sun and probe reflections, the
 *            far wall dimmer through the near one; and a refraction proxy on
 *            the distortion layer so the stage bends through it
 *   3 floor  the ground ice: a sheet with cracks glowing from within, drawn
 *            at a parallax depth so the ice has thickness, hoarfrost feathers
 *            beyond the rim, a freeze front that races out when it lands
 *   5 shards the crystals: faceted prisms, instanced — a crown at the foot
 *            of the wall and splinters rising through the air inside it
 *   6 glow   a soft card of cold light over the centre
 *   bodies   a body turned to ice: a real PBR material patched to carry the
 *            frost climbing it, the cracks spreading over it, the break and
 *            the melt — see effects/IceStatue.js for what it is drawn on
 */

/* ------------------------------------------------------------------ */
/* the ice everything is made of                                      */
/* ------------------------------------------------------------------ */

export const ICE_UNIFORMS_GLSL = /* glsl */ `
  uniform vec3  uColorDeep;
  uniform vec3  uColorIce;
  uniform vec3  uColorFrost;
  uniform vec3  uColorGlow;
  uniform sampler2D uEnvMap;
  uniform float uEnvStrength;
  uniform vec3  uSunColor;
  uniform float uSunSpec;
`;

/**
 * How ice is lit, shared by every raw shader here and by the body patch.
 *
 * No packing helpers, so it is safe inside a built-in material's fragment.
 */
export const ICE_GLSL = /* glsl */ `
  #define ICE_TAU 6.283185307179586

  vec2 iceEquirect(vec3 d) {
    float u = atan(d.z, d.x) * 0.15915494309 + 0.5;
    float v = asin(clamp(d.y, -1.0, 1.0)) * 0.31830988618 + 0.5;
    return vec2(u, v);
  }

  /* The stage probe, seen in the ice. */
  vec3 iceEnv(vec3 dir) {
    return texture2D(uEnvMap, iceEquirect(dir)).rgb * uEnvStrength;
  }

  /* Ice has an index of 1.31: almost nothing head-on, everything at a graze. */
  float iceFresnel(float NdotV, float power) {
    return 0.02 + 0.98 * pow(1.0 - NdotV, power);
  }

  /* One tight sun highlight. */
  vec3 iceSpecular(vec3 N, vec3 V, vec3 L, float shininess) {
    vec3 H = normalize(L + V);
    return uSunColor * pow(max(dot(N, H), 0.0), shininess) * uSunSpec;
  }

  /* Two-band frost: white where the air is trapped, clear elsewhere. */
  float iceFrostPatch(vec3 p, float scale, float seed) {
    return smoothstep(0.25, 0.72, fbm3(p * scale + seed) * 0.5 + 0.5);
  }

  /* F2 - F1 Voronoi in the plane: cells with a distance to their edges. */
  float iceVoronoiEdge(vec2 p, out float id) {
    vec2 n = floor(p);
    vec2 f = fract(p);
    float d1 = 8.0;
    float d2 = 8.0;
    id = 0.0;
    for (int j = -1; j <= 1; j++) {
      for (int i = -1; i <= 1; i++) {
        vec2 g = vec2(float(i), float(j));
        vec2 o = hash21(dot(n + g, vec2(7.13, 113.17)));
        vec2 r = g + o - f;
        float d = dot(r, r);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          id = hash11(dot(n + g, vec2(31.7, 57.1)));
        } else if (d < d2) {
          d2 = d;
        }
      }
    }
    return sqrt(d2) - sqrt(d1);
  }
`;

/** The palette and the probe, shared by identity across one cast's materials. */
export function iceUniforms() {
  return {
    uColorDeep: { value: new Color(0.05, 0.23, 0.37) },
    uColorIce: { value: new Color(0.49, 0.78, 0.93) },
    uColorFrost: { value: new Color(0.92, 0.97, 1.0) },
    uColorGlow: { value: new Color(0.56, 0.89, 1.0) },
    uEnvMap: frame.uEnvMap,
    uEnvStrength: { value: 1 },
    uSunColor: { value: new Color(1, 0.95, 0.85) },
    uSunSpec: { value: 1 }
  };
}

/** Push the palette from settings. `c` is the ability block. */
export function syncIce(u, c) {
  u.uColorDeep.value.copy(getColor(c.colorDeep));
  u.uColorIce.value.copy(getColor(c.colorIce));
  u.uColorFrost.value.copy(getColor(c.colorFrost));
  u.uColorGlow.value.copy(getColor(c.colorGlow));
  u.uEnvStrength.value = c.envStrength * settings.environment.envIntensity;
  u.uSunColor.value.copy(getColor(settings.environment.sunColor));
  u.uSunSpec.value = c.sunSpec * saturate(settings.environment.sunIntensity / 3);
}

/** Premultiplied over: lit colour times alpha, plus an additive glow. */
const PREMULTIPLIED = {
  transparent: true,
  depthWrite: false,
  blending: CustomBlending,
  blendEquation: AddEquation,
  blendSrc: OneFactor,
  blendDst: OneMinusSrcAlphaFactor,
  blendSrcAlpha: OneFactor,
  blendDstAlpha: OneMinusSrcAlphaFactor,
  toneMapped: false
};

/* ------------------------------------------------------------------ */
/* 3 · the ground ice                                                  */
/* ------------------------------------------------------------------ */

const FLOOR_VERTEX = /* glsl */ `
  uniform float uOuter;
  varying vec2 vLocal;
  varying vec3 vWorld;
  void main() {
    // A unit disc laid flat: metres from the centre come off xz, never y.
    vLocal = position.xz * uOuter;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const FLOOR_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uRadius;
  uniform float uOuter;
  uniform float uFront;
  uniform float uSeed;
  uniform float uOpacity;
  uniform float uFrost;
  uniform float uFrostScale;
  uniform float uCrackScale;
  uniform float uCrackWidth;
  uniform float uCrackGlow;
  uniform float uDepth;
  uniform float uSpokes;
  uniform float uFootGlow;
  uniform float uSparkle;
  uniform float uPulse;
  uniform float uFade;
  uniform float uGlowFade;
  uniform vec3  uLightDir;
  ${ICE_UNIFORMS_GLSL}
  varying vec2 vLocal;
  varying vec3 vWorld;
  ${noiseGLSL}
  ${ICE_GLSL}

  /* Radial cracks out of the centre: the sheet failed from the point in. */
  float spokes(vec2 local, float r, float R, float count, float width, float seed) {
    float a = atan(local.y, local.x) / ICE_TAU + 0.5;
    float k = a * count;
    float cell = floor(k);
    float f = fract(k);
    float centre = 0.5 + (hash11(cell + seed) - 0.5) * 0.45 + snoise(vec3(r * 1.7, cell * 3.1, seed)) * 0.1;
    float dist = abs(f - centre) * ICE_TAU / count * r;
    float w = width * (1.4 - 0.9 * clamp(r / R, 0.0, 1.0));
    float line = 1.0 - smoothstep(0.0, max(w, 1e-3), dist);
    float reach = R * (0.6 + 0.45 * hash11(cell * 7.7 + seed));
    return line * smoothstep(0.06 * R, 0.22 * R, r) * (1.0 - smoothstep(reach - 0.25, reach, r));
  }

  void main() {
    float r = length(vLocal);
    float R = uRadius;
    if (r > uFront) discard;
    vec2 dir = vLocal / max(r, 1e-4);
    vec3 V = normalize(cameraPosition - vWorld);

    /* ---- the sheet, its ragged rim, and the hoarfrost beyond it ---- */
    float rimNoise = snoise(vec3(dir * 2.6, uSeed)) * 0.1 * R;
    float sheet = 1.0 - smoothstep(R + rimNoise - 0.1, R + rimNoise + 0.1, r);
    float reach = (r - R) / max(uOuter - R, 0.05);
    float feather = fbm3(vec3(vLocal * uFrostScale, uSeed + 3.0)) * 0.5 + 0.5;
    feather = feather * 0.7 + (ridged(vec3(vLocal * uFrostScale * 2.3, uSeed), 3) - 0.4) * 0.5;
    float frost = smoothstep(0.1, 0.75, feather - reach * 1.15) * (1.0 - sheet) * (1.0 - smoothstep(0.8, 1.0, reach));

    /* ---- the surface ---- */
    vec3 N = normalize(vec3(
      snoise(vec3(vLocal * 5.0, uSeed)) * 0.05,
      1.0,
      snoise(vec3(vLocal * 5.0 + 7.0, uSeed)) * 0.05
    ));
    float NdotV = clamp(dot(N, V), 0.0, 1.0);
    float fres = iceFresnel(NdotV, 3.0);
    float frosted = iceFrostPatch(vec3(vLocal, 0.0), 2.0, uSeed);

    // Clear ice lets the deep colour through; frosted ice is a pale body.
    vec3 body = mix(uColorDeep, uColorIce, 0.3 + 0.7 * frosted);
    body = mix(body, uColorFrost, frosted * 0.55);
    float lambert = 0.55 + 0.45 * max(dot(N, uLightDir), 0.0);
    vec3 lit = body * lambert;
    vec3 refl = reflect(-V, N);
    lit += iceEnv(refl) * (0.12 + 0.7 * fres) * (1.0 - frosted * 0.5);
    lit += iceSpecular(N, V, uLightDir, 110.0) * (1.0 - frosted * 0.4);

    // Glitter: tiny facets in the frost catching the sun.
    vec3 Nj = normalize(N + vec3(hash21(floor(vLocal.x * 60.0) + floor(vLocal.y * 60.0) * 131.0) - 0.5, 0.0).xzy * 0.5);
    vec3 H = normalize(uLightDir + V);
    float twinkle = 0.5 + 0.5 * sin(uTime * 3.0 + hash11(floor(vLocal.x * 60.0) * 3.7 + floor(vLocal.y * 60.0)) * 40.0);
    lit += uSunColor * pow(max(dot(Nj, H), 0.0), 60.0) * twinkle * uSparkle * (0.3 + 0.7 * frosted) * uSunSpec;

    /* ---- what is under the surface: cracks at a depth ---- */
    // The sheet has thickness. A layer a little way down is seen through
    // the surface from where the camera is, so it shifts against the top
    // as the view moves - which is the whole read of a slab rather than a
    // decal.
    vec2 deepLocal = vLocal - V.xz * (uDepth / max(V.y, 0.2));
    float id;
    float edge = iceVoronoiEdge(deepLocal * uCrackScale + uSeed, id);
    float web = 1.0 - smoothstep(0.0, uCrackWidth * uCrackScale, edge);
    web *= 0.55 + 0.45 * id;
    float rays = spokes(deepLocal, length(deepLocal), R, uSpokes, uCrackWidth, uSeed);
    float ring = 1.0 - smoothstep(0.0, uCrackWidth * 1.3, abs(length(deepLocal) - R * (0.52 + snoise(vec3(dir * 3.0, uSeed + 9.0)) * 0.05)));
    ring *= smoothstep(0.3, 0.6, hash11(floor(atan(deepLocal.y, deepLocal.x) * 3.0) + uSeed));
    float crack = max(max(web * 0.8, rays), ring * 0.7) * sheet;
    crack *= smoothstep(0.0, 0.25 * R, r);

    // And deeper still, a haze of trapped air.
    vec2 deeper = vLocal - V.xz * (uDepth * 2.2 / max(V.y, 0.2));
    float haze = smoothstep(0.35, 0.9, fbm3(vec3(deeper * 1.4, uSeed + 5.0)) * 0.5 + 0.5) * sheet;
    lit = mix(lit, uColorFrost * 0.7, haze * 0.25);

    /* ---- the cold light in it ---- */
    float pulse = 1.0 + uPulse * sin(uTime * 1.6 + r * 1.5);
    vec3 glow = uColorGlow * crack * uCrackGlow * pulse * uGlowFade;
    // Where the wall stands.
    glow += uColorGlow * exp(-pow((r - R) / 0.09, 2.0)) * uFootGlow * uGlowFade;
    // The freeze front racing outward when it lands.
    float front = exp(-pow((uFront - r) / 0.22, 2.0)) * (1.0 - smoothstep(uOuter - 0.4, uOuter, uFront));
    glow += uColorFrost * front * 2.6;

    /* ---- alpha ---- */
    float alpha = clamp(sheet * uOpacity + frost * uFrost, 0.0, 1.0);
    alpha = max(alpha, front * 0.9) * uFade;
    glow *= uFade;
    if (alpha < 0.003 && dot(glow, glow) < 1e-6) discard;
    gl_FragColor = vec4(lit * alpha + glow, alpha);
  }
`;

export function createIceFloorMaterial(ice) {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      ...ice,
      uRadius: { value: 3 },
      uOuter: { value: 4 },
      uFront: { value: 0 },
      uSeed: { value: Math.random() * 10 },
      uOpacity: { value: 0.85 },
      uFrost: { value: 0.75 },
      uFrostScale: { value: 1.6 },
      uCrackScale: { value: 1.1 },
      uCrackWidth: { value: 0.035 },
      uCrackGlow: { value: 1.6 },
      uDepth: { value: 0.12 },
      uSpokes: { value: 9 },
      uFootGlow: { value: 1.2 },
      uSparkle: { value: 1 },
      uPulse: { value: 0.25 },
      uFade: { value: 1 },
      uGlowFade: { value: 1 }
    }),
    vertexShader: FLOOR_VERTEX,
    fragmentShader: FLOOR_FRAGMENT,
    side: DoubleSide,
    depthTest: true,
    ...PREMULTIPLIED
  });
}

/* ------------------------------------------------------------------ */
/* 1 · the ice cylinder                                                */
/* ------------------------------------------------------------------ */

const WALL_VERTEX = /* glsl */ `
  uniform float uReveal;
  uniform float uHeight;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec2 vUv;
  varying float vH;
  varying float vY;
  void main() {
    // A unit tube standing on y = 0. It grows out of the floor: the top is
    // pulled down to uReveal of the height, so every fragment knows both
    // where it sits on the finished wall (vH) and how high it is in metres.
    vec3 p = position;
    p.y *= uReveal;
    vec4 world = modelMatrix * vec4(p, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vUv = uv;
    vH = position.y;
    vY = p.y * uHeight;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const WALL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uReveal;
  uniform float uHeight;
  uniform float uRadius;
  uniform float uOpacity;
  uniform float uBody;
  uniform float uTopFade;
  uniform float uRimPower;
  uniform float uRimGlow;
  uniform float uFrostScale;
  uniform float uFrostAmount;
  uniform float uStriaScale;
  uniform float uFlow;
  uniform float uCaustic;
  uniform float uFootGlow;
  uniform float uCrackAmount;
  uniform float uBurn;
  uniform float uFade;
  uniform float uSeed;
  uniform vec3  uLightDir;
  ${ICE_UNIFORMS_GLSL}
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec2 vUv;
  varying float vH;
  varying float vY;
  ${noiseGLSL}
  ${ICE_GLSL}

  void main() {
    vec3 V = normalize(cameraPosition - vWorld);
    vec3 N = normalize(vNormal);
    float facing = dot(N, V);
    bool far = facing < 0.0;
    if (far) N = -N;
    float NdotV = abs(facing);
    float ang = vUv.x * ICE_TAU;
    vec2 around = vec2(cos(ang), sin(ang)) * uRadius;

    /* ---- the ice froze upward: vertical striations and a slow flow ---- */
    float stria = fbm3(vec3(around * uStriaScale, vY * 0.12 + uSeed)) * 0.5 + 0.5;
    float flow = snoise(vec3(around * 0.9, vY * 0.55 - uTime * uFlow + uSeed));
    float frosted = iceFrostPatch(vWorld + vec3(0.0, -uTime * 0.04, 0.0), uFrostScale, uSeed) * uFrostAmount;

    /* ---- a hairline of cracks, cells stretched up the wall ---- */
    float id;
    float edge = iceVoronoiEdge(vec2(ang * uRadius * 0.7, vY * 0.3) + uSeed, id);
    float cracks = (1.0 - smoothstep(0.0, 0.035, edge)) * uCrackAmount * (0.4 + 0.6 * id);

    /* ---- the profile: thick at the foot, thinning away toward the top ---- */
    float top = 1.0 - smoothstep(uTopFade, 1.0, vH + (stria - 0.5) * 0.08);
    float foot = exp(-vY * 2.4);
    // The lip: a faint bright ellipse where the tube ends.
    float lip = exp(-pow((1.0 - vH) / 0.02, 2.0)) * smoothstep(0.96, 1.02, uReveal) * (1.0 - step(0.001, uBurn));

    /* ---- death: it goes from the top down, a rime edge leading ---- */
    float burnLine = 1.0 - uBurn * 1.3 + (stria - 0.5) * 0.35;
    if (vH > burnLine) discard;
    float rime = (1.0 - smoothstep(0.0, 0.07, burnLine - vH)) * step(0.001, uBurn);

    /* ---- and the rising edge while it grows ---- */
    float grow = (1.0 - smoothstep(0.0, 0.08, uReveal - vH)) * (1.0 - smoothstep(0.92, 1.0, uReveal));

    /* ---- shading ---- */
    float fres = iceFresnel(NdotV, uRimPower);
    vec3 body = mix(uColorIce, uColorFrost, frosted);
    body = mix(body, uColorDeep, (1.0 - frosted) * 0.45 * (1.0 - fres));
    float lambert = 0.45 + 0.55 * (0.5 + 0.5 * dot(N, uLightDir));
    vec3 lit = body * lambert * (0.75 + 0.5 * stria);
    vec3 refl = reflect(-V, N);
    lit += iceEnv(refl) * (0.06 + 0.5 * fres) * (1.0 - frosted * 0.6);
    lit += iceSpecular(N, V, uLightDir, 70.0) * (1.0 - frosted * 0.5);

    /* ---- the light in it ---- */
    float caustic = pow(clamp(flow * 0.5 + 0.5, 0.0, 1.0), 5.0) * (1.0 - frosted * 0.7);
    vec3 glow = uColorGlow * caustic * uCaustic;
    glow += uColorGlow * foot * uFootGlow;
    glow += uColorGlow * fres * uRimGlow;
    glow += uColorGlow * cracks * 0.8;
    glow += uColorFrost * (rime * 3.0 + grow * 2.5) + uColorGlow * lip * 0.9;

    /* ---- alpha ---- */
    float alpha = uBody * (0.6 + 0.4 * stria) + frosted * 0.3 + fres * 0.8 + cracks * 0.35;
    alpha = clamp(alpha, 0.0, 1.0) * top * uOpacity;
    alpha = max(alpha, lip * 0.5);
    // The far wall, seen through the near one, is dimmer - what says the tube
    // is a shell of ice rather than a painted cylinder.
    if (far) {
      alpha *= 0.55;
      glow *= 0.5;
    }
    alpha = max(alpha, max(rime, grow) * 0.8) * uFade;
    glow *= uFade;
    if (alpha < 0.003) discard;
    gl_FragColor = vec4(lit * alpha + glow * (0.6 + 0.4 * top), alpha);
  }
`;

export function createIceWallMaterial(ice) {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      ...ice,
      uReveal: { value: 0 },
      uHeight: { value: 4 },
      uRadius: { value: 3 },
      uOpacity: { value: 0.6 },
      uBody: { value: 0.18 },
      uTopFade: { value: 0.55 },
      uRimPower: { value: 2.4 },
      uRimGlow: { value: 0.6 },
      uFrostScale: { value: 1.4 },
      uFrostAmount: { value: 0.5 },
      uStriaScale: { value: 2.0 },
      uFlow: { value: 0.35 },
      uCaustic: { value: 0.35 },
      uFootGlow: { value: 0.9 },
      uCrackAmount: { value: 0.4 },
      uBurn: { value: 0 },
      uFade: { value: 1 },
      uSeed: { value: Math.random() * 10 }
    }),
    vertexShader: WALL_VERTEX,
    fragmentShader: WALL_FRAGMENT,
    side: DoubleSide,
    depthTest: true,
    ...PREMULTIPLIED
  });
}

/**
 * The wall's refraction: nothing is drawn, the stage bends through it.
 *
 * Lives on LAYER.DISTORTION and writes what `DistortionShader` reads —
 * R,G an offset about 0.5, B its strength, A the coverage. The offset is
 * the wall's normal turned into a screen direction, so the frame is pushed
 * *across* the tube the way a thick glass cylinder displaces what is behind
 * it, modulated by the same striations the visible wall carries.
 */
const REFRACT_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uRadius;
  uniform float uStrength;
  uniform float uTopFade;
  uniform float uStriaScale;
  uniform float uBurn;
  uniform float uFade;
  uniform float uSeed;
  uniform float uShaderIntensity;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec2 vUv;
  varying float vH;
  varying float vY;
  ${noiseGLSL}

  void main() {
    vec3 N = normalize(vNormal);
    float ang = vUv.x * 6.283185307179586;
    vec2 around = vec2(cos(ang), sin(ang)) * uRadius;
    float stria = fbm3(vec3(around * uStriaScale, vY * 0.12 + uSeed)) * 0.5 + 0.5;
    float top = 1.0 - smoothstep(uTopFade, 1.0, vH + (stria - 0.5) * 0.3);
    float burnLine = 1.0 - uBurn * 1.3 + (stria - 0.5) * 0.35;
    if (vH > burnLine) discard;

    vec2 screenDir = (viewMatrix * vec4(N, 0.0)).xy;
    float len = length(screenDir);
    screenDir = len > 1e-4 ? screenDir / len : vec2(0.0, 1.0);
    vec2 offset = screenDir * (0.55 + 0.45 * stria);
    float strength = uStrength * uShaderIntensity * (0.6 + 0.4 * stria);
    float coverage = top * uFade;
    if (coverage < 0.01) discard;
    gl_FragColor = vec4(offset * 0.5 + 0.5, strength, coverage);
  }
`;

export function createWallRefractionMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uReveal: { value: 0 },
      uHeight: { value: 4 },
      uRadius: { value: 3 },
      uStrength: { value: 0.5 },
      uTopFade: { value: 0.55 },
      uStriaScale: { value: 2.0 },
      uBurn: { value: 0 },
      uFade: { value: 1 },
      uSeed: { value: 0 }
    }),
    vertexShader: WALL_VERTEX,
    fragmentShader: REFRACT_FRAGMENT,
    side: DoubleSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: NormalBlending
  });
}

/* ------------------------------------------------------------------ */
/* 5 · the crystals                                                    */
/* ------------------------------------------------------------------ */

const CRYSTAL_VERTEX = /* glsl */ `
  attribute vec2 aData;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vLocalY;
  varying float vFade;
  varying float vSeed;
  void main() {
    #ifdef USE_INSTANCING
      mat4 m = modelMatrix * instanceMatrix;
    #else
      mat4 m = modelMatrix;
    #endif
    vec4 world = m * vec4(position, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(mat3(m) * normal);
    vLocalY = position.y;
    vFade = aData.x;
    vSeed = aData.y;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const CRYSTAL_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uOpacity;
  uniform float uScreenKey;
  uniform float uInclusions;
  uniform float uRim;
  uniform float uFade;
  uniform vec3  uLightDir;
  ${ICE_UNIFORMS_GLSL}
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying float vLocalY;
  varying float vFade;
  varying float vSeed;
  ${noiseGLSL}
  ${ICE_GLSL}

  void main() {
    if (vFade < 0.002) discard;
    vec3 N = normalize(vNormal);
    vec3 V = normalize(cameraPosition - vWorld);
    if (dot(N, V) < 0.0) N = -N;

    // The key is blended toward the camera: a prism lit only by the overhead
    // sun lands its visible facets on one value and reads as a cut-out. A
    // key that sits upper-left of the view guarantees a lit face and a
    // shadow face on every crystal from every angle.
    vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 screenKey = normalize(-camRight * 0.6 + camUp * 0.75 + V * 0.35);
    vec3 L = normalize(mix(uLightDir, screenKey, uScreenKey));

    float NdotL = dot(N, L);
    float NdotV = clamp(dot(N, V), 0.0, 1.0);
    float lambert = 0.5 + 0.5 * NdotL;
    float fres = iceFresnel(NdotV, 3.0);

    // Inclusions: frost trapped a little way inside, sampled along the view
    // so it sits behind the facet rather than on it.
    float incl = fbm3((vWorld - V * 0.04) * uInclusions + vSeed * 3.0) * 0.5 + 0.5;
    float frosted = smoothstep(0.3, 0.75, incl);

    vec3 body = mix(uColorDeep, uColorIce, 0.35 + 0.65 * lambert);
    body = mix(body, uColorFrost, frosted * 0.5);
    vec3 lit = body * lambert;
    // Light through the thin tip.
    float tip = smoothstep(0.25, 1.0, vLocalY);
    float through = pow(clamp(-NdotL * 0.5 + 0.5, 0.0, 1.0), 2.0) * tip;
    lit += uColorGlow * through * 0.5;
    vec3 refl = reflect(-V, N);
    lit += iceEnv(refl) * (0.2 + 0.8 * fres) * (1.0 - frosted * 0.5);
    lit += iceSpecular(N, V, L, 90.0);

    // A glint that twinkles per facet as the crystal turns.
    vec3 H = normalize(L + V);
    float tw = snoise(N * 5.0 + vec3(vSeed * 10.0, uTime * 1.3, -uTime * 0.7));
    vec3 glow = uSunColor * smoothstep(0.7, 0.95, tw) * pow(max(dot(N, H), 0.0), 6.0) * 1.2;
    glow += uColorGlow * fres * uRim;

    float alpha = (0.72 + 0.28 * frosted) * vFade * uOpacity * uFade;
    gl_FragColor = vec4(lit * alpha + glow * vFade * uFade, alpha);
  }
`;

export function createIceCrystalMaterial(ice) {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      ...ice,
      uOpacity: { value: 0.9 },
      uScreenKey: { value: 0.55 },
      uInclusions: { value: 5 },
      uRim: { value: 0.8 },
      uFade: { value: 1 }
    }),
    vertexShader: CRYSTAL_VERTEX,
    fragmentShader: CRYSTAL_FRAGMENT,
    side: DoubleSide,
    ...PREMULTIPLIED,
    // Near-opaque solids: they sort against each other through the depth
    // buffer rather than by draw order.
    depthWrite: true,
    depthTest: true
  });
}

/* ------------------------------------------------------------------ */
/* 6 · the ambient glow                                                */
/* ------------------------------------------------------------------ */

const GLOW_VERTEX = /* glsl */ `
  uniform float uWidth;
  uniform float uHeight;
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 2.0;
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mv.xy += position.xy * vec2(uWidth, uHeight);
    gl_Position = projectionMatrix * mv;
  }
`;

const GLOW_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  uniform float uPulse;
  uniform float uPulseSpeed;
  uniform float uFade;
  uniform vec3 uColorGlow;
  uniform vec3 uColorFrost;
  varying vec2 vUv;
  ${noiseGLSL}
  void main() {
    float d = length(vUv);
    if (d > 1.0) discard;
    float breath = 1.0 + uPulse * sin(uTime * uPulseSpeed);
    float soft = pow(1.0 - d, 2.6);
    float core = pow(max(1.0 - d * 2.2, 0.0), 2.0);
    float shimmer = 0.85 + 0.15 * snoise(vec3(vUv * 2.0, uTime * 0.4));
    vec3 col = (uColorGlow * soft + uColorFrost * core * 0.6) * shimmer * breath * uIntensity * uFade;
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function createColdGlowMaterial(ice) {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uColorGlow: ice.uColorGlow,
      uColorFrost: ice.uColorFrost,
      uWidth: { value: 3 },
      uHeight: { value: 3 },
      uIntensity: { value: 0.4 },
      uPulse: { value: 0.2 },
      uPulseSpeed: { value: 1.8 },
      uFade: { value: 1 }
    }),
    vertexShader: GLOW_VERTEX,
    fragmentShader: GLOW_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    toneMapped: false
  });
}

/* ------------------------------------------------------------------ */
/* the frozen bodies                                                   */
/* ------------------------------------------------------------------ */

/**
 * The vertex stage the statue and its shadow share: every vertex is moved
 * as a rigid piece about its cell's pivot, by a transform read out of the
 * uniform arrays. Whole, every piece is at the identity and the buffer
 * draws exactly where the body stood.
 */
const BODY_VERTEX_DECL = /* glsl */ `
  #define ICE_CHUNKS ${ICE_MAX_CHUNKS}
  attribute float aCell;
  attribute vec3  aPivot;
  attribute float aEdge;
  attribute vec3  aFlat;
  uniform vec4  uChunkPos[ICE_CHUNKS];
  uniform vec4  uChunkRot[ICE_CHUNKS];
  uniform float uShatter;
  varying vec3  vIceWorld;
  varying vec3  vIceBind;
  varying float vIceEdge;

  vec3 iceRotate(vec4 q, vec3 v) {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
  }
`;

const BODY_NORMAL = /* glsl */ `
  int iceCell = int(aCell + 0.5);
  vec4 iceQ = uChunkRot[iceCell];
  vec4 iceP = uChunkPos[iceCell];
  vec3 objectNormal = iceRotate(iceQ, normalize(mix(normal, aFlat, uShatter)));
`;

const BODY_POSITION = /* glsl */ `
  vec3 transformed = aPivot + iceRotate(iceQ, (position - aPivot) * iceP.w) + iceP.xyz;
  vIceWorld = transformed;
  vIceBind = position;
  vIceEdge = aEdge;
`;

/** What both fragment stages need to decide whether a fragment exists. */
const BODY_CULL_DECL = /* glsl */ `
  uniform float uShatter;
  uniform float uGap;
  uniform float uMelt;
  uniform float uSeed;
  varying vec3  vIceWorld;
  varying vec3  vIceBind;
  varying float vIceEdge;
`;

const BODY_CULL = /* glsl */ `
  if (uShatter > 0.5 && vIceEdge < uGap) discard;
  float iceMeltNoise = fbm3(vIceBind * 6.0 + uSeed) * 0.5 + 0.5;
  if (iceMeltNoise < uMelt) discard;
`;

const BODY_FRAGMENT_DECL = /* glsl */ `
  uniform float uTime;
  uniform float uFreeze;
  uniform float uFrostLine;
  uniform float uBaseY;
  uniform float uTopY;
  uniform float uCrack;
  uniform float uCrackWidth;
  uniform float uCrackGlow;
  uniform float uFrostScale;
  uniform float uIceGlow;
  uniform float uIceRim;
  uniform float uIceClearcoat;
  uniform float uBodyRough;
  uniform float uBodyMetal;
  uniform float uIceRough;
  uniform float uFrostRough;
  uniform vec3  uBodyColor;
  uniform vec3  uRimColor;
  uniform float uRimPower;
  uniform float uRimEmissive;
  ${ICE_UNIFORMS_GLSL}
`;

/**
 * A body turned to ice.
 *
 * A `MeshPhysicalMaterial`, so the statue takes the sun, the shadows, the
 * probe and the aura's own point light exactly as the body it replaced did,
 * and the patch adds what a standard material cannot say:
 *
 *  - **the freeze.** A frost line climbs the body from the feet; below it the
 *    fragment is ice, above it the dummy's own look (the same colour, rim and
 *    roughness the body wore, so the swap from rig to statue is invisible).
 *    The line itself crystallises white as it passes.
 *  - **the ice.** Clear where the frost noise is low - the dark body visible
 *    inside it through a deep blue, with a clearcoat and the probe on top -
 *    and a pale frosted body where the noise is high. A cold rim glows at
 *    the graze.
 *  - **the cracks.** The Voronoi edge distance the buffer carries, drawn as
 *    a glowing hairline and darkened around, spreading up from the feet.
 *  - **the break.** The same hairline cut out as a gap between the pieces,
 *    the pieces re-shaded with their flat normals, their back faces frosted
 *    white so a shell of ice reads as a solid shard.
 *  - **the melt.** A noise threshold eating the pieces with a wet bright edge.
 *
 * @returns {MeshPhysicalMaterial} with `userData.uniforms`, `userData.depth`
 *   (the matching shadow-map material) and `userData.sync()`.
 */
export function createIceBodyMaterial(environment, ice) {
  const uniforms = {
    ...ice,
    uChunkPos: { value: new Float32Array(ICE_MAX_CHUNKS * 4) },
    uChunkRot: { value: new Float32Array(ICE_MAX_CHUNKS * 4) },
    uTime: frame.uTime,
    uShatter: { value: 0 },
    uGap: { value: 0.012 },
    uMelt: { value: 0 },
    uSeed: { value: 0 },
    uFreeze: { value: 0 },
    uFrostLine: { value: -1 },
    uBaseY: { value: 0 },
    uTopY: { value: 1.8 },
    uCrack: { value: 0 },
    uCrackWidth: { value: 0.02 },
    uCrackGlow: { value: 3 },
    uFrostScale: { value: 9 },
    uIceGlow: { value: 0.5 },
    uIceRim: { value: 1 },
    uIceClearcoat: { value: 0.7 },
    uBodyRough: { value: 0.78 },
    uBodyMetal: { value: 0.15 },
    uIceRough: { value: 0.08 },
    uFrostRough: { value: 0.55 },
    uBodyColor: { value: new Color(0.1, 0.12, 0.16) },
    uRimColor: { value: new Color(0.43, 0.82, 1.0) },
    uRimPower: { value: 2.6 },
    uRimEmissive: { value: 1.5 }
  };
  // Every piece at the identity until the break.
  for (let i = 0; i < ICE_MAX_CHUNKS; i++) {
    uniforms.uChunkPos.value[i * 4 + 3] = 1;
    uniforms.uChunkRot.value[i * 4 + 3] = 1;
  }

  const material = new MeshPhysicalMaterial({
    name: 'IceBody',
    color: 0xffffff,
    roughness: 0.2,
    metalness: 0,
    // Frozen, the coat is what makes it glass; the patch scales it to zero
    // above the frost line so the unfrozen body keeps its matte look.
    clearcoat: 1.0,
    clearcoatRoughness: 0.06,
    ior: 1.31,
    envMapIntensity: 1.3,
    // The pieces are shells: their far wall is what fills them in.
    side: DoubleSide
  });

  environment.registerShadowCasterWithPatch(
    material,
    (shader) => {
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${BODY_VERTEX_DECL}`)
        .replace('#include <beginnormal_vertex>', BODY_NORMAL)
        .replace('#include <begin_vertex>', BODY_POSITION);

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>\n${noiseGLSL}\n${BODY_CULL_DECL}\n${BODY_FRAGMENT_DECL}\n${ICE_GLSL}`
        )
        .replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>
           ${BODY_CULL}
           // How frozen this fragment is: the frost line has passed it, or
           // the whole body is done. Noise on the line so it climbs as a
           // crystallising edge rather than a waterline.
           float iceLineNoise = snoise(vIceBind * 3.2 + uSeed) * 0.1;
           float iceFrozen = 1.0 - smoothstep(-0.09, 0.09, vIceWorld.y + iceLineNoise - uFrostLine);
           iceFrozen = max(iceFrozen, step(0.999, uFreeze));
           float icePatch = iceFrostPatch(vIceBind, uFrostScale, uSeed);
           // The cracks climb the body too, ahead of the break.
           float iceCrackReach = smoothstep(0.0, 1.0, (uCrack * 1.4 - (vIceWorld.y - uBaseY) / max(uTopY - uBaseY, 0.1)) * 3.0);
           float iceCrack = (1.0 - smoothstep(0.0, uCrackWidth, vIceEdge)) * iceCrackReach * step(0.001, uCrack);`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           {
             vec3 iceBody = mix(uColorDeep, uColorIce, 0.45 + 0.55 * icePatch);
             iceBody = mix(iceBody, uColorFrost, icePatch * 0.55);
             diffuseColor.rgb = mix(uBodyColor, iceBody, iceFrozen);
             // The inside of a piece: frosted, pale, denser than the skin.
             if (!gl_FrontFacing && uShatter > 0.5) diffuseColor.rgb = mix(uColorIce, uColorFrost, 0.65);
             diffuseColor.rgb *= 1.0 - iceCrack * 0.45;
           }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `float roughnessFactor = mix(uBodyRough, mix(uIceRough, uFrostRough, icePatch), iceFrozen);
           if (!gl_FrontFacing) roughnessFactor = max(roughnessFactor, 0.5);`
        )
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = uBodyMetal * (1.0 - iceFrozen);')
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           {
             vec3 iceV = normalize(vViewPosition);
             float iceNdotV = clamp(dot(iceV, normal), 0.0, 1.0);
             // The body's own rim, exactly as the dummy draws it, until the
             // frost takes that part of it.
             if (gl_FrontFacing) {
               float rim = pow(1.0 - iceNdotV, uRimPower);
               totalEmissiveRadiance += uRimColor * rim * uRimEmissive * (1.0 - iceFrozen);
             }
             // Cold light in the ice: at the graze, and a little everywhere.
             float iceRim = pow(1.0 - iceNdotV, 2.5);
             totalEmissiveRadiance += uColorGlow * (iceRim * uIceRim + 0.05) * iceFrozen * uIceGlow;
             // The frost line, crystallising.
             float line = exp(-pow((vIceWorld.y + iceLineNoise - uFrostLine) / 0.05, 2.0));
             line *= step(0.001, uFreeze) * (1.0 - step(0.999, uFreeze));
             totalEmissiveRadiance += uColorFrost * line * 5.0;
             // The cracks, lit from within, flickering as they run.
             float flicker = 0.75 + 0.25 * sin(uTime * 28.0 + vIceEdge * 90.0 + uSeed);
             totalEmissiveRadiance += uColorGlow * iceCrack * uCrackGlow * flicker;
             // The wet edge of the melt.
             float meltEdge = 1.0 - smoothstep(0.0, 0.07, iceMeltNoise - uMelt);
             totalEmissiveRadiance += uColorFrost * meltEdge * 1.8 * step(0.001, uMelt);
           }`
        )
        .replace(
          '#include <lights_physical_fragment>',
          `#include <lights_physical_fragment>
           #ifdef USE_CLEARCOAT
             material.clearcoat *= iceFrozen * uIceClearcoat * (1.0 - icePatch * 0.6);
           #endif`
        );
    },
    'ice-body'
  );

  /* ---- the same silhouette, for the sun ---- */
  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  patchOnBeforeCompile(
    depth,
    (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${BODY_VERTEX_DECL}`)
        .replace('#include <begin_vertex>', `${BODY_NORMAL}\n${BODY_POSITION}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${noiseGLSL}\n${BODY_CULL_DECL}`)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${BODY_CULL}`);
    },
    'ice-body-depth'
  );

  material.userData.uniforms = uniforms;
  material.userData.depth = depth;
  material.userData.sync = () => {
    const c = settings.frost;
    const look = settings.dummies.look;
    uniforms.uBodyColor.value.copy(getColor(look.color));
    uniforms.uBodyRough.value = look.roughness;
    uniforms.uBodyMetal.value = look.metalness;
    uniforms.uRimColor.value.copy(getColor(look.rimColor));
    uniforms.uRimPower.value = look.rimPower;
    uniforms.uRimEmissive.value = look.rimEmissive;
    uniforms.uGap.value = c.shatterGap;
    uniforms.uCrackWidth.value = c.bodyCrackWidth;
    uniforms.uCrackGlow.value = c.crackGlowBody * settings.global.glow;
    uniforms.uFrostScale.value = c.bodyFrostScale;
    uniforms.uIceGlow.value = c.iceGlow * settings.global.glow;
    uniforms.uIceRim.value = c.iceRim;
    uniforms.uIceClearcoat.value = c.iceClearcoat;
    uniforms.uIceRough.value = c.iceRough;
    uniforms.uFrostRough.value = c.frostRough;
    material.envMapIntensity = c.iceEnv * settings.environment.envIntensity;
  };

  return material;
}
