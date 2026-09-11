import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  NormalBlending,
  ShaderMaterial,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { patchOnBeforeCompile, replaceChunk } from '../utils/shaderPatch.js';

/**
 * Every shader the Drone brings with it, in one place.
 *
 * The airframe itself is the modeller's — a textured PBR body that keeps its
 * own material and gets the sun like anything else on the stage. What is built
 * here is everything *around* it that turns a model hovering in the air into a
 * weapon on station:
 *
 *   - the **range ring** on the floor, which is the one thing a target has to
 *     be able to read: inside it, you are on the list;
 *   - the **searchlight**, a cone of light that stands under the drone while
 *     it loiters and swings onto whatever it is about to shoot;
 *   - the **lock reticle**, brackets that close on a body over the lock time;
 *   - the **rotor blur** discs, because a blade turning twenty times a second
 *     at sixty frames does not read as spinning — it reads as stuck at random
 *     angles. A translucent disc with streaks travelling round it is what a
 *     camera sees, and what an audience expects;
 *   - the **nav lights** at each rotor, with a strobe, because the smallest
 *     blinking light is what says *aircraft* at fifteen metres;
 *   - and a **patch on the body material** for the reveal: the drone is not
 *     dropped in, it is *printed* — a scan plane climbs the airframe with a hot
 *     edge and the metal appears under it. Recall runs it backwards.
 */

/* ---------------------------------------------------------------------- */
/* The range ring                                                           */
/* ---------------------------------------------------------------------- */

const RING_VERTEX = /* glsl */ `
  uniform float uQuadSize;
  varying vec2 vP;
  void main() {
    // Off the uv, not the position: the quad is rotated flat, so its local
    // y is zero everywhere and only the uv still spans the plane.
    vP = (uv - 0.5) * uQuadSize;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RING_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586
  uniform float uTime;
  uniform float uRadius;
  uniform float uWidth;
  uniform float uGlow;
  uniform float uSoftness;
  uniform float uFill;
  uniform float uTicks;
  uniform float uTickLength;
  uniform float uTickWidth;
  uniform float uTickSpin;
  uniform float uSweep;
  uniform float uSweepSpeed;
  uniform float uPulse;
  uniform float uHot;
  uniform float uReveal;
  uniform float uOpacity;
  uniform float uGlobalGlow;
  uniform vec3 uColor;
  uniform vec3 uColorHot;
  varying vec2 vP;

  void main() {
    float r = length(vP);
    float R = max(0.05, uRadius) * uReveal;
    float a01 = atan(vP.y, vP.x) / TAU + 0.5;
    float inside = 1.0 - smoothstep(R - uSoftness, R, r);

    // The boundary: a band with a soft outside and a hard inside.
    float hw = uWidth * 0.5;
    float band = 1.0 - smoothstep(hw, hw + uSoftness, abs(r - R));

    // Marks stepping round the outside of it. Faster when the drone is hot,
    // which is the tell that it has gone from watching to hunting.
    float spin = uTickSpin * (1.0 + 2.0 * uHot);
    float tickBand = smoothstep(R + hw, R + hw + uSoftness, r)
                   * (1.0 - smoothstep(R + hw + uTickLength, R + hw + uTickLength + uSoftness, r));
    float tick = step(1.0 - uTickWidth, fract(a01 * uTicks + uTime * spin));

    // The radar sweep. Its trailing edge is the long fade.
    float sw = fract(a01 - uTime * uSweepSpeed * (1.0 + 1.5 * uHot));
    float sweep = pow(1.0 - sw, 7.0) * uSweep * inside;

    // A faint wash crowded to the rim, so the middle stays clear for the fight.
    float fill = uFill * pow(clamp(r / R, 0.0, 1.0), 3.0) * inside;

    // Contraction rings while hot: they run inward, to the drone.
    float pt = fract(uTime * 1.1);
    float pr = (1.0 - pt) * R;
    float pulse = (1.0 - smoothstep(0.0, 0.18, abs(r - pr))) * uHot * uPulse * (1.0 - pt) * inside;

    // Crosshair at the centre — where the drone is standing.
    float cross = (1.0 - smoothstep(0.0, 0.05, min(abs(vP.x), abs(vP.y)))) * (1.0 - smoothstep(0.35, 0.6, r)) * 0.6;

    vec3 col = mix(uColor, uColorHot, uHot);
    float alpha = band * uGlow + tickBand * tick * 0.85 + sweep + fill + pulse + cross;
    alpha *= uReveal;
    gl_FragColor = vec4(col * alpha * uGlobalGlow, alpha * uOpacity);
  }
`;

export function createDroneRingMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uQuadSize: { value: 20 },
      uRadius: { value: 7 },
      uWidth: { value: 0.22 },
      uGlow: { value: 1.6 },
      uSoftness: { value: 0.06 },
      uFill: { value: 0.12 },
      uTicks: { value: 36 },
      uTickLength: { value: 0.35 },
      uTickWidth: { value: 0.22 },
      uTickSpin: { value: 0.04 },
      uSweep: { value: 0.5 },
      uSweepSpeed: { value: 0.35 },
      uPulse: { value: 0.8 },
      uHot: { value: 0 },
      uReveal: { value: 0 },
      uOpacity: { value: 1 },
      uColor: { value: new Color('#5fd0ff') },
      uColorHot: { value: new Color('#ff3b2f') }
    }),
    vertexShader: RING_VERTEX,
    fragmentShader: RING_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false
  });
}

/* ---------------------------------------------------------------------- */
/* The pool of light the searchlight throws on the floor                    */
/* ---------------------------------------------------------------------- */

const SPOT_VERTEX = /* glsl */ `
  varying vec2 vUv2;
  void main() {
    vUv2 = (uv - 0.5) * 2.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SPOT_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uIntensity;
  uniform float uHot;
  uniform float uOpacity;
  uniform float uGlobalGlow;
  uniform vec3 uColor;
  uniform vec3 uColorHot;
  varying vec2 vUv2;
  ${noiseGLSL}
  void main() {
    float r = length(vUv2);
    float disc = pow(1.0 - smoothstep(0.0, 1.0, r), 1.6);
    // The floor is stone; the light lands on it unevenly.
    float grain = 0.85 + 0.15 * snoise(vec3(vUv2 * 3.0, uTime * 0.2));
    float a = disc * grain * uIntensity;
    vec3 col = mix(uColor, uColorHot, uHot);
    gl_FragColor = vec4(col * a * uGlobalGlow, a * uOpacity);
  }
`;

export function createDroneSpotMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uIntensity: { value: 0.6 },
      uHot: { value: 0 },
      uOpacity: { value: 1 },
      uColor: { value: new Color('#bfe9ff') },
      uColorHot: { value: new Color('#ff5a3c') }
    }),
    vertexShader: SPOT_VERTEX,
    fragmentShader: SPOT_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false
  });
}

/* ---------------------------------------------------------------------- */
/* The searchlight                                                          */
/* ---------------------------------------------------------------------- */

/**
 * A unit cone along +Z: apex at the origin, rim of radius 1 at z = 1.
 *
 * Built by hand rather than from CylinderGeometry so the varyings are the
 * ones the shader wants: v runs 0 at the apex to 1 at the rim, the normal is
 * radial so the silhouette can be found in the fragment stage.
 */
export function createBeamGeometry(segments = 48) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const index = [];

  // Apex ring (all at the origin, one per segment so each has its own normal).
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    positions.push(0, 0, 0);
    normals.push(Math.cos(a), Math.sin(a), 0);
    uvs.push(i / segments, 0);
  }
  for (let i = 0; i <= segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    positions.push(Math.cos(a), Math.sin(a), 1);
    normals.push(Math.cos(a), Math.sin(a), 0);
    uvs.push(i / segments, 1);
  }
  for (let i = 0; i < segments; i++) {
    const a = i;
    const b = i + 1;
    const c = segments + 1 + i;
    const d = segments + 1 + i + 1;
    index.push(a, c, b, b, c, d);
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();
  return geometry;
}

const BEAM_VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalV;
  void main() {
    vUv = uv;
    // The cone is scaled non-uniformly (radius, radius, length), so the normal
    // has to go through the normal matrix or the silhouette drifts.
    vNormalV = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const BEAM_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586
  uniform float uTime;
  uniform float uIntensity;
  uniform float uEdge;
  uniform float uFalloff;
  uniform float uNoise;
  uniform float uNoiseScale;
  uniform float uHot;
  uniform float uOpacity;
  uniform float uGlobalGlow;
  uniform vec3 uColor;
  uniform vec3 uColorHot;
  varying vec2 vUv;
  varying vec3 vNormalV;
  ${noiseGLSL}
  void main() {
    // Thickest where the cone faces the camera, gone at its silhouette — which
    // is what a lit volume looks like from outside.
    float facing = abs(dot(normalize(vNormalV), vec3(0.0, 0.0, 1.0)));
    float body = pow(facing, uEdge);
    float along = pow(1.0 - vUv.y, uFalloff);
    // Dust in the beam, drifting down it.
    float n = 1.0 - uNoise * snoise01(vec3(cos(vUv.x * TAU) * uNoiseScale, sin(vUv.x * TAU) * uNoiseScale, vUv.y * 4.0 - uTime * 0.7));
    // A soft landing on the floor rather than a hard rim.
    float end = 1.0 - smoothstep(0.82, 1.0, vUv.y);
    float a = body * along * n * end * uIntensity;
    vec3 col = mix(uColor, uColorHot, uHot);
    gl_FragColor = vec4(col * a * uGlobalGlow, a * uOpacity);
  }
`;

export function createDroneBeamMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uIntensity: { value: 0.35 },
      uEdge: { value: 1.6 },
      uFalloff: { value: 0.6 },
      uNoise: { value: 0.35 },
      uNoiseScale: { value: 2.0 },
      uHot: { value: 0 },
      uOpacity: { value: 1 },
      uColor: { value: new Color('#bfe9ff') },
      uColorHot: { value: new Color('#ff5a3c') }
    }),
    vertexShader: BEAM_VERTEX,
    fragmentShader: BEAM_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false
  });
}

/* ---------------------------------------------------------------------- */
/* The lock reticle                                                         */
/* ---------------------------------------------------------------------- */

const RETICLE_VERTEX = /* glsl */ `
  varying vec2 vP;
  void main() {
    vP = (uv - 0.5) * 2.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RETICLE_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586
  uniform float uTime;
  uniform float uLock;
  uniform float uIntensity;
  uniform float uOpacity;
  uniform float uGlobalGlow;
  uniform vec3 uColor;
  uniform vec3 uColorLocked;
  varying vec2 vP;

  float ring(float r, float R, float w) { return 1.0 - smoothstep(w, w + 0.02, abs(r - R)); }

  void main() {
    float r = length(vP);
    float lock = clamp(uLock, 0.0, 1.0);
    float ang = atan(vP.y, vP.x);

    // The outer ring shrinks onto the body as the lock builds.
    float R = mix(0.95, 0.55, lock);
    float outer = ring(r, R, 0.012);

    // Four brackets, turning while they hunt, still once they have it.
    float turn = uTime * 1.2 * (1.0 - lock);
    float sector = abs(fract((ang + turn) / TAU * 4.0 + 0.5) - 0.5) * 2.0; // 0 at each bracket centre
    float bracket = ring(r, R + 0.08, 0.02) * step(sector, 0.35);

    // Ticks at the cardinal points inside the ring.
    float sector2 = abs(fract((ang) / TAU * 4.0) - 0.5) * 2.0;
    float tick = (1.0 - smoothstep(0.0, 0.03, abs(r - (R - 0.12)) - 0.06)) * step(0.97, sector2) * lock;

    // The dot in the middle only lands with the lock.
    float dot_ = (1.0 - smoothstep(0.0, 0.05, r)) * smoothstep(0.85, 1.0, lock);
    // And it flashes when it does.
    float flash = smoothstep(0.98, 1.0, lock) * (0.6 + 0.4 * sin(uTime * 22.0));

    vec3 col = mix(uColor, uColorLocked, lock);
    float a = (outer + bracket + tick + dot_ * 2.0) * (1.0 + flash) * uIntensity;
    gl_FragColor = vec4(col * a * uGlobalGlow, a * uOpacity);
  }
`;

export function createDroneReticleMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uLock: { value: 0 },
      uIntensity: { value: 1.6 },
      uOpacity: { value: 1 },
      uColor: { value: new Color('#ffc46a') },
      uColorLocked: { value: new Color('#ff3b2f') }
    }),
    vertexShader: RETICLE_VERTEX,
    fragmentShader: RETICLE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false
  });
}

/* ---------------------------------------------------------------------- */
/* The rotor blur                                                           */
/* ---------------------------------------------------------------------- */

const ROTOR_VERTEX = /* glsl */ `
  varying vec2 vP;
  void main() {
    vP = (uv - 0.5) * 2.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const ROTOR_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uBlur;
  uniform float uSpin;
  uniform float uBlades;
  uniform float uOpacity;
  varying vec2 vP;
  void main() {
    float r = length(vP);
    if (r > 1.0) discard;
    float ang = atan(vP.y, vP.x);
    // The hub is solid metal underneath, so the disc starts a little way out.
    float radial = smoothstep(0.12, 0.35, r) * (1.0 - smoothstep(0.92, 1.0, r));
    // Streaks going round: the eye sees the blades as a smear with structure.
    float streak = 0.5 + 0.5 * sin(ang * uBlades * 2.0 + uTime * uSpin * 6.2831 * 0.37);
    // A pale haze rather than a dark one: against this sky a dark disc is
    // invisible, and a spinning rotor on camera reads as a grey smear anyway.
    float a = uBlur * radial * (0.22 + 0.16 * streak);
    // A bright rim where the tips catch the light.
    float rim = (1.0 - smoothstep(0.0, 0.06, abs(r - 0.93))) * 0.3 * uBlur;
    vec3 col = mix(vec3(0.42, 0.47, 0.55), vec3(0.85, 0.9, 1.0), rim);
    gl_FragColor = vec4(col, (a + rim) * uOpacity);
  }
`;

export function createRotorBlurMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uBlur: { value: 0 },
      uSpin: { value: 0 },
      uBlades: { value: 2 },
      uOpacity: { value: 1 }
    }),
    vertexShader: ROTOR_VERTEX,
    fragmentShader: ROTOR_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: NormalBlending,
    side: DoubleSide,
    toneMapped: false
  });
}

/* ---------------------------------------------------------------------- */
/* The nav lights                                                           */
/* ---------------------------------------------------------------------- */

const NAV_VERTEX = /* glsl */ `
  attribute vec3 aColor;
  attribute float aPhase;
  attribute float aStrobe;
  uniform float uTime;
  uniform float uSize;
  uniform float uStrobeRate;
  uniform vec2 uResolution;
  varying vec3 vColor;
  varying float vBlink;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float blink = aStrobe > 0.5
      ? step(0.92, fract(uTime * uStrobeRate + aPhase)) * 1.6
      : 0.7 + 0.3 * sin(uTime * 2.6 + aPhase * 6.2831);
    vBlink = blink;
    vColor = aColor;
    gl_PointSize = uSize * (1.0 + 0.8 * blink * aStrobe) * uResolution.y / max(0.5, -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const NAV_FRAGMENT = /* glsl */ `
  uniform float uIntensity;
  uniform float uGlobalGlow;
  varying vec3 vColor;
  varying float vBlink;
  void main() {
    float d = length(gl_PointCoord - 0.5) * 2.0;
    float core = pow(clamp(1.0 - d, 0.0, 1.0), 2.4);
    float a = core * vBlink * uIntensity;
    gl_FragColor = vec4(vColor * a * uGlobalGlow + core * 0.6 * vBlink, a);
  }
`;

export function createNavLightsMaterial() {
  return new ShaderMaterial({
    uniforms: sharedUniforms({
      uSize: { value: 0.12 },
      uStrobeRate: { value: 1.3 },
      uIntensity: { value: 1 }
    }),
    vertexShader: NAV_VERTEX,
    fragmentShader: NAV_FRAGMENT,
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    toneMapped: false
  });
}

/* ---------------------------------------------------------------------- */
/* The reveal, on the modeller's own material                               */
/* ---------------------------------------------------------------------- */

/**
 * Print the airframe in from the bottom up.
 *
 * Injected into the glTF's standard material rather than replacing it, so the
 * textures, the sun and the environment all stay exactly as authored. Three
 * things are added:
 *
 *   - a **scan plane** at world height `uRevealY`: everything above it is
 *     discarded, everything within `uRevealWidth` under it is driven to a hot
 *     emissive so the edge reads as the thing being built;
 *   - a **screen-door** just above the plane, so the edge is a fizz of pixels
 *     rather than a ruler line;
 *   - a **rim**, because the export is dark metal and the stage is dark: a
 *     cool fresnel is the one thing that keeps the silhouette legible against
 *     the backdrop at fifteen metres, and the dummies do the same thing.
 *
 * The uniforms are attached to the material as `userData.droneUniforms` so the
 * ability can drive them without going through three's compile step.
 */
export function patchDroneBody(material) {
  const uniforms = {
    uRevealY: { value: 1e4 },
    uRevealWidth: { value: 0.08 },
    uRevealColor: { value: new Color('#7fe0ff') },
    uRevealGlow: { value: 6 },
    uRimColor: { value: new Color('#6fd2ff') },
    uRimStrength: { value: 0.35 },
    uRimPower: { value: 2.8 }
  };
  material.userData.droneUniforms = uniforms;

  patchOnBeforeCompile(
    material,
    (shader) => {
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = replaceChunk(
        shader.vertexShader,
        '#include <common>',
        /* glsl */ `
          #include <common>
          varying vec3 vDroneWorld;
        `
      );
      shader.vertexShader = replaceChunk(
        shader.vertexShader,
        '#include <worldpos_vertex>',
        /* glsl */ `
          #include <worldpos_vertex>
          vDroneWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        `
      );

      shader.fragmentShader = replaceChunk(
        shader.fragmentShader,
        '#include <common>',
        /* glsl */ `
          #include <common>
          uniform float uRevealY;
          uniform float uRevealWidth;
          uniform vec3 uRevealColor;
          uniform float uRevealGlow;
          uniform vec3 uRimColor;
          uniform float uRimStrength;
          uniform float uRimPower;
          varying vec3 vDroneWorld;
          float droneHash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        `
      );
      // As early as the chunk list allows, so a discarded fragment costs no
      // lighting.
      shader.fragmentShader = replaceChunk(
        shader.fragmentShader,
        '#include <clipping_planes_fragment>',
        /* glsl */ `
          #include <clipping_planes_fragment>
          float droneAbove = vDroneWorld.y - uRevealY;
          // The fizz: a band above the plane where pixels are printed at random.
          float droneFizz = droneHash(floor(gl_FragCoord.xy * 0.5)) * uRevealWidth * 1.5;
          if (droneAbove > droneFizz) discard;
        `
      );
      shader.fragmentShader = replaceChunk(
        shader.fragmentShader,
        '#include <emissivemap_fragment>',
        /* glsl */ `
          #include <emissivemap_fragment>
          {
            // Hot just under the plane, and on the fizzing pixels above it.
            float edge = 1.0 - smoothstep(0.0, uRevealWidth, abs(droneAbove));
            edge = max(edge, step(0.0, droneAbove));
            float rim = pow(1.0 - clamp(dot(normalize(vNormal), normalize(vViewPosition)), 0.0, 1.0), uRimPower);
            totalEmissiveRadiance += uRevealColor * edge * uRevealGlow;
            totalEmissiveRadiance += uRimColor * rim * uRimStrength;
          }
        `
      );
    },
    'drone-body'
  );

  return material;
}

/** The unit vectors the beam and the reticle are oriented with. */
export const DRONE_FORWARD = new Vector3(0, 0, 1);
