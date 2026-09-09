import { AdditiveBlending, Color, DoubleSide, ShaderMaterial } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { TWILIGHT_SPINE_GLSL } from './TwilightSpine.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * THE BURNING TIP — panel 3 of the breakdown, captioned there "Source Muzzle
 * Glow".
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
 * So this is the leading edge. The tongues root **at the head** and stream
 * backward along the same spine everything else is hung off, with a few short
 * licks poking forward past the point itself. All of them are at full width
 * where they meet, so a dozen additive strips stack at the nose into the one
 * white-hot mass the panel puts there — the hot core is not a separate sprite
 * and does not need to be.
 *
 * What makes it fire rather than an orange cone:
 *
 *  1. **tongues, not a surface.** Discrete strips with a hard-ish cross-section
 *     falloff, each tapering `(1−t)^k` to an actual point. Fire in this style is
 *     read off its *pointed tips*; a cone with a soft edge is a spotlight.
 *  2. **unequal tongues.** A rolled fraction of them are `needles` — much
 *     longer, much thinner — which is what puts the long thin licks past the
 *     main mass that the panel has. Uniform tongues read as a paper crown.
 *  3. **a nose that is not a single point.** The roots are jittered a little
 *     way back along the path from each other, so the fat ends overlap into a
 *     body of flame rather than all meeting at one spot and radiating like a
 *     starburst.
 *  4. **it licks.** The angle each tongue sits at is pushed around by noise
 *     scrolling along its own length, so the tongue curls and uncurls instead of
 *     being a straight spoke, and the flame is eaten into by a second noise
 *     travelling outward from the root.
 *
 * The colour runs white → yellow → orange → a deep ember at the tails, on a
 * four-stop ramp keyed to distance from the nose. That ordering is the layer:
 * hottest where it is thickest and at the front, coldest where it is thinnest
 * and streaming away, which is the one thing every believable flame does.
 */

const PLUME_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  attribute float aStrand;

  uniform float uTime;
  uniform float uTongues;
  uniform float uRoot;         // metres behind the head the nose sits
  uniform float uLength;       // how far *back* a tongue streams, metres
  uniform float uSplay;        // how far off the axis its tip ends up, metres
  uniform float uSplayPow;     // >1 hugs the axis then opens late
  uniform float uWidth;        // half-width at the root, metres
  uniform float uTaper;        // how fast it comes to a point
  uniform float uNoseWidth;    // the pinch at the apex, x the body width
  uniform float uNeedles;      // fraction of tongues that are long and thin
  uniform float uNeedleLength; // ... how much longer, x
  uniform float uNeedleWidth;  // ... and how much thinner, x
  uniform float uSpikes;       // fraction that lick forward past the point
  uniform float uSpikeLength;  // ... how far forward, x the backward reach
  uniform float uRootSpread;   // metres the roots are strung out over
  uniform float uLick;         // how far noise pushes a tongue off its spoke
  uniform float uLickScale;
  uniform float uLickSpeed;
  uniform float uRoll;         // turns/second the whole fan rotates
  uniform float uFlare;        // the strike blowing it open
  uniform float uFade;

  varying float vT;
  varying float vV;
  varying float vStrand;
  varying float vFacing;
  varying float vSpike;
  varying float vViewZ;

  ${noiseGLSL}
  ${TWILIGHT_SPINE_GLSL}

  /**
   * A point on one tongue. t runs 0 at the root to 1 at the tip; len is
   * signed, so a back-spike is the same function with a negative reach.
   */
  vec3 tongueAt(float t, float sRoot, float angle, float len, float splay, float seed) {
    float s = max(sRoot + t * len, 0.0);

    vec3 tangent, side, up;
    twilightFrame(s, tangent, side, up);
    vec3 axis = twilightSpine(s);

    // Hugs the axis at the root and opens late, which is what makes the fan a
    // flash rather than a starburst.
    float radius = splay * pow(clamp(t, 0.0, 1.0), max(uSplayPow, 0.05));

    // The lick: the spoke's angle is pushed around by noise running along its
    // own length, so the tongue curls instead of pointing.
    float n = snoise(vec3(t * uLickScale, uTime * uLickSpeed, seed));
    float a = angle + n * uLick + uTime * uRoll * TAU;

    return axis + (side * cos(a) + up * sin(a)) * radius;
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
    // *point* of this thing and every tongue streams backward off it. Rooted
    // behind the head with the tongues running forward instead — which is what
    // the word "muzzle" in the panel's caption talks you into — the ability
    // flies tail first, with its flame trailing and its debris leading.
    float len = -uLength * mix(0.55, 1.0, r2) * mix(1.0, uNeedleLength, needle);
    float splay = uSplay * (0.5 + r1 * 1.0) * mix(1.0, 1.35, needle);
    float width = uWidth * (0.6 + r2 * 0.8) * mix(1.0, uNeedleWidth, needle);

    // A few short licks the other way, poking out past the point itself.
    len = mix(len, uLength * uSpikeLength, spike);
    splay = mix(splay, splay * 1.4, spike);

    len *= 1.0 + uFlare;
    splay *= 1.0 + uFlare * 0.7;

    // The nose sits a hair behind the head, jittered per tongue along the path.
    // All of them meeting on one exact point is a starburst — a white node with
    // spokes coming off it — where strung out over half a metre the fat ends
    // overlap into a body of flame with the hot core at its front.
    float sRoot = max(uFront - uRoot - r1 * uRootSpread, 0.0);

    float t = clamp(position.x, 0.0, 1.0);
    const float H = 0.01;
    vec3 p0 = tongueAt(t, sRoot, angle, len, splay, r1 * 41.0);
    vec3 p1 = tongueAt(min(t + H, 1.0), sRoot, angle, len, splay, r1 * 41.0);
    vec3 tangent = normalize(p1 - p0 + 1e-6);

    vec3 toEye = normalize(cameraPosition - p0);
    vec3 broad = cross(tangent, toEye);
    if (dot(broad, broad) < 1e-8) broad = vec3(0.0, 1.0, 0.0);
    broad = normalize(broad);

    // Pinched at the apex, swelling through the body, pointed at the trailing
    // end. This one curve is what makes the layer read as flame rather than as
    // a glow, and the pinch is what makes it a *tip* rather than a spiky ball:
    // t = 0 is the one place every tongue coincides, so leaving them at full
    // width there piles the whole layer's mass onto a single point and the
    // flame becomes a bright dot with streamers coming off it.
    float nose = mix(uNoseWidth, 1.0, smoothstep(0.0, 0.28, t));
    float halfWidth = width * nose * pow(1.0 - t, max(uTaper, 0.05)) * uFade;

    vec3 world = p0 + broad * (position.y * halfWidth);

    vT = t;
    vV = position.y;
    vStrand = strand;
    vSpike = spike;
    vFacing = 1.0;

    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const PLUME_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSharp;        // falloff across a tongue
  uniform float uCore;         // the thread down the middle of one
  uniform float uHeat;         // how much hotter the root is than the tip
  uniform float uMass;         // extra energy piled into the root
  uniform float uMassTight;
  uniform float uEat;          // how hard the flame is eaten into
  uniform float uEatScale;
  uniform float uEatSpeed;
  uniform float uFlicker;
  uniform float uFlickerSpeed;
  uniform float uIntensity;
  uniform float uOpacity;
  uniform float uSoftFade;
  uniform float uFade;
  uniform vec3  uColorWhite;   // the incandescent root
  uniform vec3  uColorHot;
  uniform vec3  uColorBody;
  uniform vec3  uColorTip;     // the ember the tips die at

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
    float across = clamp(1.0 - abs(vV), 0.0, 1.0);
    float body = pow(across, max(uSharp, 0.05));
    float core = pow(across, max(uCore, 1.0));

    /* eaten into by noise running outward from the root */
    float bite = snoise01(vec3(vT * uEatScale, vV * 1.3, uTime * uEatSpeed + vStrand * 6.7));
    body *= mix(1.0, bite * 1.4, uEat);

    /* the whole tongue gutters on its own clock */
    float flicker = 0.75 + 0.25 * sin(uTime * uFlickerSpeed * (1.0 + vStrand * 0.13) + vStrand * 2.7);
    flicker = mix(1.0, flicker, uFlicker);

    /* hottest, thickest and brightest where it leaves the source */
    float heat = pow(1.0 - vT, max(uHeat, 0.05));
    float mass = uMass * pow(1.0 - vT, max(uMassTight, 0.05));

    float energy = (body * heat + core * 0.6) * flicker + mass * body;
    // The back-kicks are embers, not part of the core mass.
    energy *= mix(1.0, 0.55, vSpike);

    if (energy < 0.003) discard;

    // White at the root, ember at the tip — the ordering *is* the layer. The
    // ramp is biased so the white stop is spent inside the first tenth of the
    // tongue: at a linear rate the flame was pale for half its length and the
    // panel's orange never arrived.
    float ramp = pow(clamp(vT, 0.0, 1.0), 0.4);
    vec3 color = gradient4(uColorWhite, uColorHot, uColorBody, uColorTip, ramp);
    // Held to under half. The white core is a small hot spot at the root on
    // the sheet, not a wash over the body: taken further the orange — the
    // one colour this layer exists to supply — goes out of the frame.
    color = mix(color, uColorWhite, clamp(core * 0.7 + mass * 0.5, 0.0, 1.0) * 0.45);
    color *= energy * uIntensity * uShaderIntensity;

    float alpha = clamp(energy, 0.0, 1.0) * uOpacity * uFade;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    color *= uGlobalGlow;
    // The root of this one is *supposed* to reach white; the rest of it must
    // not follow. Sixteen additive tongues will stack past white on their own,
    // and the first render was a white lance with no orange left in it.
    color /= 1.0 + color * 0.3;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * @param {object} spine shared uniform block from `createTwilightSpineUniforms()`
 * @returns {THREE.ShaderMaterial} with `userData.sync({ tongues, flare, fade })`
 */
export function createMuzzlePlumeMaterial(spine) {
  const material = new ShaderMaterial({
    name: 'MuzzlePlume',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...spine,

      uTongues: { value: 14 },
      uRoot: { value: 5.5 },
      uLength: { value: 3.4 },
      uSplay: { value: 0.85 },
      uSplayPow: { value: 1.5 },
      uWidth: { value: 0.3 },
      uTaper: { value: 1.5 },
      uNoseWidth: { value: 0.35 },
      uNeedles: { value: 0.3 },
      uNeedleLength: { value: 1.9 },
      uNeedleWidth: { value: 0.42 },
      uSpikes: { value: 0.22 },
      uSpikeLength: { value: 0.3 },
      uRootSpread: { value: 1.6 },
      uLick: { value: 0.5 },
      uLickScale: { value: 2.2 },
      uLickSpeed: { value: 1.6 },
      uRoll: { value: 0.08 },
      uFlare: { value: 0 },
      uFade: { value: 1 },

      uSharp: { value: 1.1 },
      uCore: { value: 8 },
      uHeat: { value: 1.3 },
      uMass: { value: 1.5 },
      uMassTight: { value: 4 },
      uEat: { value: 0.45 },
      uEatScale: { value: 3.4 },
      uEatSpeed: { value: 2.2 },
      uFlicker: { value: 0.4 },
      uFlickerSpeed: { value: 9 },
      uIntensity: { value: 1.6 },
      uOpacity: { value: 0.9 },
      uSoftFade: { value: 0.3 },
      uColorWhite: { value: new Color(1, 0.97, 0.85) },
      uColorHot: { value: new Color(1, 0.76, 0.28) },
      uColorBody: { value: new Color(1, 0.38, 0.06) },
      uColorTip: { value: new Color(0.45, 0.08, 0.02) }
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
    u.uRootSpread.value = c.plumeRootSpread;
    u.uLick.value = c.plumeLick * g.noiseStrength;
    u.uLickScale.value = c.plumeLickScale * g.noiseFrequency;
    u.uLickSpeed.value = c.plumeLickSpeed * g.noiseSpeed;
    u.uRoll.value = c.plumeRoll * g.animationSpeed;

    u.uSharp.value = c.plumeSharp;
    u.uCore.value = c.plumeCore;
    u.uHeat.value = c.plumeHeat;
    u.uMass.value = c.plumeMass;
    u.uMassTight.value = c.plumeMassTight;
    u.uEat.value = c.plumeEat * g.turbulence;
    u.uEatScale.value = c.plumeEatScale * g.noiseFrequency;
    u.uEatSpeed.value = c.plumeEatSpeed * g.noiseSpeed;
    u.uFlicker.value = c.plumeFlicker * g.randomness;
    u.uFlickerSpeed.value = c.plumeFlickerSpeed * g.noiseSpeed;
    u.uIntensity.value = c.plumeIntensity;
    u.uOpacity.value = c.plumeOpacity * g.opacity;
    u.uSoftFade.value = c.plumeSoftFade;

    u.uColorWhite.value.copy(getColor(c.colorPlumeCore));
    u.uColorHot.value.copy(getColor(c.colorPlumeHot));
    u.uColorBody.value.copy(getColor(c.colorPlume));
    u.uColorTip.value.copy(getColor(c.colorPlumeTip));
  };

  return material;
}
