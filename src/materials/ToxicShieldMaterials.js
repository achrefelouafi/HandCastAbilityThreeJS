import {
  AddEquation,
  BackSide,
  Color,
  CustomBlending,
  DoubleSide,
  FrontSide,
  MeshDepthMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NormalBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  RGBADepthPacking,
  ShaderMaterial
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame, sharedUniforms } from '../core/FrameUniforms.js';
import { ICE_MAX_CHUNKS } from '../effects/IceStatue.js';
import { STONE_PARS, stoneUniforms, syncStone } from './MonolithStoneMaterial.js';
import { patchOnBeforeCompile } from '../utils/shaderPatch.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate } from '../utils/math.js';

/**
 * THE TOXIC SHIELD OF CONQUEST — every material the aura draws with.
 *
 * Four layers off the breakdown sheet and one idea under all of them: **it is
 * all the same glass.** The barrier, the seams in the broken floor, the
 * shockwave and the bodies turned to glass inside share one palette
 * (`toxicUniforms`) and one way of being lit (`TOXIC_GLSL`): a deep bottle
 * green the glass lets you see into, a brighter venom green where it is
 * thin, a near-white cyan for the crystal lattice that holds it together,
 * and a bruise purple for the gas in its shadow. Every surface reflects the
 * stage's own HDR probe through the same equirect lookup and takes the same
 * sun highlight, so a shard of a shattered body lying on the ruptured floor
 * is visibly a piece of the barrier's material.
 *
 *   1 dome   the crystalline barrier: a sphere of toxic glass with a lattice
 *            of crystal spars grown over it — great-circle arcs of varying
 *            length and thickness, bright where they cross — and a finer
 *            cellular facet network under them; fresnel glass between, the
 *            probe and the sun in it, poison swirling inside; and a
 *            refraction proxy on the distortion layer so the stage bends
 *            through it. It dies cell by cell: the facets flash and drop out.
 *   3 crust  the ground rupture: the floor inside the circle cut into slabs
 *            (`ShatterGeometry`), heaved and tilted, the stone scan on top,
 *            toxic light coming up through every seam and a crack network
 *            over the plates, with embers still burning along the cracks
 *   4 ring   the radial shockwave: a thin bright ring on the floor with
 *            spiked flares thrown off it, instanced so the landing, the
 *            pulses while it stands and the break each get one
 *   bodies   a body turned to glass: a real PBR material patched to carry
 *            the conversion — the fracture seams light up ahead of a
 *            crystallising front, cell by cell, and the glass sets behind
 *            it — the cracks, the break and the dissolve. See
 *            effects/IceStatue.js for what it is drawn on.
 *
 * The miasma (panel 2) is a smoke particle system in a toxic palette, the
 * same one the Corrupted Shard coils round its cluster; see the ability.
 */

/* ------------------------------------------------------------------ */
/* the glass everything is made of                                    */
/* ------------------------------------------------------------------ */

export const TOXIC_UNIFORMS_GLSL = /* glsl */ `
  uniform vec3  uColorDeep;
  uniform vec3  uColorGlass;
  uniform vec3  uColorGlow;
  uniform vec3  uColorLattice;
  uniform vec3  uColorVenom;
  uniform sampler2D uEnvMap;
  uniform float uEnvStrength;
  uniform vec3  uSunColor;
  uniform float uSunSpec;
`;

/**
 * How the glass is lit, shared by every raw shader here and by the body and
 * crust patches. No packing helpers, so it is safe inside a built-in
 * material's fragment.
 */
export const TOXIC_GLSL = /* glsl */ `
  #define TOXIC_TAU 6.283185307179586

  vec2 toxicEquirect(vec3 d) {
    float u = atan(d.z, d.x) * 0.15915494309 + 0.5;
    float v = asin(clamp(d.y, -1.0, 1.0)) * 0.31830988618 + 0.5;
    return vec2(u, v);
  }

  /* The stage probe, seen in the glass. */
  vec3 toxicEnv(vec3 dir) {
    return texture2D(uEnvMap, toxicEquirect(dir)).rgb * uEnvStrength;
  }

  /* Glass has an index of 1.5: a little head-on, everything at a graze. */
  float toxicFresnel(float NdotV, float power) {
    return 0.04 + 0.96 * pow(1.0 - NdotV, power);
  }

  /* One tight sun highlight. */
  vec3 toxicSpecular(vec3 N, vec3 V, vec3 L, float shininess) {
    vec3 H = normalize(L + V);
    return uSunColor * pow(max(dot(N, H), 0.0), shininess) * uSunSpec;
  }

  /* F2 - F1 Voronoi in three dimensions: cells with a distance to their
     edges, and an id per cell. The facets of the glass. */
  float toxicCellEdge(vec3 p, out float id) {
    vec3 n = floor(p);
    vec3 f = fract(p);
    float d1 = 8.0;
    float d2 = 8.0;
    id = 0.0;
    for (int k = -1; k <= 1; k++) {
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          vec3 g = vec3(float(i), float(j), float(k));
          vec3 o = hash31(dot(n + g, vec3(7.13, 113.17, 41.71)));
          vec3 r = g + o - f;
          float d = dot(r, r);
          if (d < d1) {
            d2 = d1;
            d1 = d;
            id = hash11(dot(n + g, vec3(31.7, 57.1, 17.3)));
          } else if (d < d2) {
            d2 = d;
          }
        }
      }
    }
    return sqrt(d2) - sqrt(d1);
  }
`;

/** The palette and the probe, shared by identity across one cast's materials. */
export function toxicUniforms() {
  return {
    uColorDeep: { value: new Color(0.02, 0.16, 0.09) },
    uColorGlass: { value: new Color(0.18, 0.75, 0.45) },
    uColorGlow: { value: new Color(0.45, 1.0, 0.72) },
    uColorLattice: { value: new Color(0.78, 1.0, 0.92) },
    uColorVenom: { value: new Color(0.48, 0.24, 0.7) },
    uEnvMap: frame.uEnvMap,
    uEnvStrength: { value: 1 },
    uSunColor: { value: new Color(1, 0.95, 0.85) },
    uSunSpec: { value: 1 }
  };
}

/** Push the palette from settings. `c` is the ability block. */
export function syncToxic(u, c) {
  u.uColorDeep.value.copy(getColor(c.colorDeep));
  u.uColorGlass.value.copy(getColor(c.colorGlass));
  u.uColorGlow.value.copy(getColor(c.colorGlow));
  u.uColorLattice.value.copy(getColor(c.colorLattice));
  u.uColorVenom.value.copy(getColor(c.colorVenom));
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
/* 1 · the crystalline barrier                                         */
/* ------------------------------------------------------------------ */

/** Crystal spars the lattice may be built from. Sized into the uniform arrays. */
export const TOXIC_MAX_SPARS = 28;

const DOME_VERTEX = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vDir;
  void main() {
    // A unit sphere; the ability places, scales and turns it. vDir is where
    // the fragment sits on the sphere, in the sphere's own frame, so the
    // lattice turns with it.
    vDir = normalize(position);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

/**
 * The lattice: up to TOXIC_MAX_SPARS great-circle arcs on the sphere.
 *
 * Each spar is a plane through the centre (its normal), a tangent in that
 * plane to measure along it, a half-length, and a brightness. The arc is
 * thin where it is straight and thick where it bulges - a crystal needle,
 * not a wire - tapers to nothing at its ends, and carries a pulse of light
 * along it. Where two cross the sum goes past one and the node flares.
 */
const LATTICE_GLSL = /* glsl */ `
  #define TOXIC_SPARS ${TOXIC_MAX_SPARS}
  uniform vec4  uSpar[TOXIC_SPARS];
  uniform vec4  uSparTan[TOXIC_SPARS];
  uniform float uSparCount;
  uniform float uSparWidth;
  uniform float uSparSpeed;
  uniform float uSparGrow;

  float toxicLattice(vec3 d, float t, out float nodes) {
    float sum = 0.0;
    nodes = 0.0;
    for (int i = 0; i < TOXIC_SPARS; i++) {
      if (float(i) >= uSparCount) break;
      vec4 S = uSpar[i];
      vec4 T = uSparTan[i];
      float s = dot(d, S.xyz);
      // Only fragments near the plane can be on the arc; skip the rest.
      if (abs(s) > uSparWidth * 3.0) continue;
      vec3 B = cross(S.xyz, T.xyz);
      float along = atan(dot(d, B), dot(d, T.xyz));
      float reach = T.w * uSparGrow;
      float end = smoothstep(reach, reach - 0.35, abs(along));
      if (end <= 0.0) continue;
      // Needle: the width swells and pinches along its length.
      float swell = 1.0 + 0.45 * sin(along * 2.3 + S.w * 10.0) * sin(along * 5.1 + S.w * 3.0);
      float w = uSparWidth * swell * (0.35 + 0.65 * end);
      float aa = fwidth(s) * 0.8;
      float line = 1.0 - smoothstep(w - aa, w + aa, abs(s));
      // A pulse of light running along the spar.
      float pulse = 0.7 + 0.3 * sin(along * 3.0 - t * uSparSpeed + S.w * TOXIC_TAU);
      float bright = 0.55 + 0.45 * S.w;
      sum += line * pulse * bright * end;
    }
    nodes = smoothstep(0.9, 1.7, sum);
    return sum;
  }
`;

const DOME_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uFar;
  uniform float uBuild;
  uniform float uOpacity;
  uniform float uBody;
  uniform float uRimPower;
  uniform float uRimGlow;
  uniform float uSparGlow;
  uniform float uCellScale;
  uniform float uCellWidth;
  uniform float uCellGlow;
  uniform float uSwirl;
  uniform float uSwirlScale;
  uniform float uSwirlSpeed;
  uniform float uFootGlow;
  uniform float uBurn;
  uniform float uFade;
  uniform vec3  uLightDir;
  ${TOXIC_UNIFORMS_GLSL}
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vDir;
  ${noiseGLSL}
  ${TOXIC_GLSL}
  ${LATTICE_GLSL}

  void main() {
    if (vWorld.y < 0.0) discard;
    vec3 V = normalize(cameraPosition - vWorld);
    vec3 N = normalize(vNormal);
    // The far wall is seen from inside: light it as the face we are looking at.
    if (uFar > 0.5) N = -N;
    float NdotV = clamp(dot(N, V), 0.0, 1.0);
    vec3 d = normalize(vDir);

    /* ---- birth and death: the facets flash in, and flash and fall out,
       one by one, in two different orders ---- */
    float cellId;
    float cellEdge = toxicCellEdge(d * uCellScale + uSeed, cellId);
    float cellT = hash11(cellId * 73.1 + uSeed);
    float cellB = hash11(cellId * 41.7 + uSeed + 3.1);
    float dying = step(0.001, uBurn);
    if (dying > 0.5 && cellT < uBurn) discard;
    if (cellB > uBuild) discard;
    // The cells about to go, and the ones just arrived: their edges flare
    // and they flicker.
    float doomed = (1.0 - smoothstep(0.0, 0.14, cellT - uBurn)) * dying;
    float born = (1.0 - smoothstep(0.0, 0.14, uBuild - cellB)) * (1.0 - step(1.0, uBuild));
    float flare = max(doomed, born);
    float flicker = 0.6 + 0.4 * sin(uTime * 38.0 + cellId * 90.0);

    /* ---- the lattice, and the facets under it ---- */
    float nodes;
    float lattice = toxicLattice(d, uTime, nodes);
    float facet = 1.0 - smoothstep(0.0, uCellWidth, cellEdge);

    /* ---- the poison inside ---- */
    float swirl = fbm3(d * uSwirlScale + vec3(0.0, -uTime * uSwirlSpeed, 0.0) + uSeed) * 0.5 + 0.5;
    swirl = swirl * swirl;

    /* ---- the profile: lit from the rupture at its foot ---- */
    float foot = exp(-vWorld.y * 1.6);

    /* ---- shading ---- */
    float fres = toxicFresnel(NdotV, uRimPower);
    vec3 body = mix(uColorDeep, uColorGlass, 0.3 + 0.7 * fres);
    float lambert = 0.5 + 0.5 * (0.5 + 0.5 * dot(N, uLightDir));
    vec3 lit = body * lambert;
    vec3 refl = reflect(-V, N);
    lit += toxicEnv(refl) * (0.05 + 0.5 * fres);
    lit += toxicSpecular(N, V, uLightDir, 80.0);

    /* ---- the light in it ---- */
    vec3 glow = uColorGlow * fres * uRimGlow;
    glow += uColorGlass * swirl * uSwirl;
    glow += uColorGlow * foot * uFootGlow;
    glow += uColorLattice * lattice * uSparGlow * (0.75 + 0.6 * nodes);
    glow += uColorGlow * facet * uCellGlow * (1.0 + flare * 6.0 * flicker);
    glow += uColorLattice * flare * flicker * 0.35;

    /* ---- alpha ---- */
    float alpha = uBody * (0.55 + 0.45 * swirl) + fres * 0.85 + facet * 0.2;
    alpha += lattice * 0.45;
    alpha = clamp(alpha, 0.0, 1.0) * uOpacity;
    // The far wall, seen through the near one, is dimmer - what says the dome
    // is a shell of glass rather than a painted ball.
    if (uFar > 0.5) {
      alpha *= 0.5;
      glow *= 0.42;
    }
    alpha *= uFade;
    glow *= uFade;
    if (alpha < 0.003 && dot(glow, vec3(1.0)) < 0.003) discard;
    gl_FragColor = vec4(lit * alpha + glow, alpha);
  }
`;

/** The barrier. `far` draws the inside of the far wall, `!far` the near one. */
export function createBarrierMaterial(toxic, far) {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      ...toxic,
      uSpar: { value: new Float32Array(TOXIC_MAX_SPARS * 4) },
      uSparTan: { value: new Float32Array(TOXIC_MAX_SPARS * 4) },
      uSparCount: { value: 0 },
      uSparWidth: { value: 0.012 },
      uSparSpeed: { value: 2.5 },
      uSparGrow: { value: 1 },
      uSparGlow: { value: 1.6 },
      uSeed: { value: 0 },
      uFar: { value: far ? 1 : 0 },
      uBuild: { value: 0 },
      uOpacity: { value: 0.85 },
      uBody: { value: 0.12 },
      uRimPower: { value: 2.6 },
      uRimGlow: { value: 0.55 },
      uCellScale: { value: 3.2 },
      uCellWidth: { value: 0.03 },
      uCellGlow: { value: 0.22 },
      uSwirl: { value: 0.25 },
      uSwirlScale: { value: 2.2 },
      uSwirlSpeed: { value: 0.12 },
      uFootGlow: { value: 0.5 },
      uBurn: { value: 0 },
      uFade: { value: 1 }
    }),
    vertexShader: DOME_VERTEX,
    fragmentShader: DOME_FRAGMENT,
    side: far ? BackSide : FrontSide,
    depthTest: true,
    ...PREMULTIPLIED
  });
}

/**
 * The barrier's refraction: nothing is drawn, the stage bends through it.
 *
 * Lives on LAYER.DISTORTION and writes what `DistortionShader` reads —
 * R,G an offset about 0.5, B its strength, A the coverage. The offset is
 * the sphere's normal turned into a screen direction, strongest at the
 * limb where a ball of glass displaces what is behind it most, and it
 * comes in and drops out cell by cell with the visible dome.
 */
const DOME_REFRACT_FRAGMENT = /* glsl */ `
  uniform float uSeed;
  uniform float uBuild;
  uniform float uStrength;
  uniform float uCellScale;
  uniform float uBurn;
  uniform float uFade;
  uniform float uShaderIntensity;
  varying vec3 vWorld;
  varying vec3 vNormal;
  varying vec3 vDir;
  ${noiseGLSL}

  float refrCellId(vec3 p) {
    vec3 n = floor(p);
    vec3 f = fract(p);
    float d1 = 8.0;
    float id = 0.0;
    for (int k = -1; k <= 1; k++) {
      for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
          vec3 g = vec3(float(i), float(j), float(k));
          vec3 o = hash31(dot(n + g, vec3(7.13, 113.17, 41.71)));
          vec3 r = g + o - f;
          float d = dot(r, r);
          if (d < d1) {
            d1 = d;
            id = hash11(dot(n + g, vec3(31.7, 57.1, 17.3)));
          }
        }
      }
    }
    return id;
  }

  void main() {
    if (vWorld.y < 0.0) discard;
    vec3 d = normalize(vDir);
    if (uBurn > 0.001 || uBuild < 1.0) {
      float id = refrCellId(d * uCellScale + uSeed);
      if (hash11(id * 73.1 + uSeed) < uBurn) discard;
      if (hash11(id * 41.7 + uSeed + 3.1) > uBuild) discard;
    }
    vec3 N = normalize(vNormal);
    vec3 V = normalize(cameraPosition - vWorld);
    float NdotV = clamp(dot(N, V), 0.0, 1.0);
    vec2 screenDir = (viewMatrix * vec4(N, 0.0)).xy;
    float len = length(screenDir);
    screenDir = len > 1e-4 ? screenDir / len : vec2(0.0, 1.0);
    float limb = 0.25 + 0.75 * pow(1.0 - NdotV, 1.5);
    float strength = uStrength * uShaderIntensity * limb;
    float coverage = uFade;
    if (coverage < 0.01) discard;
    gl_FragColor = vec4(screenDir * 0.5 + 0.5, strength, coverage);
  }
`;

export function createBarrierRefractionMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uSeed: { value: 0 },
      uBuild: { value: 0 },
      uStrength: { value: 0.5 },
      uCellScale: { value: 3.2 },
      uBurn: { value: 0 },
      uFade: { value: 1 }
    }),
    vertexShader: DOME_VERTEX,
    fragmentShader: DOME_REFRACT_FRAGMENT,
    side: FrontSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: NormalBlending
  });
}

/* ------------------------------------------------------------------ */
/* 3 · the ground rupture                                              */
/* ------------------------------------------------------------------ */

/** F2 - F1 Voronoi in the plane: the crack network over the plates. */
const PLATES_GLSL = /* glsl */ `
  vec3 toxicPlates(vec2 p) {
    vec2 n = floor(p);
    vec2 f = fract(p);
    float d1 = 8.0;
    float d2 = 8.0;
    float id = 0.0;
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
    return vec3(sqrt(d2) - sqrt(d1), id, sqrt(d1));
  }
`;

/**
 * The broken floor: a `MeshStandardMaterial` on a Voronoi plate, so it takes
 * the sun, the shadows and the aura's own light like the stage it is cut
 * from. A heaved crust with venom in the seams: every slab
 * is a rigid piece heaved and canted about its own centroid, the stone scan
 * on top, toxic light coming up through the seams and the walls, a crack
 * network glowing over the plates, and embers - the stage was on fire when
 * it broke - still burning along the cracks.
 *
 * @returns {MeshStandardMaterial} with `userData.uniforms` and `userData.sync(state)`
 */
export function createToxicCrustMaterial(environment, toxic) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0.0,
    side: DoubleSide
  });

  const uniforms = {
    ...stoneUniforms(),
    ...toxic,
    uGrown: { value: 0 },
    uGap: { value: 0.05 },
    uHeave: { value: 0.07 },
    uTilt: { value: 0.3 },
    uRumble: { value: 0 },
    uDepth: { value: 0.12 },
    uHeat: { value: 1 },
    uSeamGlow: { value: 3 },
    uCrackScale: { value: 2.2 },
    uCrackWidth: { value: 0.05 },
    uCrackGlow: { value: 2.5 },
    uCrackReach: { value: 0.85 },
    uStain: { value: 0.6 },
    uEmber: { value: 1 },
    uEmberScale: { value: 9 },
    uPulse: { value: 0.3 },
    uPulseSpeed: { value: 2.2 },
    uSeed: { value: Math.random() * 10 },
    uWallDark: { value: 0.6 },
    uColorStain: { value: new Color(0.04, 0.09, 0.05) },
    uColorEmber: { value: new Color(1.0, 0.45, 0.1) },
    uGlobalGlow: { value: 1 }
  };

  const FRAME_FN = /* glsl */ `
    #define TX_TAU 6.283185307179586

    void crustFrame(out vec3 axis, out float ang, out float lift, out float open) {
      vec2  c      = aCell.xy;
      float radial = length(c);

      // A slab is whole until the front has passed its centroid.
      open = smoothstep(radial - 0.28, radial + 0.04, uGrown);

      // Domed: the middle came up, the lip stays welded to the floor.
      float profile = 1.0 - smoothstep(0.1, 1.0, radial);

      float yaw = aRand.z * TX_TAU;
      axis = vec3(cos(yaw), 0.0, sin(yaw));
      ang  = uTilt * (aRand.y * 2.0 - 1.0) * open * profile;
      lift = uHeave * (0.2 + 0.8 * aRand.x) * open * profile;
      // A tremor: every slab shivers on its own phase.
      lift += uRumble * (0.4 + 0.6 * profile) * open * sin(uTime * 27.0 + aRand.x * 40.0) * 0.5;
    }

    vec3 crustRotate(vec3 v, vec3 axis, float ang) {
      float s = sin(ang);
      float c = cos(ang);
      return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
    }
  `;

  environment.registerShadowCasterWithPatch(
    material,
    (shader) => {
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute vec3  aCell;
           attribute vec3  aRand;
           attribute float aEdge;
           attribute float aWall;

           uniform float uTime;
           uniform float uGrown;
           uniform float uGap;
           uniform float uHeave;
           uniform float uTilt;
           uniform float uRumble;
           uniform float uDepth;

           varying vec3  vCrustWorld;
           varying vec3  vCrustNormal;
           varying vec3  vCrustRand;
           varying vec2  vCrustCell;
           varying float vCrustEdge;
           varying float vCrustWall;
           varying float vCrustDepth;
           varying float vCrustOpen;

           ${FRAME_FN}`
        )
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
           {
             vec3 axis; float ang; float lift; float open;
             crustFrame(axis, ang, lift, open);
             objectNormal = crustRotate(objectNormal, axis, ang);
             vCrustNormal = normalize(mat3(modelMatrix) * objectNormal);
           }`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           {
             vec3 axis; float ang; float lift; float open;
             crustFrame(axis, ang, lift, open);

             vec2 c = aCell.xy;
             // The seams open widest in the middle, where the venom is.
             float gap = uGap * (0.5 + 0.95 * aRand.x) * (0.35 + 0.65 * (1.0 - smoothstep(0.2, 1.0, length(c))));
             vec2 local = (transformed.xz - c) * (1.0 - gap);

             vec3 v = vec3(local.x, transformed.y, local.y);
             v = crustRotate(v, axis, ang);

             transformed = vec3(c.x + v.x, v.y + lift, c.y + v.z);

             vCrustEdge  = aEdge;
             vCrustWall  = aWall;
             vCrustRand  = aRand;
             vCrustCell  = c;
             vCrustOpen  = open;
             vCrustDepth = clamp(-position.y / max(uDepth, 1e-4), 0.0, 1.0);
             vCrustWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
           }`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3  vCrustWorld;
           varying vec3  vCrustNormal;
           varying vec3  vCrustRand;
           varying vec2  vCrustCell;
           varying float vCrustEdge;
           varying float vCrustWall;
           varying float vCrustDepth;
           varying float vCrustOpen;

           uniform float uTime;
           uniform float uHeat;
           uniform float uSeamGlow;
           uniform float uCrackScale;
           uniform float uCrackWidth;
           uniform float uCrackGlow;
           uniform float uCrackReach;
           uniform float uStain;
           uniform float uEmber;
           uniform float uEmberScale;
           uniform float uPulse;
           uniform float uPulseSpeed;
           uniform float uSeed;
           uniform float uWallDark;
           uniform float uGlobalGlow;
           uniform vec3  uColorStain;
           uniform vec3  uColorEmber;
           ${TOXIC_UNIFORMS_GLSL}

           ${noiseGLSL}
           ${STONE_PARS}
           ${PLATES_GLSL}

           // Written by the map stage, read by the emissive stage.
           vec3 gCrustGlow = vec3(0.0);`
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           {
             vec3 wn = normalize(vCrustNormal);
             Stone st = sampleStone(vCrustWorld, wn, vCrustRand.x * 7.0);
             st.albedo *= 0.8 + 0.4 * vCrustRand.y;

             // The exposed wall is the inside of the stone: dark at the top,
             // lit from below where the venom is.
             float shade = vCrustWall * pow(vCrustDepth, 0.7) * uWallDark;
             st.albedo = mix(st.albedo, uColorStain, shade * 0.6);
             st.rough = mix(st.rough, min(1.0, st.rough + 0.1), vCrustWall);

             float radial = length(vCrustCell);
             float centre = 1.0 - smoothstep(0.15, 1.0, radial);

             // The fracture network on the top faces, in world metres.
             vec2 cp = vCrustWorld.xz * uCrackScale + uSeed * 10.0;
             cp += (snoise01(vec3(vCrustWorld.xz * 1.3, uSeed + 9.0)) - 0.5) * 0.6;
             vec3 vor = toxicPlates(cp);
             float reach = 1.0 - smoothstep(uCrackReach * 0.45, uCrackReach, radial);
             float width = uCrackWidth * (0.6 + 0.9 * reach);
             float crack = (1.0 - smoothstep(0.0, width, vor.x)) * (1.0 - vCrustWall) * reach;
             float near = (1.0 - smoothstep(0.0, width * 5.0, vor.x)) * (1.0 - vCrustWall) * reach;
             float pulse = 1.0 - uPulse + uPulse * (0.5 + 0.5 * sin(uTime * uPulseSpeed - radial * 4.0 + vor.y * 5.0));

             // Light coming up round the edge of every slab.
             float rim = (1.0 - smoothstep(0.0, 0.14, vCrustEdge)) * (1.0 - vCrustWall) * vCrustOpen;
             // ...and up the wall from the venom below it.
             float wall = vCrustWall * pow(vCrustDepth, 1.3) * vCrustOpen;

             float seam = (rim * 0.9 + wall) * uSeamGlow * (0.35 + 0.65 * centre);
             vec3 glow = uColorGlow * seam * pulse + uColorGlass * crack * uCrackGlow * pulse;

             // Embers: the stage was burning when it broke, and the fire
             // still lives along the cracks in small hot points that flicker.
             float emberN = snoise01(vec3(vCrustWorld.xz * uEmberScale, uSeed * 3.0 + uTime * 0.7));
             float ember = pow(emberN, 7.0) * near * (0.6 + 0.4 * sin(uTime * 9.0 + vor.y * 40.0));
             glow += uColorEmber * ember * uEmber * 6.0;

             gCrustGlow = glow * uHeat;

             // Stained toward the middle, and dark round every lit edge.
             float stain = clamp(rim * 0.8 + crack * 0.6 + centre * 0.45, 0.0, 1.0) * uStain;
             st.albedo = mix(st.albedo, uColorStain, stain);
             // The embers scorch the stone round them black.
             st.albedo = mix(st.albedo, vec3(0.01), near * 0.35 * uEmber);

             diffuseColor.rgb *= st.albedo;
             gStoneAO = mix(1.0, st.ao, uStoneAO) * (1.0 - shade * 0.5);
             gStoneNormal = st.normal;
             gRoughness = st.rough;
           }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `#include <roughnessmap_fragment>
           roughnessFactor = clamp(gRoughness * uStoneRough, uStoneFloor, 1.0);`
        )
        .replace(
          '#include <normal_fragment_maps>',
          `#include <normal_fragment_maps>
           normal = normalize((viewMatrix * vec4(gStoneNormal, 0.0)).xyz) * faceDirection;`
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           totalEmissiveRadiance += gCrustGlow * uGlobalGlow;`
        )
        .replace(
          '#include <aomap_fragment>',
          `#include <aomap_fragment>
           reflectedLight.indirectDiffuse *= gStoneAO;
           reflectedLight.indirectSpecular *= mix(1.0, gStoneAO, 0.6);`
        );
    },
    'toxic-crust'
  );

  material.userData.uniforms = uniforms;

  /**
   * @param {object} state { grown, heat, rumble }
   */
  material.userData.sync = (state) => {
    const c = settings.toxic;
    const g = settings.global;
    syncStone(uniforms, c, g);
    uniforms.uDustCoat.value = 0;

    uniforms.uGrown.value = state.grown;
    uniforms.uHeat.value = state.heat;
    uniforms.uRumble.value = state.rumble;
    uniforms.uDepth.value = c.plateDepth;
    uniforms.uGap.value = c.plateGap;
    uniforms.uHeave.value = c.plateHeave;
    uniforms.uTilt.value = c.plateTilt;
    uniforms.uSeamGlow.value = c.seamGlow * g.glow;
    uniforms.uCrackScale.value = c.crustCrackScale * g.noiseFrequency;
    uniforms.uCrackWidth.value = c.crustCrackWidth;
    uniforms.uCrackGlow.value = c.crustCrackGlow * g.glow;
    uniforms.uCrackReach.value = c.crustCrackReach;
    uniforms.uStain.value = c.crustStain;
    uniforms.uEmber.value = c.crustEmber;
    uniforms.uEmberScale.value = c.crustEmberScale * g.noiseFrequency;
    uniforms.uPulse.value = c.crustPulse;
    uniforms.uPulseSpeed.value = c.crustPulseSpeed;
    uniforms.uWallDark.value = c.plateWallDark;
    uniforms.uColorStain.value.copy(getColor(c.colorStain));
    uniforms.uColorEmber.value.copy(getColor(c.colorEmber));
    uniforms.uGlobalGlow.value = g.glow * g.shaderIntensity;
  };

  return material;
}

/* ------------------------------------------------------------------ */
/* 4 · the radial shockwave                                            */
/* ------------------------------------------------------------------ */

/** Rings one cast can have on the floor at once. */
export const TOXIC_MAX_RINGS = 4;

const RING_VERTEX = /* glsl */ `
  attribute vec4 aRing;
  varying vec2 vP;
  varying vec4 vRing;
  void main() {
    // A unit quad laid flat: the rotation is baked into the vertices, so the
    // plane coordinate has to come from the uv.
    vP = (uv - 0.5) * 2.0;
    vRing = aRing;
    #ifdef USE_INSTANCING
      mat4 m = modelMatrix * instanceMatrix;
    #else
      mat4 m = modelMatrix;
    #endif
    gl_Position = projectionMatrix * viewMatrix * m * vec4(position, 1.0);
  }
`;

/**
 * A ring on the floor with spiked flares thrown off it.
 *
 * Per instance: the radius it has reached (a fraction of the quad), a seed,
 * its strength (the fade is folded in) and its thickness. The ring is a
 * Gaussian about the radius with a wash trailing inside it, and the flares
 * are triangular teeth in angle - a fixed comb per ring, each tooth its own
 * length - reaching outward from the ring and tapering to nothing.
 */
const RING_FRAGMENT = /* glsl */ `
  uniform float uSpikes;
  uniform float uSpikeReach;
  uniform float uFade;
  ${TOXIC_UNIFORMS_GLSL}
  varying vec2 vP;
  varying vec4 vRing;
  ${noiseGLSL}
  ${TOXIC_GLSL}

  void main() {
    float r = vRing.x;
    float seed = vRing.y;
    float strength = vRing.z * uFade;
    if (strength < 0.002) discard;
    float d = length(vP);
    if (d > 1.0) discard;
    float w = max(vRing.w, fwidth(d) * 1.5);

    float ring = exp(-pow((d - r) / w, 2.0));
    float wash = smoothstep(r, r - w * 4.0, d) * exp(-(r - d) * 5.0) * 0.3;

    // The comb of flares.
    float ang = atan(vP.y, vP.x) / TOXIC_TAU + 0.5;
    float k = max(4.0, uSpikes);
    float slot = floor(ang * k + seed * 13.0);
    float phase = fract(ang * k + seed * 13.0);
    float amp = hash11(slot + seed * 97.0);
    amp = amp * amp;
    float tooth = pow(max(0.0, 1.0 - abs(phase - 0.5) * 2.0), 2.5);
    float reach = w * (2.0 + uSpikeReach * amp);
    float flare = tooth * smoothstep(r + reach, r + w * 0.5, d) * smoothstep(r - w * 1.5, r, d);

    vec3 glow = uColorLattice * ring * 1.6 + uColorGlow * (flare * 0.9 + wash);
    float alpha = clamp(ring + flare * 0.6 + wash, 0.0, 1.0);
    glow *= strength;
    alpha *= strength * 0.55;
    if (alpha < 0.002 && dot(glow, vec3(1.0)) < 0.002) discard;
    gl_FragColor = vec4(glow, alpha);
  }
`;

export function createShockRingMaterial(toxic) {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      ...toxic,
      uSpikes: { value: 28 },
      uSpikeReach: { value: 12 },
      uFade: { value: 1 }
    }),
    vertexShader: RING_VERTEX,
    fragmentShader: RING_FRAGMENT,
    side: DoubleSide,
    depthTest: true,
    ...PREMULTIPLIED
  });
}

/* ------------------------------------------------------------------ */
/* the bodies turned to glass                                          */
/* ------------------------------------------------------------------ */

/**
 * The vertex stage the statue and its shadow share: every vertex is moved
 * as a rigid piece about its cell's pivot, by a transform read out of the
 * uniform arrays. Whole, every piece is at the identity and the buffer
 * draws exactly where the body stood. The pivot's height is carried through
 * so the conversion can run cell by cell.
 */
const BODY_VERTEX_DECL = /* glsl */ `
  #define GLASS_CHUNKS ${ICE_MAX_CHUNKS}
  attribute float aCell;
  attribute vec3  aPivot;
  attribute float aEdge;
  attribute vec3  aFlat;
  uniform vec4  uChunkPos[GLASS_CHUNKS];
  uniform vec4  uChunkRot[GLASS_CHUNKS];
  uniform float uShatter;
  varying vec3  vGlassWorld;
  varying vec3  vGlassBind;
  varying float vGlassEdge;
  varying vec2  vGlassCell;

  vec3 glassRotate(vec4 q, vec3 v) {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
  }
`;

const BODY_NORMAL = /* glsl */ `
  int glassCell = int(aCell + 0.5);
  vec4 glassQ = uChunkRot[glassCell];
  vec4 glassP = uChunkPos[glassCell];
  vec3 objectNormal = glassRotate(glassQ, normalize(mix(normal, aFlat, uShatter)));
`;

const BODY_POSITION = /* glsl */ `
  vec3 transformed = aPivot + glassRotate(glassQ, (position - aPivot) * glassP.w) + glassP.xyz;
  vGlassWorld = transformed;
  vGlassBind = position;
  vGlassEdge = aEdge;
  vGlassCell = vec2(aPivot.y, aCell);
`;

/** What both fragment stages need to decide whether a fragment exists. */
const BODY_CULL_DECL = /* glsl */ `
  uniform float uShatter;
  uniform float uGap;
  uniform float uMelt;
  uniform float uSeed;
  varying vec3  vGlassWorld;
  varying vec3  vGlassBind;
  varying float vGlassEdge;
  varying vec2  vGlassCell;
`;

const BODY_CULL = /* glsl */ `
  if (uShatter > 0.5 && vGlassEdge < uGap) discard;
  float glassMeltNoise = fbm3(vGlassBind * 6.0 + uSeed) * 0.5 + 0.5;
  if (glassMeltNoise < uMelt) discard;
`;

const BODY_FRAGMENT_DECL = /* glsl */ `
  uniform float uTime;
  uniform float uFreeze;
  uniform float uFrostLine;
  uniform float uBaseY;
  uniform float uTopY;
  uniform float uCellWise;
  uniform float uLead;
  uniform float uCrack;
  uniform float uCrackWidth;
  uniform float uCrackGlow;
  uniform float uSeamWidth;
  uniform float uSeamGlow;
  uniform float uSeamSet;
  uniform float uSwirl;
  uniform float uSwirlScale;
  uniform float uGlassGlow;
  uniform float uGlassRim;
  uniform float uGlassClearcoat;
  uniform float uBodyRough;
  uniform float uBodyMetal;
  uniform float uGlassRough;
  uniform vec3  uBodyColor;
  uniform vec3  uRimColor;
  uniform float uRimPower;
  uniform float uRimEmissive;
  ${TOXIC_UNIFORMS_GLSL}
`;

/**
 * A body turned to glass.
 *
 * A `MeshPhysicalMaterial`, so the statue takes the sun, the shadows, the
 * probe and the aura's own point light exactly as the body it replaced did,
 * and the patch adds what a standard material cannot say:
 *
 *  - **the conversion.** A crystallising front climbs the body from the
 *    feet, but not as a waterline: it is run *per fracture cell*, each cell
 *    converting on its own beat by its pivot's height, so the body is taken
 *    facet by facet. Ahead of the front the seams between the cells - the
 *    same Voronoi edges it will break along - light up first, a lattice
 *    growing over the body the way the spars grow over the barrier; the
 *    front itself is a bright band; behind it the cell is glass and the
 *    seam settles to a steady glow. Above the front the dummy's own look
 *    (colour, rim, roughness) so the swap from rig to statue is invisible.
 *  - **the glass.** A deep bottle green with the dark body visible inside
 *    it, a clearcoat and the probe on top, a venom rim at the graze, and a
 *    slow swirl of poison moving through it.
 *  - **the cracks.** The seams brightening to the lattice white and
 *    widening, spreading up from the feet.
 *  - **the break.** The same seams cut out as a gap between the pieces, the
 *    pieces re-shaded with their flat normals, their back faces dense glass
 *    so a shell reads as a solid shard.
 *  - **the dissolve.** A noise threshold eating the pieces with a hot green
 *    edge, the shards going to vapour.
 *
 * @returns {MeshPhysicalMaterial} with `userData.uniforms`, `userData.depth`
 *   (the matching shadow-map material) and `userData.sync()`.
 */
export function createGlassBodyMaterial(environment, toxic) {
  const uniforms = {
    ...toxic,
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
    uCellWise: { value: 0.65 },
    uLead: { value: 0.35 },
    uCrack: { value: 0 },
    uCrackWidth: { value: 0.02 },
    uCrackGlow: { value: 3 },
    uSeamWidth: { value: 0.012 },
    uSeamGlow: { value: 2.5 },
    uSeamSet: { value: 0.3 },
    uSwirl: { value: 0.3 },
    uSwirlScale: { value: 4 },
    uGlassGlow: { value: 0.5 },
    uGlassRim: { value: 1 },
    uGlassClearcoat: { value: 0.8 },
    uBodyRough: { value: 0.78 },
    uBodyMetal: { value: 0.15 },
    uGlassRough: { value: 0.08 },
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
    name: 'GlassBody',
    color: 0xffffff,
    roughness: 0.2,
    metalness: 0,
    // Converted, the coat is what makes it glass; the patch scales it to zero
    // above the front so the unconverted body keeps its matte look.
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    ior: 1.5,
    envMapIntensity: 1.4,
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
          `#include <common>\n${noiseGLSL}\n${BODY_CULL_DECL}\n${BODY_FRAGMENT_DECL}\n${TOXIC_GLSL}`
        )
        .replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>
           ${BODY_CULL}
           // How far through the conversion this fragment is. The front is a
           // height that climbs the body; each cell measures it against a
           // blend of its own height and its pivot's, so cells convert on
           // their own beats, with a little noise so the front crystallises
           // rather than floods.
           float glassSpan = max(uTopY - uBaseY, 0.1);
           float glassLocal = (vGlassWorld.y - uBaseY) / glassSpan;
           float glassCellY = (vGlassCell.x - uBaseY) / glassSpan + (hash11(vGlassCell.y * 3.7 + uSeed) - 0.5) * 0.2;
           float glassMeasure = mix(glassLocal, glassCellY, uCellWise);
           float glassNoise = snoise(vGlassBind * 3.2 + uSeed) * 0.04;
           float glassConv = (uFrostLine - uBaseY) / glassSpan - glassMeasure + glassNoise;
           float glassed = smoothstep(-0.025, 0.025, glassConv);
           glassed = max(glassed, step(0.999, uFreeze));
           // The seams: the lattice the body will break along.
           float glassSeam = 1.0 - smoothstep(0.0, uSeamWidth, vGlassEdge);
           // Ahead of the front they light first; on it they flash; behind
           // it they settle.
           float glassAhead = smoothstep(-uLead, -0.02, glassConv) * (1.0 - glassed);
           float glassBand = exp(-pow(glassConv / 0.05, 2.0)) * step(0.001, uFreeze) * (1.0 - step(0.999, uFreeze));
           // The cracks climb the body too, ahead of the break.
           float glassCrackReach = smoothstep(0.0, 1.0, (uCrack * 1.4 - glassLocal) * 3.0);
           float glassCrack = (1.0 - smoothstep(0.0, uCrackWidth, vGlassEdge)) * glassCrackReach * step(0.001, uCrack);
           // The poison in the glass.
           float glassSwirl = fbm3(vGlassBind * uSwirlScale + vec3(0.0, -uTime * 0.25, 0.0) + uSeed) * 0.5 + 0.5;
           glassSwirl *= glassSwirl;`
        )
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
           {
             vec3 glassBody = mix(uColorDeep, uColorGlass, 0.2 + 0.5 * glassSwirl);
             // The dark body seen inside the glass.
             glassBody = mix(uBodyColor * 0.5, glassBody, 0.8);
             diffuseColor.rgb = mix(uBodyColor, glassBody, glassed);
             // The inside of a piece: dense glass, darker than the skin.
             if (!gl_FrontFacing && uShatter > 0.5) diffuseColor.rgb = mix(uColorDeep, uColorGlass, 0.35);
             diffuseColor.rgb *= 1.0 - glassCrack * 0.5;
           }`
        )
        .replace(
          '#include <roughnessmap_fragment>',
          `float roughnessFactor = mix(uBodyRough, uGlassRough, glassed);
           if (!gl_FrontFacing) roughnessFactor = max(roughnessFactor, 0.35);`
        )
        .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = uBodyMetal * (1.0 - glassed);')
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
           {
             vec3 glassV = normalize(vViewPosition);
             float glassNdotV = clamp(dot(glassV, normal), 0.0, 1.0);
             // The body's own rim, exactly as the dummy draws it, until the
             // glass takes that part of it.
             if (gl_FrontFacing) {
               float rim = pow(1.0 - glassNdotV, uRimPower);
               totalEmissiveRadiance += uRimColor * rim * uRimEmissive * (1.0 - glassed);
             }
             // Venom light in the glass: at the graze, and a little everywhere.
             float glassRim = pow(1.0 - glassNdotV, 2.5);
             totalEmissiveRadiance += uColorGlow * (glassRim * uGlassRim + 0.06) * glassed * uGlassGlow;
             totalEmissiveRadiance += uColorGlass * glassSwirl * uSwirl * glassed;
             // The lattice: growing ahead of the front, flashing on it,
             // settled behind it - pulsing faintly once the glass has set.
             float settle = uSeamSet * (0.8 + 0.2 * sin(uTime * 2.4 + vGlassCell.y * 1.7));
             float seamLit = glassAhead * 1.0 + glassBand * 2.5 + glassed * settle;
             totalEmissiveRadiance += uColorLattice * glassSeam * seamLit * uSeamGlow;
             // The front, crystallising.
             totalEmissiveRadiance += uColorGlow * glassBand * 2.5;
             // The cracks, lit from within, flickering as they run.
             float flicker = 0.75 + 0.25 * sin(uTime * 28.0 + vGlassEdge * 90.0 + uSeed);
             totalEmissiveRadiance += uColorLattice * glassCrack * uCrackGlow * flicker;
             // The hot edge of the dissolve.
             float meltEdge = 1.0 - smoothstep(0.0, 0.07, glassMeltNoise - uMelt);
             totalEmissiveRadiance += uColorGlow * meltEdge * 2.2 * step(0.001, uMelt);
           }`
        )
        .replace(
          '#include <lights_physical_fragment>',
          `#include <lights_physical_fragment>
           #ifdef USE_CLEARCOAT
             material.clearcoat *= glassed * uGlassClearcoat;
           #endif`
        );
    },
    'toxic-glass-body'
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
    'toxic-glass-depth'
  );

  material.userData.uniforms = uniforms;
  material.userData.depth = depth;
  material.userData.sync = () => {
    const c = settings.toxic;
    const g = settings.global;
    const look = settings.dummies.look;
    uniforms.uBodyColor.value.copy(getColor(look.color));
    uniforms.uBodyRough.value = look.roughness;
    uniforms.uBodyMetal.value = look.metalness;
    uniforms.uRimColor.value.copy(getColor(look.rimColor));
    uniforms.uRimPower.value = look.rimPower;
    uniforms.uRimEmissive.value = look.rimEmissive;
    uniforms.uGap.value = c.shatterGap;
    uniforms.uCellWise.value = c.convertCellWise;
    uniforms.uLead.value = c.convertLead;
    uniforms.uCrackWidth.value = c.bodyCrackWidth;
    uniforms.uCrackGlow.value = c.crackGlowBody * g.glow;
    uniforms.uSeamWidth.value = c.bodySeamWidth;
    uniforms.uSeamGlow.value = c.bodySeamGlow * g.glow;
    uniforms.uSeamSet.value = c.bodySeamSet;
    uniforms.uSwirl.value = c.bodySwirl * g.glow;
    uniforms.uSwirlScale.value = c.bodySwirlScale * g.noiseFrequency;
    uniforms.uGlassGlow.value = c.glassGlow * g.glow;
    uniforms.uGlassRim.value = c.glassRim;
    uniforms.uGlassClearcoat.value = c.glassClearcoat;
    uniforms.uGlassRough.value = c.glassRough;
    material.envMapIntensity = c.glassEnv * settings.environment.envIntensity;
  };

  return material;
}
