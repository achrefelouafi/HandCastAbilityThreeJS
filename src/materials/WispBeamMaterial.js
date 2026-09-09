import { AdditiveBlending, Color, DoubleSide, ShaderMaterial } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { TWILIGHT_SPINE_GLSL } from './TwilightSpine.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * THE WISPY BEAM CORE — panel 1 of the breakdown.
 *
 * The panel shows two things and it is worth being exact about which, because
 * the obvious reading of "energy beam" produces neither of them:
 *
 *  - it is a **braid**, not a helix. Two or three strips leave the same point,
 *    bow apart, cross, bow apart again and converge at the far end. A helix
 *    reads as one screw thread rotating; a braid reads as several separate
 *    things sharing a path, which is what makes it look like *flow*. So the
 *    orbit is deliberately **flattened** (`uFlatten` squashes the vertical
 *    component of the coil), the strands take under one full turn over the
 *    whole span, and they are given opposite handedness in pairs so they
 *    genuinely cross rather than nesting.
 *  - it is **pointed at both ends**. Every wisp on the sheet tapers to nothing
 *    at the leading tip and to nothing again at the muzzle. Both the orbit
 *    radius and the width are driven by `sin(πt)` profiles, so the strands
 *    converge and thin at the same places — which is what welds the layer into
 *    one object instead of three parallel noodles.
 *
 * On top of that shape, a wisp has to look like **smoke lit from inside**, and
 * three things do that:
 *
 *  1. **a soft body under a hard thread.** A broad, low-exponent falloff across
 *     the strip for the glow, and a very tight one for the filament down the
 *     middle. Without the thread the layer is fog; without the body it is a
 *     laser.
 *  2. **fibres.** Noise scrolling backwards along the strip breaks the body
 *     into strands of brightness that travel. This is the difference between a
 *     wisp and a ribbon of coloured gel, and it costs one `snoise`.
 *  3. **a flat strip that twists.** The strip rotates about its own tangent, so
 *     it goes broad, narrows to a bright line and opens out again — with
 *     `uTwistFace` as the floor under the width so it never vanishes outright
 *     for a frame.
 *
 * Every strand is an instance of the standard bolt strip and the braid is one
 * draw call. Nothing is simulated: the path is a pure function of the strand
 * index, the parameter along it, the clock and `settings.twilight`.
 */

const WISP_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586
  #define PI  3.141592653589793

  attribute float aStrand;

  uniform float uTime;
  uniform float uStrands;
  uniform float uSpan;         // metres of path the braid reaches back over
  uniform float uLead;         // ... and how far past the head it runs
  uniform float uRadius;       // how far off the axis a strand bows, metres
  uniform float uFlatten;      // vertical component of that bow, x the lateral
  uniform float uCoil;         // turns one strand makes over the span
  uniform float uSpin;         // turns/second the braid rolls
  uniform float uBow;          // how sharply the strands converge at the ends
  uniform float uWander;       // noise off the braid, metres
  uniform float uWanderScale;
  uniform float uWanderSpeed;
  uniform float uWidth;        // half-width at its fattest, metres
  uniform float uWidthBow;     // how sharply it comes to a point at both ends
  uniform float uTwist;
  uniform float uTwistTurns;
  uniform float uTwistSpeed;
  uniform float uTwistFace;
  uniform float uFade;

  varying float vT;
  varying float vV;
  varying float vStrand;
  varying float vFacing;
  varying float vViewZ;

  ${noiseGLSL}
  ${TWILIGHT_SPINE_GLSL}

  /** Where this strand is at t. 0 is the leading tip, 1 the muzzle end. */
  vec3 wispAt(float t, float phase, float radius, float coil, float wander) {
    float s = max(uFront + uLead - t * uSpan, 0.0);

    vec3 tangent, side, up;
    twilightFrame(s, tangent, side, up);
    vec3 axis = twilightSpine(s);

    // Pinched to nothing at both ends: the braid leaves the muzzle as a point
    // and closes to a point at the tip. Anything that survives at t = 0 or 1
    // shows up on the sheet as a blunt end, and there are none.
    float profile = pow(sin(clamp(t, 0.0, 1.0) * PI), max(uBow, 0.05));

    float a = phase + t * coil * TAU - uTime * uSpin * TAU;
    // Flattened on purpose — see the header. A round orbit is a helix.
    vec3 offset = (side * cos(a) + up * sin(a) * uFlatten) * radius * profile;

    float n1 = snoise(vec3(t * uWanderScale, uTime * uWanderSpeed, phase * 3.1));
    float n2 = snoise(vec3(t * uWanderScale + 19.3, uTime * uWanderSpeed, phase * 3.1 + 7.7));
    offset += (side * n1 + up * n2) * uWander * profile;

    return axis + offset;
  }

  void main() {
    float strand = aStrand;
    float roll = hash11(strand * 4.11 + uSeed);
    float roll2 = hash11(strand * 8.37 + uSeed + 13.1);

    // Spread evenly around the axis and then jittered, and alternating in
    // handedness so neighbouring strands run *into* each other and cross.
    float phase = (strand / max(uStrands, 1.0)) * TAU + roll * 1.1 + uSeed;
    float handed = mod(strand, 2.0) < 1.0 ? 1.0 : -1.0;
    float radius = uRadius * (0.7 + roll * 0.7);
    // A wide spread on the per-strand turn count, not a tight one. Strands that
    // all make the same number of turns stay in formation however many they
    // make — they bow apart and rejoin together, and the braid reads as one
    // closed almond. Different turn counts is what makes them slide past each
    // other at different points along the span.
    float coil = uCoil * (0.6 + roll2 * 1.0) * handed;
    float wander = uWander;

    float t = clamp(position.x, 0.0, 1.0);
    const float H = 0.01;
    vec3 p0 = wispAt(t, phase, radius, coil, wander);
    vec3 p1 = wispAt(min(t + H, 1.0), phase, radius, coil, wander);
    vec3 tangent = normalize(p1 - p0 + 1e-6);

    /* --- the strip's own frame, twisting about that tangent --- */
    vec3 toEye = normalize(cameraPosition - p0);
    vec3 broad = cross(tangent, toEye);
    if (dot(broad, broad) < 1e-8) broad = vec3(0.0, 1.0, 0.0);
    broad = normalize(broad);
    vec3 edge = normalize(cross(tangent, broad));

    float tw = t * uTwistTurns * TAU + roll2 * 20.0 + uTime * uTwistSpeed * TAU;
    float c = cos(tw) * uTwist + (1.0 - uTwist);
    vec3 strip = broad * c + edge * (sin(tw) * uTwist);
    strip = mix(strip, broad, uTwistFace);

    // Same sin(πt) as the orbit, so a strand is thinnest exactly where it is
    // closest to its neighbours — the two profiles have to agree or the braid
    // ends in three fat stubs meeting at a point.
    float taper = pow(sin(clamp(t, 0.0, 1.0) * PI), max(uWidthBow, 0.05));
    float halfWidth = uWidth * taper * uFade * (0.65 + roll * 0.7);

    vec3 world = p0 + strip * (position.y * halfWidth);

    vT = t;
    vV = position.y;
    vStrand = strand;
    vFacing = clamp(abs(dot(strip, broad)), 0.0, 1.0);

    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const WISP_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSoft;         // falloff across the strip — low is wispy
  uniform float uCore;         // the hard thread down the middle
  uniform float uCoreWeight;
  uniform float uFiber;        // how hard the body breaks into fibres
  uniform float uFiberScale;
  uniform float uFiberSpeed;
  uniform float uPulse;        // charge running up it toward the tip
  uniform float uPulseFreq;
  uniform float uPulseSpeed;
  uniform float uHeadGlow;     // the leading tip runs hotter
  uniform float uIntensity;
  uniform float uOpacity;
  uniform float uSoftFade;
  uniform float uFade;
  uniform vec3  uColorCore;
  uniform vec3  uColorBody;
  uniform vec3  uColorTail;

  uniform sampler2D uSceneDepth;
  uniform vec2  uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uShaderIntensity;
  uniform float uGlobalGlow;

  varying float vT;
  varying float vV;
  varying float vStrand;
  varying float vFacing;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    /* across the strip: a broad soft body with a hard thread down it */
    float across = clamp(1.0 - abs(vV), 0.0, 1.0);
    float body = pow(across, max(uSoft, 0.05));
    float core = pow(across, max(uCore, 1.0));

    /* fibres travelling back down the wisp — see the header */
    float fiber = snoise01(vec3(vT * uFiberScale, vV * 1.7, uTime * uFiberSpeed + vStrand * 9.1));
    body *= mix(1.0, fiber * 1.35, uFiber);

    /* charge running up toward the tip */
    float phase = fract(vT * uPulseFreq - uTime * uPulseSpeed + vStrand * 0.37);
    float pulse = pow(1.0 - abs(phase * 2.0 - 1.0), 5.0) * uPulse;

    float energy = body * (1.0 + pulse) + core * uCoreWeight;
    // Edge-on the same energy crosses fewer pixels, so a strand reads as a
    // bright filament at exactly the moment it is narrowest.
    energy *= mix(1.35, 1.0, vFacing);
    // The leading end is where the beam is being made.
    energy *= 1.0 + uHeadGlow * pow(1.0 - vT, 3.0);

    if (energy < 0.002) discard;

    vec3 color = mix(uColorBody, uColorTail, smoothstep(0.45, 1.0, vT));
    color = mix(color, uColorCore, clamp(core * uCoreWeight + pulse * 0.6, 0.0, 1.0) * 0.55);
    color *= energy * uIntensity * uShaderIntensity;

    float alpha = clamp(energy, 0.0, 1.0) * uOpacity * uFade;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    color *= uGlobalGlow;
    // Rolled off hard: where three additive strips cross they stack, and the
    // braid has to stay *blue* through its own crossings. At 0.14 the first
    // render's beam went white down the middle and took the whole composite's
    // colour split with it.
    color /= 1.0 + color * 0.3;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * @param {object} spine shared uniform block from `createTwilightSpineUniforms()`
 * @returns {THREE.ShaderMaterial} with `userData.sync({ span, strands, fade })`
 */
export function createWispBeamMaterial(spine) {
  const material = new ShaderMaterial({
    name: 'WispBeam',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...spine,

      uStrands: { value: 3 },
      uSpan: { value: 12 },
      uLead: { value: 0.6 },
      uRadius: { value: 0.42 },
      uFlatten: { value: 0.4 },
      uCoil: { value: 0.62 },
      uSpin: { value: 0.18 },
      uBow: { value: 0.55 },
      uWander: { value: 0.13 },
      uWanderScale: { value: 2.4 },
      uWanderSpeed: { value: 0.7 },
      uWidth: { value: 0.16 },
      uWidthBow: { value: 0.75 },
      uTwist: { value: 0.8 },
      uTwistTurns: { value: 1.4 },
      uTwistSpeed: { value: 0.25 },
      uTwistFace: { value: 0.2 },
      uFade: { value: 1 },

      uSoft: { value: 1.5 },
      uCore: { value: 16 },
      uCoreWeight: { value: 0.85 },
      uFiber: { value: 0.55 },
      uFiberScale: { value: 5.5 },
      uFiberSpeed: { value: 1.5 },
      uPulse: { value: 0.9 },
      uPulseFreq: { value: 1.6 },
      uPulseSpeed: { value: 1.1 },
      uHeadGlow: { value: 0.8 },
      uIntensity: { value: 1.5 },
      uOpacity: { value: 0.85 },
      uSoftFade: { value: 0.3 },
      uColorCore: { value: new Color(0.92, 0.99, 1) },
      uColorBody: { value: new Color(0.36, 0.81, 1) },
      uColorTail: { value: new Color(0.07, 0.3, 0.68) }
    }),
    vertexShader: WISP_VERTEX,
    fragmentShader: WISP_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.twilight;
    const g = settings.global;
    const u = material.uniforms;

    u.uStrands.value = state.strands;
    u.uSpan.value = state.span;
    u.uFade.value = state.fade;

    u.uLead.value = c.wispLead;
    u.uRadius.value = c.wispRadius;
    u.uFlatten.value = c.wispFlatten;
    u.uCoil.value = c.wispCoil;
    u.uSpin.value = c.wispSpin * g.animationSpeed;
    u.uBow.value = c.wispBow;
    u.uWander.value = c.wispWander * g.noiseStrength;
    u.uWanderScale.value = c.wispWanderScale * g.noiseFrequency;
    u.uWanderSpeed.value = c.wispWanderSpeed * g.noiseSpeed;
    u.uWidth.value = c.wispWidth;
    u.uWidthBow.value = c.wispWidthBow;
    u.uTwist.value = c.wispTwist;
    u.uTwistTurns.value = c.wispTwistTurns;
    u.uTwistSpeed.value = c.wispTwistSpeed * g.animationSpeed;
    u.uTwistFace.value = c.wispTwistFace;

    u.uSoft.value = c.wispSoft;
    u.uCore.value = c.wispCore;
    u.uCoreWeight.value = c.wispCoreWeight;
    u.uFiber.value = c.wispFiber * g.randomness;
    u.uFiberScale.value = c.wispFiberScale * g.noiseFrequency;
    u.uFiberSpeed.value = c.wispFiberSpeed * g.noiseSpeed;
    u.uPulse.value = c.wispPulse;
    u.uPulseFreq.value = c.wispPulseFreq;
    u.uPulseSpeed.value = c.wispPulseSpeed * g.noiseSpeed;
    u.uHeadGlow.value = c.wispHeadGlow;
    u.uIntensity.value = c.wispIntensity;
    u.uOpacity.value = c.wispOpacity * g.opacity;
    u.uSoftFade.value = c.wispSoftFade;

    u.uColorCore.value.copy(getColor(c.colorWispCore));
    u.uColorBody.value.copy(getColor(c.colorWisp));
    u.uColorTail.value.copy(getColor(c.colorWispTail));
  };

  return material;
}
