import { Color, DoubleSide, NormalBlending, ShaderMaterial } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * The radial water splash — layer 3 of the Corrupted Shard Spawn.
 *
 * A **lathe whose whole shape lives in the vertex stage**: the mesh handed to
 * it is a bare unit cylinder (radius 1, y from 0 to 1) and every metre of the
 * crown is built here from `settings.shard`, so the footprint slider re-cuts a
 * crown that is already in the air and the buffer is never rebuilt.
 *
 * The sheet's third panel is a *dark* crown — indigo water thrown up by the
 * crystals breaking the floor, lit only at its edges. It is on screen for
 * about a second, so the whole material is organised around the two things
 * that read in that second:
 *
 *  - the **silhouette** — a rim scalloped into fingers by ridged noise (not a
 *    cosine: a periodic scallop is a saw blade at any count), fingers that
 *    lean outward as they fall, a crest torn into spray by a dissolve that
 *    climbs with height and with the fall;
 *  - the **edge light** — a sheet of water is nearly invisible through its
 *    middle and bright at its boundary, so the alpha and the colour are both
 *    weighted onto the fresnel rim, the torn edges and the crest, and the body
 *    is left dark and thin.
 *
 * Two clocks from the ability: `uRise` (0 → 1, the crown standing up) and
 * `uFall` (0 → 1, it leaning out and falling away). Alpha blended, both faces:
 * the inside of the far wall is most of what the camera sees of a crown.
 */

const SPLASH_VERTEX = /* glsl */ `
  #define STAU 6.283185307179586

  uniform float uTime;
  uniform float uRadius;
  uniform float uHeight;
  uniform float uRise;
  uniform float uFall;
  uniform float uFingers;
  uniform float uFingerDepth;
  uniform float uFlare;
  uniform float uLean;
  uniform float uCurl;
  uniform float uWobble;
  uniform float uWobbleScale;
  uniform float uSeed;

  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vUp;
  varying float vBearing;
  varying float vFinger;
  varying float vViewZ;

  ${noiseGLSL}

  void main() {
    float a = atan(position.z, position.x);
    float v = uv.y;

    vec2 ring = vec2(cos(a), sin(a));
    float wander = snoise(vec3(ring * uWobbleScale, uSeed));

    // The scallops: ridged noise, so their spacing, width and height all vary
    // on their own. 0.16 is 1/(2 pi), so the count means what it says.
    float n1 = snoise(vec3(ring * uFingers * 0.16, uSeed + 3.0));
    float n2 = snoise(vec3(ring * uFingers * 0.41, uSeed * 3.0 + 7.0));
    float finger = 1.0 - abs(n1 * 0.68 + n2 * 0.32 + wander * 0.12);
    finger = pow(clamp(finger, 0.0, 1.0), 2.4);

    // How tall this finger stands. The fall drops the wall between the fingers
    // first, so the crown ends as a ring of falling spikes rather than sinking
    // as one sheet.
    float depth = mix(1.0 - uFingerDepth, 1.0, finger);
    float h = uHeight * depth * uRise * (1.0 - uFall * uFall * mix(0.7, 0.35, finger));

    // The radius and its slope. The lean grows with the fall: a crown
    // collapses by falling away from its own axis, not by shrinking.
    float base = uRadius * (1.0 + uWobble * wander);
    float lean = uFlare + uLean * uFall;
    float r = base * (1.0 + lean * v) - uCurl * base * v * v * (1.0 - uFall);
    float dr = base * lean - 2.0 * uCurl * base * v * (1.0 - uFall);

    vec3 world = vec3(ring.x * r, h * v, ring.y * r);
    // Outward normal of a lathe with radius r(v) and height h: the cross of
    // the two surface tangents.
    vec3 nrm = normalize(vec3(ring.x * h, -dr, ring.y * h) + vec3(0.0, 1e-4, 0.0));

    vec4 worldPos = modelMatrix * vec4(world, 1.0);
    vec4 viewPos = viewMatrix * worldPos;

    vUp = v;
    vBearing = a;
    vFinger = finger;
    vNormalW = normalize(mat3(modelMatrix) * nrm);
    vViewDir = cameraPosition - worldPos.xyz;
    vViewZ = viewPos.z;

    gl_Position = projectionMatrix * viewPos;
  }
`;

const SPLASH_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uRise;
  uniform float uFall;
  uniform float uTear;
  uniform float uFresnel;
  uniform float uFade;
  uniform float uOpacity;
  uniform float uGlow;
  uniform float uSoftFade;
  uniform float uSeed;
  uniform vec3  uColorWater;
  uniform vec3  uColorDeep;
  uniform vec3  uColorRim;
  uniform vec3  uColorCrest;

  uniform vec3  uLightDir;
  uniform vec2  uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uGlobalGlow;

  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vUp;
  varying float vBearing;
  varying float vFinger;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    vec3 N = normalize(vNormalW);
    vec3 V = normalize(vViewDir);
    vec3 L = normalize(uLightDir);

    // Sampled on the bearing and the height, so the tear is welded to the wall.
    vec2 ring = vec2(cos(vBearing), sin(vBearing));
    float sheet = snoise01(vec3(ring * 3.2, vUp * 1.9 - uTime * 0.5 + uSeed));
    sheet = sheet * 0.66 + snoise01(vec3(ring * 9.5, vUp * 5.5 - uTime * 1.1 + uSeed)) * 0.34;

    /* ---- the crest is torn, not cut ---- */
    // The threshold climbs with height and with the fall, so the wall goes to
    // spray from the tips down as it collapses.
    // Torn from low down: the sheet throws *jets*, not a bowl, so most of the
    // wall between the fingers has to be spray rather than sheet.
    float tearAt = smoothstep(0.12, 0.95, vUp) * (0.5 + uTear * 0.6) - 0.05 + uFall * 0.45;
    float body = smoothstep(tearAt, tearAt + 0.26, sheet);
    if (body < 0.01) discard;

    // The bright rim along every torn edge: the one term that makes a sheet
    // read as water rather than as a cut-out.
    float edge = clamp(body - smoothstep(tearAt + 0.07, tearAt + 0.34, sheet), 0.0, 1.0);

    /* ---- shading ---- */
    float lambert = clamp(dot(N, L), 0.0, 1.0);
    float rim = fresnelTerm(V, N, 2.2, uFresnel);
    vec3 H = normalize(L + V);
    float spec = pow(clamp(dot(N, H), 0.0, 1.0), 70.0);

    // The crest: only the last of the wall, on the fingers, broken by the tear.
    float crest = smoothstep(0.7, 1.0, vUp) * (0.25 + vFinger * 0.75) * smoothstep(0.35, 0.9, sheet);

    // Thin at the tips, deep at the foot — water gets its form from thickness.
    vec3 color = mix(uColorDeep, uColorWater, 0.2 + vUp * 0.6);
    color *= mix(0.45, 1.1, lambert);
    color += uColorRim * rim * 0.35;
    color = mix(color, uColorCrest, clamp(crest + edge * 0.7, 0.0, 1.0));
    color += uColorCrest * spec * (0.25 + crest);

    // Weighted onto the edges rather than onto the sheet.
    float alpha = body * (0.2 + rim * 0.3 + crest * 0.7 + edge * 0.85);
    // Faded into the floor at its foot, so the near wall does not draw a hard
    // scalloped band across the rune.
    alpha *= smoothstep(0.0, 0.18, vUp);
    alpha *= uRise * (1.0 - uFall * uFall * 0.85) * uFade * uOpacity;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.006) discard;

    color *= uGlow * uGlobalGlow;
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
  }
`;

export function createShardSplashMaterial() {
  const material = new ShaderMaterial({
    name: 'ShardSplash',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      uRadius: { value: 1.8 },
      uHeight: { value: 1.5 },
      uRise: { value: 0 },
      uFall: { value: 0 },
      uFingers: { value: 24 },
      uFingerDepth: { value: 0.72 },
      uFlare: { value: 0.3 },
      uLean: { value: 1.1 },
      uCurl: { value: 0.18 },
      uWobble: { value: 0.08 },
      uWobbleScale: { value: 2.2 },
      uTear: { value: 0.4 },
      uFresnel: { value: 1.7 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uGlow: { value: 1 },
      uSoftFade: { value: 0.5 },
      uSeed: { value: 0 },
      uColorWater: { value: new Color() },
      uColorDeep: { value: new Color() },
      uColorRim: { value: new Color() },
      uColorCrest: { value: new Color() }
    }),
    vertexShader: SPLASH_VERTEX,
    fragmentShader: SPLASH_FRAGMENT
  });

  /** @param {object} state { radius, rise, fall, fade, seed } */
  material.userData.sync = (state) => {
    const c = settings.shard;
    const g = settings.global;
    const u = material.uniforms;

    u.uRadius.value = state.radius;
    u.uRise.value = state.rise;
    u.uFall.value = state.fall;
    u.uFade.value = state.fade;
    u.uSeed.value = state.seed;

    u.uHeight.value = c.splashHeight;
    u.uFingers.value = c.splashFingers;
    u.uFingerDepth.value = c.splashFingerDepth;
    u.uFlare.value = c.splashFlare;
    u.uLean.value = c.splashLean;
    u.uCurl.value = c.splashCurl;
    u.uWobble.value = c.splashWobble * g.noiseStrength;
    u.uWobbleScale.value = c.splashWobbleScale * g.noiseFrequency;
    u.uTear.value = c.splashTear;
    u.uFresnel.value = c.splashFresnel * g.fresnel;
    u.uOpacity.value = c.splashOpacity * g.opacity;
    u.uGlow.value = c.splashGlow * g.glow;

    u.uColorWater.value.copy(getColor(c.colorWater));
    u.uColorDeep.value.copy(getColor(c.colorWaterDeep));
    u.uColorRim.value.copy(getColor(c.colorWaterRim));
    u.uColorCrest.value.copy(getColor(c.colorWaterCrest));
  };

  return material;
}
