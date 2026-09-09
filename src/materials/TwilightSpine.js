import { Vector3 } from 'three';
import { settings } from '../config/settings.js';
import { Easing, lerp, saturate } from '../utils/math.js';

/**
 * The line the Scorched Twilight flies down — written once, in two languages,
 * because all three layers of the breakdown have to agree about it exactly.
 *
 * The composite is a single clean diagonal streak, so unlike the Flux this path
 * is **almost straight**: a long lazy drift and a rise onto cruise height, and
 * nothing else. Every curve you read in the reference belongs to the wisps
 * braiding *about* this line, not to the line itself. Give the spine its own
 * chaos and the braid stops being legible — the ribbons and the beam start
 * swinging together and the whole thing reads as one fat noodle.
 *
 *     p(s) = origin + dir·s + side·drift(s) + up·height(s)
 *
 * `s` is metres from the caster, so the point eight metres behind the head is
 * `p(front - 8)` — the same value this frame, next frame, and after the cast has
 * stopped moving. That is what lets the ice shards be placed *where the head
 * was when they were struck off it* without a history buffer: distance is speed
 * times time, so `s_birth = front - age·speed`, and the spine turns that back
 * into a world position. The whole crystal field is stateless because of it.
 *
 * Two sines rather than noise, deliberately: the CPU half of this file has to
 * return the same metre as the GPU half to the last digit, or the muzzle light
 * ends up lighting a corridor next to the one you are watching. A pair of sines
 * is trivially identical in both; `snoise` and a JS noise are not.
 *
 * The uniform block is created **per cast** and shared by identity with all
 * three materials, so `syncTwilightSpine` writes each value once a frame and
 * none of them can disagree.
 */

const _a = /* @__PURE__ */ new Vector3();
const _b = /* @__PURE__ */ new Vector3();
const _worldUp = /* @__PURE__ */ new Vector3(0, 1, 0);

/** Half the gap between the two samples a numeric tangent is taken from. */
const H = 0.05;

/**
 * The GLSL half. Include it in a vertex shader and the block below is declared
 * for you — every material that uses it must be built with
 * `createTwilightSpineUniforms()` spread into its uniforms.
 */
export const TWILIGHT_SPINE_GLSL = /* glsl */ `
#ifndef TWILIGHT_SPINE_INCLUDED
#define TWILIGHT_SPINE_INCLUDED

uniform vec3  uOrigin;        // the caster's feet
uniform vec3  uDir;           // unit heading, flat
uniform vec3  uSide;          // up × dir — the lateral the drift swings along
uniform float uFront;         // metres the head has travelled
uniform float uSeed;
uniform float uDrift;         // amplitude of the lazy wander, metres
uniform float uDriftWaves;    // radians per metre
uniform float uDriftRise;     // the vertical wander, as a fraction of the lateral
uniform float uLaunchHeight;
uniform float uFlightHeight;
uniform float uRiseDistance;

/** How far onto its cruise height the beam is, s metres out. */
float twilightRise(float s) {
  float t = clamp(s / max(uRiseDistance, 0.01), 0.0, 1.0);
  return 1.0 - pow(1.0 - t, 3.0);          // outCubic — mirrors utils/math.js
}

/** A point on the flight path, s metres from the caster. */
vec3 twilightSpine(float s) {
  float k = max(s, 0.0);                   // nothing lives behind the caster
  float lateral  = uDrift * sin(k * uDriftWaves + uSeed);
  float vertical = uDrift * uDriftRise * sin(k * uDriftWaves * 0.71 + uSeed * 2.3 + 1.1);
  float height   = mix(uLaunchHeight, uFlightHeight, twilightRise(k));
  return uOrigin + uDir * k + uSide * lateral + vec3(0.0, height + vertical, 0.0);
}

/**
 * The local frame at s: where the path is going, and the two directions across
 * it that everything wrapped around the spine is placed in.
 */
void twilightFrame(float s, out vec3 tangent, out vec3 side, out vec3 up) {
  tangent = normalize(twilightSpine(s + ${H.toFixed(2)}) - twilightSpine(s - ${H.toFixed(2)}) + 1e-6);
  side = normalize(cross(vec3(0.0, 1.0, 0.0), tangent) + 1e-6);
  up = normalize(cross(tangent, side));
}
#endif
`;

/**
 * One cast's worth of spine uniforms.
 *
 * Handed to all three twilight materials, which is why the boxes are created
 * here and not inside each `create*Material()`.
 */
export function createTwilightSpineUniforms() {
  return {
    uOrigin: { value: new Vector3() },
    uDir: { value: new Vector3(0, 0, 1) },
    uSide: { value: new Vector3(1, 0, 0) },
    uFront: { value: 0 },
    uSeed: { value: 0 },
    uDrift: { value: 0.35 },
    uDriftWaves: { value: 0.22 },
    uDriftRise: { value: 0.5 },
    uLaunchHeight: { value: 1.35 },
    uFlightHeight: { value: 2.0 },
    uRiseDistance: { value: 5 }
  };
}

/**
 * Push this frame's cast state and the live settings into that block.
 *
 * @param {object} block  from `createTwilightSpineUniforms()`
 * @param {object} spine  `{ origin, dir, side, seed }` — the cast's own frame
 * @param {number} front  metres the head has travelled
 */
export function syncTwilightSpine(block, spine, front) {
  const c = settings.twilight;
  const g = settings.global;

  block.uOrigin.value.copy(spine.origin);
  block.uDir.value.copy(spine.dir);
  block.uSide.value.copy(spine.side);
  block.uFront.value = front;
  block.uSeed.value = spine.seed;

  block.uDrift.value = c.drift * g.noiseStrength;
  block.uDriftWaves.value = c.driftWaves * g.noiseFrequency;
  block.uDriftRise.value = c.driftRise;
  block.uLaunchHeight.value = c.launchHeight;
  block.uFlightHeight.value = c.flightHeight;
  block.uRiseDistance.value = c.riseDistance;
}

/**
 * The JS half of `twilightSpine`. Same curve, same numbers, same live settings —
 * used by the ability to place its two lights and to tell the camera where the
 * head is.
 *
 * @param {object} spine `{ origin, dir, side, seed }`
 * @param {number} s     metres from the caster
 * @param {THREE.Vector3} out
 */
export function twilightSpinePoint(spine, s, out) {
  const c = settings.twilight;
  const g = settings.global;
  const k = Math.max(s, 0);

  const drift = c.drift * g.noiseStrength;
  const waves = c.driftWaves * g.noiseFrequency;
  const lateral = drift * Math.sin(k * waves + spine.seed);
  const vertical = drift * c.driftRise * Math.sin(k * waves * 0.71 + spine.seed * 2.3 + 1.1);
  const height = lerp(c.launchHeight, c.flightHeight, Easing.outCubic(saturate(k / Math.max(0.01, c.riseDistance))));

  out.copy(spine.origin).addScaledVector(spine.dir, k).addScaledVector(spine.side, lateral);
  out.y += height + vertical;
  return out;
}

/**
 * The JS half of `twilightFrame`. Writes into the three vectors handed in and
 * allocates nothing.
 */
export function twilightSpineFrame(spine, s, tangent, side, up) {
  twilightSpinePoint(spine, s + H, _a);
  twilightSpinePoint(spine, s - H, _b);
  tangent.subVectors(_a, _b).normalize();
  side.crossVectors(_worldUp, tangent).normalize();
  up.crossVectors(tangent, side).normalize();
  return tangent;
}
