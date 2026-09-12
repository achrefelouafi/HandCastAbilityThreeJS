import { Color } from 'three';
import { getStoneTextures, STONE_TILE_METRES } from '../loaders/StoneTextures.js';
import { frame } from '../core/FrameUniforms.js';
import { getColor } from '../utils/color.js';
import { saturate } from '../utils/math.js';

/**
 * The shared stone surface model — the way photographic rock is drawn on
 * procedural geometry anywhere in the sandbox.
 *
 * It was built for the Monolith Rift's slabs and outlived them: today the
 * Toxic Shield's ruptured crust (`ToxicShieldMaterials.js`) is what includes
 * it. The host is a real `MeshStandardMaterial` — sun, shadows, IBL, the
 * whole physical stack — with a **triplanar projection of the ambientCG
 * Rock030 scan** patched over the map slots, plus the handful of things a
 * *blast* does to rock that a static texture cannot know about.
 *
 * ## Why triplanar rather than UVs
 *
 * Every piece of geometry this dresses is procedurally generated per cast or
 * stretched by a per-instance matrix that is different every time. Any UV set
 * baked into that would swim: the grain would stretch with the instance and a
 * tall slab would show a smeared rock while the block beside it showed a fine
 * one. Sampling in **world metres** off the world normal fixes the grain to
 * physical size, so every stone in a cluster is made of the same rock, and the
 * floor it came out of is made of it too.
 *
 * The cost is three texture fetches per map instead of one. At the instance
 * counts here that is nothing, and it buys the single thing the look is built
 * on: the slabs have to look photographed.
 *
 * ## What is added on top of the scan
 *
 *   - **Cement dust settling.** `uDustCoat` climbs over the life of the cast and
 *     pales every up-facing surface, patchily, killing its roughness contrast
 *     and flattening its normal. Freshly erupted stone is clean and dark; a
 *     second later it is wearing the cloud.
 *   - **Fresh fracture.** `aFace` marks the faces that did not exist a moment
 *     ago. They are paler, rougher and unweathered, which is what separates a
 *     broken slab from a boulder.
 *   - **Damp root.** The bottom of a slab came from under the floor: darker,
 *     slightly less rough, and occluded.
 *
 * Three exports: `STONE_PARS` (the GLSL, to splice into a host shader's
 * fragment pars), `stoneUniforms()` (the uniform block it reads) and
 * `syncStone()` (which pulls the `texScale` / `stoneRough` / `colorStone`…
 * family out of an ability's settings block every frame).
 */

/* ---------------------------------------------------------------------- */
/* The shared surface model                                                */
/* ---------------------------------------------------------------------- */

export const STONE_PARS = /* glsl */ `
  uniform sampler2D uAlbedoMap;
  uniform sampler2D uNormalMap;
  uniform sampler2D uRoughMap;
  uniform sampler2D uAOMap;
  uniform float uTexAmount;
  uniform float uTexScale;
  uniform float uNormalScale;
  uniform float uStoneRough;
  uniform float uStoneFloor;
  uniform float uStoneAO;
  uniform float uDustCoat;
  uniform float uDustSharp;
  uniform float uDustScale;
  uniform vec3  uColorStone;
  uniform vec3  uColorStoneDeep;
  uniform vec3  uColorDust;
  uniform vec3  uColorGrade;
  uniform float uDesat;
  uniform float uGrade;

  struct Stone {
    vec3  albedo;
    vec3  normal;   // world space
    float rough;
    float ao;
  };

  // Written by sampleStone in the map stage, read by the roughness, normal and
  // ambient-occlusion stages further down the shader. There is no varying to
  // carry them through, and repeating three texture fetches to recover them
  // would cost more than the globals do.
  float gStoneAO = 1.0;
  float gRoughness = 1.0;
  vec3  gStoneNormal = vec3(0.0, 1.0, 0.0);

  /**
   * Projection weights. A high power keeps the seams between the three planes
   * narrow, which matters on a slab: a soft blend across a vertical wall reads
   * as the grain fading out halfway up it.
   */
  vec3 triWeights(vec3 n) {
    vec3 b = pow(abs(n), vec3(6.0));
    return b / max(dot(b, vec3(1.0)), 1e-4);
  }

  vec3 triColor(sampler2D tex, vec3 p, vec3 w, float s) {
    return texture2D(tex, p.yz * s).rgb * w.x
         + texture2D(tex, p.zx * s).rgb * w.y
         + texture2D(tex, p.xy * s).rgb * w.z;
  }

  /**
   * Whiteout-blended triplanar normal: each projection is read as a tangent
   * space normal, swizzled into the orientation of its own plane, and summed by
   * the same weights the colour uses. Cheaper and steadier than building a real
   * tangent frame per plane, and on rock nobody can tell.
   */
  vec3 triNormal(sampler2D tex, vec3 p, vec3 n, vec3 w, float s, float strength) {
    vec3 nx = texture2D(tex, p.yz * s).xyz * 2.0 - 1.0;
    vec3 ny = texture2D(tex, p.zx * s).xyz * 2.0 - 1.0;
    vec3 nz = texture2D(tex, p.xy * s).xyz * 2.0 - 1.0;
    nx.xy *= strength;
    ny.xy *= strength;
    nz.xy *= strength;
    nx = vec3(nx.xy + n.zy, abs(nx.z) * n.x);
    ny = vec3(ny.xy + n.xz, abs(ny.z) * n.y);
    nz = vec3(nz.xy + n.xy, abs(nz.z) * n.z);
    return normalize(nx.zyx * w.x + ny.xzy * w.y + nz.xyz * w.z);
  }

  /**
   * The scan, projected onto a surface.
   *
   * uTexAmount is the loader's handshake: 0 until all four maps have landed,
   * and the procedural fallback carries the shading until they do. See
   * loaders/StoneTextures.js.
   */
  Stone sampleStone(vec3 wp, vec3 wn, float seed) {
    vec3 w = triWeights(wn);
    float s = uTexScale;

    Stone st;

    /* the procedural stand-in — broad value variation, no fine detail, so it
       never aliases while it is on screen */
    float macro = fbm3(wp * 0.6 + seed * 13.0) * 0.5 + 0.5;
    vec3 fallback = mix(uColorStoneDeep, uColorStone, smoothstep(0.25, 0.8, macro));

    vec3 sampled = triColor(uAlbedoMap, wp, w, s);
    st.albedo = mix(fallback, sampled, uTexAmount);

    float rough = triColor(uRoughMap, wp, w, s).r;
    st.rough = mix(0.92, rough, uTexAmount);

    float ao = triColor(uAOMap, wp, w, s).r;
    st.ao = mix(1.0, ao, uTexAmount);

    st.normal = mix(wn, triNormal(uNormalMap, wp, wn, w, s, uNormalScale), uTexAmount);

    // The scan is a *natural* rock and comes out faintly olive. Brutalist
    // concrete is neutral, so the albedo is pulled toward its own luminance and
    // then tinted — and the tint is normalised to unit luminance first, so it
    // shifts the hue and leaves the value alone. Grading after the sample
    // rather than editing the texture keeps this a live slider, and keeps the
    // floor (which uses the same maps, ungraded) reading as the same rock.
    float lum = dot(st.albedo, vec3(0.299, 0.587, 0.114));
    st.albedo = mix(st.albedo, vec3(lum), uDesat);
    vec3 tint = uColorGrade / max(1e-4, dot(uColorGrade, vec3(0.299, 0.587, 0.114)));
    st.albedo = mix(st.albedo, st.albedo * tint, uGrade);
    return st;
  }

  /**
   * Cement dust settling on a surface.
   *
   * Up-facing first, patchy, and gated on how much of the cloud has come down
   * yet. Returned as a coverage so the caller can pale the albedo, flatten the
   * normal and kill the roughness contrast with the one number.
   */
  float dustCoverage(vec3 wp, vec3 wn) {
    if (uDustCoat <= 0.001) return 0.0;
    float up = saturate(wn.y);
    float mottle = fbm3(wp * uDustScale) * 0.5 + 0.5;
    float face = pow(up, max(0.05, uDustSharp));
    return saturate(face * uDustCoat * (0.45 + 0.85 * mottle));
  }

  /** Apply that coverage to a sampled surface. Dust is pale, flat and matte. */
  void applyDust(inout Stone st, float coverage) {
    st.albedo = mix(st.albedo, uColorDust, coverage * 0.88);
    st.rough = mix(st.rough, 1.0, coverage * 0.8);
    st.normal = normalize(mix(st.normal, vec3(0.0, 1.0, 0.0), coverage * 0.35));
    st.ao = mix(st.ao, mix(st.ao, 1.0, 0.6), coverage);
  }
`;

/** Uniform block every host of the surface model shares. */
export function stoneUniforms() {
  const textures = getStoneTextures();
  return {
    uTime: frame.uTime,
    uAlbedoMap: { value: textures.map },
    uNormalMap: { value: textures.normalMap },
    uRoughMap: { value: textures.roughnessMap },
    uAOMap: { value: textures.aoMap },
    uTexAmount: { value: 0 },
    uTexScale: { value: 1 / STONE_TILE_METRES },
    uNormalScale: { value: 1.35 },
    uStoneRough: { value: 1.0 },
    uStoneFloor: { value: 0.34 },
    uStoneAO: { value: 1.0 },
    uDustCoat: { value: 0 },
    uDustSharp: { value: 1.6 },
    uDustScale: { value: 1.4 },
    uColorStone: { value: new Color(0.62, 0.6, 0.57) },
    uColorStoneDeep: { value: new Color(0.24, 0.23, 0.22) },
    uColorDust: { value: new Color(0.78, 0.74, 0.68) },
    uColorGrade: { value: new Color(0.78, 0.77, 0.74) },
    uDesat: { value: 0.35 },
    uGrade: { value: 0.4 }
  };
}

/** Pull the settings every stone material shares. `amount` is the load gate. */
export function syncStone(uniforms, c, g) {
  const textures = getStoneTextures();
  // Ease the scan in rather than popping it, in case the first cast of the
  // session goes off inside the couple of frames the JPEGs are still landing.
  const target = textures.state.amount * saturate(c.texAmount);
  uniforms.uTexAmount.value += (target - uniforms.uTexAmount.value) * 0.25;

  uniforms.uTexScale.value = 1 / Math.max(0.05, c.texScale);
  uniforms.uNormalScale.value = c.normalScale;
  uniforms.uStoneRough.value = c.stoneRough;
  // The scan's roughness map dips low enough in its crevices to put a wet,
  // glossy vein across a face at a grazing angle, which on a slab this size
  // reads as quartz rather than as concrete. Stone has a floor.
  uniforms.uStoneFloor.value = c.stoneRoughFloor;
  uniforms.uStoneAO.value = c.stoneAO;
  uniforms.uDustSharp.value = c.dustCoatSharp;
  uniforms.uDustScale.value = c.dustCoatScale * g.noiseFrequency;
  uniforms.uColorStone.value.copy(getColor(c.colorStone));
  uniforms.uColorStoneDeep.value.copy(getColor(c.colorStoneDeep));
  uniforms.uColorDust.value.copy(getColor(c.colorDustCoat));
  uniforms.uColorGrade.value.copy(getColor(c.colorStoneGrade));
  uniforms.uDesat.value = c.stoneDesat;
  uniforms.uGrade.value = c.stoneGrade;
}
