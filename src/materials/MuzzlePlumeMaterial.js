import { Color, DoubleSide, NormalBlending, ShaderMaterial } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { TWILIGHT_SPINE_GLSL } from './TwilightSpine.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * THE BURNING TIP — the tongues off its body. Panel 3 of the breakdown,
 * captioned there "Source Muzzle Glow".
 *
 * Go by the composite, not by the caption. The word *source* invites you to
 * park this at the caster's hand and fly the rest of the effect out in front of
 * it. That reading is wrong, it was built that way once, and the whole ability
 * came out back to front. Three things in the panel say so:
 *
 *  - the flame is a **point**. It is the most compact, sharpest shape on the
 *    sheet, and every tongue streams away from that point in one direction.
 *    That is the nose of a projectile. A flash left behind at a hand has no
 *    reason to be pointed, and no reason to point that way.
 *  - the crystals **spread the further they get from it**. Debris fans out
 *    behind a moving thing; it does not gather into a cone ahead of one.
 *  - the wisps taper away from the flame, not into it.
 *
 * So these root in the back half of the flame body (`FlameConeMaterial.js`)
 * and stream backward along the same spine everything else is hung off, a few
 * short ones poking forward past the point.
 *
 * ## Painted leaves, not glowing hairs
 *
 * The sheet's tongues are **opaque, flat-painted leaves**: a fat triangular
 * base, straight-ish sides, a sharp point, a yellow thread up the middle and a
 * red edge, and where two overlap the front one simply covers the other. An
 * additive strip cannot do that — it has no edge, it stacks where it crosses
 * its neighbours, and a fan of them is a haze — so these are drawn as solids:
 * normal blending, depth write, the leaf cut out of the strip by an alpha
 * clip. Each one is cel-shaded off the same kind of heat field the body uses,
 * hottest at the root and along its spine, coolest at its point and its
 * edges, stepped into flat tones with wandering boundaries.
 *
 *  1. **two populations.** A rolled fraction of the tongues are `needles`:
 *     much longer, much thinner. The contrast between the short fat teeth and
 *     the few long streamers is the silhouette; uniform tongues are a crown.
 *  2. **roots strung out, off the axis.** Each tongue leaves the body from its
 *     own point along the back half and its own distance off the line, so
 *     they emerge from the flame's flanks rather than all meeting at one spot.
 *  3. **it licks.** The angle each tongue sits at is pushed around by noise
 *     scrolling along its own length, so it curls and uncurls instead of
 *     being a straight spoke, and its edge is eaten into by a second noise.
 */

const PLUME_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  attribute float aStrand;

  uniform float uTime;
  uniform float uTongues;
  uniform float uRoot;         // metres behind the head the first root sits
  uniform float uRootSpread;   // metres the roots are strung out over, behind that
  uniform float uRootRadius;   // metres off the axis a tongue leaves the body
  uniform float uLength;       // how far *back* a tongue streams, metres
  uniform float uSplay;        // how far off the axis its tip ends up, metres
  uniform float uSplayPow;     // >1 hugs the axis then opens late
  uniform float uWidth;        // half-width at the root, metres
  uniform float uTaper;        // how it comes to a point: 1 straight-sided
  uniform float uNoseWidth;    // the pinch at the root, x the body width
  uniform float uNeedles;      // fraction of tongues that are long and thin
  uniform float uNeedleLength; // ... how much longer, x
  uniform float uNeedleWidth;  // ... and how much thinner, x
  uniform float uSpikes;       // fraction that lick forward past the point
  uniform float uSpikeLength;  // ... how far forward, x the backward reach
  uniform float uLick;         // how far noise pushes a tongue off its spoke
  uniform float uLickScale;
  uniform float uLickSpeed;
  uniform float uRoll;         // turns/second the whole fan rotates
  uniform float uFlatten;      // depth of the fan, x its width across the view
  uniform float uFlare;        // the strike blowing it open
  uniform float uFade;

  varying float vT;
  varying float vV;
  varying float vStrand;
  varying float vSpike;
  varying float vViewZ;

  ${noiseGLSL}
  ${TWILIGHT_SPINE_GLSL}

  /**
   * A point on one tongue. t runs 0 at the root to 1 at the tip; len is
   * signed, so a forward spike is the same function with a negative reach.
   */
  vec3 tongueAt(float t, float sRoot, float angle, float len, float splay, float seed) {
    float s = max(sRoot + t * len, 0.0);

    vec3 tangent, side, up;
    twilightFrame(s, tangent, side, up);
    vec3 axis = twilightSpine(s);

    // Leaves the body's flank and opens late, which is what makes the fan a
    // flame rather than a starburst.
    float radius = uRootRadius + splay * pow(clamp(t, 0.0, 1.0), max(uSplayPow, 0.05));

    // The lick: the spoke's angle is pushed around by noise running along its
    // own length, so the tongue curls instead of pointing.
    float n = snoise(vec3(t * uLickScale, uTime * uLickSpeed, seed));
    float a = angle + n * uLick + uTime * uRoll * TAU;

    // The fan spreads *across the view*, not evenly round the axis. The sheet
    // paints its tongues fanning symmetrically about the path in the picture
    // plane; a round cone of leaves only looks like that from dead side-on,
    // and from the rig's usual elevated seat its top half dominates and the
    // whole flame reads as swept upward, off the line. So the fan's wide
    // axis is the in-view perpendicular to the path and its narrow one points
    // at the eye, squashed by uFlatten — enough depth to be a volume, not so
    // much that the angle you watch from changes the shape.
    vec3 toEye = normalize(cameraPosition - axis);
    vec3 broad = cross(tangent, toEye);
    float bl = length(broad);
    broad = bl > 1e-4 ? broad / bl : side;
    vec3 deep = cross(broad, tangent);

    return axis + (broad * cos(a) + deep * sin(a) * uFlatten) * radius;
  }

  void main() {
    float strand = aStrand;
    float r1 = hash11(strand * 2.91 + uSeed);
    float r2 = hash11(strand * 6.13 + uSeed + 7.7);
    float r3 = hash11(strand * 9.77 + uSeed + 19.3);
    float r4 = hash11(strand * 13.31 + uSeed + 31.1);

    // A hard step, not a blend: the panel's silhouette is built on the contrast
    // between a few long licks and a body of short fat ones.
    float needle = step(1.0 - uNeedles, r3);
    float spike = step(1.0 - uSpikes, r4) * (1.0 - needle);

    float angle = (strand / max(uTongues, 1.0)) * TAU + r1 * 1.7 + uSeed;
    // Negative, and that minus sign is the whole correction. The fire is the
    // *point* of this thing and every tongue streams backward off it.
    float len = -uLength * mix(0.55, 1.0, r2) * mix(1.0, uNeedleLength, needle);
    float splay = uSplay * (0.5 + r1 * 1.0) * mix(1.0, 1.35, needle);
    float width = uWidth * (0.6 + r2 * 0.8) * mix(1.0, uNeedleWidth, needle);

    // A few short licks the other way, poking out past the point itself.
    len = mix(len, uLength * uSpikeLength, spike);
    splay = mix(splay, splay * 1.4, spike);

    len *= 1.0 + uFlare;
    splay *= 1.0 + uFlare * 0.7;

    // The roots are strung out along the back half of the body, so the tongues
    // leave it from all along its flanks. The forward spikes root at the nose.
    float sRoot = max(uFront - mix(uRoot + r1 * uRootSpread, uRoot * 0.3, spike), 0.0);

    float t = clamp(position.x, 0.0, 1.0);
    const float H = 0.01;
    vec3 p0 = tongueAt(t, sRoot, angle, len, splay, r1 * 41.0);
    vec3 p1 = tongueAt(min(t + H, 1.0), sRoot, angle, len, splay, r1 * 41.0);
    vec3 tangent = normalize(p1 - p0 + 1e-6);

    vec3 toEye = normalize(cameraPosition - p0);
    vec3 broad = cross(tangent, toEye);
    if (dot(broad, broad) < 1e-8) broad = vec3(0.0, 1.0, 0.0);
    broad = normalize(broad);

    // A leaf: pinched a little at the root, fattest just past it, then a
    // near-straight taper to a sharp point. Fire in this style is read off its
    // pointed tips, and a soft rounded end is a petal.
    float nose = mix(uNoseWidth, 1.0, smoothstep(0.0, 0.22, t));
    float halfWidth = width * nose * pow(1.0 - t, max(uTaper, 0.05)) * uFade;

    vec3 world = p0 + broad * (position.y * halfWidth);

    vT = t;
    vV = position.y;
    vStrand = strand;
    vSpike = spike;

    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const PLUME_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uEat;          // how raggedly the edge is eaten into
  uniform float uEatScale;
  uniform float uEatSpeed;
  uniform float uHeat;         // how fast the heat drops off toward the tip
  uniform float uEdgeCool;     // how much the edge cools
  uniform float uEdgePower;
  uniform float uCore;         // how tight the thread up the middle is
  uniform float uCoreHeat;     // ... and how much hotter it runs
  uniform float uBands;
  uniform float uPosterize;
  uniform float uWobble;
  uniform float uFlicker;
  uniform float uFlickerSpeed;
  uniform float uIntensity;
  uniform float uRolloff;
  uniform float uOpacity;
  uniform float uSoftFade;
  uniform float uFade;
  uniform vec3  uColorWhite;   // the incandescent root
  uniform vec3  uColorHot;
  uniform vec3  uColorBody;
  uniform vec3  uColorTip;     // the red the tips die at

  uniform sampler2D uSceneDepth;
  uniform vec2  uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uShaderIntensity;
  uniform float uGlobalGlow;

  varying float vT;
  varying float vV;
  varying float vStrand;
  varying float vSpike;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    float across = abs(vV);

    /* ---- the leaf, cut out of the strip ---- */
    // Its edge is eaten into by noise running outward from the root, more so
    // toward the point, so the licks are ragged rather than milled.
    float bite = snoise01(vec3(vT * uEatScale, vV * 1.3, uTime * uEatSpeed + vStrand * 6.7));
    float edge = 1.0 - (bite - 0.5) * uEat * (0.4 + vT);
    float mask = 1.0 - aastep(edge, across);
    if (mask < 0.02) discard;

    /* ---- the heat field ---- */
    // Hottest at the root, cooling to the point; hottest up the middle,
    // cooling to the edge; and a thread up the spine that runs hotter still.
    float heat = pow(1.0 - vT, max(uHeat, 0.05));
    heat *= 1.0 - pow(across, max(uEdgePower, 0.05)) * uEdgeCool;
    heat += pow(1.0 - across, max(uCore, 1.0)) * (1.0 - vT) * uCoreHeat;

    // The whole tongue gutters on its own clock.
    float flicker = 1.0 - uFlicker * 0.5 * (1.0 - sin(uTime * uFlickerSpeed * (1.0 + vStrand * 0.13) + vStrand * 2.7));
    heat *= flicker;
    // The forward spikes are embers, not part of the core mass.
    heat *= mix(1.0, 0.6, vSpike);

    heat += snoise(vec3(vT * 3.0, vV * 2.0, uTime * 0.8 + vStrand * 3.1)) * uWobble;

    /* ---- stepped into flat tones ---- */
    float steps = max(uBands, 1.0);
    float banded = floor(heat * steps + 0.5) / steps;
    heat = clamp(mix(heat, banded, uPosterize), 0.0, 1.0);

    vec3 color = gradient4(uColorWhite, uColorHot, uColorBody, uColorTip, 1.0 - heat);
    color *= uIntensity * uShaderIntensity;
    // Compressed so the tongues keep their orange instead of blowing to white.
    color /= 1.0 + color * uRolloff;

    float alpha = mask * uOpacity * uFade;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.02) discard;

    color *= uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * @param {object} spine shared uniform block from `createTwilightSpineUniforms()`
 * @returns {THREE.ShaderMaterial} with `userData.sync({ tongues, root, flare, fade })`
 */
export function createMuzzlePlumeMaterial(spine) {
  const material = new ShaderMaterial({
    name: 'MuzzlePlume',
    transparent: true,
    // Solids, like the body they leave: the leaf is an alpha clip with a depth
    // write, so the front tongue covers the one behind it instead of adding
    // to it.
    depthWrite: true,
    depthTest: true,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...spine,

      uTongues: { value: 22 },
      uRoot: { value: 1.0 },
      uRootSpread: { value: 1.6 },
      uRootRadius: { value: 0.2 },
      uLength: { value: 2.2 },
      uSplay: { value: 1.1 },
      uSplayPow: { value: 1.6 },
      uWidth: { value: 0.26 },
      uTaper: { value: 1.1 },
      uNoseWidth: { value: 0.55 },
      uNeedles: { value: 0.25 },
      uNeedleLength: { value: 1.5 },
      uNeedleWidth: { value: 0.4 },
      uSpikes: { value: 0.1 },
      uSpikeLength: { value: 0.25 },
      uLick: { value: 0.4 },
      uLickScale: { value: 2.2 },
      uLickSpeed: { value: 1.7 },
      uRoll: { value: 0 },
      uFlatten: { value: 0.35 },
      uFlare: { value: 0 },
      uFade: { value: 1 },

      uEat: { value: 0.35 },
      uEatScale: { value: 3.4 },
      uEatSpeed: { value: 2.2 },
      uHeat: { value: 0.8 },
      uEdgeCool: { value: 0.45 },
      uEdgePower: { value: 2.5 },
      uCore: { value: 3 },
      uCoreHeat: { value: 0.3 },
      uBands: { value: 3 },
      uPosterize: { value: 0.85 },
      uWobble: { value: 0.1 },
      uFlicker: { value: 0.3 },
      uFlickerSpeed: { value: 9 },
      uIntensity: { value: 1.6 },
      uRolloff: { value: 0.2 },
      uOpacity: { value: 1 },
      uSoftFade: { value: 0.3 },
      uColorWhite: { value: new Color(1, 0.95, 0.77) },
      uColorHot: { value: new Color(1, 0.8, 0.2) },
      uColorBody: { value: new Color(1, 0.44, 0.06) },
      uColorTip: { value: new Color(0.72, 0.15, 0.04) }
    }),
    vertexShader: PLUME_VERTEX,
    fragmentShader: PLUME_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.twilight;
    const g = settings.global;
    const u = material.uniforms;

    u.uTongues.value = state.tongues;
    u.uFlare.value = state.flare;
    u.uFade.value = state.fade;

    u.uRoot.value = state.root;
    u.uRootSpread.value = c.plumeRootSpread;
    u.uRootRadius.value = c.plumeRootRadius;
    u.uLength.value = c.plumeLength;
    u.uSplay.value = c.plumeSplay;
    u.uSplayPow.value = c.plumeSplayPow;
    u.uWidth.value = c.plumeWidth;
    u.uTaper.value = c.plumeTaper;
    u.uNoseWidth.value = c.plumeNoseWidth;
    u.uNeedles.value = c.plumeNeedles;
    u.uNeedleLength.value = c.plumeNeedleLength;
    u.uNeedleWidth.value = c.plumeNeedleWidth;
    u.uSpikes.value = c.plumeSpikes;
    u.uSpikeLength.value = c.plumeSpikeLength;
    u.uLick.value = c.plumeLick * g.noiseStrength;
    u.uLickScale.value = c.plumeLickScale * g.noiseFrequency;
    u.uLickSpeed.value = c.plumeLickSpeed * g.noiseSpeed;
    u.uRoll.value = c.plumeRoll * g.animationSpeed;
    u.uFlatten.value = c.plumeFlatten;

    u.uEat.value = c.plumeEat * g.turbulence;
    u.uEatScale.value = c.plumeEatScale * g.noiseFrequency;
    u.uEatSpeed.value = c.plumeEatSpeed * g.noiseSpeed;
    u.uHeat.value = c.plumeHeat;
    u.uEdgeCool.value = c.plumeEdgeCool;
    u.uEdgePower.value = c.plumeEdgePower;
    u.uCore.value = c.plumeCore;
    u.uCoreHeat.value = c.plumeCoreHeat;
    u.uBands.value = c.plumeBands;
    u.uPosterize.value = c.plumePosterize;
    u.uWobble.value = c.plumeWobble * g.noiseStrength;
    u.uFlicker.value = c.plumeFlicker * g.randomness;
    u.uFlickerSpeed.value = c.plumeFlickerSpeed * g.noiseSpeed;
    u.uIntensity.value = c.plumeIntensity;
    u.uRolloff.value = c.plumeRolloff;
    u.uOpacity.value = c.plumeOpacity * g.opacity;
    u.uSoftFade.value = c.plumeSoftFade;

    u.uColorWhite.value.copy(getColor(c.colorPlumeCore));
    u.uColorHot.value.copy(getColor(c.colorPlumeHot));
    u.uColorBody.value.copy(getColor(c.colorPlume));
    u.uColorTip.value.copy(getColor(c.colorPlumeTip));
  };

  return material;
}
