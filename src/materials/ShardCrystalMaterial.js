import { MeshStandardMaterial, Color, DoubleSide, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * Corrupted amethyst — layer 2 of the Corrupted Shard Spawn.
 *
 * Built on MeshStandardMaterial rather than a raw ShaderMaterial so the gems
 * cast and receive the stage's real shadows and catch the HDR probe; the sheet
 * draws them as *solids*, the one thing in the composite with a hard edge, and
 * the whole spawn is measured against them. Everything that makes them
 * corrupted is injected on top.
 *
 * The reference panel is doing one thing above all: **cold violet glass with
 * something hot and red sealed inside it**. The body is amethyst that darkens
 * where you look into it; the flaws run magenta, pooled at the foot and
 * thinning toward the tip; the tip goes milky; and the foot — where the sheet's
 * crystals go nearly black — is a band of obsidian the violet grows out of.
 * Three lights land on it from outside: the stage's sun through three's own
 * lighting, the flare in the heart of the cluster (`uCore`, so the gems are
 * lit by the light source that is standing among them), and a **screen-space
 * key** blended into the facet lift, because a prism's facets under a single
 * overhead sun all land on nearly one value and the crystal draws flat.
 *
 * Two clocks on top of the material: a per-instance **birth** flash as a gem
 * tears out of the floor, and a shared **charge** that runs the veins hot as
 * the beam winds up — the crystals are what shows the spawn is about to fire.
 *
 * Per-instance inputs arrive as instanced attributes (`aSeed`, `aBirth`,
 * `aFlow`), so this material is only ever used on an InstancedMesh.
 */
export function createShardCrystalMaterial(environment) {
  const material = new MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.14,
    metalness: 0.0,
    flatShading: true,
    transparent: true,
    // Translucent: the far wall of a gem is part of what you see through the
    // near one, and culling it leaves the slender ones reading as shells.
    side: DoubleSide,
    depthWrite: true
  });

  const uniforms = {
    uTime: frame.uTime,
    uColorDeep: { value: new Color() },
    uColorBody: { value: new Color() },
    uColorRim: { value: new Color() },
    uColorVein: { value: new Color() },
    uColorTip: { value: new Color() },
    uColorBase: { value: new Color() },
    uDensity: { value: 1.3 },
    uFresnel: { value: 2.0 },
    uFresnelPower: { value: 2.6 },
    uDispersion: { value: 0.6 },
    uFacetSharp: { value: 0.75 },
    uScreenKey: { value: 0.7 },
    uCleave: { value: 0.7 },
    uCleaveScale: { value: 7.0 },
    uVein: { value: 1.7 },
    uVeinScale: { value: 3.2 },
    uVeinFlow: { value: 0.4 },
    uVeinBase: { value: 0.7 },
    uVeinSharp: { value: 3.0 },
    uBaseDark: { value: 0.28 },
    uTipFrost: { value: 0.55 },
    uTipStart: { value: 0.62 },
    uGlint: { value: 1.2 },
    uGlintScale: { value: 28 },
    uGlintSpeed: { value: 0.6 },
    uGlow: { value: 1.0 },
    uEdgeGlow: { value: 1.1 },
    uBodyGlow: { value: 0.45 },
    uBirthGlow: { value: 3.0 },
    uCharge: { value: 0 },
    uChargeGlow: { value: 2.4 },
    /** Where the flare is standing, world space, and how far its light carries. */
    uCore: { value: new Vector3() },
    uCoreLit: { value: 0 },
    uCoreGlow: { value: 1.5 },
    uCoreRadius: { value: 3.6 },
    uColorCore: { value: new Color() }
  };

  environment.registerShadowCasterWithPatch(material, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         attribute float aSeed;
         attribute float aBirth;
         attribute float aFlow;
         varying vec3  vGemLocal;
         varying vec3  vGemWorld;
         varying float vGemSeed;
         varying float vGemBirth;
         varying float vGemFlow;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vGemLocal = transformed;
         vGemSeed = aSeed;
         vGemBirth = aBirth;
         vGemFlow = aFlow;
         #ifdef USE_INSTANCING
           vGemWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
         #else
           vGemWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
         #endif`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uTime;
         uniform vec3  uColorDeep;
         uniform vec3  uColorBody;
         uniform vec3  uColorRim;
         uniform vec3  uColorVein;
         uniform vec3  uColorTip;
         uniform vec3  uColorBase;
         uniform float uDensity;
         uniform float uFresnel;
         uniform float uFresnelPower;
         uniform float uDispersion;
         uniform float uFacetSharp;
         uniform float uScreenKey;
         uniform float uCleave;
         uniform float uCleaveScale;
         uniform float uVein;
         uniform float uVeinScale;
         uniform float uVeinFlow;
         uniform float uVeinBase;
         uniform float uVeinSharp;
         uniform float uBaseDark;
         uniform float uTipFrost;
         uniform float uTipStart;
         uniform float uGlint;
         uniform float uGlintScale;
         uniform float uGlintSpeed;
         uniform float uGlow;
         uniform float uEdgeGlow;
         uniform float uBodyGlow;
         uniform float uBirthGlow;
         uniform float uCharge;
         uniform float uChargeGlow;
         uniform vec3  uCore;
         uniform float uCoreLit;
         uniform float uCoreGlow;
         uniform float uCoreRadius;
         uniform vec3  uColorCore;
         varying vec3  vGemLocal;
         varying vec3  vGemWorld;
         varying float vGemSeed;
         varying float vGemBirth;
         varying float vGemFlow;
         ${noiseGLSL}`
      )
      // Injected once the normal is resolved: with flatShading there is no
      // vNormal varying, so every view-dependent term here reads the face
      // normal that <normal_fragment_begin> derives from screen derivatives.
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         {
           vec3  N   = normalize(normal);
           float ndv = clamp(dot(N, normalize(vViewPosition)), 0.0, 1.0);

           float thickness = clamp(ndv * uDensity, 0.0, 1.0);
           float rim = pow(1.0 - ndv, uFresnelPower);
           float fres = rim * uFresnel;

           // Height up this crystal's own axis, 0 at the floor, 1 at the tip.
           float up = clamp(vGemLocal.y, 0.0, 1.0);

           /* --- the flaws the corruption runs in ------------------------- */
           vec3  cp     = vGemWorld * uCleaveScale + vGemSeed * 41.0;
           float cleave = smoothstep(0.52, 0.97, ridged(cp, 4));

           /* --- the corruption itself ------------------------------------ */
           // Local space and climbing: the fluid belongs to this gem.
           vec3 vp = vGemLocal * vec3(uVeinScale * 2.2, uVeinScale, uVeinScale * 2.2);
           vp.y -= uTime * uVeinFlow + vGemFlow * 6.0;
           float fluid = ridged(vp + vGemSeed * 17.0, 4);
           fluid = pow(clamp(fluid, 0.0, 1.0), uVeinSharp);
           fluid *= mix(1.0, uVeinBase, up);
           fluid = clamp(fluid * (0.55 + 1.1 * cleave), 0.0, 1.0);

           /* --- body colour ---------------------------------------------- */
           vec3 body = mix(uColorBody, uColorDeep, thickness);
           body = mix(body, uColorRim, cleave * uCleave * 0.3);

           // The obsidian foot the violet grows out of.
           float foot = 1.0 - smoothstep(uBaseDark * 0.5, uBaseDark * 1.4 + 0.02, up +
                        (fbm3(vGemLocal * 6.0 + vGemSeed * 3.0) - 0.5) * 0.12);
           body = mix(body, uColorBase, foot);

           // The milky band in the last third.
           float frost = smoothstep(uTipStart, 1.0, up) *
                         (0.55 + 0.45 * fbm3(vGemLocal * 11.0 + vGemSeed * 5.0));
           body = mix(body, uColorTip, clamp(frost, 0.0, 1.0) * uTipFrost);

           /* --- facet lift, keyed from the camera and from a screen key --- */
           // Under one overhead sun a prism's visible facets all land on nearly
           // the same value. A key that lives in screen space — upper left,
           // where every stylised crystal on the sheet is lit from — puts a lit
           // face and a shadow face on every gem from every angle.
           vec3  keyView = normalize(vec3(-0.55, 0.72, 0.42));
           float keyLit  = clamp(dot(N, keyView), 0.0, 1.0);
           float lift    = mix(ndv, keyLit, uScreenKey);
           body *= mix(1.0, 0.45 + 1.0 * lift, uFacetSharp);

           diffuseColor.rgb *= body;

           /* --- dispersion ------------------------------------------------ */
           vec3 spread = vec3(
             pow(1.0 - ndv, uFresnelPower * (1.0 - 0.30 * uDispersion)),
             rim,
             pow(1.0 - ndv, uFresnelPower * (1.0 + 0.38 * uDispersion))
           );

           /* --- pinpoint glints on the facets ----------------------------- */
           float sp = snoise(vGemWorld * uGlintScale +
                             vec3(0.0, uTime * uGlintSpeed, 0.0) + vGemSeed * 23.0);
           sp = pow(clamp(sp, 0.0, 1.0), 16.0) * smoothstep(0.0, 0.7, fres + 0.25);

           /* --- the flare's light ----------------------------------------- */
           vec3  toCore = uCore - vGemWorld;
           float reach  = 1.0 - smoothstep(0.0, max(uCoreRadius, 0.05), length(toCore));
           float facing = clamp(dot(N, normalize(toCore + 1e-4)), 0.0, 1.0);
           float coreLit = reach * reach * (0.35 + 0.65 * facing) * uCoreLit;

           /* --- everything that emits ------------------------------------- */
           float hot = uVein * (1.0 + uCharge * uChargeGlow);
           // The glass itself, lit from inside. On a stage this dark the diffuse
           // is nearly nothing, and without this the body is whatever the flaws
           // are — maroon. This is what keeps it violet.
           vec3 glow = body * uBodyGlow * (1.0 - foot);
           glow += uColorRim * spread * uEdgeGlow * (1.0 - foot * 0.7);
           glow += uColorVein * fluid * hot;
           glow += uColorRim * sp * uGlint * 1.4;
           glow += uColorCore * coreLit * uCoreGlow * (1.0 + uCharge);
           glow += mix(uColorVein, uColorCore, 0.25) * vGemBirth * uBirthGlow;
           // As the charge peaks the whole body takes the light: the flaws stop
           // being flaws and the gem reads as a lamp.
           glow += uColorCore * uCharge * uCharge * 0.35 * (1.0 - foot);
           glow *= uGlow;

           // Soft ceiling. Every term above peaks at a grazing angle and they
           // stack; without a rolloff a facet on the silhouette sums past ten
           // and the gem is a white blob wearing the bloom pass.
           glow /= 1.0 + glow * 0.42;

           totalEmissiveRadiance += glow;

           // Denser through the body, thinner at the edges, near-solid where the
           // corruption has pooled and solid at the obsidian foot.
           diffuseColor.a = clamp(
             diffuseColor.a * (0.8 + 0.3 * fres) + fluid * 0.28 + frost * 0.14 + foot * 0.3,
             0.0, 1.0
           );
         }`
      );
  });

  material.userData.uniforms = uniforms;

  /**
   * Pull the palette and every shading control from the live settings.
   *
   * @param {THREE.Vector3} core  where the flare is standing
   * @param {number} coreLit      0..1 how lit the flare is
   * @param {number} charge       0..1 how wound up the beam is
   */
  material.userData.sync = (core, coreLit, charge) => {
    const c = settings.shard;
    const g = settings.global;

    uniforms.uColorDeep.value.copy(getColor(c.colorGemDeep));
    uniforms.uColorBody.value.copy(getColor(c.colorGem));
    uniforms.uColorRim.value.copy(getColor(c.colorGemRim));
    uniforms.uColorVein.value.copy(getColor(c.colorVein));
    uniforms.uColorTip.value.copy(getColor(c.colorGemTip));
    uniforms.uColorBase.value.copy(getColor(c.colorGemBase));
    uniforms.uColorCore.value.copy(getColor(c.colorFlareGlow));

    uniforms.uDensity.value = c.gemDepthTint;
    uniforms.uFresnel.value = c.gemFresnel * g.fresnel;
    uniforms.uFresnelPower.value = c.gemFresnelPower;
    uniforms.uDispersion.value = c.gemDispersion;
    uniforms.uFacetSharp.value = c.gemFacetSharp;
    uniforms.uScreenKey.value = c.gemScreenKey;
    uniforms.uCleave.value = c.gemCleave * g.shaderIntensity;
    uniforms.uCleaveScale.value = c.gemCleaveScale * g.noiseFrequency;
    uniforms.uVein.value = c.gemVein * g.shaderIntensity;
    uniforms.uVeinScale.value = c.gemVeinScale * g.noiseFrequency;
    uniforms.uVeinFlow.value = c.gemVeinFlow * g.noiseSpeed;
    uniforms.uVeinBase.value = c.gemVeinBase;
    uniforms.uVeinSharp.value = c.gemVeinSharp;
    uniforms.uBaseDark.value = c.gemBaseDark;
    uniforms.uTipFrost.value = c.gemTipFrost;
    uniforms.uTipStart.value = c.gemTipStart;
    uniforms.uGlint.value = c.gemGlint * g.shaderIntensity;
    uniforms.uGlintScale.value = c.gemGlintScale;
    uniforms.uGlintSpeed.value = c.gemGlintSpeed * g.noiseSpeed;
    uniforms.uGlow.value = c.gemGlow * g.glow;
    uniforms.uEdgeGlow.value = c.gemEdgeGlow;
    uniforms.uBodyGlow.value = c.gemBodyGlow;
    uniforms.uBirthGlow.value = c.gemBirthGlow;
    uniforms.uCharge.value = charge;
    uniforms.uChargeGlow.value = c.gemChargeGlow;
    uniforms.uCore.value.copy(core);
    uniforms.uCoreLit.value = coreLit;
    uniforms.uCoreGlow.value = c.gemCoreBleed;
    uniforms.uCoreRadius.value = c.gemCoreBleedRadius;

    material.opacity = c.gemOpacity * g.opacity;
    material.envMapIntensity = c.gemEnv;
    material.roughness = c.gemRoughness;
  };

  material.userData.sync(uniforms.uCore.value, 0, 0);
  return material;
}
