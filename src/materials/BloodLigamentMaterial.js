import { Color, DoubleSide, NormalBlending, ShaderMaterial } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { FLUX_SPINE_GLSL } from './FluxSpine.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * THE FLUID BLOOD SPLATTER — layer 2 of the breakdown, the half that is matter.
 *
 * The panel is not a spray of red dots. It is *liquid*: fat beads dragging
 * filaments behind them, the filaments necking, thinning and finally pinching
 * off into more beads. That behaviour has a name — the Plateau–Rayleigh
 * instability — and it is the only reason a splatter reads as blood rather than
 * as confetti. So the layer is built in two halves that hand off to each other:
 * these **ligaments**, which are mesh, and the droplet particles the ability
 * throws from their ends as they break.
 *
 * Every ligament is one instance of the standard bolt strip, and the whole
 * splatter is one draw call. The strand's life is a *pure function of time*:
 *
 *   - `cycle` is its own clock, out of phase with every other strand, so the
 *     head throws fluid continuously instead of in frames;
 *   - `floor(cycle)` is which throw this is, and re-rolls the direction — a
 *     strand that always flew the same way would read as a fixed spike;
 *   - `fract(cycle)` is how long ago it left, which gives the two things that
 *     make it liquid: where the head *was* when it tore free (`uFront` minus
 *     the distance travelled since), and how far it has stretched.
 *
 * The stretch is the load-bearing detail. Every point along the strand is
 * thrown at a slightly different speed — the trailing end slower by `uNeck` —
 * so the ligament is a point at birth and metres long a moment later, exactly
 * as a real one is drawn out of a moving mass. The beading rides on top of that
 * and deepens as it goes, so the strand visibly *pinches* before it dies.
 *
 * Non-additive, and that is the whole argument for this layer existing: blood
 * is opaque. It has to occlude the ribbons behind it, take the key light on a
 * wet highlight and go dark in its own shadow. Add it in and it stops being
 * matter and joins the glow.
 */

const LIGAMENT_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  attribute float aStrand;

  uniform float uTime;
  uniform float uSpeed;        // how fast the head is travelling, m/s
  uniform float uRate;         // throws per second, per strand
  uniform float uLife;         // seconds one ligament lasts
  uniform float uThrow;        // how hard the fluid is thrown, m/s
  uniform float uAxial;        // along the path: negative throws it backwards
  uniform float uSpread;       // how far off the axis
  uniform float uCarry;        // fraction of the head's own speed it keeps
  uniform float uRootSpread;   // metres back along the trail a strand may tear from
  uniform float uGravity;
  uniform float uNeck;         // how much slower the trailing end is — the stretch
  uniform float uCurl;         // how far the strand bows as it flies
  uniform float uWidth;
  uniform float uTaper;
  uniform float uBeads;
  uniform float uBeadFreq;
  uniform float uNeckDepth;    // how far it thins before it breaks
  uniform float uFade;

  varying float vT;
  varying float vV;
  varying float vThin;         // 0 where the strand has pinched, 1 where it is full
  varying vec3  vSideView;
  varying float vViewZ;
  varying float vSeed;

  ${noiseGLSL}
  ${FLUX_SPINE_GLSL}

  /* --- what this strand rolled, and when --- */
  float gPhase, gFlight, gV0, gDead;
  vec3 gRoot, gTangent, gOut, gBow;

  void rollStrand() {
    float roll = hash11(aStrand * 7.13 + uSeed);
    float roll2 = hash11(aStrand * 3.71 + uSeed + 11.3);

    float cycle = uTime * max(uRate, 0.01) * (0.65 + 0.7 * roll) + roll2;
    gPhase = fract(cycle);
    float shot = floor(cycle);

    // Re-rolled per throw, so a strand does not fly the same way twice.
    float d1 = hash11(shot * 13.7 + aStrand * 3.1 + uSeed);
    float d2 = hash11(shot * 7.31 + aStrand * 9.7 + uSeed + 5.0);
    float d3 = hash11(shot * 4.93 + aStrand * 17.3 + uSeed + 19.0);
    float d4 = hash11(shot * 9.17 + aStrand * 23.1 + uSeed + 37.0);

    gFlight = gPhase * max(uLife, 0.02);
    // Where the head was when this fluid tore off it — and how far back down the
    // trail it tore from. Without that second term every strand roots at the
    // same point and the splatter opens into a sea anemone: ten equal spikes
    // radiating off one centre, which is the one silhouette blood never makes.
    float s0 = uFront - uSpeed * gFlight - d4 * uRootSpread;
    gDead = s0 < 0.0 ? 1.0 : 0.0;
    s0 = max(s0, 0.0);

    vec3 side, up;
    fluxFrame(s0, gTangent, side, up);
    gRoot = fluxSpine(s0);

    float a = d1 * TAU;
    vec3 radial = side * cos(a) + up * sin(a);
    gOut = normalize(radial * uSpread * (0.4 + 0.9 * d2) + gTangent * uAxial + 1e-5);
    // The plane it bows in — perpendicular-ish to the throw, so the strand
    // curves rather than flying as a needle.
    gBow = normalize(cross(gOut, side + up * 0.5) + 1e-5) * (0.5 + d3);
    gV0 = uThrow * (0.5 + 1.0 * d3);
    vSeed = d1;
  }

  /** A point along the strand. t = 0 is the free end, t = 1 the trailing tip. */
  vec3 strandAt(float t) {
    // The trailing end is thrown slower than the leading one, which is the
    // whole reason a ligament stretches instead of translating.
    float speed = gV0 * (1.0 - uNeck * t);
    vec3 p = gRoot + gOut * (speed * gFlight) + gTangent * (uCarry * uSpeed * gFlight);
    p += gBow * uCurl * t * t * gFlight;
    p.y -= 0.5 * uGravity * gFlight * gFlight;
    return p;
  }

  void main() {
    rollStrand();

    float t = clamp(position.x, 0.0, 1.0);
    const float H = 0.02;
    vec3 p0 = strandAt(t);
    vec3 p1 = strandAt(min(t + H, 1.0));
    vec3 tangent = normalize(p1 - p0 + 1e-6);

    vec3 toEye = normalize(cameraPosition - p0);
    vec3 side = cross(tangent, toEye);
    if (dot(side, side) < 1e-8) side = gTangent;
    side = normalize(side);

    /* --- how thick the fluid is here --- */
    float grow = smoothstep(0.0, 0.10, gPhase);                 // it forms
    float die = 1.0 - smoothstep(0.62, 1.0, gPhase);            // and it breaks
    float necking = 1.0 - uNeckDepth * smoothstep(0.10, 1.0, gPhase);
    float beads = 1.0 + uBeads * sin(t * uBeadFreq * TAU + vSeed * 11.0)
                        * smoothstep(0.20, 0.85, gPhase);
    float body = pow(1.0 - t, max(uTaper, 0.05));
    float cap = sqrt(smoothstep(0.0, 0.09, t));                 // round the free end
    float thin = body * cap * beads * necking;

    float halfWidth = uWidth * thin * grow * die * uFade * (1.0 - gDead);

    vec3 world = p0 + side * (position.y * halfWidth);

    vT = t;
    vV = position.y;
    vThin = clamp(thin, 0.0, 1.4);
    vSideView = normalize((viewMatrix * vec4(side, 0.0)).xyz);

    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const LIGAMENT_FRAGMENT = /* glsl */ `
  uniform float uGloss;
  uniform float uSheen;
  uniform float uRim;
  uniform float uOpacity;
  uniform float uSoftFade;
  uniform float uFade;
  uniform vec3  uColorDeep;
  uniform vec3  uColorBlood;
  uniform vec3  uColorSheen;
  uniform vec3  uColorRim;
  uniform vec3  uLightDir;

  uniform sampler2D uSceneDepth;
  uniform vec2  uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uShaderIntensity;

  varying float vT;
  varying float vV;
  varying float vThin;
  varying vec3  vSideView;
  varying float vViewZ;
  varying float vSeed;

  ${commonGLSL}

  void main() {
    float across = clamp(1.0 - abs(vV), 0.0, 1.0);
    if (across <= 0.001) discard;

    // The strand is shaded as a *cylinder*, not as a flat strip: the fake
    // normal sweeps from one silhouette edge, through the eye, to the other.
    // That is what puts a highlight down the middle of it and darkness at both
    // edges, which is the entire difference between a wet rope and a red line.
    float z = sqrt(across);
    vec3 n = normalize(vSideView * vV + vec3(0.0, 0.0, 1.0) * z);
    vec3 L = normalize((viewMatrix * vec4(uLightDir, 0.0)).xyz);
    vec3 eye = vec3(0.0, 0.0, 1.0);

    float wrap = clamp(dot(n, L) * 0.5 + 0.5, 0.0, 1.0);
    vec3 halfway = normalize(L + eye);
    float spec = pow(clamp(dot(n, halfway), 0.0, 1.0), max(uGloss, 1.0));
    // The limb, where the surface turns away — a hard edge is what makes it
    // read as liquid rather than as smoke.
    float limb = pow(1.0 - clamp(n.z, 0.0, 1.0), 3.0);

    vec3 color = mix(uColorDeep, uColorBlood, wrap * wrap);
    // Blood is thin where it has necked, and thin blood is lit *through*.
    color += uColorRim * limb * uRim * (1.0 + (1.0 - clamp(vThin, 0.0, 1.0)) * 1.6);
    color += uColorSheen * spec * uSheen;
    color *= uShaderIntensity;

    // Crisp silhouette. Surface tension does not do soft edges.
    float alpha = smoothstep(0.0, 0.11, across) * uOpacity * uFade;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * @param {object} spine shared uniform block from `createFluxSpineUniforms()`
 * @returns {THREE.ShaderMaterial} with `userData.sync({ speed, burst, fade })`
 */
export function createBloodLigamentMaterial(spine) {
  const material = new ShaderMaterial({
    name: 'BloodLigament',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...spine,

      uSpeed: { value: 20 },
      uRate: { value: 2.6 },
      uLife: { value: 0.5 },
      uThrow: { value: 3.4 },
      uAxial: { value: -0.45 },
      uSpread: { value: 1 },
      uCarry: { value: 0.35 },
      uRootSpread: { value: 2.2 },
      uGravity: { value: 7 },
      uNeck: { value: 0.55 },
      uCurl: { value: 1.1 },
      uWidth: { value: 0.075 },
      uTaper: { value: 1.5 },
      uBeads: { value: 0.55 },
      uBeadFreq: { value: 3 },
      uNeckDepth: { value: 0.7 },
      uFade: { value: 1 },

      uGloss: { value: 26 },
      uSheen: { value: 0.9 },
      uRim: { value: 0.55 },
      uOpacity: { value: 1 },
      uSoftFade: { value: 0.25 },
      uColorDeep: { value: new Color(0.09, 0.005, 0.02) },
      uColorBlood: { value: new Color(0.55, 0.02, 0.06) },
      uColorSheen: { value: new Color(1, 0.72, 0.75) },
      uColorRim: { value: new Color(1, 0.13, 0.2) }
    }),
    vertexShader: LIGAMENT_VERTEX,
    fragmentShader: LIGAMENT_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.flux;
    const g = settings.global;
    const u = material.uniforms;

    u.uSpeed.value = state.speed;
    u.uFade.value = state.fade;

    // On the strike the splatter stops being shed sideways off something
    // passing and is thrown *forward*, off something that stopped.
    u.uAxial.value = -c.bloodBack + (c.bloodBack + c.bloodForward) * state.burst;
    u.uThrow.value = c.bloodThrow * (1 + state.burst * c.bloodBurstThrow) * g.particleSpeed;
    u.uRate.value = c.bloodRate * g.emissionRate;
    u.uLife.value = c.bloodLife * g.particleLifetime;
    u.uSpread.value = c.bloodSpread;
    u.uCarry.value = c.bloodCarry;
    u.uRootSpread.value = c.bloodRootSpread;
    u.uGravity.value = c.bloodGravity;
    u.uNeck.value = c.bloodNeck;
    u.uCurl.value = c.bloodCurl * g.randomness;
    u.uWidth.value = c.bloodWidth * g.particleSize;
    u.uTaper.value = c.bloodTaper;
    u.uBeads.value = c.bloodBeads;
    u.uBeadFreq.value = c.bloodBeadFreq;
    u.uNeckDepth.value = c.bloodNeckDepth;

    u.uGloss.value = c.bloodGloss;
    u.uSheen.value = c.bloodSheen;
    u.uRim.value = c.bloodRim;
    u.uOpacity.value = c.bloodOpacity * g.opacity;
    u.uSoftFade.value = c.bloodSoftFade;

    u.uColorDeep.value.copy(getColor(c.colorBloodDeep));
    u.uColorBlood.value.copy(getColor(c.colorBlood));
    u.uColorSheen.value.copy(getColor(c.colorBloodSheen));
    u.uColorRim.value.copy(getColor(c.colorBloodRim));
  };

  return material;
}
