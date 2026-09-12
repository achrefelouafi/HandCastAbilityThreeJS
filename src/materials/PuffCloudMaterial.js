import {
  AddEquation,
  BackSide,
  Color,
  CustomBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate } from '../utils/math.js';

/**
 * A raymarched volume of puffs — the cloud the Glacial Prison's cold mist and
 * the Toxic Shield's miasma are both drawn with.
 *
 * The ability lays out up to CLOUD_MAX_PUFFS spheres each frame — where they
 * are, how big, how strong — and the shader does the rest. The field is the
 * soft union of the spheres eroded by three octaves of rising value noise,
 * which turns a handful of balls into a cauliflower, and it is *lit*: the
 * union's own gradient stands in for a surface normal, so every puff has a
 * sunlit top and a shaded underside; a second, noise-free probe toward the
 * sun through the same union shadows the puffs under other puffs; and a point
 * of light under the cloud lights it from below.
 */

export const CLOUD_MAX_PUFFS = 16;

const HULL_VERTEX = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

/** Clip the march against the opaque scene. */
const SCENE_CLIP_GLSL = /* glsl */ `
  uniform vec2 uResolution;
  uniform sampler2D uSceneDepth;
  uniform float uCameraNear;
  uniform float uCameraFar;

  float sceneReach(vec3 rd) {
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    float packed = unpackRGBAToDepth(texture2D(uSceneDepth, screenUV));
    float sceneViewZ = perspectiveDepthToViewZ(packed, uCameraNear, uCameraFar);
    float dzdt = (viewMatrix * vec4(rd, 0.0)).z;
    return dzdt < -1e-5 ? sceneViewZ / dzdt : 1e6;
  }
`;

const CLOUD_FRAGMENT = /* glsl */ `
  #define MAX_PUFFS ${CLOUD_MAX_PUFFS}

  uniform float uTime;
  uniform vec4  uPuffs[MAX_PUFFS];
  uniform vec4  uPuffData[MAX_PUFFS];
  uniform float uCount;
  uniform vec3  uBoundCenter;
  uniform float uBoundRadius;
  uniform float uSeed;
  uniform float uNoiseScale;
  uniform float uRise;
  uniform float uDetail;
  uniform float uErode;
  uniform float uSoftness;
  uniform float uDensity;
  uniform float uExtinction;
  uniform float uSteps;
  uniform float uShadow;
  uniform float uShadowStep;
  uniform float uFade;
  uniform float uOpacity;
  uniform float uGlobalGlow;
  uniform vec3  uAlbedo;
  uniform vec3  uSunColor;
  uniform float uSunStrength;
  uniform vec3  uSkyColor;
  uniform float uSkyStrength;
  uniform vec3  uFirePos;
  uniform vec3  uFireColor;
  uniform float uFireGlow;
  uniform float uFireFalloff;
  uniform vec3  uLightDir;

  varying vec3 vWorld;

  ${noiseGLSL}
  ${commonGLSL}
  ${SCENE_CLIP_GLSL}

  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash13(i);
    float b = hash13(i + vec3(1.0, 0.0, 0.0));
    float c = hash13(i + vec3(0.0, 1.0, 0.0));
    float d = hash13(i + vec3(1.0, 1.0, 0.0));
    float e = hash13(i + vec3(0.0, 0.0, 1.0));
    float g = hash13(i + vec3(1.0, 0.0, 1.0));
    float h = hash13(i + vec3(0.0, 1.0, 1.0));
    float k = hash13(i + vec3(1.0, 1.0, 1.0));
    return mix(
      mix(mix(a, b, f.x), mix(c, d, f.x), f.y),
      mix(mix(e, g, f.x), mix(h, k, f.x), f.y),
      f.z
    );
  }

  /* The soft union of the puffs, and its gradient. */
  float blob(vec3 p, out vec3 grad, out float seed) {
    float sum = 0.0;
    float wsum = 0.0;
    grad = vec3(0.0);
    seed = 0.0;
    for (int i = 0; i < MAX_PUFFS; i++) {
      if (float(i) >= uCount) break;
      vec4 pf = uPuffs[i];
      vec3 rel = (p - pf.xyz) / max(pf.w, 1e-3);
      float d2 = dot(rel, rel);
      if (d2 < 1.0) {
        float k = 1.0 - d2;
        k = k * k * uPuffData[i].x;
        sum += k;
        grad += rel * k;
        seed += uPuffData[i].y * k;
        wsum += k;
      }
    }
    seed = wsum > 1e-4 ? seed / wsum : 0.0;
    return sum;
  }

  float blobOnly(vec3 p) {
    float sum = 0.0;
    for (int i = 0; i < MAX_PUFFS; i++) {
      if (float(i) >= uCount) break;
      vec4 pf = uPuffs[i];
      vec3 rel = (p - pf.xyz) / max(pf.w, 1e-3);
      float d2 = dot(rel, rel);
      if (d2 < 1.0) {
        float k = 1.0 - d2;
        sum += k * k * uPuffData[i].x;
      }
    }
    return sum;
  }

  float cloudSample(vec3 p, out vec3 normal, out float shadow, out float bump) {
    normal = vec3(0.0, 1.0, 0.0);
    shadow = 1.0;
    bump = 0.5;
    vec3 g;
    float seed;
    float b = blob(p, g, seed);
    if (b < 0.02) return 0.0;

    // Three octaves, drifting up: the detail rises through the puffs.
    vec3 np = p * uNoiseScale + vec3(seed * 7.0, -uTime * uRise + seed * 3.0, uSeed);
    float n = vnoise(np) * 0.5 + vnoise(np * 2.13 + 3.7) * 0.3 + vnoise(np * 4.31 + 9.1) * 0.2;
    float field = b - uErode + (n - 0.5) * uDetail;
    float d = smoothstep(0.0, clamp(uSoftness, 0.05, 2.0), field);
    if (d <= 0.0) return 0.0;

    normal = normalize(g + vec3(0.0, 1e-4, 0.0));
    bump = n;
    // How much cloud stands between here and the sun.
    shadow = exp(-blobOnly(p + uLightDir * uShadowStep) * uShadow);
    return d * uDensity;
  }

  vec3 shade(vec3 p, vec3 n, float shadow, float bump) {
    float sun = max(dot(n, uLightDir), 0.0) * shadow * (0.55 + 0.7 * bump);
    float sky = (0.55 + 0.45 * n.y) * (0.7 + 0.3 * bump);
    vec3 toFire = uFirePos - p;
    float df = length(toFire);
    float fire = max(dot(n, toFire / max(df, 1e-3)), 0.0) * uFireGlow / (1.0 + df * df * uFireFalloff);
    return uAlbedo * (uSunColor * sun * uSunStrength + uSkyColor * sky * uSkyStrength + uFireColor * fire);
  }

  void main() {
    vec3 ro = cameraPosition;
    vec3 rd = normalize(vWorld - ro);

    vec3 oc = ro - uBoundCenter;
    float b = dot(oc, rd);
    float c = dot(oc, oc) - uBoundRadius * uBoundRadius;
    float disc = b * b - c;
    if (disc < 0.0) discard;
    float sq = sqrt(disc);
    float tScene = sceneReach(rd);
    float t0 = max(-b - sq, 0.02);
    float t1 = min(-b + sq, tScene);
    if (t1 <= t0) discard;

    float steps = clamp(uSteps, 6.0, 48.0);
    float baseStep = (t1 - t0) / steps;
    float t = t0 + baseStep * hash13(vec3(gl_FragCoord.xy, fract(uTime) * 64.0));

    vec3 acc = vec3(0.0);
    float transmittance = 1.0;
    float stride = 1.0;
    for (int i = 0; i < 48; i++) {
      if (t >= t1 || transmittance < 0.015) break;
      vec3 n;
      float shadow;
      float bump;
      vec3 p = ro + rd * t;
      float dens = cloudSample(p, n, shadow, bump);
      float stepSize = baseStep * stride;
      if (dens > 0.002) {
        stride = 1.0;
        stepSize = baseStep;
        dens *= clamp((tScene - t) / 0.5, 0.0, 1.0);
        vec3 col = shade(p, n, shadow, bump);
        acc += col * dens * transmittance * stepSize;
        transmittance *= exp(-dens * uExtinction * stepSize);
      } else {
        stride = min(stride * 1.5, 2.5);
      }
      t += stepSize;
    }

    float alpha = clamp((1.0 - transmittance) * uOpacity, 0.0, 1.0) * uFade;
    vec3 color = acc * uOpacity * uFade * uGlobalGlow;
    if (alpha < 0.002) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

export function createCloudMaterial() {
  // The vec4 arrays are flat Float32Arrays the ability writes straight into:
  // three uploads a typed array as one block, so a puff costs no objects.
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uPuffs: { value: new Float32Array(CLOUD_MAX_PUFFS * 4) },
      uPuffData: { value: new Float32Array(CLOUD_MAX_PUFFS * 4) },
      uCount: { value: 0 },
      uBoundCenter: { value: new Vector3() },
      uBoundRadius: { value: 1 },
      uSeed: { value: Math.random() * 10 },
      uNoiseScale: { value: 1.1 },
      uRise: { value: 0.6 },
      uDetail: { value: 0.9 },
      uErode: { value: 0.35 },
      uSoftness: { value: 0.35 },
      uDensity: { value: 1.6 },
      uExtinction: { value: 2.4 },
      uSteps: { value: 22 },
      uShadow: { value: 1.4 },
      uShadowStep: { value: 0.7 },
      uFade: { value: 1 },
      uOpacity: { value: 1 },
      uAlbedo: { value: new Color(0.9, 0.9, 0.9) },
      uSunColor: { value: new Color(1, 0.95, 0.85) },
      uSunStrength: { value: 1.6 },
      uSkyColor: { value: new Color(0.55, 0.62, 0.75) },
      uSkyStrength: { value: 0.6 },
      uFirePos: { value: new Vector3() },
      uFireColor: { value: new Color(1, 0.45, 0.1) },
      uFireGlow: { value: 12 },
      uFireFalloff: { value: 0.12 }
    }),
    vertexShader: HULL_VERTEX,
    fragmentShader: CLOUD_FRAGMENT,
    side: BackSide,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    blendSrcAlpha: OneFactor,
    blendDstAlpha: OneMinusSrcAlphaFactor,
    toneMapped: false
  });
}

/** Push the cloud's shared look from settings. `c` is the cloud's own sub-block. */
export function syncCloud(material, c, g, fade) {
  const u = material.uniforms;
  u.uNoiseScale.value = c.noiseScale * g.noiseFrequency;
  u.uRise.value = c.rise * g.noiseSpeed;
  u.uDetail.value = c.detail * g.noiseStrength;
  u.uErode.value = c.erode;
  u.uSoftness.value = c.softness;
  u.uDensity.value = c.density;
  u.uExtinction.value = c.extinction;
  u.uSteps.value = c.steps;
  u.uShadow.value = c.shadow;
  u.uShadowStep.value = c.shadowStep;
  u.uFade.value = fade;
  u.uOpacity.value = c.opacity * g.opacity;
  u.uAlbedo.value.copy(getColor(c.colorAlbedo));
  u.uSunColor.value.copy(getColor(settings.environment.sunColor));
  u.uSunStrength.value = c.sun * saturate(settings.environment.sunIntensity / 3);
  u.uSkyColor.value.copy(getColor(c.colorSky));
  u.uSkyStrength.value = c.sky;
  u.uFireGlow.value = c.fireGlow * g.glow;
  u.uFireFalloff.value = c.fireFalloff;
  u.uGlobalGlow.value = 1;
}
