import { DoubleSide, NormalBlending, ShaderMaterial, Vector3 } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';

/**
 * THE DISTORTION WAVE — layer 5 of the breakdown.
 *
 * Nothing here is drawn. The mesh lives on `LAYER.DISTORTION`, is invisible to
 * the main pass, and writes screen-space refraction offsets into the buffer
 * that `postprocessing/DistortionShader.js` warps the finished frame by:
 *
 *   R,G → offset encoded around 0.5   B → strength   A → coverage
 *
 * The panel shows one smooth dark lens with a wave running through it, so this
 * writes exactly three things and no heat shimmer:
 *
 *  1. **the lens.** A broad bulb riding the head that displaces the frame along
 *     the *direction of travel* — the air is being shouldered aside by
 *     something going somewhere, and a radial smear would say the opposite.
 *  2. **the churn.** Two channels of noise inside that bulb, so the lens boils
 *     rather than sliding, which is the only part of this ability where the
 *     word *chaos* is doing literal work.
 *  3. **the waves.** Ring packets shed off the head at a fixed rate and
 *     displaced *radially*, so the frame is stretched away from the projectile
 *     along the wavefront. On the strike one much larger packet is fired the
 *     same way.
 *
 * Camera-facing, because a flat proxy seen edge-on writes nothing at all and
 * the distortion would vanish as the camera orbits past the flight line.
 */

const WARP_VERTEX = /* glsl */ `
  uniform float uWidth;
  uniform float uHeight;
  uniform vec3  uDir;

  varying vec2 vUv;
  varying vec2 vDirView;

  void main() {
    vUv = uv;

    // Which way "forward" is on screen. Flat across the quad, which is right —
    // the whole proxy is displacing one way.
    vec2 dv = (viewMatrix * vec4(uDir, 0.0)).xy;
    vDirView = length(dv) > 1e-4 ? normalize(dv) : vec2(0.0, 1.0);

    // The quad's own basis is discarded; its corners are laid out in view space
    // around the object's origin.
    vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mv.xy += position.xy * vec2(uWidth, uHeight);
    gl_Position = projectionMatrix * mv;
  }
`;

const WARP_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSeed;
  uniform float uLens;
  uniform float uLensPower;
  uniform float uChurn;
  uniform float uScale;
  uniform float uSpeed;
  uniform float uWave;
  uniform float uWaveRate;
  uniform float uWaveWidth;
  uniform float uRipples;
  uniform float uBurst;        // 0..1 — how much of the strike's wave is left
  uniform float uBurstFront;   // 0..1 — where that wave has got to
  uniform float uBurstWidth;
  uniform float uStrength;
  uniform float uFade;
  uniform float uShaderIntensity;

  varying vec2 vUv;
  varying vec2 vDirView;

  ${noiseGLSL}

  void main() {
    vec2 c = (vUv - 0.5) * 2.0;
    float d = length(c);
    if (d > 1.0) discard;
    // Feathered, or the proxy's own border shows up in the frame as a seam.
    float edge = 1.0 - smoothstep(0.72, 1.0, d);

    /* --- the lens the head drags with it --- */
    float lens = pow(1.0 - smoothstep(0.0, 0.78, d), max(uLensPower, 0.2)) * uLens;

    /* --- boiling inside it --- */
    float n1 = snoise(vec3(c * uScale, uTime * uSpeed + uSeed));
    float n2 = snoise(vec3(c * uScale + 19.3, uTime * uSpeed + uSeed + 7.7));

    /* --- the wave packets it sheds --- */
    float front = fract(uTime * uWaveRate + uSeed);
    float dd = d - front;
    float ring = exp(-(dd * dd) / max(1e-4, uWaveWidth * uWaveWidth));
    // Energy over a growing circumference: a wave loses its punch as it spreads.
    float waveAmp = uWave * ring * (1.0 - front);

    /* --- and the one the strike fires --- */
    float bd = d - uBurstFront;
    float burstAmp = uBurst * exp(-(bd * bd) / max(1e-4, uBurstWidth * uBurstWidth));

    float bands = sin(dd * uRipples);
    float burstBands = sin(bd * uRipples * 0.7);
    vec2 radial = d > 1e-4 ? c / d : vec2(0.0, 1.0);

    vec2 offset = vDirView * lens
                + vec2(n1, n2) * uChurn * lens
                + radial * (bands * waveAmp + burstBands * burstAmp);
    offset = clamp(offset, vec2(-1.0), vec2(1.0));

    float mask = clamp(lens + waveAmp + burstAmp, 0.0, 1.0) * edge * uFade;
    if (mask < 0.003) discard;

    gl_FragColor = vec4(offset * 0.5 + 0.5, uStrength * uShaderIntensity, mask);
  }
`;

/**
 * @returns {THREE.ShaderMaterial} with `userData.sync(state)`, where state is
 *   `{ dir, size, burst, burstFront, fade }`
 */
export function createFluxWarpMaterial() {
  const material = new ShaderMaterial({
    name: 'FluxWarp',
    transparent: true,
    depthWrite: false,
    // Off, like every other distortion proxy: the buffer is a full-screen
    // instruction to the composer, not a thing standing in the world.
    depthTest: false,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uWidth: { value: 4 },
      uHeight: { value: 4 },
      uDir: { value: new Vector3(0, 0, 1) },
      uSeed: { value: 0 },
      uLens: { value: 0.8 },
      uLensPower: { value: 1.6 },
      uChurn: { value: 0.55 },
      uScale: { value: 1.7 },
      uSpeed: { value: 1.4 },
      uWave: { value: 0.7 },
      uWaveRate: { value: 1.6 },
      uWaveWidth: { value: 0.16 },
      uRipples: { value: 9 },
      uBurst: { value: 0 },
      uBurstFront: { value: 0 },
      uBurstWidth: { value: 0.22 },
      uStrength: { value: 1 },
      uFade: { value: 1 }
    }),
    vertexShader: WARP_VERTEX,
    fragmentShader: WARP_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.flux;
    const g = settings.global;
    const u = material.uniforms;

    u.uDir.value.copy(state.dir);
    u.uWidth.value = state.size;
    u.uHeight.value = state.size;
    u.uSeed.value = state.seed;
    u.uBurst.value = state.burst;
    u.uBurstFront.value = state.burstFront;
    u.uFade.value = state.fade;

    u.uLens.value = c.warpLens;
    u.uLensPower.value = c.warpLensPower;
    u.uChurn.value = c.warpChurn * g.noiseStrength;
    u.uScale.value = c.warpScale * g.noiseFrequency;
    u.uSpeed.value = c.warpSpeed * g.noiseSpeed;
    u.uWave.value = c.warpWave;
    u.uWaveRate.value = c.warpWaveRate * g.animationSpeed;
    u.uWaveWidth.value = c.warpWaveWidth;
    u.uRipples.value = c.warpRipples;
    u.uBurstWidth.value = c.warpBurstWidth;
    u.uStrength.value = c.warpStrength * g.distortion;
  };

  return material;
}
