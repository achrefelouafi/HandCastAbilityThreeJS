import { Vector3 } from 'three';
import { settings } from '../config/settings.js';
import { Easing, lerp, saturate } from '../utils/math.js';

/**
 * The curve the Shimmering Flux of Chaos flies down — written once, in two
 * languages, because four different things have to agree about it exactly.
 *
 * The cone, the ligaments, the ribbons and the particle emitters all place
 * themselves *on the flight path*, and the moment any two of them disagree
 * about where that path is the effect comes apart: the trail hangs off the
 * head, the blood is thrown from somewhere the projectile never was, the motes
 * are left in a corridor next to the one you watched. So the path is not a
 * history buffer sampled by whoever gets there first — it is a **pure function
 * of distance travelled**, and this file is the only place it is defined.
 *
 *     p(s) = origin + dir·s + side·weave(s) + up·(height(s) + rise(s))
 *
 * `s` is metres from the caster along the aimed line, so a point on the trail
 * eight metres behind the head is `p(front - 8)` — the same value this frame,
 * next frame and after the cast has stopped moving. That is what makes the
 * trail a *record* of where the thing went rather than a shape that swims: the
 * spine holds still and the energy on it churns, which is the split the whole
 * ability rests on.
 *
 * Two sines rather than noise, and deliberately: `snoise` and a JS noise are
 * two different functions, and the CPU half of this file has to return the same
 * metre as the GPU half to the last digit or the sparkles come off the ribbons.
 * A pair of sines is trivially identical in both.
 *
 * The uniform block is created **per cast**, not per material: the three
 * materials of one ability instance are handed the same boxes by identity, so
 * `syncFluxSpine` writes each value once a frame and all three see it — the
 * same trick `core/FrameUniforms.js` plays globally, applied to one cast.
 */

const _a = /* @__PURE__ */ new Vector3();
const _b = /* @__PURE__ */ new Vector3();
const _worldUp = /* @__PURE__ */ new Vector3(0, 1, 0);

/** Half the gap between the two samples a numeric tangent is taken from. */
const H = 0.05;

/**
 * The GLSL half. Include it in a vertex shader and the block below is declared
 * for you — every material that uses it must therefore be built with
 * `createFluxSpineUniforms()` spread into its uniforms.
 */
export const FLUX_SPINE_GLSL = /* glsl */ `
#ifndef FLUX_SPINE_INCLUDED
#define FLUX_SPINE_INCLUDED

uniform vec3  uOrigin;        // the caster's feet
uniform vec3  uDir;           // unit heading, flat
uniform vec3  uSide;          // up × dir — the lateral the weave swings along
uniform float uFront;         // metres the head has travelled
uniform float uSeed;
uniform float uWeave;         // amplitude of the wander, metres
uniform float uWeaveWaves;    // radians per metre, long wave
uniform float uWeaveWaves2;   // ... and the short one riding on it
uniform float uWeaveRise;     // the vertical wander, as a fraction of the lateral
uniform float uLaunchHeight;
uniform float uFlightHeight;
uniform float uRiseDistance;

/** How far onto its cruise height the projectile is, s metres out. */
float fluxRise(float s) {
  float t = clamp(s / max(uRiseDistance, 0.01), 0.0, 1.0);
  return 1.0 - pow(1.0 - t, 3.0);          // outCubic — mirrors utils/math.js
}

/** A point on the flight path, s metres from the caster. */
vec3 fluxSpine(float s) {
  float k = max(s, 0.0);                   // nothing lives behind the caster
  float lateral = uWeave * (sin(k * uWeaveWaves + uSeed) * 0.62 +
                            sin(k * uWeaveWaves2 + uSeed * 2.7) * 0.38);
  float vertical = uWeave * uWeaveRise *
                   (sin(k * uWeaveWaves2 * 0.83 + uSeed * 1.9 + 1.7) * 0.70 +
                    sin(k * uWeaveWaves * 1.31 + uSeed * 3.3) * 0.30);
  float height = mix(uLaunchHeight, uFlightHeight, fluxRise(k));
  return uOrigin + uDir * k + uSide * lateral + vec3(0.0, height + vertical, 0.0);
}

/**
 * The local frame at s: where the path is going, and the two directions across
 * it that everything wrapped around the spine is placed in.
 */
void fluxFrame(float s, out vec3 tangent, out vec3 side, out vec3 up) {
  tangent = normalize(fluxSpine(s + ${H.toFixed(2)}) - fluxSpine(s - ${H.toFixed(2)}) + 1e-6);
  side = normalize(cross(vec3(0.0, 1.0, 0.0), tangent) + 1e-6);
  up = normalize(cross(tangent, side));
}
#endif
`;

/**
 * One cast's worth of spine uniforms.
 *
 * Handed to all three flux materials, which is why the boxes are created here
 * and not inside each `create*Material()`.
 */
export function createFluxSpineUniforms() {
  return {
    uOrigin: { value: new Vector3() },
    uDir: { value: new Vector3(0, 0, 1) },
    uSide: { value: new Vector3(1, 0, 0) },
    uFront: { value: 0 },
    uSeed: { value: 0 },
    uWeave: { value: 0.5 },
    uWeaveWaves: { value: 0.55 },
    uWeaveWaves2: { value: 1.25 },
    uWeaveRise: { value: 0.55 },
    uLaunchHeight: { value: 1.3 },
    uFlightHeight: { value: 1.8 },
    uRiseDistance: { value: 4 }
  };
}

/**
 * Push this frame's cast state and the live settings into that block.
 *
 * @param {object} block  from `createFluxSpineUniforms()`
 * @param {object} spine  `{ origin, dir, side, seed }` — the cast's own frame
 * @param {number} front  metres the head has travelled
 */
export function syncFluxSpine(block, spine, front) {
  const c = settings.flux;
  const g = settings.global;

  block.uOrigin.value.copy(spine.origin);
  block.uDir.value.copy(spine.dir);
  block.uSide.value.copy(spine.side);
  block.uFront.value = front;
  block.uSeed.value = spine.seed;

  block.uWeave.value = c.weave * g.noiseStrength;
  block.uWeaveWaves.value = c.weaveWaves * g.noiseFrequency;
  block.uWeaveWaves2.value = c.weaveWaves2 * g.noiseFrequency;
  block.uWeaveRise.value = c.weaveRise;
  block.uLaunchHeight.value = c.launchHeight;
  block.uFlightHeight.value = c.flightHeight;
  block.uRiseDistance.value = c.riseDistance;
}

/**
 * The JS half of `fluxSpine`. Same curve, same numbers, same live settings —
 * used by the emitters, which have to put a droplet on the animal the GPU is
 * drawing rather than near it.
 *
 * @param {object} spine `{ origin, dir, side, seed }`
 * @param {number} s     metres from the caster
 * @param {THREE.Vector3} out
 */
export function fluxSpinePoint(spine, s, out) {
  const c = settings.flux;
  const g = settings.global;
  const k = Math.max(s, 0);

  const weave = c.weave * g.noiseStrength;
  const w1 = c.weaveWaves * g.noiseFrequency;
  const w2 = c.weaveWaves2 * g.noiseFrequency;
  const lateral = weave * (Math.sin(k * w1 + spine.seed) * 0.62 + Math.sin(k * w2 + spine.seed * 2.7) * 0.38);
  const vertical =
    weave *
    c.weaveRise *
    (Math.sin(k * w2 * 0.83 + spine.seed * 1.9 + 1.7) * 0.7 + Math.sin(k * w1 * 1.31 + spine.seed * 3.3) * 0.3);
  const height = lerp(c.launchHeight, c.flightHeight, Easing.outCubic(saturate(k / Math.max(0.01, c.riseDistance))));

  out.copy(spine.origin).addScaledVector(spine.dir, k).addScaledVector(spine.side, lateral);
  out.y += height + vertical;
  return out;
}

/**
 * The JS half of `fluxFrame`. Writes into the three vectors handed in and
 * allocates nothing.
 */
export function fluxSpineFrame(spine, s, tangent, side, up) {
  fluxSpinePoint(spine, s + H, _a);
  fluxSpinePoint(spine, s - H, _b);
  tangent.subVectors(_a, _b).normalize();
  side.crossVectors(_worldUp, tangent).normalize();
  up.crossVectors(tangent, side).normalize();
  return tangent;
}
