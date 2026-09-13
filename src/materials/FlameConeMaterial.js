import { Color, DoubleSide, NormalBlending, ShaderMaterial } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { TWILIGHT_SPINE_GLSL } from './TwilightSpine.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * THE BURNING TIP — the body of the flame, as a painted teardrop.
 *
 * The reference's flame is not a cone and it is not a bundle of strips. It is
 * a **teardrop**: a slim needle at the point, swelling fast into a fat body,
 * whose back edge breaks up into a couple of dozen sharp teeth — most of them
 * short, a few of them long streamers — with a paler core showing through the
 * gaps between them. The whole thing is flat-painted in three or four tones,
 * yellow at the heart and red at the tooth points, and its outline is
 * *jagged*, not faceted.
 *
 * The previous build carved a cone into eight strips that ran its whole
 * length, with a four-step gradient along it, and that is a faceted dart
 * however it is tuned: eight hard-edged spokes with straight bands across them
 * read as low-poly geometry, which is the one thing a painted flame must not
 * do. So the carve has moved and the shading has changed:
 *
 *  1. **the profile is a teardrop**, not a cone. The radius rises out of the
 *     apex as a needle (`uFlare`), reaches the full envelope at `uSwell`, and
 *     only opens a little more from there (`uSplay`). Ahead of the swell it is
 *     a point; behind it, it is a body.
 *  2. **the teeth are cut into the back half only.** Ahead of `uBodyEnd` the
 *     surface is continuous. Behind it, each of `uTeeth` slots around the
 *     circumference becomes one triangular tooth — full slot width where it
 *     leaves the body, a sharp point at its own reach — and the gaps between
 *     them open. A rolled fraction of the teeth are streamers that run to the
 *     very end of the surface; the rest stop well short. Two populations, and
 *     the contrast between them is what makes the edge read as fire rather
 *     than as a crown.
 *  3. **two shells.** The same surface is drawn twice: an orange *skin*, and a
 *     smaller, paler *core* inside it with its own teeth. Through the gaps in
 *     the skin you see the core, which is exactly the yellow heart the sheet
 *     paints inside its orange tongues — and from behind, where an open cone
 *     would show its hollow inside, this one shows a burning heart instead.
 *  4. **the colour is keyed on a heat field, not on the length.** Heat falls
 *     off from the apex, cools toward every silhouette (the fresnel term), and
 *     cools again along each tooth to its point. It is then stepped into a few
 *     bands whose edges are pushed around by slow noise — so the bands are the
 *     wandering brush-stroke boundaries of the painting, curving around the
 *     body, rather than rings across a cone.
 *
 * It is a solid: normal blending, depth write, alpha clipped. That is what
 * gives it a silhouette, and it is what lets the tongues off its mouth
 * (`MuzzlePlumeMaterial.js`) and the crystals behind it occlude it properly.
 */

/** The teeth, shared by both stages so a vertex and its fragments agree. */
const TEETH_GLSL = /* glsl */ `
  uniform float uTime;
  uniform float uTeeth;        // slots around the circumference, one tooth each
  uniform float uBodyEnd;      // u where the solid body ends and the teeth begin
  uniform float uToothLength;  // how far past that a short tooth reaches, in u
  uniform float uStreamers;    // fraction of teeth that run to the very end
  uniform float uFlicker;      // how far a tooth's reach wanders, in u
  uniform float uFlickerSpeed;
  uniform float uShell;        // 0 the skin, 1 the core; decorrelates the rolls

  float toothRoll(float id, float k) {
    return hash11(id * k + uSeed + uShell * 53.1);
  }

  /** Where this tooth's point lands, in u. */
  float toothReach(float id, out float streamer) {
    streamer = step(1.0 - uStreamers, toothRoll(id, 5.71));
    float reach = uBodyEnd + uToothLength * mix(0.3, 1.0, toothRoll(id, 7.31));
    reach = mix(reach, 1.0, streamer);
    // Every tooth licks in and out on its own clock.
    float flick = snoise(vec3(id * 1.71, uTime * uFlickerSpeed, uSeed + uShell * 9.0));
    reach += flick * uFlicker * mix(1.0, 0.4, streamer);
    return clamp(reach, uBodyEnd + 0.02, 1.0);
  }
`;

const CONE_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  uniform float uLength;     // metres from the apex back to the end of the longest tooth
  uniform float uRadius;     // the envelope radius, metres
  uniform float uSwell;      // u where the needle has swollen to that radius
  uniform float uFlare;      // >1 concave and needle-like out of the apex
  uniform float uSplay;      // how much the back keeps opening past the swell
  uniform float uCurl;       // how far a tooth swings off its own spoke
  uniform float uCurlScale;
  uniform float uCurlSpeed;
  uniform float uSpread;     // how much a tooth leaves the envelope, x
  uniform float uRipple;     // how far the surface is pushed off a clean teardrop
  uniform float uRippleFreq;
  uniform float uRippleScale;
  uniform float uRippleSpeed;
  uniform float uBurst;      // the strike blowing the body open

  varying float vU;
  varying float vV;
  varying vec3  vNormal;
  varying vec3  vWorld;
  varying float vViewZ;

  ${noiseGLSL}
  ${TWILIGHT_SPINE_GLSL}
  ${TEETH_GLSL}

  /** The clean envelope: a needle, a swell, a gentle opening. */
  float envelope(float u) {
    float swell = pow(smoothstep(0.0, max(uSwell, 0.01), u), max(uFlare, 0.05));
    return swell * (1.0 + uSplay * max(u - uSwell, 0.0));
  }

  void main() {
    float u = clamp(position.x, 0.0, 1.0);
    float v = position.y;

    /* ---- which tooth ---- */
    float teeth = max(uTeeth, 1.0);
    float id = mod(floor(v * teeth), teeth);
    float streamer;
    float reach = toothReach(id, streamer);
    float toothU = clamp((u - uBodyEnd) / max(reach - uBodyEnd, 1e-3), 0.0, 1.0);

    /* ---- the envelope ---- */
    float s = max(uFront - u * uLength, 0.0);

    vec3 tangent, side, up;
    twilightFrame(s, tangent, side, up);
    vec3 axis = twilightSpine(s);

    float profile = envelope(u);
    float r = uRadius * profile * (1.0 + uBurst);

    // Scaled by the profile on purpose: the ripple has to vanish where the body
    // does, or it eats the point.
    float n = snoise(vec3(cos(v * TAU) * uRippleFreq, sin(v * TAU) * uRippleFreq,
                          u * uRippleScale + uTime * uRippleSpeed + uSeed));
    r *= 1.0 + n * uRipple * profile;

    /* ---- and each tooth goes its own way, only once it is a tooth ---- */
    // Faded in with toothU: ahead of the body's end the teeth are one surface,
    // so they all move together there and there is no seam to tear open.
    float roll = toothRoll(id, 3.17);
    r *= 1.0 + (roll - 0.5) * 2.0 * uSpread * toothU;

    float wander = snoise(vec3(id * 3.3, u * uCurlScale, uTime * uCurlSpeed + uSeed));
    float curl = ((toothRoll(id, 9.13) - 0.5) * 1.4 + wander * 0.8) * uCurl * toothU;
    float ang = v * TAU + curl;

    vec3 radial = side * cos(ang) + up * sin(ang);
    vec3 world = axis + radial * r;

    // The surface normal leans forward off the radial by the envelope's slope.
    // A numeric slope, so it follows the swell rather than a straight cone.
    float slope = uRadius * (envelope(min(u + 0.02, 1.0)) - envelope(max(u - 0.02, 0.0)))
                / (0.04 * max(uLength, 0.01));
    vNormal = normalize(radial + tangent * slope);
    vU = u;
    vV = v;
    vWorld = world;

    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const CONE_FRAGMENT = /* glsl */ `
  uniform float uToothWidth;  // fraction of its slot a tooth keeps just past the body
  uniform float uToothTaper;  // how it comes to its point: >1 concave, sharp
  uniform float uToothLean;   // how far a tooth's centre line drifts sideways
  uniform float uErode;       // how raggedly the tooth edges are eaten into
  uniform float uErodeFreq;
  uniform float uErodeScale;
  uniform float uErodeSpeed;
  uniform float uBands;       // steps the heat is quantised into
  uniform float uPosterize;
  uniform float uWobble;      // how far noise pushes the band edges around
  uniform float uWobbleScale;
  uniform float uWobbleSpeed;
  uniform float uHeatFalloff; // how fast the heat drops off behind the apex
  uniform float uRimCool;     // how much the silhouette cools
  uniform float uRimPower;
  uniform float uToothCool;   // how much a tooth cools to its point
  uniform float uHeatBias;    // per shell: the core runs hotter throughout
  uniform float uApex;        // extra heat piled into the point
  uniform float uApexTight;
  uniform float uInner;       // how much dimmer the inside of the shell is
  uniform float uIntensity;
  uniform float uRolloff;
  uniform float uOpacity;
  uniform float uSoftFade;
  uniform float uFade;
  uniform vec3  uColorCore;   // white-hot, at the point and in the heart
  uniform vec3  uColorHot;    // yellow
  uniform vec3  uColorBody;   // orange
  uniform vec3  uColorBase;   // the red the teeth die at

  uniform sampler2D uSceneDepth;
  uniform vec2  uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uShaderIntensity;
  uniform float uGlobalGlow;

  varying float vU;
  varying float vV;
  varying vec3  vNormal;
  varying vec3  vWorld;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}
  ${TWILIGHT_SPINE_GLSL}
  ${TEETH_GLSL}

  void main() {
    /* ---- the teeth ---- */
    float teeth = max(uTeeth, 1.0);
    float slot = vV * teeth;
    float id = mod(floor(slot), teeth);
    float local = fract(slot);
    float streamer;
    float reach = toothReach(id, streamer);
    float toothU = clamp((vU - uBodyEnd) / max(reach - uBodyEnd, 1e-3), 0.0, 1.0);

    // Each tooth's centre line drifts to one side as it goes back: a lick,
    // not a spoke.
    float centre = 0.5 + (toothRoll(id, 11.7) - 0.5) * uToothLean * toothU * toothU;
    float across = abs(local - centre) * 2.0;

    // Full slot where it leaves the body, so the base of the tooth is
    // continuous with it; pinched to uToothWidth just behind, so the gaps open
    // at once; then a concave taper to a genuine point at its reach.
    float width = mix(1.0, uToothWidth, smoothstep(0.0, 0.2, toothU))
                * (1.0 - pow(toothU, max(uToothTaper, 0.05)));

    // Eaten into along its edges, more so toward the point.
    float n = snoise01(vec3(vV * uErodeFreq * 4.0, vU * uErodeScale, uTime * uErodeSpeed + uSeed));
    across += (n - 0.5) * uErode * (0.3 + toothU);

    float tooth = 1.0 - aastep(width, across);
    tooth *= 1.0 - step(reach, vU);
    float mask = vU < uBodyEnd ? 1.0 : tooth;
    if (mask < 0.02) discard;

    /* ---- the heat field ---- */
    vec3 N = normalize(vNormal);
    if (!gl_FrontFacing) N = -N;
    vec3 V = normalize(cameraPosition - vWorld);
    float f = 1.0 - clamp(dot(N, V), 0.0, 1.0);

    float axial = 1.0 - vU;
    float heat = pow(axial, max(uHeatFalloff, 0.05));
    heat *= 1.0 - pow(f, max(uRimPower, 0.05)) * uRimCool;
    heat *= 1.0 - toothU * uToothCool;
    heat += uHeatBias;
    // The band edges wander: these are brush strokes, not contour lines.
    heat += snoise(vec3(vV * 6.0, vU * uWobbleScale, uTime * uWobbleSpeed + uSeed + uShell * 4.0)) * uWobble;

    /* ---- stepped into flat tones ---- */
    float steps = max(uBands, 1.0);
    float banded = floor(heat * steps + 0.5) / steps;
    heat = clamp(mix(heat, banded, uPosterize), 0.0, 1.0);

    vec3 color = gradient4(uColorCore, uColorHot, uColorBody, uColorBase, 1.0 - heat);

    /* ---- the point runs hotter than anything else in the ability ---- */
    color += uColorCore * uApex * pow(axial, max(uApexTight, 0.05));

    // The inside of the shell, seen through the gaps: the same fire, a shade
    // deeper, so the gaps read as depth rather than as holes.
    if (!gl_FrontFacing) color = mix(color, color * uColorBase * 2.0, 0.35) * uInner;

    color *= uIntensity * uShaderIntensity;
    // Compressed so the flame keeps its own colour instead of blowing to white.
    color /= 1.0 + color * uRolloff;

    float alpha = uOpacity * uFade * mask;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.02) discard;

    color *= uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * One shell of the flame body.
 *
 * @param {object}  spine shared uniform block from `createTwilightSpineUniforms()`
 * @param {object}  [options]
 * @param {boolean} [options.core] true for the pale inner shell, false for the skin
 * @returns {THREE.ShaderMaterial} with `userData.sync({ burst, fade })`
 */
export function createFlameConeMaterial(spine, { core = false } = {}) {
  const material = new ShaderMaterial({
    name: core ? 'FlameCore' : 'FlameSkin',
    transparent: true,
    // A solid, like the crystals: this layer exists to have an edge, and an
    // edge needs a depth write. Double-sided because through the gaps between
    // the teeth you see the inside of the far side of the shell.
    depthWrite: true,
    depthTest: true,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...spine,

      uLength: { value: 3.6 },
      uRadius: { value: 0.72 },
      uSwell: { value: 0.5 },
      uFlare: { value: 1.6 },
      uSplay: { value: 0.35 },
      uTeeth: { value: 21 },
      uBodyEnd: { value: 0.42 },
      uToothLength: { value: 0.4 },
      uStreamers: { value: 0.2 },
      uFlicker: { value: 0.06 },
      uFlickerSpeed: { value: 2.5 },
      uShell: { value: core ? 1 : 0 },
      uCurl: { value: 0.22 },
      uCurlScale: { value: 2.2 },
      uCurlSpeed: { value: 1.4 },
      uSpread: { value: 0.2 },
      uRipple: { value: 0.08 },
      uRippleFreq: { value: 3 },
      uRippleScale: { value: 2 },
      uRippleSpeed: { value: 1.5 },
      uBurst: { value: 0 },
      uFade: { value: 1 },

      uToothWidth: { value: 0.72 },
      uToothTaper: { value: 1.3 },
      uToothLean: { value: 0.5 },
      uErode: { value: 0.25 },
      uErodeFreq: { value: 2 },
      uErodeScale: { value: 3 },
      uErodeSpeed: { value: 1.6 },
      uBands: { value: 3 },
      uPosterize: { value: 0.85 },
      uWobble: { value: 0.1 },
      uWobbleScale: { value: 2.5 },
      uWobbleSpeed: { value: 1.2 },
      uHeatFalloff: { value: 0.7 },
      uRimCool: { value: 0.35 },
      uRimPower: { value: 2 },
      uToothCool: { value: 0.55 },
      uHeatBias: { value: core ? 0.35 : 0 },
      uApex: { value: 0.6 },
      uApexTight: { value: 6 },
      uInner: { value: 0.7 },
      uIntensity: { value: 1.6 },
      uRolloff: { value: 0.2 },
      uOpacity: { value: 1 },
      uSoftFade: { value: 0.26 },
      uColorCore: { value: new Color(1, 0.97, 0.84) },
      uColorHot: { value: new Color(1, 0.82, 0.24) },
      uColorBody: { value: new Color(1, 0.49, 0.08) },
      uColorBase: { value: new Color(0.77, 0.18, 0.03) }
    }),
    vertexShader: CONE_VERTEX,
    fragmentShader: CONE_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.twilight;
    const g = settings.global;
    const u = material.uniforms;

    u.uBurst.value = state.burst;
    u.uFade.value = state.fade;

    // The core is the same surface at a fraction of the size, running hotter.
    u.uLength.value = c.tipLength * (core ? c.tipCoreLength : 1);
    u.uRadius.value = c.tipRadius * (core ? c.tipCoreScale : 1);
    u.uHeatBias.value = core ? c.tipCoreHeat : 0;

    u.uSwell.value = c.tipSwell;
    u.uFlare.value = c.tipFlare;
    u.uSplay.value = c.tipSplay;
    u.uTeeth.value = Math.max(1, Math.round(c.tipTeeth));
    u.uBodyEnd.value = c.tipBodyEnd;
    u.uToothLength.value = c.tipToothLength;
    u.uStreamers.value = c.tipStreamers;
    u.uFlicker.value = c.tipFlicker * g.randomness;
    u.uFlickerSpeed.value = c.tipFlickerSpeed * g.noiseSpeed;
    u.uCurl.value = c.tipCurl * g.noiseStrength;
    u.uCurlScale.value = c.tipCurlScale * g.noiseFrequency;
    u.uCurlSpeed.value = c.tipCurlSpeed * g.noiseSpeed;
    u.uSpread.value = c.tipSpread;
    u.uRipple.value = c.tipRipple * g.noiseStrength;
    u.uRippleFreq.value = c.tipRippleFreq * g.noiseFrequency;
    u.uRippleScale.value = c.tipRippleScale * g.noiseFrequency;
    u.uRippleSpeed.value = c.tipRippleSpeed * g.noiseSpeed;

    u.uToothWidth.value = c.tipToothWidth;
    u.uToothTaper.value = c.tipToothTaper;
    u.uToothLean.value = c.tipToothLean;
    u.uErode.value = c.tipErode * g.turbulence;
    u.uErodeFreq.value = c.tipErodeFreq * g.noiseFrequency;
    u.uErodeScale.value = c.tipErodeScale * g.noiseFrequency;
    u.uErodeSpeed.value = c.tipErodeSpeed * g.noiseSpeed;
    u.uBands.value = c.tipBands;
    u.uPosterize.value = c.tipPosterize;
    u.uWobble.value = c.tipWobble * g.noiseStrength;
    u.uWobbleScale.value = c.tipWobbleScale * g.noiseFrequency;
    u.uWobbleSpeed.value = c.tipWobbleSpeed * g.noiseSpeed;
    u.uHeatFalloff.value = c.tipHeatFalloff;
    u.uRimCool.value = c.tipRimCool * g.fresnel;
    u.uRimPower.value = c.tipRimPower;
    u.uToothCool.value = c.tipToothCool;
    u.uApex.value = c.tipApex;
    u.uApexTight.value = c.tipApexTight;
    u.uInner.value = c.tipInner;
    u.uIntensity.value = c.tipIntensity;
    u.uRolloff.value = c.tipRolloff;
    u.uOpacity.value = c.tipOpacity * g.opacity;
    u.uSoftFade.value = c.tipSoftFade;

    u.uColorCore.value.copy(getColor(c.colorTipCore));
    u.uColorHot.value.copy(getColor(c.colorTipHot));
    u.uColorBody.value.copy(getColor(c.colorTip));
    u.uColorBase.value.copy(getColor(c.colorTipBase));
  };

  return material;
}
