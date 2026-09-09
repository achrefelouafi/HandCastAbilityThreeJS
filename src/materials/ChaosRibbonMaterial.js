import { AdditiveBlending, Color, DoubleSide, ShaderMaterial } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { FLUX_SPINE_GLSL } from './FluxSpine.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * THE CHAOTIC ENERGY RIBBONS — layer 3 of the breakdown.
 *
 * The composite has two kinds of trail leaving the cone's apex and it needs
 * both: a few **straight** ones that hold the line of the shot and read as
 * speed, and the **curved** ones weaving around them that read as chaos.
 * `uStraight` is the split — a rolled fraction of the strands drop their coil
 * and their noise and run flat down the axis, thinner, brighter and crimson,
 * while the rest tangle. Straight alone is a laser; curved alone is a knot of
 * string; the pair is what the sheet is showing.
 *
 * Beyond that split, the tangled ones are doing three things at once, and all
 * three have to be there or they collapse into the neon helix every projectile
 * in every game has behind it:
 *
 *  1. **they are chaotic, not wound.** A helix is a machined screw thread; you
 *     read it as one object rotating. These take their path from noise sampled
 *     along the ribbon *and* in time, with only a weak coil under it, so
 *     strands cross, double back and swap places instead of nesting.
 *  2. **they are flat, and they twist.** This is the detail the reference is
 *     actually built on: a ribbon is a *strip*, so as it turns it goes broad,
 *     narrows to a bright line and opens out again. The vertex stage rotates
 *     the strip's own frame about its tangent and blends it only partly back
 *     toward the camera — `uTwistFace` is the floor under that width, and it is
 *     what stops a strand disappearing outright twice a turn.
 *  3. **they are two colours.** Half the strands run crimson and half a paler
 *     rose, rolled per strand, which is the entire reason the tangle reads as
 *     depth rather than as one glowing mass. Both halves stay inside the red;
 *     the violet this used to reach for put one fat purple noodle through the
 *     middle of a composite that has no purple anywhere in it.
 *
 * Every strand is an instance of the standard bolt strip, and the tangle is one
 * draw call. Nothing here is simulated: the path is a pure function of the
 * strand index, the parameter along it, the clock and `settings.flux`, which is
 * why dragging `ribbonChaos` re-tangles ribbons already in the air.
 */

const RIBBON_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586
  #define PI  3.141592653589793

  attribute float aStrand;

  uniform float uTime;
  uniform float uStrands;
  uniform float uSpan;         // metres of path the tangle reaches back over
  uniform float uLead;         // ... and how far past the head it runs
  uniform float uRadius;       // the coil under the chaos, metres
  uniform float uCoil;         // turns it makes over the span
  uniform float uSpin;         // turns/second the whole tangle rolls
  uniform float uSwell;        // where along the span it is fattest
  uniform float uChaos;        // how far the noise throws it off, metres
  uniform float uChaosScale;
  uniform float uChaosSpeed;
  uniform float uStraight;       // fraction of strands that run straight
  uniform float uStraightRadius; // their orbit radius, × the tangle's
  uniform float uStraightChaos;  // their wander, × the tangle's
  uniform float uStraightWidth;  // their width, × the tangle's
  uniform float uWidth;
  uniform float uWidthTip;
  uniform float uTwist;
  uniform float uTwistTurns;
  uniform float uTwistSpeed;
  uniform float uTwistFace;    // the floor under the width when it is edge-on
  uniform float uFade;

  varying float vT;
  varying float vV;
  varying float vHue;          // 0 crimson, 1 rose — rolled per strand
  varying float vStraight;     // 1 on the strands that hold the line
  varying float vFacing;       // how broadside the strip is to the camera
  varying float vStrand;
  varying float vViewZ;

  ${noiseGLSL}
  ${FLUX_SPINE_GLSL}

  /** Where this strand is at t. 0 is the leading end, 1 the far tail. */
  vec3 ribbonAt(float t, float phase, float radius, float coil, float chaos, float wander) {
    float s = max(uFront + uLead - t * uSpan, 0.0);

    vec3 tangent, side, up;
    fluxFrame(s, tangent, side, up);
    vec3 axis = fluxSpine(s);

    // Opens behind the head and *stays* open: a strand splays wider the further
    // back it runs, and it is ended by the width taper rather than by being
    // pinched back onto the axis. Closing both ends made a spindle, and a
    // spindle seen side-on is a squid — twelve tentacles radiating out of one
    // point at the caster's end, which is the silhouette the composite least
    // resembles. There the strands are still apart where they dissolve.
    float profile = pow(clamp(t, 0.0, 1.0), max(uSwell, 0.05));

    float a = phase + t * coil * TAU - uTime * uSpin * TAU;
    vec3 offset = (side * cos(a) + up * sin(a)) * radius * profile;

    float n1 = snoise(vec3(t * uChaosScale, uTime * uChaosSpeed, chaos));
    float n2 = snoise(vec3(t * uChaosScale + 31.7, uTime * uChaosSpeed, chaos + 11.3));
    float n3 = snoise(vec3(t * uChaosScale * 2.3 + 7.1, uTime * uChaosSpeed * 1.6, chaos + 4.7));
    offset += (side * n1 + up * n2 + tangent * n3 * 0.45) * wander * profile;

    return axis + offset;
  }

  void main() {
    float strand = aStrand;
    float roll = hash11(strand * 7.13 + uSeed);
    float roll2 = hash11(strand * 3.71 + uSeed + 11.3);
    float roll3 = hash11(strand * 5.17 + uSeed + 23.7);

    // Which strands hold the line. A hard step rather than a blend: a ribbon
    // that is *slightly* straight is just a lazy curve, and the composite reads
    // off the contrast between the two kinds.
    float roll4 = hash11(strand * 11.7 + uSeed + 41.3);
    float straight = step(1.0 - uStraight, roll4);

    // Evenly spaced around the axis, then jittered — evenly spaced alone reads
    // as one rotating cage.
    float phase = (strand / max(uStrands, 1.0)) * TAU + roll * 1.9 + uSeed;
    float radius = uRadius * (0.55 + roll * 0.85) * mix(1.0, uStraightRadius, straight);
    float coil = uCoil * (0.6 + roll2 * 0.9) * (roll2 > 0.5 ? 1.0 : -1.0) * mix(1.0, 0.15, straight);
    float wander = uChaos * mix(1.0, uStraightChaos, straight);
    float chaos = uSeed * 3.1 + strand * 17.9;

    float t = clamp(position.x, 0.0, 1.0);
    const float H = 0.01;
    vec3 p0 = ribbonAt(t, phase, radius, coil, chaos, wander);
    vec3 p1 = ribbonAt(min(t + H, 1.0), phase, radius, coil, chaos, wander);
    vec3 tangent = normalize(p1 - p0 + 1e-6);

    /* --- the strip's own frame, twisting about that tangent --- */
    vec3 toEye = normalize(cameraPosition - p0);
    vec3 broad = cross(tangent, toEye);
    if (dot(broad, broad) < 1e-8) broad = vec3(0.0, 1.0, 0.0);
    broad = normalize(broad);
    vec3 edge = normalize(cross(tangent, broad));

    float tw = t * uTwistTurns * TAU + roll3 * 20.0 + uTime * uTwistSpeed * TAU;
    float c = cos(tw) * uTwist + (1.0 - uTwist);
    vec3 strip = broad * c + edge * (sin(tw) * uTwist);
    // Blended back toward broadside, so a strand thins to a bright line when it
    // turns edge-on instead of vanishing for a frame.
    strip = mix(strip, broad, uTwistFace);

    // Held broad most of the way and released late. Cutting the width at 0.68
    // lopped the strands off while they were still fat, which is what made the
    // tangle read as a bundle of noodles with ends; the reference has every
    // ribbon thinning to a hair over the last third and dissolving rather than
    // stopping, so the taper starts where uWidthTip has already narrowed it.
    float taper = smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(0.82, 1.0, t));
    float halfWidth = uWidth * mix(1.0, uWidthTip, t) * taper * uFade * (0.6 + roll * 0.8)
                    * mix(1.0, uStraightWidth, straight);

    vec3 world = p0 + strip * (position.y * halfWidth);

    vT = t;
    vV = position.y;
    // The straight ones are the crimson core of the shot, never the rose.
    vHue = roll2 * (1.0 - straight);
    vStraight = straight;
    vFacing = clamp(abs(dot(strip, broad)), 0.0, 1.0);
    vStrand = strand;

    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const RIBBON_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSharp;
  uniform float uCore;
  uniform float uPulse;
  uniform float uPulseFreq;
  uniform float uPulseSpeed;
  uniform float uFlicker;
  uniform float uFlickerScale;
  uniform float uFlickerSpeed;
  uniform float uIntensity;
  uniform float uOpacity;
  uniform float uSoftFade;
  uniform float uFade;
  uniform float uTailFade;
  uniform vec3  uColorCore;
  uniform vec3  uColorBody;
  uniform vec3  uColorAlt;
  uniform vec3  uColorTail;

  uniform sampler2D uSceneDepth;
  uniform vec2  uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uShaderIntensity;
  uniform float uGlobalGlow;

  varying float vT;
  varying float vV;
  varying float vHue;
  varying float vStraight;
  varying float vFacing;
  varying float vStrand;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    /* across the ribbon: a soft body with a hard thread down the middle */
    float across = clamp(1.0 - abs(vV), 0.0, 1.0);
    float body = pow(across, max(uSharp, 0.05));
    float core = pow(across, max(uCore, 1.0));

    /* charge running up the ribbon toward the head */
    float phase = fract(vT * uPulseFreq + uTime * uPulseSpeed + vStrand * 0.41);
    float pulse = pow(1.0 - abs(phase * 2.0 - 1.0), 6.0) * uPulse;

    /* chaos is not steady — let it stutter */
    float flicker = snoise01(vec3(vT * uFlickerScale, uTime * uFlickerSpeed, vStrand * 5.1 + 3.0));
    flicker = mix(1.0, flicker, uFlicker);

    // The straight strands carry a harder thread: they are the streak, and a
    // streak is read off its core rather than off its body.
    // The core is weighted low on purpose. Twelve additive strips crossing each
    // other will stack to white on their own; a fat white thread down every one
    // of them on top of that turned the whole tangle into pale pink floss. The
    // crimson has to be the loudest thing in the layer, so the thread is only
    // ever a highlight on it.
    float energy = (body * (1.0 + pulse) + core * (0.9 + vStraight * 0.7)) * flicker;
    // Edge-on the same energy crosses fewer pixels, so the strand reads as a
    // bright filament at exactly the moment it is narrowest.
    energy *= mix(1.45, 1.0, vFacing);
    energy *= 1.0 - smoothstep(uTailFade, 1.0, vT);

    if (energy < 0.002) discard;

    vec3 hue = mix(uColorBody, uColorAlt, smoothstep(0.22, 0.6, vHue));
    vec3 color = mix(hue, uColorTail, smoothstep(0.3, 0.95, vT));
    // A third of the way to the core colour and no further. Taking it all the
    // way put a white thread down the middle of every strand at once, and a
    // tangle of white threads is a ponytail — the crimson has to survive the
    // core.
    color = mix(color, uColorCore, clamp(core + pulse * 0.65, 0.0, 1.0) * 0.32);
    color *= energy * uIntensity * uShaderIntensity;

    float alpha = clamp(energy, 0.0, 1.0) * uOpacity * uFade;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    color *= uGlobalGlow;
    // Rolled off hard: where six strands cross, an unclamped additive stack
    // goes white, and white is the one colour this ability must never be.
    color /= 1.0 + color * 0.2;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * @param {object} spine shared uniform block from `createFluxSpineUniforms()`
 * @returns {THREE.ShaderMaterial} with `userData.sync({ span, strands, fade })`
 */
export function createChaosRibbonMaterial(spine) {
  const material = new ShaderMaterial({
    name: 'ChaosRibbon',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...spine,

      uStrands: { value: 6 },
      uSpan: { value: 9 },
      uLead: { value: 1.2 },
      uRadius: { value: 0.55 },
      uCoil: { value: 1.1 },
      uSpin: { value: 0.35 },
      uSwell: { value: 0.55 },
      uChaos: { value: 0.7 },
      uChaosScale: { value: 2.1 },
      uChaosSpeed: { value: 0.8 },
      uStraight: { value: 0.35 },
      uStraightRadius: { value: 0.22 },
      uStraightChaos: { value: 0.12 },
      uStraightWidth: { value: 0.55 },
      uWidth: { value: 0.16 },
      uWidthTip: { value: 0.4 },
      uTwist: { value: 0.85 },
      uTwistTurns: { value: 2.2 },
      uTwistSpeed: { value: 0.4 },
      uTwistFace: { value: 0.12 },
      uFade: { value: 1 },

      uSharp: { value: 1.6 },
      uCore: { value: 12 },
      uPulse: { value: 1.1 },
      uPulseFreq: { value: 2 },
      uPulseSpeed: { value: 1.2 },
      uFlicker: { value: 0.35 },
      uFlickerScale: { value: 6 },
      uFlickerSpeed: { value: 2.4 },
      uIntensity: { value: 1.6 },
      uOpacity: { value: 0.8 },
      uSoftFade: { value: 0.35 },
      uTailFade: { value: 0.55 },
      uColorCore: { value: new Color(1, 1, 1) },
      uColorBody: { value: new Color(1, 0.14, 0.28) },
      uColorAlt: { value: new Color(0.63, 0.17, 1) },
      uColorTail: { value: new Color(0.23, 0.04, 0.32) }
    }),
    vertexShader: RIBBON_VERTEX,
    fragmentShader: RIBBON_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.flux;
    const g = settings.global;
    const u = material.uniforms;

    u.uStrands.value = state.strands;
    u.uSpan.value = state.span;
    u.uFade.value = state.fade;

    u.uLead.value = c.ribbonLead;
    u.uRadius.value = c.ribbonRadius;
    u.uCoil.value = c.ribbonCoil;
    u.uSpin.value = c.ribbonSpin * g.animationSpeed;
    u.uSwell.value = c.ribbonSwell;
    u.uChaos.value = c.ribbonChaos * g.noiseStrength;
    u.uChaosScale.value = c.ribbonChaosScale * g.noiseFrequency;
    u.uChaosSpeed.value = c.ribbonChaosSpeed * g.noiseSpeed;
    u.uStraight.value = c.ribbonStraight;
    u.uStraightRadius.value = c.ribbonStraightRadius;
    u.uStraightChaos.value = c.ribbonStraightChaos;
    u.uStraightWidth.value = c.ribbonStraightWidth;
    u.uWidth.value = c.ribbonWidth;
    u.uWidthTip.value = c.ribbonWidthTip;
    u.uTwist.value = c.ribbonTwist;
    u.uTwistTurns.value = c.ribbonTwistTurns;
    u.uTwistSpeed.value = c.ribbonTwistSpeed * g.animationSpeed;
    u.uTwistFace.value = c.ribbonTwistFace;

    u.uSharp.value = c.ribbonSharp;
    u.uCore.value = c.ribbonCore;
    u.uPulse.value = c.ribbonPulse;
    u.uPulseFreq.value = c.ribbonPulseFreq;
    u.uPulseSpeed.value = c.ribbonPulseSpeed * g.noiseSpeed;
    u.uFlicker.value = c.ribbonFlicker * g.randomness;
    u.uFlickerScale.value = c.ribbonFlickerScale * g.noiseFrequency;
    u.uFlickerSpeed.value = c.ribbonFlickerSpeed * g.noiseSpeed;
    u.uIntensity.value = c.ribbonIntensity;
    u.uOpacity.value = c.ribbonOpacity * g.opacity;
    u.uSoftFade.value = c.ribbonSoftFade;
    u.uTailFade.value = c.ribbonTailFade;

    u.uColorCore.value.copy(getColor(c.colorRibbonCore));
    u.uColorBody.value.copy(getColor(c.colorRibbon));
    u.uColorAlt.value.copy(getColor(c.colorRibbonAlt));
    u.uColorTail.value.copy(getColor(c.colorRibbonTail));
  };

  return material;
}
