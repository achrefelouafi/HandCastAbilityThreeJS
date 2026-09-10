import { Color, DoubleSide, NormalBlending, ShaderMaterial } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { TWILIGHT_SPINE_GLSL } from './TwilightSpine.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * THE BURNING TIP — the cone, cut into tongues.
 *
 * The reference's flame is cone *shaped* and it has a genuinely sharp point,
 * but it is not a cone. It is a **cluster**: six or eight separately tapered
 * tongues, each pointed, arranged so their envelope is a cone, with black
 * between them. Both halves of that matter and the layer has failed twice by
 * having only one of them:
 *
 *  - as a fan of additive strips alone it had no silhouette. Every strand is
 *    soft, they stack where they cross, bloom rounds off what survives, and the
 *    front of the shot came out as a warm smear. No amount of tuning gives an
 *    additive cloud an edge.
 *  - as a solid cone it had a silhouette and nothing else. Crisp, pointed, and
 *    completely dead — a machined dart. Fire is read off the gaps between its
 *    tongues as much as off the tongues.
 *
 * So: one cone surface, in parameter space against the flight path, **carved
 * into tongues along v**. That is the shape and the structure at once, and it
 * costs one draw call.
 *
 * The carve is not uniform along the length, and that detail is the whole
 * effect. `uSplitStart` is where the tongues begin to separate: ahead of it the
 * surface is continuous, so the apex is a solid point rather than a bundle of
 * needles meeting in mid-air; behind it the gaps open, the tongues take their
 * own lengths and their own curl, and the mouth is a ring of separate licks.
 * A flame that is one thing at its tip and many things at its base is exactly
 * what the sheet draws.
 *
 * Everything else follows from wanting the point to survive:
 *
 *  1. **the profile is concave.** `uFlare` above 1 grows the radius slower than
 *     linearly out of the apex — a needle, not a party hat.
 *  2. **the ripple is scaled by the radius**, so it dies away where the cone is
 *     thinnest. Noise applied evenly along the length chews the apex off, and
 *     once the apex is gone there is no tip.
 *  3. **the per-tongue curl is scaled by the split.** Adjacent tongues rotate
 *     by different amounts, which would tear the surface where they are still
 *     joined — so up at the apex, where they are joined, they all rotate
 *     together and there is nothing to tear.
 *  4. **the colour steps rather than blends.** The same posterisation the
 *     crystals use. A smooth ramp up a cone is an airbrushed cylinder.
 */

const CONE_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform float uLength;     // metres from the apex back to the mouth
  uniform float uRadius;     // the envelope radius at the mouth, metres
  uniform float uFlare;      // >1 concave and needle-like, 1 straight, <1 blunt
  uniform float uTongues;    // how many licks the cone is cut into
  uniform float uSplitStart; // where along the length they begin to separate
  uniform float uLengthVar;  // how unequal their reaches are
  uniform float uCurl;       // how far a tongue swings off its own spoke
  uniform float uCurlScale;
  uniform float uCurlSpeed;
  uniform float uSpread;     // how much a tongue leaves the envelope, x
  uniform float uRipple;     // how far the surface is pushed off a clean cone
  uniform float uRippleFreq;
  uniform float uRippleScale;
  uniform float uRippleSpeed;
  uniform float uBurst;      // the strike blowing the mouth open

  varying float vU;
  varying float vLocal;      // 0..1 across this tongue's own slot
  varying float vSplit;      // 0 joined at the apex, 1 fully separate
  varying float vReach;      // where this tongue ends, in u
  varying float vAng;
  varying vec3  vNormal;
  varying vec3  vWorld;
  varying float vViewZ;

  ${noiseGLSL}
  ${TWILIGHT_SPINE_GLSL}

  void main() {
    float u = clamp(position.x, 0.0, 1.0);
    float v = position.y;

    /* ---- which tongue, and where across it ---- */
    float slot = v * max(uTongues, 1.0);
    float tongueId = floor(slot);
    float local = fract(slot);
    float roll = hash11(tongueId * 7.31 + uSeed);
    float roll2 = hash11(tongueId * 3.17 + uSeed + 11.3);

    // Joined at the point, separate at the mouth. This one curve is what makes
    // the layer a flame rather than either a cone or a bundle of needles.
    float split = smoothstep(uSplitStart, 1.0, u);

    /* ---- the envelope ---- */
    float s = max(uFront - u * uLength, 0.0);

    vec3 tangent, side, up;
    twilightFrame(s, tangent, side, up);
    vec3 axis = twilightSpine(s);

    // Concave out of the apex. This exponent is the difference between a needle
    // and a party hat.
    float profile = pow(u, max(uFlare, 0.05));
    float r = uRadius * profile * (1.0 + uBurst);

    // Scaled by the profile on purpose: the ripple has to vanish where the cone
    // does, or it eats the point.
    float n = snoise(vec3(cos(v * TAU) * uRippleFreq, sin(v * TAU) * uRippleFreq,
                          u * uRippleScale + uTime * uRippleSpeed + uSeed));
    r *= 1.0 + n * uRipple * profile;

    // Tongues wander off the envelope once they are free of each other.
    r *= 1.0 + (roll2 - 0.5) * 2.0 * uSpread * split;

    /* ---- and the curl, only where they have separated ---- */
    // Neighbouring tongues turn by different amounts. Up at the apex they are
    // still one surface, so the curl is faded out there and there is no seam to
    // tear open.
    float wander = snoise(vec3(tongueId * 3.3, u * uCurlScale, uTime * uCurlSpeed + uSeed));
    float curl = ((roll - 0.5) * 1.4 + wander * 0.8) * uCurl * split;
    float ang = v * TAU + curl;

    vec3 radial = side * cos(ang) + up * sin(ang);
    vec3 world = axis + radial * r;

    // A cone's surface normal leans forward off the radial by its own slope.
    // Cheap, and it is what lets the fresnel term find the silhouette.
    vNormal = normalize(radial + tangent * (uRadius / max(uLength, 0.01)));
    vU = u;
    vLocal = local;
    vSplit = split;
    vReach = mix(1.0 - uLengthVar, 1.0, roll);
    vAng = ang;
    vWorld = world;

    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const CONE_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uBands;      // steps the length gradient is quantised into
  uniform float uPosterize;
  uniform float uTongueWidth; // fraction of a slot the tongue fills at the mouth
  uniform float uPoint;      // how far back a tongue starts coming to its point
  uniform float uRim;        // the silhouette term that draws the edge
  uniform float uRimPower;
  uniform float uApex;       // extra heat piled into the point
  uniform float uApexTight;
  uniform float uErode;      // how raggedly the tongues are eaten into
  uniform float uErodeFreq;
  uniform float uErodeScale;
  uniform float uErodeSpeed;
  uniform float uIntensity;
  uniform float uRolloff;
  uniform float uOpacity;
  uniform float uSoftFade;
  uniform float uFade;
  uniform vec3  uColorCore;  // white-hot, at the point
  uniform vec3  uColorHot;
  uniform vec3  uColorBody;
  uniform vec3  uColorBase;  // the ember the licks die at

  uniform sampler2D uSceneDepth;
  uniform vec2  uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uShaderIntensity;
  uniform float uGlobalGlow;

  varying float vU;
  varying float vLocal;
  varying float vSplit;
  varying float vReach;
  varying float vAng;
  varying vec3  vNormal;
  varying vec3  vWorld;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(cameraPosition - vWorld);

    /* ---- cut the cone into tongues ---- */
    // Across this tongue's own slot: 0 down its middle, 1 at the gap.
    float across = abs(vLocal * 2.0 - 1.0);

    // How much of the slot is filled. One at the apex, where the tongues are
    // still one surface, falling to uTongueWidth at the mouth — so the black
    // between the licks opens up as they separate.
    float fill = mix(1.0, uTongueWidth, vSplit);

    // ... and each tongue comes to its own point at its own reach.
    float endTaper = 1.0 - smoothstep(vReach - uPoint, vReach, vU);
    fill *= mix(1.0, endTaper, vSplit);
    fill = max(fill, 1e-4);

    float mask = 1.0 - smoothstep(fill * 0.62, fill, across);

    // Eaten into along its length, so the licks are ragged rather than milled.
    float n = snoise01(vec3(cos(vAng) * uErodeFreq, sin(vAng) * uErodeFreq,
                            vU * uErodeScale + uTime * uErodeSpeed));
    mask *= mix(1.0, smoothstep(0.18, 0.62, n + (1.0 - vSplit) * 0.5), uErode);

    if (mask < 0.02) discard;

    /* ---- the length gradient, in flat bands ---- */
    float steps = max(uBands, 1.0);
    float banded = floor(vU * steps + 0.5) / steps;
    float grade = mix(vU, banded, uPosterize);

    vec3 color = gradient4(uColorCore, uColorHot, uColorBody, uColorBase, grade);

    /* ---- the point runs hotter than anything else in the ability ---- */
    color += uColorCore * uApex * pow(1.0 - vU, max(uApexTight, 0.05));

    /* ---- the silhouette ---- */
    float f = 1.0 - clamp(dot(N, V), 0.0, 1.0);
    color += uColorHot * pow(f, max(uRimPower, 0.05)) * uRim;

    color *= uIntensity * uShaderIntensity;
    // Compressed like the crystal body, so the flame keeps its own colour
    // instead of blowing to white and losing its edges to bloom.
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
 * @param {object} spine shared uniform block from `createTwilightSpineUniforms()`
 * @returns {THREE.ShaderMaterial} with `userData.sync({ burst, fade })`
 */
export function createFlameConeMaterial(spine) {
  const material = new ShaderMaterial({
    name: 'FlameCone',
    transparent: true,
    // A solid, like the crystals: this layer exists to have an edge, and an
    // edge needs a depth write. Double-sided because once the cone is cut into
    // tongues you see the inside of the far ones through the gaps.
    depthWrite: true,
    depthTest: true,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...spine,

      uLength: { value: 4.5 },
      uRadius: { value: 0.62 },
      uFlare: { value: 1.7 },
      uTongues: { value: 8 },
      uSplitStart: { value: 0.22 },
      uLengthVar: { value: 0.35 },
      uCurl: { value: 0.22 },
      uCurlScale: { value: 2.2 },
      uCurlSpeed: { value: 1.4 },
      uSpread: { value: 0.22 },
      uRipple: { value: 0.12 },
      uRippleFreq: { value: 1.6 },
      uRippleScale: { value: 2.4 },
      uRippleSpeed: { value: 1.8 },
      uBurst: { value: 0 },
      uFade: { value: 1 },

      uBands: { value: 4 },
      uPosterize: { value: 0.8 },
      uTongueWidth: { value: 0.55 },
      uPoint: { value: 0.35 },
      uRim: { value: 0.6 },
      uRimPower: { value: 2.2 },
      uApex: { value: 0.45 },
      uApexTight: { value: 5 },
      uErode: { value: 0.45 },
      uErodeFreq: { value: 2.2 },
      uErodeScale: { value: 2.6 },
      uErodeSpeed: { value: 1.6 },
      uIntensity: { value: 1.7 },
      uRolloff: { value: 0.35 },
      uOpacity: { value: 1 },
      uSoftFade: { value: 0.25 },
      uColorCore: { value: new Color(1, 0.98, 0.91) },
      uColorHot: { value: new Color(1, 0.76, 0.23) },
      uColorBody: { value: new Color(1, 0.35, 0.03) },
      uColorBase: { value: new Color(0.48, 0.1, 0.01) }
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

    u.uLength.value = c.tipLength;
    u.uRadius.value = c.tipRadius;
    u.uFlare.value = c.tipFlare;
    u.uTongues.value = Math.max(1, Math.round(c.tipTongues));
    u.uSplitStart.value = c.tipSplitStart;
    u.uLengthVar.value = c.tipLengthVar * g.randomness;
    u.uCurl.value = c.tipCurl * g.noiseStrength;
    u.uCurlScale.value = c.tipCurlScale * g.noiseFrequency;
    u.uCurlSpeed.value = c.tipCurlSpeed * g.noiseSpeed;
    u.uSpread.value = c.tipSpread;
    u.uRipple.value = c.tipRipple * g.noiseStrength;
    u.uRippleFreq.value = c.tipRippleFreq * g.noiseFrequency;
    u.uRippleScale.value = c.tipRippleScale * g.noiseFrequency;
    u.uRippleSpeed.value = c.tipRippleSpeed * g.noiseSpeed;

    u.uBands.value = c.tipBands;
    u.uPosterize.value = c.tipPosterize;
    u.uTongueWidth.value = c.tipTongueWidth;
    u.uPoint.value = c.tipPoint;
    u.uRim.value = c.tipRim * g.fresnel;
    u.uRimPower.value = c.tipRimPower;
    u.uApex.value = c.tipApex;
    u.uApexTight.value = c.tipApexTight;
    u.uErode.value = c.tipErode * g.turbulence;
    u.uErodeFreq.value = c.tipErodeFreq * g.noiseFrequency;
    u.uErodeScale.value = c.tipErodeScale * g.noiseFrequency;
    u.uErodeSpeed.value = c.tipErodeSpeed * g.noiseSpeed;
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
