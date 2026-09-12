import { AdditiveBlending, Color, DoubleSide, ShaderMaterial } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The glow flash — layer 5 of the Corrupted Shard Spawn, and the light source
 * the whole ability is built around.
 *
 * One billboarded quad, everything on it a function of distance and angle from
 * its centre. The sheet's fifth panel is a **lens star**: a white point, four
 * long rays with the vertical pair longest, four shorter rays on the
 * diagonals, a soft lilac halo and a horizontal anamorphic streak — the
 * signature of a light bright enough to flare the lens rather than of a
 * glowing object. It is drawn with the depth test *off*: a lens flare is a
 * screen phenomenon, and the star has to blaze through the crystals it is
 * standing among rather than be cut into slices by them.
 *
 * Three clocks from the ability: `uLit` (0 → 1 as it ignites, with a pop past
 * 1 on the first frames), `uCharge` (0 → 1 as a beam winds up — the star swells
 * and hardens, which is the only warning a body gets), and `uFade`.
 */

const FLARE_VERTEX = /* glsl */ `
  uniform float uSize;
  uniform float uCharge;
  uniform float uChargeGain;
  varying vec2 vP;

  void main() {
    vP = position.xy * 2.0;
    // Billboarded in view space, and grown as it charges.
    float size = uSize * (1.0 + uCharge * uChargeGain * 0.35);
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mv.xy += position.xy * size * 2.0;
    gl_Position = projectionMatrix * mv;
  }
`;

const FLARE_FRAGMENT = /* glsl */ `
  #define FTAU 6.283185307179586

  uniform float uTime;
  uniform float uSeed;
  uniform float uLit;
  uniform float uCharge;
  uniform float uChargeGain;
  uniform float uFade;
  uniform float uPulse;
  uniform float uCore;
  uniform float uCoreSize;
  uniform float uRays;
  uniform float uRayLength;
  uniform float uRaySharp;
  uniform float uDiagonals;
  uniform float uStreak;
  uniform float uStreakLength;
  uniform float uHalo;
  uniform float uHaloFalloff;
  uniform float uRing;
  uniform float uRingRadius;
  uniform float uSpin;
  uniform float uFlicker;
  uniform float uIntensity;
  uniform float uOpacity;
  uniform vec3  uColorCore;
  uniform vec3  uColorGlow;
  uniform vec3  uColorHalo;
  uniform vec3  uColorStreak;
  uniform float uGlobalGlow;

  varying vec2 vP;

  ${noiseGLSL}

  /** A ray lobe: narrow, and narrower still toward its tip. */
  float lobe(float c, float d, float sharp, float len) {
    float tip = 1.0 - smoothstep(0.0, max(len, 1e-3), d);
    return pow(abs(c), sharp * (1.0 + d * 4.0)) * tip * tip / (1.0 + d * 3.0);
  }

  void main() {
    if (uLit <= 0.001) discard;

    vec2 p = vP;
    float d = length(p);
    if (d > 1.0) discard;
    float ang = atan(p.y, p.x);

    float flick = 1.0 - uFlicker * (0.5 + 0.5 * snoise(vec3(uTime * 9.0, uSeed, 0.0)));
    float charge = 1.0 + uCharge * uChargeGain;
    float spin = uTime * uSpin * FTAU;

    /* ---- the point ---- */
    float core = pow(1.0 - smoothstep(0.0, uCoreSize * (1.0 + uCharge * 0.5), d), 2.2) * uCore;

    /* ---- the rays ---- */
    // abs(cos 2a) has four lobes; the vertical pair is drawn longer, as the
    // sheet has it, by stretching the length on |sin a|.
    float a = ang - spin;
    float longRay = lobe(cos(2.0 * a), d, uRaySharp, uRayLength * mix(0.7, 1.0, abs(sin(a))));
    float diag = lobe(sin(2.0 * a), d, uRaySharp * 1.4, uRayLength * 0.55) * uDiagonals;
    float rays = (longRay + diag) * uRays;

    /* ---- the anamorphic streak ---- */
    float streak = exp(-abs(p.y) * 38.0) * (1.0 - smoothstep(0.0, max(uStreakLength, 1e-3), abs(p.x)));
    streak *= 1.0 - smoothstep(0.0, 0.06, abs(p.y)) * 0.3;
    streak *= uStreak;

    /* ---- the halo, and the ring at its edge ---- */
    float halo = pow(clamp(1.0 - d, 0.0, 1.0), uHaloFalloff) * uHalo;
    float ring = (1.0 - smoothstep(0.0, 0.05, abs(d - uRingRadius * (1.0 + uCharge * 0.2)))) * uRing;
    // The halo carries the pulse; the point does not — a point source holds.
    halo *= 1.0 + uPulse;

    /* ---- put it together ---- */
    float energy = (core * 1.6 + rays + streak) * charge + halo + ring;
    vec3 color = mix(uColorHalo, uColorGlow, clamp(rays + streak + core, 0.0, 1.0));
    color = mix(color, uColorCore, clamp(core * 1.4 + rays * 0.5, 0.0, 1.0));
    color += uColorStreak * streak * 0.5;
    color += uColorHalo * ring;
    color *= energy * uIntensity * uLit * flick;

    float alpha = clamp(energy * 0.8, 0.0, 1.0) * min(uLit, 1.0) * uFade * uOpacity;
    if (alpha < 0.004) discard;

    color *= uGlobalGlow;
    color /= 1.0 + color * 0.08;
    gl_FragColor = vec4(color, alpha);
  }
`;

export function createShardFlareMaterial() {
  const material = new ShaderMaterial({
    name: 'ShardFlare',
    transparent: true,
    depthWrite: false,
    // A lens flare is drawn over whatever is in front of the light.
    depthTest: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uSize: { value: 1.9 },
      uSeed: { value: 0 },
      uLit: { value: 0 },
      uCharge: { value: 0 },
      uChargeGain: { value: 1.6 },
      uFade: { value: 1 },
      uPulse: { value: 0 },
      uCore: { value: 1 },
      uCoreSize: { value: 0.13 },
      uRays: { value: 1 },
      uRayLength: { value: 1 },
      uRaySharp: { value: 3.2 },
      uDiagonals: { value: 0.42 },
      uStreak: { value: 0.75 },
      uStreakLength: { value: 1 },
      uHalo: { value: 0.55 },
      uHaloFalloff: { value: 2.4 },
      uRing: { value: 0.22 },
      uRingRadius: { value: 0.5 },
      uSpin: { value: 0.03 },
      uFlicker: { value: 0.14 },
      uIntensity: { value: 2.2 },
      uOpacity: { value: 1 },
      uColorCore: { value: new Color() },
      uColorGlow: { value: new Color() },
      uColorHalo: { value: new Color() },
      uColorStreak: { value: new Color() }
    }),
    vertexShader: FLARE_VERTEX,
    fragmentShader: FLARE_FRAGMENT
  });

  /** @param {object} state { lit, charge, pulse, fade, seed } */
  material.userData.sync = (state) => {
    const c = settings.shard;
    const g = settings.global;
    const u = material.uniforms;

    u.uLit.value = state.lit;
    u.uCharge.value = state.charge;
    u.uPulse.value = state.pulse * c.pulseDepth;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uSize.value = c.flareSize;
    u.uChargeGain.value = c.flareChargeGain;
    u.uCore.value = c.flareCore;
    u.uCoreSize.value = c.flareCoreSize;
    u.uRays.value = c.flareRays;
    u.uRayLength.value = c.flareRayLength;
    u.uRaySharp.value = c.flareRaySharp;
    u.uDiagonals.value = c.flareDiagonals;
    u.uStreak.value = c.flareStreak;
    u.uStreakLength.value = c.flareStreakLength;
    u.uHalo.value = c.flareHalo;
    u.uHaloFalloff.value = c.flareHaloFalloff;
    u.uRing.value = c.flareRing;
    u.uRingRadius.value = c.flareRingRadius;
    u.uSpin.value = c.flareSpin;
    u.uFlicker.value = c.flareFlicker * g.randomness;
    u.uIntensity.value = c.flareIntensity * g.shaderIntensity;
    u.uOpacity.value = c.flareOpacity * g.opacity;

    u.uColorCore.value.copy(getColor(c.colorFlareCore));
    u.uColorGlow.value.copy(getColor(c.colorFlareGlow));
    u.uColorHalo.value.copy(getColor(c.colorFlareHalo));
    u.uColorStreak.value.copy(getColor(c.colorFlareStreak));
  };

  return material;
}
