import { AdditiveBlending, Color, DoubleSide, ShaderMaterial, Vector3, Vector4 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/** How many beams may be in the air at once. One instance apiece, one draw. */
export const MAX_BEAMS = 6;

/**
 * The beam the flash fires — the seventh layer, the one the sheet implies.
 *
 * A volley is **one draw call**: every shot is one instance of the same tube
 * and reads its own two endpoints and its own clock out of a small uniform
 * array, exactly as the growth's lances do. What differs is what a *laser* is
 * as against a lance of living light:
 *
 *  - it is **straight**. No wander, no coils. The only life in it is a pressure
 *    ripple in its width and charge racing down it from the flash to the body,
 *    which is what says the light is *coming from* somewhere.
 *  - it is **hard**. The core is white and weighted onto the axis (the path a
 *    view ray takes through the tube is longest looking straight down it), the
 *    sheath is a thin violet skin with a definite edge, and there is nothing
 *    soft between them.
 *  - it has a **muzzle** and a **head**. The muzzle is bright where the beam
 *    leaves the flash — the light source is the brightest thing on screen and
 *    the beam must be brightest next to it — and the head blooms where the beam
 *    is going through something, on the frame it arrives.
 *
 * The strike profile is the lance's: the beam reaches the target in the first
 * tenth of its life as a spearhead, holds while it burns, then snaps out by
 * collapsing its radius.
 */

const BEAM_VERTEX = /* glsl */ `
  #define BTAU 6.283185307179586
  #define BPI  3.141592653589793

  attribute float aBeam;

  uniform vec3  uOrigin[MAX_BEAMS];
  uniform vec3  uTarget[MAX_BEAMS];
  uniform vec4  uState[MAX_BEAMS];

  uniform float uTime;
  uniform float uRadius;
  uniform float uRadiusMuzzle;
  uniform float uRadiusCurve;
  uniform float uFlare;
  uniform float uFlareWidth;
  uniform float uRipple;
  uniform float uRippleBands;
  uniform float uRippleSpeed;
  uniform float uStrike;
  uniform float uHold;

  varying float vT;
  varying float vA;
  varying float vFacing;
  varying float vLife;
  varying float vSeed;
  varying float vLive;
  varying float vReach;
  varying float vViewZ;

  void main() {
    int slot = int(aBeam + 0.5);
    vec3 from = uOrigin[slot];
    vec3 to = uTarget[slot];
    vec4 state = uState[slot];

    float life = state.x;
    float seed = state.y;
    float width = state.z;
    float live = state.w;

    // How far down the line the beam has reached: fast, eased out so it lands.
    float reach = clamp(life / max(uStrike, 1e-3), 0.0, 1.0);
    reach = 1.0 - pow(1.0 - reach, 3.0);
    // And how much of it is left. It holds while it burns, then snaps out.
    float spent = clamp((life - uHold) / max(1.0 - uHold, 1e-3), 0.0, 1.0);
    float fade = 1.0 - spent * spent;

    vec3 delta = to - from;
    float span = max(length(delta), 0.01);
    vec3 dir = delta / span;
    vec3 n1 = normalize(cross(dir, abs(dir.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 n2 = normalize(cross(dir, n1));

    float t = position.x * reach;
    float a = position.y;
    float angle = a * BTAU;
    vec3 nrm = n1 * cos(angle) + n2 * sin(angle);

    /* ---- half-width at t ---- */
    float r = mix(uRadiusMuzzle, uRadius, pow(clamp(t, 0.0, 1.0), max(uRadiusCurve, 0.01)));
    r *= 1.0 + uRipple * sin((t * uRippleBands - uTime * uRippleSpeed) * BTAU + seed * 13.0);
    r *= 1.0 + uFlare * smoothstep(1.0 - max(uFlareWidth, 1e-3), 1.0, t / max(reach, 1e-3));
    r *= width * fade;
    // Drawn to a point at the head while it is still travelling.
    r *= smoothstep(0.0, 0.04, position.x) * (1.0 - smoothstep(0.86, 1.0, position.x) * (1.0 - reach));

    vec3 here = mix(from, to, t) + nrm * max(r, 1e-5);
    // An idle slot is collapsed onto its own origin: no fragments, no branch.
    here = mix(from, here, live);

    vT = t;
    vA = a;
    vLife = life;
    vSeed = seed;
    vLive = live;
    vReach = reach;
    vFacing = abs(dot(normalize(cameraPosition - here), nrm));

    vec4 mv = viewMatrix * vec4(here, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const BEAM_FRAGMENT = /* glsl */ `
  #define BTAU 6.283185307179586

  uniform float uTime;
  uniform float uCoreFill;
  uniform float uEdgePower;
  uniform float uSheath;
  uniform float uPulse;
  uniform float uPulseBands;
  uniform float uPulseSpeed;
  uniform float uPulseSharp;
  uniform float uHeadGlow;
  uniform float uHeadWidth;
  uniform float uMuzzleGlow;
  uniform float uMuzzleWidth;
  uniform float uHold;
  uniform float uIntensity;
  uniform float uOpacity;
  uniform float uSoftFade;
  uniform vec3  uColorCore;
  uniform vec3  uColorInner;
  uniform vec3  uColorOuter;
  uniform vec3  uColorPulse;

  uniform sampler2D uSceneDepth;
  uniform vec2  uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uGlobalGlow;

  varying float vT;
  varying float vA;
  varying float vFacing;
  varying float vLife;
  varying float vSeed;
  varying float vLive;
  varying float vReach;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    if (vLive < 0.5) discard;

    float spent = clamp((vLife - uHold) / max(1.0 - uHold, 1e-3), 0.0, 1.0);
    float fade = 1.0 - spent * spent;

    // Weighted toward the axis: the white belongs where the view ray runs
    // down the barrel.
    float facing = clamp(vFacing, 0.0, 1.0);
    float core = pow(facing, max(uCoreFill, 0.05));
    // ... and the opposite weighting for the sheath, with a definite edge.
    float sheath = pow(1.0 - facing, max(uEdgePower, 0.05)) * uSheath;
    sheath *= smoothstep(0.0, 0.25, 1.0 - facing);

    /* ---- charge racing from the flash to the body ---- */
    float phase = vT * uPulseBands - uTime * uPulseSpeed + vSeed;
    float pulse = pow(0.5 + 0.5 * sin(phase * BTAU), max(uPulseSharp, 1.0)) * uPulse;

    /* ---- the head, where it is going through something ---- */
    float head = 1.0 - smoothstep(0.0, max(uHeadWidth, 1e-3), abs(vT - vReach));
    head *= uHeadGlow;

    /* ---- the muzzle, where it leaves the light ---- */
    float muzzle = (1.0 - smoothstep(0.0, max(uMuzzleWidth, 1e-3), vT)) * uMuzzleGlow;

    float energy = core + sheath + pulse * (0.4 + core) + head + muzzle;
    vec3 color = mix(uColorOuter, uColorInner, clamp(core * 1.4, 0.0, 1.0));
    color = mix(color, uColorCore, clamp(pow(core, 2.0) + head + muzzle * 0.7, 0.0, 1.0));
    color += uColorPulse * pulse * 0.6;
    color *= energy * uIntensity * fade;

    float alpha = clamp(energy * 0.9, 0.0, 1.0) * fade * uOpacity;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    color *= uGlobalGlow;
    color /= 1.0 + color * 0.08;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * The beams, as one material driving every shot in flight.
 *
 * @returns {THREE.ShaderMaterial} with `userData.sync` and, on its uniforms,
 *   the `uOrigin` / `uTarget` / `uState` arrays the ability writes each frame.
 */
export function createShardBeamMaterial() {
  const origin = [];
  const target = [];
  const state = [];
  for (let i = 0; i < MAX_BEAMS; i++) {
    origin.push(new Vector3());
    target.push(new Vector3(0, 1, 0));
    // x = life 0..1, y = seed, z = width, w = live
    state.push(new Vector4(0, 0, 1, 0));
  }

  const material = new ShaderMaterial({
    name: 'ShardBeam',
    defines: { MAX_BEAMS },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uOrigin: { value: origin },
      uTarget: { value: target },
      uState: { value: state },

      uRadius: { value: 0.06 },
      uRadiusMuzzle: { value: 0.13 },
      uRadiusCurve: { value: 0.7 },
      uFlare: { value: 0.6 },
      uFlareWidth: { value: 0.12 },
      uRipple: { value: 0.08 },
      uRippleBands: { value: 7 },
      uRippleSpeed: { value: 6 },
      uStrike: { value: 0.1 },
      uHold: { value: 0.5 },

      uCoreFill: { value: 2.2 },
      uEdgePower: { value: 2.4 },
      uSheath: { value: 0.8 },
      uPulse: { value: 1.2 },
      uPulseBands: { value: 6 },
      uPulseSpeed: { value: 9 },
      uPulseSharp: { value: 7 },
      uHeadGlow: { value: 2.6 },
      uHeadWidth: { value: 0.07 },
      uMuzzleGlow: { value: 1.7 },
      uMuzzleWidth: { value: 0.08 },
      uIntensity: { value: 2.6 },
      uOpacity: { value: 1 },
      uSoftFade: { value: 0.3 },
      uColorCore: { value: new Color(1, 1, 1) },
      uColorInner: { value: new Color(0.95, 0.7, 1) },
      uColorOuter: { value: new Color(0.55, 0.18, 0.9) },
      uColorPulse: { value: new Color(1, 0.35, 0.85) }
    }),
    vertexShader: BEAM_VERTEX,
    fragmentShader: BEAM_FRAGMENT
  });

  material.userData.sync = () => {
    const c = settings.shard;
    const g = settings.global;
    const u = material.uniforms;

    u.uRadius.value = c.beamRadius;
    u.uRadiusMuzzle.value = c.beamMuzzleRadius;
    u.uRadiusCurve.value = c.beamRadiusCurve;
    u.uFlare.value = c.beamFlare;
    u.uFlareWidth.value = c.beamFlareWidth;
    u.uRipple.value = c.beamRipple;
    u.uRippleBands.value = c.beamRippleBands;
    u.uRippleSpeed.value = c.beamRippleSpeed * g.noiseSpeed;
    u.uStrike.value = c.beamStrike;
    u.uHold.value = c.beamHold;

    u.uCoreFill.value = c.beamCoreFill;
    u.uEdgePower.value = c.beamEdgePower;
    u.uSheath.value = c.beamSheath * g.fresnel;
    u.uPulse.value = c.beamPulse * g.shaderIntensity;
    u.uPulseBands.value = c.beamPulseBands;
    u.uPulseSpeed.value = c.beamPulseSpeed * g.noiseSpeed;
    u.uPulseSharp.value = c.beamPulseSharp;
    u.uHeadGlow.value = c.beamHeadGlow * g.shaderIntensity;
    u.uHeadWidth.value = c.beamHeadWidth;
    u.uMuzzleGlow.value = c.beamMuzzleGlow * g.shaderIntensity;
    u.uMuzzleWidth.value = c.beamMuzzleWidth;
    u.uIntensity.value = c.beamIntensity * g.shaderIntensity;
    u.uOpacity.value = c.beamOpacity * g.opacity;
    u.uSoftFade.value = c.beamSoftFade;

    u.uColorCore.value.copy(getColor(c.colorBeamCore));
    u.uColorInner.value.copy(getColor(c.colorBeamInner));
    u.uColorOuter.value.copy(getColor(c.colorBeamOuter));
    u.uColorPulse.value.copy(getColor(c.colorBeamPulse));
  };

  return material;
}
