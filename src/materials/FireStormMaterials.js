import {
  AddEquation,
  BackSide,
  BufferAttribute,
  Color,
  CustomBlending,
  DoubleSide,
  FrontSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  MeshStandardMaterial,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  Sphere,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { FIRE_UNIFORMS_GLSL, FIRE_GLSL, fireUniforms } from './PhoenixMaterials.js';
import { STONE_PARS, stoneUniforms, syncStone } from './MonolithStoneMaterial.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate } from '../utils/math.js';

/**
 * THE VOLCANIC FIRE STORM ERUPTION — every material the eruption draws with.
 *
 * Five layers off the breakdown sheet, and two ideas under all of them.
 *
 * **The fire is the phoenix's fire.** Every hot surface here — the melt under
 * the crust, the bombs in the air, the whirl — turns a heat into kelvin and
 * radiates it through the same `fireColor` the Serpent Tide Field uses, so the
 * eruption and the bird are visibly the same element at different temperatures
 * rather than two palettes that happen to both be orange.
 *
 * **The stone is the floor's stone.** The crust and the bombs are real
 * `MeshStandardMaterial`s carrying the Monolith Rift's triplanar projection of
 * the ambientCG scan, graded down to basalt, so the plate that heaves up is
 * made of the ground it came out of and takes the sun, the shadows and the
 * dynamic light of the fire standing on it.
 *
 *   1. seam    the magma running under the floor from the caster to the point
 *      crust   the floor cut into slabs and lifted, the melt in every seam
 *      lava    the melt itself, a disc under the plate seen through the seams
 *   2. clouds  a raymarched volume of puffs — the steam blast, in white
 *   3. bombs   instanced basalt, molten inside, cooling as they fly
 *   4. ribbons the whirl: broad bands of flame wound about one axis, each a
 *              camera-facing strip on a helix, torn to tongues at the edges
 *      core    the white-hot interior they are wound round, a card turned to
 *              the camera and shaded as the front of a twisting cylinder
 *      skirt   the phoenix's torn cylinder of tongues, flared over the plate
 *   5. clouds  the same volume again — the pyrocumulus, in soot, lit from
 *              underneath by the fire it is standing on
 */

export const FIRESTORM_MAX_PUFFS = 16;

/* ------------------------------------------------------------------ */
/* shared: a Voronoi edge field for crack networks                     */
/* ------------------------------------------------------------------ */

/** F2 - F1 Voronoi: the plates are the cells, the cracks are where it goes to zero. */
const PLATES_GLSL = /* glsl */ `
  vec3 fsPlates(vec2 p) {
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
`;

/**
 * The four-stop ramp `fireColor` blends its palette over. Lifted out of
 * `commonGLSL` for the two standard-material patches below, which cannot
 * include that chunk (it pulls in three's packing helpers a second time).
 */
const GRADIENT_GLSL = /* glsl */ `
  vec3 gradient4(vec3 c0, vec3 c1, vec3 c2, vec3 c3, float t) {
    t = clamp(t, 0.0, 1.0);
    vec3 a = mix(c0, c1, smoothstep(0.0, 0.34, t));
    vec3 b = mix(a, c2, smoothstep(0.30, 0.68, t));
    return mix(b, c3, smoothstep(0.64, 1.0, t));
  }
`;

/* ------------------------------------------------------------------ */
/* 1a · the seam: magma running under the floor                        */
/* ------------------------------------------------------------------ */

const SEAM_VERTEX = /* glsl */ `
  uniform float uLength;
  uniform float uWidth;
  varying vec2 vLocal;
  void main() {
    // A flat-rotated quad has no y of its own to read: the plane frame is uv.
    vLocal = vec2(uv.x * uLength, (uv.y - 0.5) * uWidth);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * A fracture that runs along the cast line with the melt showing through it.
 *
 * The main crack wanders off the line on two octaves of noise, side cracks are
 * the edges of a Voronoi field gated to within reach of it, and everything is
 * revealed up to uFront with the tip running hottest — this is the magma
 * *arriving*, and the crust erupts where it stops. Premultiplied over: the
 * melt adds, the scorch beside it darkens the stone.
 */
const SEAM_FRAGMENT = /* glsl */ `
  ${FIRE_UNIFORMS_GLSL}
  uniform float uTime;
  uniform float uSeed;
  uniform float uLength;
  uniform float uFront;
  uniform float uHeat;
  uniform float uFade;
  uniform float uWander;
  uniform float uCrackWidth;
  uniform float uGlowWidth;
  uniform float uBranch;
  uniform float uBranchScale;
  uniform float uScorch;
  uniform float uIntensity;
  uniform float uGlobalGlow;
  uniform vec3  uColorScorch;

  varying vec2 vLocal;

  ${noiseGLSL}
  ${commonGLSL}
  ${FIRE_GLSL}
  ${PLATES_GLSL}

  void main() {
    float s = vLocal.x;
    float x = vLocal.y;

    // The main fracture: a slow wander and a fine one, so it is neither a
    // ruled line nor a scribble.
    float wander = (snoise(vec3(s * 0.32, uSeed, 0.0)) * 0.7 + snoise(vec3(s * 1.15, uSeed + 5.0, 0.0)) * 0.3) * uWander;
    float dc = abs(x - wander);
    float w = uCrackWidth * (0.5 + 0.5 * snoise01(vec3(s * 2.3, uSeed + 9.0, 0.0)));

    // Revealed up to the front, with the tip the hottest thing on the floor.
    float behind = 1.0 - smoothstep(uFront - 0.35, uFront + 0.05, s);
    float tip = exp(-pow((s - uFront) / 0.9, 2.0)) * (1.0 - smoothstep(uLength - 0.2, uLength, uFront));
    float start = smoothstep(0.0, 0.9, s);

    float crack = 1.0 - smoothstep(0.0, w, dc);
    float glow = exp(-dc * dc / (uGlowWidth * uGlowWidth));

    // Side cracks: a Voronoi edge field beside the main one, only within reach.
    vec2 bp = vec2(s, x) * uBranchScale + uSeed * 3.0;
    bp += (snoise01(vec3(s * 0.9, x * 0.9, uSeed + 2.0)) - 0.5) * 0.8;
    vec3 vor = fsPlates(bp);
    float reach = 1.0 - smoothstep(0.15, 0.9, dc);
    float branch = (1.0 - smoothstep(0.0, 0.05, vor.x)) * reach * uBranch;

    // Melt pulsing along the seam, running toward the front.
    float pulse = 0.8 + 0.2 * sin(uTime * 4.0 - s * 2.2 + vor.y * 3.0);

    float melt = (crack + branch * 0.7) * behind * start * pulse;
    float heat = uHeat * (0.85 * melt + 0.35 * glow * behind + tip * 0.9) * (0.75 + 0.25 * snoise01(vec3(s * 0.7, uSeed, uTime * 0.5)));
    heat = clamp(heat, 0.0, 1.0);

    float lit = melt + glow * behind * 0.35 + tip * 0.8;
    vec3 col = fireColor(heat) * lit * uIntensity;

    // The stone beside the melt is scorched black.
    float scorch = (glow * 0.8 + branch * 0.5) * behind * start * uScorch;
    col += uColorScorch * scorch;
    col *= uFade * uGlobalGlow;

    float alpha = clamp(scorch * uFade, 0.0, 1.0);
    if (alpha < 0.002 && max(col.r, max(col.g, col.b)) < 0.002) discard;
    gl_FragColor = vec4(col, alpha);
  }
`;

export function createMagmaSeamMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      ...fireUniforms(),
      uSeed: { value: Math.random() * 10 },
      uLength: { value: 10 },
      uWidth: { value: 2.4 },
      uFront: { value: 0 },
      uHeat: { value: 1 },
      uFade: { value: 1 },
      uWander: { value: 0.35 },
      uCrackWidth: { value: 0.06 },
      uGlowWidth: { value: 0.35 },
      uBranch: { value: 0.8 },
      uBranchScale: { value: 1.6 },
      uScorch: { value: 0.7 },
      uIntensity: { value: 2.2 },
      uColorScorch: { value: new Color(0.02, 0.012, 0.008) }
    }),
    vertexShader: SEAM_VERTEX,
    fragmentShader: SEAM_FRAGMENT,
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
/* 1b · the crust: the floor cut into slabs, lit from underneath       */
/* ------------------------------------------------------------------ */

/**
 * The plate from `assets/ShatterGeometry.js`, shaded as basalt over live melt.
 *
 * The break is the Monolith Rift's — a front racing out from the middle, the
 * slabs shrinking toward their own centroids to open the seams, heaved and
 * canted hardest where the magma came through — and what is different is
 * what is *in* the seams. Every exposed wall is lit from the bottom, where
 * the lava bed sits a hand's breadth under it; the rim of every slab glows
 * where the light comes up round it; and the top faces carry a finer
 * fracture network of their own, running hot toward the centre and cooling
 * to black as the storm dies. Under the storm the whole plate shivers.
 */
export function createMagmaCrustMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0.0,
    side: DoubleSide
  });

  const uniforms = {
    ...stoneUniforms(),
    ...fireUniforms(),
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
    uSoot: { value: 0.6 },
    uPulse: { value: 0.3 },
    uPulseSpeed: { value: 2.2 },
    uSeed: { value: Math.random() * 10 },
    uWallDark: { value: 0.6 },
    uColorDamp: { value: new Color(0.1, 0.09, 0.09) },
    uGlobalGlow: { value: 1 }
  };

  const FRAME_FN = /* glsl */ `
    #define FS_TAU 6.283185307179586

    void crustFrame(out vec3 axis, out float ang, out float lift, out float open) {
      vec2  c      = aCell.xy;
      float radial = length(c);

      // A slab is whole until the front has passed its centroid.
      open = smoothstep(radial - 0.28, radial + 0.04, uGrown);

      // Domed: the middle came up, the lip stays welded to the floor.
      float profile = 1.0 - smoothstep(0.1, 1.0, radial);

      float yaw = aRand.z * FS_TAU;
      axis = vec3(cos(yaw), 0.0, sin(yaw));
      ang  = uTilt * (aRand.y * 2.0 - 1.0) * open * profile;
      lift = uHeave * (0.2 + 0.8 * aRand.x) * open * profile;
      // The storm shakes it: every slab shivers on its own phase.
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
             // The seams open widest in the middle, where the melt is.
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
           uniform float uSoot;
           uniform float uPulse;
           uniform float uPulseSpeed;
           uniform float uSeed;
           uniform float uWallDark;
           uniform float uGlobalGlow;
           uniform vec3  uColorDamp;
           ${FIRE_UNIFORMS_GLSL}

           ${noiseGLSL}
           ${STONE_PARS}
           ${GRADIENT_GLSL}
           ${FIRE_GLSL}
           ${PLATES_GLSL}

           // Written by the map stage, read by the emissive stage.
           float gCrustGlow = 0.0;
           float gCrustHeat = 0.0;`
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           {
             vec3 wn = normalize(vCrustNormal);
             Stone st = sampleStone(vCrustWorld, wn, vCrustRand.x * 7.0);
             st.albedo *= 0.8 + 0.4 * vCrustRand.y;

             // The exposed wall is the inside of the stone, and it is being
             // baked: dark at the top, glowing at the bottom where the melt is.
             float shade = vCrustWall * pow(vCrustDepth, 0.7) * uWallDark;
             st.albedo = mix(st.albedo, uColorDamp, shade * 0.6);
             st.rough = mix(st.rough, min(1.0, st.rough + 0.1), vCrustWall);

             float radial = length(vCrustCell);
             float centre = 1.0 - smoothstep(0.15, 1.0, radial);

             // The fracture network on the top faces, in world metres.
             vec2 cp = vCrustWorld.xz * uCrackScale + uSeed * 10.0;
             cp += (snoise01(vec3(vCrustWorld.xz * 1.3, uSeed + 9.0)) - 0.5) * 0.6;
             vec3 vor = fsPlates(cp);
             float reach = 1.0 - smoothstep(uCrackReach * 0.45, uCrackReach, radial);
             float width = uCrackWidth * (0.6 + 0.9 * reach);
             float crack = (1.0 - smoothstep(0.0, width, vor.x)) * (1.0 - vCrustWall) * reach;
             float pulse = 1.0 - uPulse + uPulse * (0.5 + 0.5 * sin(uTime * uPulseSpeed - radial * 4.0 + vor.y * 5.0));

             // Light coming up round the edge of every slab.
             float rim = (1.0 - smoothstep(0.0, 0.14, vCrustEdge)) * (1.0 - vCrustWall) * vCrustOpen;
             // ...and up the wall from the melt below it.
             float wall = vCrustWall * pow(vCrustDepth, 1.3) * vCrustOpen;

             float seam = (rim * 0.9 + wall) * uSeamGlow * (0.35 + 0.65 * centre);
             float glow = seam + crack * uCrackGlow * pulse;
             gCrustHeat = clamp(uHeat * (0.35 + 0.65 * centre) * (0.55 + 0.45 * pulse), 0.0, 1.0);
             gCrustGlow = glow * uHeat;

             // Soot round every hot edge, and the whole plate scorched darker
             // toward the middle.
             float soot = clamp(rim * 0.8 + crack * 0.6 + centre * 0.35, 0.0, 1.0) * uSoot;
             st.albedo = mix(st.albedo, vec3(0.012, 0.01, 0.009), soot);

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
           totalEmissiveRadiance += fireColor(gCrustHeat) * gCrustGlow * uGlobalGlow;`
        )
        .replace(
          '#include <aomap_fragment>',
          `#include <aomap_fragment>
           reflectedLight.indirectDiffuse *= gStoneAO;
           reflectedLight.indirectSpecular *= mix(1.0, gStoneAO, 0.6);`
        );
    },
    'firestorm-crust'
  );

  material.userData.uniforms = uniforms;

  /**
   * @param {object} state { grown, heat, rumble }
   */
  material.userData.sync = (state) => {
    const c = settings.firestorm;
    const g = settings.global;
    syncStone(uniforms, c, g);
    uniforms.uDustCoat.value = 0;
    syncFire(uniforms, c);

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
    uniforms.uSoot.value = c.crustSoot;
    uniforms.uPulse.value = c.lavaPulse;
    uniforms.uPulseSpeed.value = c.lavaPulseSpeed;
    uniforms.uWallDark.value = c.plateWallDark;
    uniforms.uColorDamp.value.copy(getColor(c.colorDamp));
    uniforms.uGlobalGlow.value = g.glow * g.shaderIntensity;
  };

  return material;
}

/** The four temperatures and the four authored stops every hot layer shares. */
function syncFire(u, c) {
  u.uTempCore.value = c.tempCore;
  u.uTempEdge.value = c.tempEdge;
  u.uEmissionCurve.value = c.emissionCurve;
  u.uPalette.value = c.palette;
  u.uColorCore.value.copy(getColor(c.colorCore));
  u.uColorMid.value.copy(getColor(c.colorMid));
  u.uColorEdge.value.copy(getColor(c.colorEdge));
  u.uColorEmber.value.copy(getColor(c.colorEmber));
}

/* ------------------------------------------------------------------ */
/* 1c · the lava bed under the plate                                   */
/* ------------------------------------------------------------------ */

const LAVA_VERTEX = /* glsl */ `
  uniform float uRadius;
  varying vec2 vLocal;
  void main() {
    vLocal = (uv - 0.5) * 2.0 * uRadius;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * The melt. A disc a hand's breadth under the plate, seen through the seams.
 *
 * Domain-warped fbm crawling outward from the middle; where it runs high a
 * skin has formed and the surface is black basalt with the glow leaking
 * through the cracks between the plates of skin, where it runs low the melt
 * is open and radiating. Cooling drops uHeat: the skin spreads and the melt
 * goes from white through orange to a dull red before it is stone.
 */
const LAVA_FRAGMENT = /* glsl */ `
  ${FIRE_UNIFORMS_GLSL}
  uniform float uTime;
  uniform float uSeed;
  uniform float uRadius;
  uniform float uHeat;
  uniform float uFlow;
  uniform float uScale;
  uniform float uSkin;
  uniform float uIntensity;
  uniform float uGlobalGlow;
  uniform vec3  uColorSkin;

  varying vec2 vLocal;

  ${noiseGLSL}
  ${commonGLSL}
  ${FIRE_GLSL}

  void main() {
    vec2 p = vLocal;
    float dist = length(p) / max(uRadius, 1e-3);
    if (dist > 1.0) discard;

    // The melt crawls outward from the middle, warped as it goes.
    float t = uTime * uFlow;
    vec2 fp = p * uScale;
    vec2 dir = dist > 1e-3 ? p / (dist * uRadius) : vec2(0.0);
    fp -= dir * t * 0.35;
    vec2 warp = vec2(snoise(vec3(fp * 0.55, t * 0.25 + uSeed)), snoise(vec3(fp * 0.55 + 7.3, t * 0.25 + uSeed))) * 0.7;
    vec3 w = vec3(fp + warp, uSeed + t * 0.12);

    float n = fbm4(w) * 0.5 + 0.5;
    float filament = ridged(w * 1.9 + 3.1, 4);

    // The skin: cooled where the field runs high, more of it as the heat goes.
    float threshold = mix(0.75, 0.32, 1.0 - uHeat) * uSkin;
    float skin = smoothstep(threshold - 0.1, threshold + 0.1, n);
    float cracks = smoothstep(0.62, 0.9, filament) * skin;
    float melt = 1.0 - skin;

    // Hottest under the vortex.
    float centre = 0.55 + 0.45 * (1.0 - smoothstep(0.15, 1.0, dist));
    float heat = uHeat * centre * (melt * (0.65 + 0.35 * n) + cracks * 0.9);
    heat += uHeat * 0.06;
    heat = clamp(heat, 0.0, 1.0);

    float lit = melt + cracks * 0.8;
    vec3 col = fireColor(heat) * lit * uIntensity;
    // The skin: black, with the melt under it warming it a little.
    col += uColorSkin * skin * (1.0 - cracks) * (1.0 + heat * 2.0);
    col *= uGlobalGlow;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export function createLavaBedMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      ...fireUniforms(),
      uSeed: { value: Math.random() * 10 },
      uRadius: { value: 2 },
      uHeat: { value: 1 },
      uFlow: { value: 0.6 },
      uScale: { value: 1.6 },
      uSkin: { value: 1 },
      uIntensity: { value: 2.4 },
      uColorSkin: { value: new Color(0.03, 0.02, 0.018) }
    }),
    vertexShader: LAVA_VERTEX,
    fragmentShader: LAVA_FRAGMENT,
    side: FrontSide,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    toneMapped: false
  });
}

/* ------------------------------------------------------------------ */
/* 3 · the bombs: basalt, molten inside, cooling as they fly           */
/* ------------------------------------------------------------------ */

/**
 * Instanced lumps of the floor's stone with the melt showing through them.
 *
 * Everything on a bomb is sampled in its *own* frame — the scan, the crack
 * network, the molten patches — because a bomb tumbles, and a world-space
 * projection would slide the glow across the rock as it turned. The per
 * instance heat comes from the ability: a bomb leaves the vent white, its
 * open patches skin over first, and the cracks stay lit longest, which is
 * how a real one cools — from the outside in.
 */
export function createLavaBombMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
    metalness: 0.0,
    side: FrontSide
  });

  const uniforms = {
    ...stoneUniforms(),
    ...fireUniforms(),
    uDarken: { value: 0.55 },
    uCrackScale: { value: 6 },
    uCrackSharp: { value: 0.82 },
    uMoltenScale: { value: 2.2 },
    uMolten: { value: 0.6 },
    uGlow: { value: 3 },
    uGlobalGlow: { value: 1 }
  };

  environment.registerShadowCasterWithPatch(
    material,
    (shader) => {
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute float aSeed;
           attribute float aHeat;
           varying vec3  vBombLocal;
           varying vec3  vBombNormal;
           varying mat3  vBombRot;
           varying float vBombSeed;
           varying float vBombHeat;`
        )
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
           {
             vBombNormal = objectNormal;
             mat3 rot = mat3(modelMatrix);
             float sc = 1.0;
             #ifdef USE_INSTANCING
               mat3 im = mat3(instanceMatrix);
               sc = length(im[0]);
               im = mat3(im[0] / max(length(im[0]), 1e-5), im[1] / max(length(im[1]), 1e-5), im[2] / max(length(im[2]), 1e-5));
               rot = rot * im;
             #endif
             vBombRot = rot;
             vBombLocal = position * sc;
           }`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vBombSeed = aSeed;
           vBombHeat = aHeat;`
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying vec3  vBombLocal;
           varying vec3  vBombNormal;
           varying mat3  vBombRot;
           varying float vBombSeed;
           varying float vBombHeat;
           uniform float uTime;
           uniform float uDarken;
           uniform float uCrackScale;
           uniform float uCrackSharp;
           uniform float uMoltenScale;
           uniform float uMolten;
           uniform float uGlow;
           uniform float uGlobalGlow;
           ${FIRE_UNIFORMS_GLSL}

           ${noiseGLSL}
           ${STONE_PARS}
           ${GRADIENT_GLSL}
           ${FIRE_GLSL}

           float gBombGlow = 0.0;
           float gBombHeat = 0.0;`
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
           {
             vec3 ln = normalize(vBombNormal);
             Stone st = sampleStone(vBombLocal + vBombSeed * 3.0, ln, vBombSeed);
             st.albedo *= mix(0.6, 1.2, fract(vBombSeed * 0.618 + 0.11));
             st.albedo *= 1.0 - uDarken;

             // Cracks: two ridged octaves in the bomb's own frame.
             vec3 lp = vBombLocal * uCrackScale + vBombSeed * 11.0;
             float c1 = 1.0 - abs(snoise(lp));
             float c2 = 1.0 - abs(snoise(lp * 2.3 + 5.0));
             float crack = smoothstep(uCrackSharp, 1.0, max(c1, c2 * 0.85));

             // Open melt: broad patches where the skin has not formed.
             float field = snoise01(vBombLocal * uMoltenScale + vBombSeed * 5.0);
             float molten = smoothstep(1.0 - uMolten * 0.6, 1.0 - uMolten * 0.3, field);

             float heat = clamp(vBombHeat, 0.0, 1.0);
             // The open patches skin over first; the cracks stay lit longest.
             float glowMask = crack * smoothstep(0.0, 0.5, heat) + molten * smoothstep(0.3, 1.0, heat);
             float flick = 0.85 + 0.15 * sin(uTime * 19.0 + vBombSeed * 30.0);
             gBombGlow = glowMask * uGlow * flick;
             gBombHeat = heat * (0.5 + 0.5 * molten) ;

             // Where it was molten the skin is glassy black.
             st.albedo = mix(st.albedo, vec3(0.015, 0.012, 0.01), molten * 0.85);
             st.rough = mix(st.rough, 0.45, molten * 0.5);

             diffuseColor.rgb *= st.albedo;
             gStoneAO = mix(1.0, st.ao, uStoneAO);
             gStoneNormal = normalize(vBombRot * st.normal);
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
           totalEmissiveRadiance += fireColor(gBombHeat) * gBombGlow * uGlobalGlow;`
        )
        .replace(
          '#include <aomap_fragment>',
          `#include <aomap_fragment>
           reflectedLight.indirectDiffuse *= gStoneAO;`
        );
    },
    'firestorm-bomb'
  );

  material.userData.uniforms = uniforms;

  material.userData.sync = () => {
    const c = settings.firestorm;
    const g = settings.global;
    syncStone(uniforms, c, g);
    syncFire(uniforms, c);
    uniforms.uDustCoat.value = 0;
    uniforms.uDarken.value = c.bombDarken;
    uniforms.uTexScale.value = 1 / Math.max(0.05, c.texScale * c.bombTexScale);
    uniforms.uCrackScale.value = c.bombCrackScale;
    uniforms.uCrackSharp.value = c.bombCrackSharp;
    uniforms.uMoltenScale.value = c.bombMoltenScale;
    uniforms.uMolten.value = c.bombMolten;
    uniforms.uGlow.value = c.bombGlow * g.glow;
    uniforms.uGlobalGlow.value = g.glow * g.shaderIntensity;
  };

  return material;
}

/* ------------------------------------------------------------------ */
/* 4 · the vortex: a fire whirl                                         */
/* ------------------------------------------------------------------ */

const HULL_VERTEX = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

/** Clip a march against the opaque scene. Used by the clouds. */
const SCENE_CLIP_GLSL = /* glsl */ `
  uniform vec2 uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  float sceneReach(vec3 rd) {
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    float packed = unpackRGBAToDepth(texture2D(uSceneDepth, screenUV));
    float sceneViewZ = perspectiveDepthToViewZ(packed, uCameraNear, uCameraFar);
    float dzdt = (viewMatrix * vec4(rd, 0.0)).z;
    return dzdt < -1e-5 ? sceneViewZ / dzdt : 1e6;
  }
`;

/**
 * The column every piece of the whirl is built round: its profile with
 * height and the wander of its axis. Shared by the ribbons and the core so
 * the two stay wound about the same line.
 */
const COLUMN_GLSL = /* glsl */ `
  #define TAU 6.283185307179586

  uniform vec3  uBase;
  uniform float uHeight;
  uniform float uReveal;
  uniform float uLift;
  uniform float uFoot;
  uniform float uWaist;
  uniform float uCrown;
  uniform float uWaistAt;
  uniform float uSway;
  uniform float uSwayRate;
  uniform float uTurns;
  uniform float uSpin;

  /* Wide at the foot where the flames spread over the plate, pinched to a
     waist, opening again toward the crown. */
  float radiusAt(float s) {
    float foot = pow(1.0 - smoothstep(0.0, uWaistAt, s), 1.6);
    float crown = smoothstep(uWaistAt, 1.0, s);
    return uWaist + (uFoot - uWaist) * foot + (uCrown - uWaist) * crown;
  }

  /* The axis leans and wanders on two slow waves: the top dances, the foot
     stays planted. */
  vec2 axisOffset(float s, float t) {
    float k = pow(s, 1.4) * uSway;
    return vec2(
      sin(t * uSwayRate + s * 2.7) * 0.7 + sin(t * uSwayRate * 0.37 + 1.3) * 0.5,
      cos(t * uSwayRate * 0.83 + s * 2.1) * 0.7 + cos(t * uSwayRate * 0.29 + 2.1) * 0.5
    ) * k;
  }

  /* Where the winding stands at height s: uTurns turns over the column, and
     the whole pattern climbing at uSpin. */
  float windingAt(float s, float t) {
    return s * uTurns * TAU - t * uSpin;
  }
`;

export const FIRESTORM_MAX_RIBBONS = 14;

/**
 * One strip per ribbon, instanced: aS runs foot to crown, aV across, and
 * aRibbon says which helix the instance rides. The vertex stage places all
 * of it; the buffer holds nothing but parameters.
 */
export function createRibbonGeometry(segments = 120) {
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

  const ribbon = new Float32Array(FIRESTORM_MAX_RIBBONS);
  for (let i = 0; i < FIRESTORM_MAX_RIBBONS; i++) ribbon[i] = i;
  geometry.setAttribute('aRibbon', new InstancedBufferAttribute(ribbon, 1));
  geometry.instanceCount = FIRESTORM_MAX_RIBBONS;
  geometry.boundingSphere = new Sphere(new Vector3(), 1e4);
  return geometry;
}

/**
 * The ribbons — the whirl's structure, and what the sheet's fourth panel
 * actually draws: a few broad bands of flame wound about one axis, climbing
 * it, each one solid down its spine and torn to tongues along its edges
 * and at its tip.
 *
 * Every ribbon rides a helix round the column (the profile and the winding
 * come from COLUMN_GLSL) and is widened into a strip that faces the camera,
 * the way the phoenix's serpents are — so a band that is crossing the front
 * of the column reads as a broad slanted sheet, and one at the silhouette
 * reads as a streak licking up the edge, which is what a wound sheet of
 * flame looks like from any side without the strip ever turning edge-on.
 * The first uRibbons are the broad bands; the next uWisps are thinner
 * strands at a larger radius, turning faster: the loose fire peeling off
 * the outside of the column.
 *
 * Premultiplied over, not additive: the upper reach of every ribbon has
 * cooled from flame to soot, and soot has to *darken* what is behind it —
 * the dark laces wound through the fire in the sheet are exactly that.
 */
const RIBBON_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uRibbons;
  uniform float uWisps;
  uniform float uWidth;
  uniform float uFootWidth;
  uniform float uWispWidth;
  uniform float uWispRadius;
  uniform float uWispSpin;
  uniform float uWaver;

  attribute float aS;
  attribute float aV;
  attribute float aRibbon;

  varying vec2  vST;
  varying float vKind;
  varying float vSeed;
  varying float vLen;
  varying float vWidth;
  varying float vFacing;

  ${COLUMN_GLSL}

  vec3 pathAt(float s, float phase, float rScale, float seed, float spinScale) {
    float H = uHeight * uReveal;
    float theta = phase + windingAt(s, uTime * spinScale);
    // Not a perfect helix: the band swells and pinches as it climbs.
    float waver = 1.0 + uWaver * (sin(s * 7.0 + uTime * 2.3 + seed * 6.0) * 0.6
                                + sin(s * 13.0 - uTime * 3.1 + seed * 2.0) * 0.4);
    float R = radiusAt(s) * rScale * waver * (0.45 + 0.55 * uReveal);
    vec2 sway = axisOffset(s, uTime);
    return uBase + vec3(cos(theta) * R + sway.x, s * H + uLift, sin(theta) * R + sway.y);
  }

  void main() {
    float i = aRibbon;
    float broad = step(i + 0.5, uRibbons);
    float live = step(i + 0.5, uRibbons + uWisps);
    vKind = 1.0 - broad;
    vSeed = i;

    // Broad bands spaced evenly round the axis; wisps on their own spacing,
    // offset so none of them hides inside a band.
    float n = mix(max(uWisps, 1.0), max(uRibbons, 1.0), broad);
    float k = mix(i - uRibbons, i, broad);
    float phase = k * TAU / n + (1.0 - broad) * 0.9;
    float rScale = mix(uWispRadius, 1.0, broad);
    float spinScale = mix(uWispSpin, 1.0, broad);

    vec3 p = pathAt(aS, phase, rScale, i, spinScale);
    vec3 p2 = pathAt(aS + 0.004, phase, rScale, i, spinScale);
    vec3 tangent = normalize(p2 - p);
    vec3 toEye = normalize(cameraPosition - p);
    vec3 side = cross(tangent, toEye);
    float sl = length(side);
    side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);

    // Broad over the plate, a steady band up the column, opening a little
    // where the tip frays.
    float foot = pow(1.0 - smoothstep(0.0, 0.45, aS), 1.5);
    float w = mix(uWispWidth, uWidth * (1.0 + (uFootWidth - 1.0) * foot), broad);
    w *= 0.85 + 0.15 * smoothstep(0.6, 1.0, aS);
    vec3 world = p + side * (aV - 0.5) * w;

    // Which side of the axis this bit of ribbon is on, seen from the camera.
    vec2 fromAxis = p.xz - (uBase.xz + axisOffset(aS, uTime));
    vec2 toCam = cameraPosition.xz - uBase.xz;
    vFacing = dot(normalize(fromAxis + 1e-4), normalize(toCam + 1e-4));

    float H = uHeight * uReveal;
    float Rm = radiusAt(0.5) * rScale;
    vLen = sqrt(H * H + pow(uTurns * TAU * Rm, 2.0));
    vWidth = w;
    vST = vec2(aS, aV);
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
    if (live < 0.5 || uReveal <= 0.001) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  }
`;

const RIBBON_FRAGMENT = /* glsl */ `
  ${FIRE_UNIFORMS_GLSL}
  uniform float uTime;
  uniform float uNoiseScale;
  uniform float uFlow;
  uniform float uShred;
  uniform float uTongue;
  uniform float uHeat;
  uniform float uCool;
  uniform float uSootFrom;
  uniform float uSoot;
  uniform float uIntensity;
  uniform float uWispIntensity;
  uniform float uFlicker;
  uniform float uBurn;
  uniform float uFade;
  uniform float uOpacity;
  uniform float uGlobalGlow;
  uniform float uShaderIntensity;
  uniform vec3  uColorSmoke;

  varying vec2  vST;
  varying float vKind;
  varying float vSeed;
  varying float vLen;
  varying float vWidth;
  varying float vFacing;

  ${noiseGLSL}
  ${commonGLSL}
  ${FIRE_GLSL}

  void main() {
    float s = vST.x;                       // 0 foot → 1 tip
    float across = abs(vST.y - 0.5) * 2.0; // 0 spine → 1 edge
    float wisp = vKind;

    // The noise domain is the ribbon itself, so the fire climbs the helix
    // rather than being swum through by it.
    vec3 np = vec3(s * vLen - uTime * uFlow, (vST.y - 0.5) * vWidth * 1.4, vSeed * 9.0 + wisp * 5.0) * uNoiseScale;
    float ridge, coarse;
    float n = flameFbm(np, uTime * 0.25, 0.3, ridge, coarse);

    // Solid down the spine, shredded along the edges, and the top torn into
    // tongues that thin to strands. A wisp is the same band, rattier.
    float top = smoothstep(0.5, 1.0, s);
    float field = (1.0 - across * across) - 0.42
                + (n - 0.5) * uShred * (0.45 + 0.9 * across)
                - top * uTongue * (0.35 + 0.65 * ridge)
                - wisp * (0.16 + 0.3 * across)
                - uBurn * (1.0 - s) * 1.4;
    float d = smoothstep(0.0, 0.2, field) * smoothstep(0.0, 0.05, s);
    if (d < 0.003) discard;

    // Temperature: a yellow spine in an orange band, red at the edges,
    // cooler with height. Kept well under white: the core is the white.
    float spine = 1.0 - across * across;
    float heat = (spine * 0.55 + 0.14 + (coarse - 0.5) * 0.45) * uHeat;
    heat *= 1.0 - uCool * smoothstep(0.1, 1.0, s);
    heat = clamp(heat, 0.0, 1.0);

    // Past uSootFrom the gas has burnt out: it radiates nothing and blocks.
    float burnt = smoothstep(uSootFrom - 0.12, uSootFrom + 0.28, s + (n - 0.5) * 0.3 + across * 0.1);

    // A band crossing behind the column sits behind the core: no soot over
    // it, and a touch dimmer, so the front of the whirl reads as the front.
    float back = 1.0 - smoothstep(-0.35, 0.35, vFacing);
    burnt *= 1.0 - back * 0.7;

    float flick = 1.0 + uFlicker * (vnoise(vec3(uTime * 7.0, vSeed * 5.0, 0.0)) * 2.0 - 1.0);
    float intensity = mix(uIntensity, uIntensity * uWispIntensity, wisp) * flick * (1.0 - back * 0.25);
    vec3 fire = fireColor(heat) * intensity * mix(0.65, 1.0, uShaderIntensity);
    vec3 col = mix(fire, uColorSmoke * (0.3 + 0.7 * heat), burnt);
    float a = d * mix(1.0, uSoot, burnt);

    float fade = uFade * uOpacity;
    gl_FragColor = vec4(col * d * uGlobalGlow * fade, a * fade);
  }
`;

export function createRibbonMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      ...fireUniforms(),
      uBase: { value: new Vector3() },
      uHeight: { value: 5 },
      uReveal: { value: 0 },
      uLift: { value: 0 },
      uFoot: { value: 2 },
      uWaist: { value: 1.2 },
      uCrown: { value: 1.4 },
      uWaistAt: { value: 0.4 },
      uSway: { value: 0.5 },
      uSwayRate: { value: 1.1 },
      uTurns: { value: 1.3 },
      uSpin: { value: 2 },
      uRibbons: { value: 3 },
      uWisps: { value: 4 },
      uWidth: { value: 1.2 },
      uFootWidth: { value: 1.6 },
      uWispWidth: { value: 0.4 },
      uWispRadius: { value: 1.3 },
      uWispSpin: { value: 1.35 },
      uWaver: { value: 0.12 },
      uNoiseScale: { value: 1 },
      uFlow: { value: 3 },
      uShred: { value: 1 },
      uTongue: { value: 0.8 },
      uHeat: { value: 1 },
      uCool: { value: 0.5 },
      uSootFrom: { value: 0.62 },
      uSoot: { value: 0.75 },
      uIntensity: { value: 1.5 },
      uWispIntensity: { value: 0.7 },
      uFlicker: { value: 0.2 },
      uBurn: { value: 0 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uColorSmoke: { value: new Color(0.16, 0.13, 0.12) }
    }),
    vertexShader: RIBBON_VERTEX,
    fragmentShader: RIBBON_FRAGMENT,
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

/**
 * The core — the white-hot interior the ribbons are wound round.
 *
 * One quad, turned about the column's axis to face the camera every frame,
 * as wide as the column's profile at every height. The fragment treats it
 * as the front face of a cylinder: from the pixel's offset across the quad
 * it recovers the world azimuth of the point under it and shades a helical
 * band there, in step with the ribbons' winding, so the interior reads as
 * turning with them — the barber-pole that makes a flat card a whirl. Bright
 * on the axis, falling off to the sides, torn into tongues at the crown.
 */
const CORE_VERTEX = /* glsl */ `
  uniform float uTime;
  uniform float uCoreWidth;

  varying float vX;
  varying float vS;
  varying float vAzimuth;
  varying float vRadius;

  ${COLUMN_GLSL}

  void main() {
    float s = uv.y;
    float x = uv.x * 2.0 - 1.0;
    float H = uHeight * uReveal;
    vec2 sway = axisOffset(s, uTime);
    vec3 centre = uBase + vec3(sway.x, s * H + uLift, sway.y);

    vec3 toEye = cameraPosition - centre;
    toEye.y = 0.0;
    float l = length(toEye);
    toEye = l > 1e-4 ? toEye / l : vec3(0.0, 0.0, 1.0);
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toEye));

    float R = radiusAt(s) * uCoreWidth * (0.45 + 0.55 * uReveal);
    vec3 world = centre + right * x * R;

    vX = x;
    vS = s;
    vRadius = R;
    vAzimuth = atan(toEye.z, toEye.x);
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
    if (uReveal <= 0.001) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  }
`;

const CORE_FRAGMENT = /* glsl */ `
  ${FIRE_UNIFORMS_GLSL}
  uniform float uTime;
  uniform float uRibbons;
  uniform float uNoiseScale;
  uniform float uFlow;
  uniform float uShred;
  uniform float uTongue;
  uniform float uStripe;
  uniform float uHeat;
  uniform float uCool;
  uniform float uSootFrom;
  uniform float uSoot;
  uniform float uIntensity;
  uniform float uFlicker;
  uniform float uBurn;
  uniform float uFade;
  uniform float uOpacity;
  uniform float uGlobalGlow;
  uniform float uShaderIntensity;
  uniform vec3  uColorSmoke;

  varying float vX;
  varying float vS;
  varying float vAzimuth;
  varying float vRadius;

  ${COLUMN_GLSL}
  ${noiseGLSL}
  ${commonGLSL}
  ${FIRE_GLSL}

  void main() {
    float s = vS;
    float r = min(abs(vX), 1.0);

    // The front face of the cylinder: the azimuth of the point under this
    // pixel, and the helical band there, in step with the ribbons.
    float theta = vAzimuth - asin(clamp(vX, -1.0, 1.0));
    float stripe = 0.5 + 0.5 * cos(max(uRibbons, 1.0) * (theta - windingAt(s, uTime)));

    // Fire climbing the interior.
    vec3 np = vec3(vX * vRadius * 0.8, s * uHeight - uTime * uFlow, theta * 0.5) * uNoiseScale;
    float ridge, coarse;
    float n = flameFbm(np, uTime * 0.2, 0.3, ridge, coarse);

    float bell = 1.0 - r * r;
    float twist = 1.0 - uStripe * (1.0 - stripe) * (0.35 + 0.65 * r);
    float top = smoothstep(0.55, 1.0, s);
    float field = bell * twist - 0.22
                + (n - 0.5) * uShred * (0.4 + 0.8 * r)
                - top * uTongue * (0.4 + 0.6 * ridge)
                - uBurn * (1.0 - s) * 1.4;
    float d = smoothstep(0.0, 0.3, field) * smoothstep(0.0, 0.04, s);
    if (d < 0.003) discard;

    float heat = (0.35 + 0.55 * bell * twist + (coarse - 0.5) * 0.4) * uHeat;
    heat *= 1.0 - uCool * smoothstep(0.15, 1.0, s);
    heat = clamp(heat, 0.0, 1.0);
    float burnt = smoothstep(uSootFrom - 0.1, uSootFrom + 0.3, s + (n - 0.5) * 0.3 + r * 0.15);

    float flick = 1.0 + uFlicker * (vnoise(vec3(uTime * 6.1, 3.0, 0.0)) * 2.0 - 1.0);
    vec3 fire = fireColor(heat) * uIntensity * flick * mix(0.65, 1.0, uShaderIntensity);
    vec3 col = mix(fire, uColorSmoke * (0.3 + 0.7 * heat), burnt);
    float a = d * mix(1.0, uSoot, burnt);

    float fade = uFade * uOpacity;
    gl_FragColor = vec4(col * d * uGlobalGlow * fade, a * fade);
  }
`;

export function createCoreMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      ...fireUniforms(),
      uBase: { value: new Vector3() },
      uHeight: { value: 5 },
      uReveal: { value: 0 },
      uLift: { value: 0 },
      uFoot: { value: 2 },
      uWaist: { value: 1.2 },
      uCrown: { value: 1.4 },
      uWaistAt: { value: 0.4 },
      uSway: { value: 0.5 },
      uSwayRate: { value: 1.1 },
      uTurns: { value: 1.3 },
      uSpin: { value: 2 },
      uRibbons: { value: 3 },
      uCoreWidth: { value: 0.7 },
      uNoiseScale: { value: 1 },
      uFlow: { value: 3 },
      uShred: { value: 0.7 },
      uTongue: { value: 0.8 },
      uStripe: { value: 0.55 },
      uHeat: { value: 1.0 },
      uCool: { value: 0.5 },
      uSootFrom: { value: 0.6 },
      uSoot: { value: 0.85 },
      uIntensity: { value: 1.7 },
      uFlicker: { value: 0.2 },
      uBurn: { value: 0 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uColorSmoke: { value: new Color(0.16, 0.13, 0.12) }
    }),
    vertexShader: CORE_VERTEX,
    fragmentShader: CORE_FRAGMENT,
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
/* 2 + 5 · the clouds: the steam blast and the pyrocumulus              */
/* ------------------------------------------------------------------ */

/**
 * A raymarched volume of puffs.
 *
 * The ability lays out up to FIRESTORM_MAX_PUFFS spheres each frame — where
 * they are, how big, how strong — and the shader does the rest. The field is
 * the soft union of the spheres eroded by three octaves of rising value
 * noise, which turns a handful of balls into a cauliflower, and it is *lit*:
 * the union's own gradient stands in for a surface normal, so every puff has
 * a sunlit top and a shaded underside; a second, noise-free probe toward the
 * sun through the same union shadows the puffs under other puffs; and a
 * point of fire under the cloud lights it from below, which is the one thing
 * the pyrocumulus over a fire storm has that a cloud does not.
 *
 * One material, two instances: the steam blast is white and expands off the
 * plate, the pyrocumulus is soot and stands on the vortex.
 */
const CLOUD_FRAGMENT = /* glsl */ `
  #define MAX_PUFFS ${FIRESTORM_MAX_PUFFS}

  uniform float uTime;
  uniform vec4  uPuffs[MAX_PUFFS];
  uniform vec4  uPuffData[MAX_PUFFS];
  uniform float uCount;
  uniform vec3  uBoundCenter;
  uniform float uBoundRadius;
  uniform float uSeed;
  uniform float uNoiseScale;
  uniform float uRise;
  uniform float uDetail;
  uniform float uErode;
  uniform float uSoftness;
  uniform float uDensity;
  uniform float uExtinction;
  uniform float uSteps;
  uniform float uShadow;
  uniform float uShadowStep;
  uniform float uFade;
  uniform float uOpacity;
  uniform float uGlobalGlow;
  uniform vec3  uAlbedo;
  uniform vec3  uSunColor;
  uniform float uSunStrength;
  uniform vec3  uSkyColor;
  uniform float uSkyStrength;
  uniform vec3  uFirePos;
  uniform vec3  uFireColor;
  uniform float uFireGlow;
  uniform float uFireFalloff;
  uniform vec3  uLightDir;

  varying vec3 vWorld;

  ${noiseGLSL}
  ${commonGLSL}
  ${SCENE_CLIP_GLSL}

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

  /* The soft union of the puffs, and its gradient. */
  float blob(vec3 p, out vec3 grad, out float seed) {
    float sum = 0.0;
    float wsum = 0.0;
    grad = vec3(0.0);
    seed = 0.0;
    for (int i = 0; i < MAX_PUFFS; i++) {
      if (float(i) >= uCount) break;
      vec4 pf = uPuffs[i];
      vec3 rel = (p - pf.xyz) / max(pf.w, 1e-3);
      float d2 = dot(rel, rel);
      if (d2 < 1.0) {
        float k = 1.0 - d2;
        k = k * k * uPuffData[i].x;
        sum += k;
        grad += rel * k;
        seed += uPuffData[i].y * k;
        wsum += k;
      }
    }
    seed = wsum > 1e-4 ? seed / wsum : 0.0;
    return sum;
  }

  float blobOnly(vec3 p) {
    float sum = 0.0;
    for (int i = 0; i < MAX_PUFFS; i++) {
      if (float(i) >= uCount) break;
      vec4 pf = uPuffs[i];
      vec3 rel = (p - pf.xyz) / max(pf.w, 1e-3);
      float d2 = dot(rel, rel);
      if (d2 < 1.0) {
        float k = 1.0 - d2;
        sum += k * k * uPuffData[i].x;
      }
    }
    return sum;
  }

  float cloudSample(vec3 p, out vec3 normal, out float shadow, out float bump) {
    normal = vec3(0.0, 1.0, 0.0);
    shadow = 1.0;
    bump = 0.5;
    vec3 g;
    float seed;
    float b = blob(p, g, seed);
    if (b < 0.02) return 0.0;

    // Three octaves, drifting up: the detail rises through the puffs.
    vec3 np = p * uNoiseScale + vec3(seed * 7.0, -uTime * uRise + seed * 3.0, uSeed);
    float n = vnoise(np) * 0.5 + vnoise(np * 2.13 + 3.7) * 0.3 + vnoise(np * 4.31 + 9.1) * 0.2;
    float field = b - uErode + (n - 0.5) * uDetail;
    float d = smoothstep(0.0, clamp(uSoftness, 0.05, 2.0), field);
    if (d <= 0.0) return 0.0;

    normal = normalize(g + vec3(0.0, 1e-4, 0.0));
    bump = n;
    // How much cloud stands between here and the sun.
    shadow = exp(-blobOnly(p + uLightDir * uShadowStep) * uShadow);
    return d * uDensity;
  }

  vec3 shade(vec3 p, vec3 n, float shadow, float bump) {
    float sun = max(dot(n, uLightDir), 0.0) * shadow * (0.55 + 0.7 * bump);
    float sky = (0.55 + 0.45 * n.y) * (0.7 + 0.3 * bump);
    vec3 toFire = uFirePos - p;
    float df = length(toFire);
    float fire = max(dot(n, toFire / max(df, 1e-3)), 0.0) * uFireGlow / (1.0 + df * df * uFireFalloff);
    return uAlbedo * (uSunColor * sun * uSunStrength + uSkyColor * sky * uSkyStrength + uFireColor * fire);
  }

  void main() {
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorld - ro);

    vec3 oc = ro - uBoundCenter;
    float b = dot(oc, rd);
    float c = dot(oc, oc) - uBoundRadius * uBoundRadius;
    float disc = b * b - c;
    if (disc < 0.0) discard;
    float sq = sqrt(disc);
    float tScene = sceneReach(rd);
    float t0 = max(-b - sq, 0.02);
    float t1 = min(-b + sq, tScene);
    if (t1 <= t0) discard;

    float steps = clamp(uSteps, 6.0, 48.0);
    float baseStep = (t1 - t0) / steps;
    float t = t0 + baseStep * hash13(vec3(gl_FragCoord.xy, fract(uTime) * 64.0));

    vec3 acc = vec3(0.0);
    float transmittance = 1.0;
    float stride = 1.0;
    for (int i = 0; i < 48; i++) {
      if (t >= t1 || transmittance < 0.015) break;
      vec3 n;
      float shadow;
      float bump;
      vec3 p = ro + rd * t;
      float dens = cloudSample(p, n, shadow, bump);
      float stepSize = baseStep * stride;
      if (dens > 0.002) {
        stride = 1.0;
        stepSize = baseStep;
        dens *= clamp((tScene - t) / 0.5, 0.0, 1.0);
        vec3 col = shade(p, n, shadow, bump);
        acc += col * dens * transmittance * stepSize;
        transmittance *= exp(-dens * uExtinction * stepSize);
      } else {
        stride = min(stride * 1.5, 2.5);
      }
      t += stepSize;
    }

    float alpha = clamp((1.0 - transmittance) * uOpacity, 0.0, 1.0) * uFade;
    vec3 color = acc * uOpacity * uFade * uGlobalGlow;
    if (alpha < 0.002) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

export function createCloudMaterial() {
  // The vec4 arrays are flat Float32Arrays the ability writes straight into:
  // three uploads a typed array as one block, so a puff costs no objects.
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uPuffs: { value: new Float32Array(FIRESTORM_MAX_PUFFS * 4) },
      uPuffData: { value: new Float32Array(FIRESTORM_MAX_PUFFS * 4) },
      uCount: { value: 0 },
      uBoundCenter: { value: new Vector3() },
      uBoundRadius: { value: 1 },
      uSeed: { value: Math.random() * 10 },
      uNoiseScale: { value: 1.1 },
      uRise: { value: 0.6 },
      uDetail: { value: 0.9 },
      uErode: { value: 0.35 },
      uSoftness: { value: 0.35 },
      uDensity: { value: 1.6 },
      uExtinction: { value: 2.4 },
      uSteps: { value: 22 },
      uShadow: { value: 1.4 },
      uShadowStep: { value: 0.7 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uAlbedo: { value: new Color(0.9, 0.9, 0.9) },
      uSunColor: { value: new Color(1, 0.95, 0.85) },
      uSunStrength: { value: 1.6 },
      uSkyColor: { value: new Color(0.55, 0.62, 0.75) },
      uSkyStrength: { value: 0.6 },
      uFirePos: { value: new Vector3() },
      uFireColor: { value: new Color(1, 0.45, 0.1) },
      uFireGlow: { value: 12 },
      uFireFalloff: { value: 0.12 }
    }),
    vertexShader: HULL_VERTEX,
    fragmentShader: CLOUD_FRAGMENT,
    side: BackSide,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneMinusSrcAlphaFactor,
    toneMapped: false
  });
}

/** Push the cloud's shared look from settings. `c` is the cloud's own sub-block. */
export function syncCloud(material, c, g, fade) {
  const u = material.uniforms;
  u.uNoiseScale.value = c.noiseScale * g.noiseFrequency;
  u.uRise.value = c.rise * g.noiseSpeed;
  u.uDetail.value = c.detail * g.noiseStrength;
  u.uErode.value = c.erode;
  u.uSoftness.value = c.softness;
  u.uDensity.value = c.density;
  u.uExtinction.value = c.extinction;
  u.uSteps.value = c.steps;
  u.uShadow.value = c.shadow;
  u.uShadowStep.value = c.shadowStep;
  u.uFade.value = fade;
  u.uOpacity.value = c.opacity * g.opacity;
  u.uAlbedo.value.copy(getColor(c.colorAlbedo));
  u.uSunColor.value.copy(getColor(settings.environment.sunColor));
  u.uSunStrength.value = c.sun * saturate(settings.environment.sunIntensity / 3);
  u.uSkyColor.value.copy(getColor(c.colorSky));
  u.uSkyStrength.value = c.sky;
  u.uFireGlow.value = c.fireGlow * g.glow;
  u.uFireFalloff.value = c.fireFalloff;
  u.uGlobalGlow.value = 1;
}
