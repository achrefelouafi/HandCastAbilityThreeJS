import {
  AddEquation,
  AdditiveBlending,
  Color,
  CustomBlending,
  DoubleSide,
  FrontSide,
  NormalBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  ShaderMaterial,
  Vector3
} from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { VOID_SPINE_GLSL } from './VoidSpine.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * LINEAR VOID SLASH — the six layers of the breakdown, one material each.
 *
 * The sheet names six things and this file draws six things:
 *
 *  1. **the shadow core beam** — two draws. The *lance*: a pointed envelope
 *     shingled with flakes of black glass, packed tight at the point and
 *     lifting off toward the rear until they come away. It is a solid, it
 *     writes depth, and it has a silhouette — which is the one thing an
 *     additive beam can never have, and the reason the front of the shot
 *     reads as a *point*. Down its axis the *beam*: a white-violet filament
 *     with a few tight satellites winding around it, pinched to nothing at
 *     the point and thinning away behind the lance.
 *  2. **the particle debris** — the same flakes, loosed. Struck off the rear
 *     of the lance, keeping most of the head's speed as a slip back down the
 *     spine, tumbling out on a drag curve, a few of them still carrying the
 *     void's light inside the glass.
 *  3. **the shadow ribbon trails** — broad translucent silks wound about the
 *     wake, opening wider the further back they get. They are *shadow*: drawn
 *     premultiplied-over, so their bodies darken what is behind them and only
 *     their hems and their pulses add light.
 *  4. **the energy sparks** — four-rayed points of white-violet light: a trail
 *     shed off the lance, a shell thrown on the strike, and one large glare
 *     pinned to the point that is the brightest thing in the ability.
 *  5. **the distortion wave** — nothing drawn. A proxy on the distortion layer
 *     that lenses the frame along the heading and *swirls* it about the head,
 *     with wave packets shed off it and one big one fired on the strike.
 *  6. **the lingering shadow motes** — the layer still on screen when the rest
 *     has gone: soft puffs of violet smoke laid down where the lance passed and
 *     left there, thinning from their edges in, with a few bright motes
 *     drifting up through them.
 *
 * Every placement here is a pure function of the instance index, the clock,
 * how far the head has flown and `settings.voidslash` — the ice wake's trick
 * of the line casts, applied to a whole ability. There is no
 * particle system, no history buffer and nothing written per frame beyond
 * uniforms, which is what lets every slider in the editor re-fly a cast that
 * is already in the air, paused included.
 *
 * The lance and the debris share one shading chunk (`OBSIDIAN_GLSL`): flat,
 * posterised facets off a camera-relative key, a violet rim on the silhouette,
 * a glass highlight, and a screen-space hairline along every facet edge. Same
 * glass, so they are tuned from one folder.
 */

/* ------------------------------------------------------------------ */
/* shared                                                              */
/* ------------------------------------------------------------------ */

/** Rodrigues, as a matrix. */
const ROTATION_GLSL = /* glsl */ `
#ifndef VOID_ROTATION_INCLUDED
#define VOID_ROTATION_INCLUDED
mat3 rotationAbout(vec3 axis, float angle) {
  float s = sin(angle);
  float c = cos(angle);
  float t = 1.0 - c;
  return mat3(
    t * axis.x * axis.x + c,          t * axis.x * axis.y + s * axis.z, t * axis.x * axis.z - s * axis.y,
    t * axis.x * axis.y - s * axis.z, t * axis.y * axis.y + c,          t * axis.y * axis.z + s * axis.x,
    t * axis.x * axis.z + s * axis.y, t * axis.y * axis.z - s * axis.x, t * axis.z * axis.z + c
  );
}
#endif
`;

/**
 * How a flake of black glass is lit. Included by the lance and the debris.
 *
 * Declares its own uniforms; a material that includes it must carry them, and
 * `syncObsidian` writes them from the shared obsidian block of the settings.
 * Needs the shared uLightDir and the builtin viewMatrix.
 */
const OBSIDIAN_GLSL = /* glsl */ `
#ifndef VOID_OBSIDIAN_INCLUDED
#define VOID_OBSIDIAN_INCLUDED
uniform float uBands;        // steps the diffuse term is quantised into
uniform float uPosterize;    // how far toward those steps it is pushed
uniform float uScreenKey;    // how far the key swings from the sun to the camera
uniform float uAmbient;
uniform float uRim;          // the violet on the silhouette
uniform float uRimPower;
uniform float uEdge;         // the hairline along every facet boundary
uniform float uEdgeWidth;    // ... in pixels
uniform float uSpecular;     // obsidian is glass: one tight highlight
uniform float uGloss;
uniform vec3  uColorDeep;    // the facet turned away from the key
uniform vec3  uColorBody;
uniform vec3  uColorLit;     // ... and the one facing it
uniform vec3  uColorEdge;    // the rim and the hairline
uniform vec3  uLightDir;     // shared: toward the sun

/**
 * The body of a flake, before any emissive term. Writes the hairline weight
 * into edge so the caller can add it after its own roll-off.
 */
vec3 obsidianBody(vec3 N, vec3 V, vec3 bary, out float edge) {
  vec3 L = normalize(uLightDir);
  // Keyed from the upper left in screen space, like the ice: a flake is thin
  // and its two faces sit nearly parallel, so under the scene's sun alone both
  // land on one posterised band and the chip draws as a flat paper cut-out.
  vec3 camRight = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
  vec3 camUp = normalize(vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]));
  vec3 screenKey = normalize(-camRight * 0.55 + camUp * 0.72 + V * 0.4);
  vec3 K = normalize(mix(L, screenKey, clamp(uScreenKey, 0.0, 1.0)));

  float lambert = dot(N, K) * 0.5 + 0.5;
  float steps = max(uBands, 1.0);
  float banded = floor(lambert * steps + 0.5) / steps;
  float lit = mix(lambert, banded, uPosterize);

  // Stops placed between the quantised levels, not across them.
  vec3 color = mix(uColorDeep, uColorBody, smoothstep(0.34, 0.66, lit));
  color = mix(color, uColorLit, smoothstep(0.68, 0.99, lit));
  color += uColorDeep * uAmbient;

  float facing = clamp(dot(N, V), 0.0, 1.0);
  color += uColorEdge * pow(1.0 - facing, max(uRimPower, 0.05)) * uRim;

  vec3 H = normalize(K + V);
  color += vec3(0.85, 0.75, 1.0) * pow(clamp(dot(N, H), 0.0, 1.0), max(uGloss, 1.0)) * uSpecular;

  // Constant width in pixels, whatever the distance. This is why it cannot be
  // a texture.
  float e = min(min(bary.x, bary.y), bary.z);
  float w = fwidth(e) * max(uEdgeWidth, 0.1);
  edge = 1.0 - smoothstep(0.0, w, e);
  return color;
}
#endif
`;

function obsidianUniforms() {
  return {
    uBands: { value: 3 },
    uPosterize: { value: 0.85 },
    uScreenKey: { value: 0.85 },
    uAmbient: { value: 0.15 },
    uRim: { value: 0.9 },
    uRimPower: { value: 2.6 },
    uEdge: { value: 0.7 },
    uEdgeWidth: { value: 1.2 },
    uSpecular: { value: 0.5 },
    uGloss: { value: 40 },
    uColorDeep: { value: new Color(0.03, 0.015, 0.06) },
    uColorBody: { value: new Color(0.09, 0.05, 0.18) },
    uColorLit: { value: new Color(0.23, 0.15, 0.4) },
    uColorEdge: { value: new Color(0.63, 0.42, 1) }
  };
}

function syncObsidian(u) {
  const c = settings.voidslash;
  const g = settings.global;
  u.uBands.value = c.obsidianBands;
  u.uPosterize.value = c.obsidianPosterize;
  u.uScreenKey.value = c.obsidianScreenKey;
  u.uAmbient.value = c.obsidianAmbient;
  u.uRim.value = c.obsidianRim * g.fresnel;
  u.uRimPower.value = c.obsidianRimPower;
  u.uEdge.value = c.obsidianEdge;
  u.uEdgeWidth.value = c.obsidianEdgeWidth;
  u.uSpecular.value = c.obsidianSpecular;
  u.uGloss.value = c.obsidianGloss;
  u.uColorDeep.value.copy(getColor(c.colorObsidianDeep));
  u.uColorBody.value.copy(getColor(c.colorObsidian));
  u.uColorLit.value.copy(getColor(c.colorObsidianLit));
  u.uColorEdge.value.copy(getColor(c.colorObsidianEdge));
}

/**
 * Premultiplied-over. The shadow layers output rgb already multiplied by
 * alpha, so a dark body covers what is behind it while a bright hem with no
 * alpha simply adds - one blend mode that both darkens and glows.
 */
const PREMULTIPLIED = {
  blending: CustomBlending,
  blendEquation: AddEquation,
  blendSrc: OneFactor,
  blendDst: OneMinusSrcAlphaFactor,
  blendSrcAlpha: OneFactor,
  blendDstAlpha: OneMinusSrcAlphaFactor
};

/* ------------------------------------------------------------------ */
/* 1a · the lance: black glass, shingled on a point                    */
/* ------------------------------------------------------------------ */

const LANCE_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586
  #define PI  3.141592653589793

  attribute float aFlake;
  attribute vec3  aBary;

  uniform float uTime;
  uniform float uRows;         // rows of scales from the point to the rear
  uniform float uAround;       // scales around each row
  uniform float uLength;       // metres, point to rear
  uniform float uLead;         // metres the point runs ahead of the front
  uniform float uRadius;       // envelope radius at the rear, metres
  uniform float uFlare;        // >1 concave and needle-like, 1 straight
  uniform float uScale;        // half-width of a rear scale, metres
  uniform float uTipScale;     // ... and how much smaller the point's are
  uniform float uLong;         // long axis, x the width
  uniform float uTilt;         // radians a scale leans off the tangent
  uniform float uJitter;       // placement jitter, 0..1
  uniform float uFrayStart;    // u where the scales start lifting off
  uniform float uLift;         // radians the rear scales lift
  uniform float uFraySpread;   // metres the rear scales stand off the envelope
  uniform float uFlutter;      // the lifted scales shiver
  uniform float uFlutterSpeed;
  uniform float uBurst;        // 0..1 through the strike
  uniform float uBurstTime;    // seconds since it
  uniform float uBurstSpeed;   // metres/second the scales are blown off at
  uniform float uBurstSpin;    // turns/second they tumble
  uniform float uBurstDrag;
  uniform float uFade;

  varying vec3  vBary;
  varying vec3  vNormal;
  varying vec3  vWorld;
  varying vec2  vLocal;        // the vertex on the flake: x along, y across
  varying float vU;            // 0 at the point, 1 at the rear
  varying float vRoll;
  varying float vViewZ;

  ${noiseGLSL}
  ${VOID_SPINE_GLSL}
  ${ROTATION_GLSL}

  void main() {
    float around = max(uAround, 1.0);
    float rows = max(uRows, 1.0);
    float row = floor(aFlake / around);
    float col = aFlake - row * around;

    float base = aFlake * 3.71 + uSeed;
    float r1 = hash11(base + 1.7);
    float r2 = hash11(base + 5.3);
    float r3 = hash11(base + 9.1);
    vec3  r4 = hash31(base + 13.9);

    /* ---- where on the envelope: rows back from the point, staggered ---- */
    float u = clamp((row + 0.5 + (r1 - 0.5) * uJitter) / rows, 0.0, 1.0);
    float stagger = mod(row, 2.0) * 0.5;
    float ang = (col + stagger + (r2 - 0.5) * uJitter * 0.6) / around * TAU;

    float s = uFront + uLead - u * uLength;
    vec3 tangent, side, up;
    voidFrame(s, tangent, side, up);
    vec3 axis = voidSpine(s);
    vec3 radial = side * cos(ang) + up * sin(ang);
    vec3 across = cross(tangent, radial);

    // Concave out of the point: this exponent is a needle against a party hat.
    float profile = pow(u, max(uFlare, 0.05));
    float fray = smoothstep(uFrayStart, 1.0, u);

    /* ---- size: small at the point, full toward the rear ---- */
    float sz = uScale * mix(uTipScale, 1.0, smoothstep(0.0, 0.7, u)) * (0.8 + r2 * 0.4);
    float halfLength = sz * uLong;

    /* ---- the scale's own frame ---- */
    // Nose down against the body, rear lifting off it: a scale leans off the
    // tangent by its own tilt plus a lift that grows toward the rear and
    // shivers there. That lift is what frays the lance into flakes.
    float flutter = snoise(vec3(aFlake * 0.37, uTime * uFlutterSpeed, uSeed)) * uFlutter * fray;
    float tilt = uTilt + (uLift * (0.5 + r3) + flutter) * fray;
    vec3 along = normalize(tangent * cos(tilt) - radial * sin(tilt));
    vec3 outward = normalize(radial * cos(tilt) + tangent * sin(tilt));

    // Pivoted about the nose rather than the middle, so lifting the rear moves
    // the scale's centre out and back with it.
    vec3 center = axis + radial * (uRadius * profile + uFraySpread * fray * r3)
                + (radial * sin(tilt) - tangent * (1.0 - cos(tilt))) * halfLength * 0.5;

    mat3 frame = mat3(along, outward, across);
    // A little roll about its own long axis, so the shingles are not milled.
    frame = rotationAbout(along, (r4.x - 0.5) * uJitter * 1.2 * (0.3 + fray)) * frame;

    /* ---- the strike: blown off the lance ---- */
    float drag = max(uBurstDrag, 0.01);
    float fly = uBurstSpeed * (0.4 + r3) * (1.0 - exp(-drag * uBurstTime)) / drag;
    vec3 blow = outward + tangent * (r4.y - 0.3) * 0.6 + across * (r4.z - 0.5) * 0.5;
    center += blow * fly;
    frame = rotationAbout(normalize(r4 * 2.0 - 1.0 + vec3(1e-4)),
                          uBurstSpin * uBurstTime * TAU * (0.3 + r1)) * frame;
    // ...and gone. The fade is carried by scale, never by alpha, so the depth
    // buffer can be trusted while the pieces cross each other.
    sz *= 1.0 - smoothstep(0.35, 1.0, uBurst);

    // Behind the caster is before the cast: the lance draws itself out of the
    // hand as the head flies forward.
    sz *= step(0.0, s) * uFade;

    vec3 scale = vec3(sz * uLong, sz, sz);
    vec3 world = center + frame * (position * scale);
    vec3 worldNormal = normalize(frame * (normal / max(scale, vec3(1e-5))));

    vBary = aBary;
    vNormal = worldNormal;
    vWorld = world;
    vLocal = vec2(position.x, position.z);
    vU = u;
    vRoll = r1;

    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const LANCE_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform float uVein;         // the lit crack down each scale
  uniform float uVeinWidth;
  uniform float uVeinFlow;     // pulses per lance length
  uniform float uVeinSpeed;    // ... running to the point, per second
  uniform float uTipGlow;      // the point is lit from inside
  uniform float uTipPow;
  uniform float uBurstHeat;    // the scales flash as they are blown off
  uniform float uBurst;
  uniform float uIntensity;
  uniform float uRolloff;
  uniform float uOpacity;
  uniform float uSoftFade;
  uniform float uFade;
  uniform vec3  uColorGlow;    // the violet the light leaks as
  uniform vec3  uColorHot;     // the white-violet at the point

  uniform sampler2D uSceneDepth;
  uniform vec2  uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uShaderIntensity;
  uniform float uGlobalGlow;

  varying vec3  vBary;
  varying vec3  vNormal;
  varying vec3  vWorld;
  varying vec2  vLocal;
  varying float vU;
  varying float vRoll;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}
  ${OBSIDIAN_GLSL}

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(cameraPosition - vWorld);

    /* ---- the body: matter, held under the bloom threshold ---- */
    float edge;
    vec3 color = obsidianBody(N, V, vBary, edge);
    color *= uIntensity * uShaderIntensity;
    color /= 1.0 + color * uRolloff;

    /* ---- and the light in it, which is allowed to bloom ---- */
    // Strongest at the point: the whole lance is lit from its tip.
    float tip = pow(1.0 - vU, max(uTipPow, 0.05));
    vec3 glow = mix(uColorGlow, uColorHot, tip * 0.7);
    color += glow * uTipGlow * tip;

    // A vein of void light down each scale, with pulses running to the point.
    float vein = 1.0 - smoothstep(0.0, max(uVeinWidth, 0.01), abs(vLocal.y));
    float flow = 0.5 + 0.5 * sin(vLocal.x * 2.2 + vU * uVeinFlow * TAU - uTime * uVeinSpeed * TAU + vRoll * TAU);
    color += glow * vein * uVein * (0.3 + 0.7 * flow) * (0.25 + 0.75 * tip);

    // The hairline along every facet edge, crisp on top of the matte body.
    color += uColorEdge * edge * uEdge;

    // Blown off white-hot, briefly.
    float flash = smoothstep(0.0, 0.12, uBurst) * (1.0 - smoothstep(0.12, 0.7, uBurst));
    color = mix(color, uColorHot, clamp(flash * uBurstHeat, 0.0, 1.0));

    float alpha = uOpacity * uFade;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.02) discard;

    color *= uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * @param {object} spine shared uniform block from `createVoidSpineUniforms()`
 * @returns {THREE.ShaderMaterial} with `userData.sync({ burst, burstTime, fade })`
 */
export function createVoidLanceMaterial(spine) {
  const material = new ShaderMaterial({
    name: 'VoidLance',
    transparent: true,
    // A solid: this layer exists to have an edge, and an edge needs a depth
    // write. Front faces only - the flake is closed.
    depthWrite: true,
    depthTest: true,
    blending: NormalBlending,
    side: FrontSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...spine,
      ...obsidianUniforms(),

      uRows: { value: 14 },
      uAround: { value: 8 },
      uLength: { value: 4.2 },
      uLead: { value: 0 },
      uRadius: { value: 0.62 },
      uFlare: { value: 1.35 },
      uScale: { value: 0.17 },
      uTipScale: { value: 0.35 },
      uLong: { value: 2.4 },
      uTilt: { value: 0.12 },
      uJitter: { value: 0.35 },
      uFrayStart: { value: 0.55 },
      uLift: { value: 0.55 },
      uFraySpread: { value: 0.35 },
      uFlutter: { value: 0.12 },
      uFlutterSpeed: { value: 3 },
      uBurst: { value: 0 },
      uBurstTime: { value: 0 },
      uBurstSpeed: { value: 9 },
      uBurstSpin: { value: 2.5 },
      uBurstDrag: { value: 2.2 },
      uFade: { value: 1 },

      uVein: { value: 1.2 },
      uVeinWidth: { value: 0.16 },
      uVeinFlow: { value: 3 },
      uVeinSpeed: { value: 2.2 },
      uTipGlow: { value: 1.4 },
      uTipPow: { value: 3.5 },
      uBurstHeat: { value: 1 },
      uIntensity: { value: 1.1 },
      uRolloff: { value: 0.5 },
      uOpacity: { value: 1 },
      uSoftFade: { value: 0.2 },
      uColorGlow: { value: new Color(0.54, 0.27, 1) },
      uColorHot: { value: new Color(0.94, 0.89, 1) }
    }),
    vertexShader: LANCE_VERTEX,
    fragmentShader: LANCE_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.voidslash;
    const g = settings.global;
    const u = material.uniforms;

    u.uBurst.value = state.burst;
    u.uBurstTime.value = state.burstTime;
    u.uFade.value = state.fade;

    u.uRows.value = Math.max(1, Math.round(c.lanceRows));
    u.uAround.value = Math.max(1, Math.round(c.lanceAround));
    u.uLength.value = c.lanceLength;
    u.uLead.value = c.lanceLead;
    u.uRadius.value = c.lanceRadius;
    u.uFlare.value = c.lanceFlare;
    u.uScale.value = c.lanceScale;
    u.uTipScale.value = c.lanceTipScale;
    u.uLong.value = c.lanceLong;
    u.uTilt.value = c.lanceTilt;
    u.uJitter.value = c.lanceJitter * g.randomness;
    u.uFrayStart.value = c.lanceFrayStart;
    u.uLift.value = c.lanceLift;
    u.uFraySpread.value = c.lanceFraySpread;
    u.uFlutter.value = c.lanceFlutter * g.noiseStrength;
    u.uFlutterSpeed.value = c.lanceFlutterSpeed * g.noiseSpeed;
    u.uBurstSpeed.value = c.lanceBurstSpeed * g.explosionIntensity;
    u.uBurstSpin.value = c.lanceBurstSpin;
    u.uBurstDrag.value = c.lanceBurstDrag;

    u.uVein.value = c.lanceVein;
    u.uVeinWidth.value = c.lanceVeinWidth;
    u.uVeinFlow.value = c.lanceVeinFlow;
    u.uVeinSpeed.value = c.lanceVeinSpeed * g.animationSpeed;
    u.uTipGlow.value = c.lanceTipGlow;
    u.uTipPow.value = c.lanceTipPow;
    u.uBurstHeat.value = c.lanceBurstHeat;
    u.uIntensity.value = c.lanceIntensity;
    u.uRolloff.value = c.lanceRolloff;
    u.uOpacity.value = c.lanceOpacity * g.opacity;
    u.uSoftFade.value = c.lanceSoftFade;
    u.uColorGlow.value.copy(getColor(c.colorLanceGlow));
    u.uColorHot.value.copy(getColor(c.colorLanceHot));

    syncObsidian(u);
  };

  return material;
}

/* ------------------------------------------------------------------ */
/* 1b · the beam down its axis                                         */
/* ------------------------------------------------------------------ */

const BEAM_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586
  #define PI  3.141592653589793

  attribute float aStrand;

  uniform float uTime;
  uniform float uStrands;
  uniform float uSpan;         // metres of path the beam reaches back over
  uniform float uLead;         // ... and how far past the front its point sits
  uniform float uRadius;       // how far off the axis a satellite winds, metres
  uniform float uCoil;         // turns a satellite makes over the span
  uniform float uSpin;         // turns/second they roll
  uniform float uWidth;        // half-width of the filament at its fattest
  uniform float uSatellite;    // ... and a satellite's, x that
  uniform float uBow;          // how sharply it is pinched at the point
  uniform float uTailThin;     // how thin it is at the tail, x the head
  uniform float uWander;
  uniform float uWanderScale;
  uniform float uWanderSpeed;
  uniform float uFlare;        // the strike blowing the point open
  uniform float uFade;

  varying float vT;
  varying float vV;
  varying float vStrand;
  varying float vViewZ;

  ${noiseGLSL}
  ${VOID_SPINE_GLSL}

  /** Where this strand is at t. 0 is the point, 1 the tail. */
  vec3 beamAt(float t, float strand, float phase, float radius, float coil) {
    float s = uFront + uLead - t * uSpan;
    vec3 tangent, side, up;
    voidFrame(s, tangent, side, up);
    vec3 axis = voidSpine(s);
    // Strand zero is the axis itself.
    if (strand < 0.5) return axis;

    float profile = pow(sin(clamp(t, 0.0, 1.0) * PI), max(uBow, 0.05));
    float a = phase + t * coil * TAU - uTime * uSpin * TAU;
    vec3 offset = (side * cos(a) + up * sin(a)) * radius * profile;

    float n1 = snoise(vec3(t * uWanderScale, uTime * uWanderSpeed, phase * 3.1));
    float n2 = snoise(vec3(t * uWanderScale + 19.3, uTime * uWanderSpeed, phase * 3.1 + 7.7));
    offset += (side * n1 + up * n2) * uWander * profile;
    return axis + offset;
  }

  void main() {
    float strand = aStrand;
    float roll = hash11(strand * 4.11 + uSeed);
    float roll2 = hash11(strand * 8.37 + uSeed + 13.1);

    float phase = (strand / max(uStrands, 1.0)) * TAU + roll * 1.1 + uSeed;
    float handed = mod(strand, 2.0) < 1.0 ? 1.0 : -1.0;
    float radius = uRadius * (0.7 + roll * 0.6);
    float coil = uCoil * (0.7 + roll2 * 0.6) * handed;

    float t = clamp(position.x, 0.0, 1.0);
    const float H = 0.01;
    vec3 p0 = beamAt(t, strand, phase, radius, coil);
    vec3 p1 = beamAt(min(t + H, 1.0), strand, phase, radius, coil);
    vec3 tangent = normalize(p1 - p0 + 1e-6);

    vec3 toEye = normalize(cameraPosition - p0);
    vec3 broad = cross(tangent, toEye);
    if (dot(broad, broad) < 1e-8) broad = vec3(0.0, 1.0, 0.0);
    broad = normalize(broad);

    // Pinched to nothing at the point, widest just behind it, thinning away
    // toward the tail.
    float taper = pow(sin(t * PI), max(uBow, 0.05)) * mix(1.0, uTailThin, t);
    float halfWidth = uWidth * taper * uFade;
    halfWidth *= strand < 0.5 ? 1.0 : uSatellite * (0.7 + roll * 0.6);
    // The strike: the point blows open.
    halfWidth *= 1.0 + uFlare * pow(1.0 - t, 3.0);
    // Nothing behind the caster.
    halfWidth *= step(0.0, uFront + uLead - t * uSpan);

    vec3 world = p0 + broad * (position.y * halfWidth);

    vT = t;
    vV = position.y;
    vStrand = strand;

    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const BEAM_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uSoft;
  uniform float uCore;
  uniform float uCoreWeight;
  uniform float uFiber;
  uniform float uFiberScale;
  uniform float uFiberSpeed;
  uniform float uPulse;
  uniform float uPulseFreq;
  uniform float uPulseSpeed;
  uniform float uHeadGlow;
  uniform float uFlare;
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
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    float across = clamp(1.0 - abs(vV), 0.0, 1.0);
    float body = pow(across, max(uSoft, 0.05));
    float core = pow(across, max(uCore, 1.0));

    float fiber = snoise01(vec3(vT * uFiberScale, vV * 1.7, uTime * uFiberSpeed + vStrand * 9.1));
    body *= mix(1.0, fiber * 1.35, uFiber);

    // Charge running up it to the point.
    float phase = fract(vT * uPulseFreq + uTime * uPulseSpeed + vStrand * 0.37);
    float pulse = pow(1.0 - abs(phase * 2.0 - 1.0), 5.0) * uPulse;

    float energy = body * (1.0 + pulse) + core * uCoreWeight;
    energy *= 1.0 + uHeadGlow * pow(1.0 - vT, 3.0) * (1.0 + uFlare);
    if (energy < 0.002) discard;

    vec3 color = mix(uColorBody, uColorTail, smoothstep(0.35, 1.0, vT));
    float white = clamp(core * uCoreWeight + pulse * 0.6 + pow(1.0 - vT, 4.0) * 0.8, 0.0, 1.0);
    color = mix(color, uColorCore, white * 0.6);
    color *= energy * uIntensity * uShaderIntensity;

    float alpha = clamp(energy, 0.0, 1.0) * uOpacity * uFade;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    color *= uGlobalGlow;
    // Rolled off so the axis stays violet through its own satellites.
    color /= 1.0 + color * 0.3;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * @param {object} spine shared uniform block from `createVoidSpineUniforms()`
 * @returns {THREE.ShaderMaterial} with `userData.sync({ strands, span, flare, fade })`
 */
export function createVoidBeamMaterial(spine) {
  const material = new ShaderMaterial({
    name: 'VoidBeam',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...spine,

      uStrands: { value: 4 },
      uSpan: { value: 12 },
      uLead: { value: 0 },
      uRadius: { value: 0.16 },
      uCoil: { value: 3.5 },
      uSpin: { value: 1.2 },
      uWidth: { value: 0.26 },
      uSatellite: { value: 0.35 },
      uBow: { value: 0.5 },
      uTailThin: { value: 0.35 },
      uWander: { value: 0.05 },
      uWanderScale: { value: 3 },
      uWanderSpeed: { value: 1.5 },
      uFlare: { value: 0 },
      uFade: { value: 1 },

      uSoft: { value: 1.6 },
      uCore: { value: 14 },
      uCoreWeight: { value: 0.8 },
      uFiber: { value: 0.45 },
      uFiberScale: { value: 6 },
      uFiberSpeed: { value: 2.5 },
      uPulse: { value: 1 },
      uPulseFreq: { value: 2.2 },
      uPulseSpeed: { value: 2 },
      uHeadGlow: { value: 1.2 },
      uIntensity: { value: 2.4 },
      uOpacity: { value: 0.9 },
      uSoftFade: { value: 0.3 },
      uColorCore: { value: new Color(0.96, 0.93, 1) },
      uColorBody: { value: new Color(0.61, 0.36, 1) },
      uColorTail: { value: new Color(0.23, 0.09, 0.5) }
    }),
    vertexShader: BEAM_VERTEX,
    fragmentShader: BEAM_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.voidslash;
    const g = settings.global;
    const u = material.uniforms;

    u.uStrands.value = state.strands;
    u.uSpan.value = state.span;
    u.uFlare.value = state.flare;
    u.uFade.value = state.fade;

    u.uLead.value = c.beamLead;
    u.uRadius.value = c.beamRadius;
    u.uCoil.value = c.beamCoil;
    u.uSpin.value = c.beamSpin * g.animationSpeed;
    u.uWidth.value = c.beamWidth;
    u.uSatellite.value = c.beamSatellite;
    u.uBow.value = c.beamBow;
    u.uTailThin.value = c.beamTailThin;
    u.uWander.value = c.beamWander * g.noiseStrength;
    u.uWanderScale.value = c.beamWanderScale * g.noiseFrequency;
    u.uWanderSpeed.value = c.beamWanderSpeed * g.noiseSpeed;

    u.uSoft.value = c.beamSoft;
    u.uCore.value = c.beamCore;
    u.uCoreWeight.value = c.beamCoreWeight;
    u.uFiber.value = c.beamFiber * g.randomness;
    u.uFiberScale.value = c.beamFiberScale * g.noiseFrequency;
    u.uFiberSpeed.value = c.beamFiberSpeed * g.noiseSpeed;
    u.uPulse.value = c.beamPulse;
    u.uPulseFreq.value = c.beamPulseFreq;
    u.uPulseSpeed.value = c.beamPulseSpeed * g.noiseSpeed;
    u.uHeadGlow.value = c.beamHeadGlow;
    u.uIntensity.value = c.beamIntensity;
    u.uOpacity.value = c.beamOpacity * g.opacity;
    u.uSoftFade.value = c.beamSoftFade;
    u.uColorCore.value.copy(getColor(c.colorBeamCore));
    u.uColorBody.value.copy(getColor(c.colorBeam));
    u.uColorTail.value.copy(getColor(c.colorBeamTail));
  };

  return material;
}

/* ------------------------------------------------------------------ */
/* 2 · the particle debris: the flakes that came away                  */
/* ------------------------------------------------------------------ */

const DEBRIS_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  attribute float aFlake;
  attribute vec3  aBary;

  uniform float uTime;
  uniform float uLife;         // seconds one flake lasts, and its spawn period
  uniform float uHeadSpeed;    // metres/second the head is making - unwinds history
  uniform float uLead;         // metres ahead of the front they are struck off (negative: the lance rear)
  uniform float uRadius;       // how far off the axis they are born, metres
  uniform float uThrow;        // launch speed, metres/second
  uniform float uForward;      // how much of that is along the heading ...
  uniform float uSpread;       // ... and how much is radial
  uniform float uCarry;        // fraction of the head's own speed they keep
  uniform float uDrag;
  uniform float uGravity;
  uniform float uSize;         // metres across, before the per-flake roll
  uniform float uSizeVariance;
  uniform float uLong;         // how long the longest sliver is
  uniform float uSpin;         // tumble, turns/second
  uniform float uGrowIn;
  uniform float uShrinkOut;
  uniform float uHot;          // fraction still carrying the void's light
  uniform float uStopped;      // seconds since the head came to rest, 0 in flight
  uniform float uFade;

  varying vec3  vBary;
  varying vec3  vNormal;
  varying vec3  vWorld;
  varying vec2  vLocal;
  varying float vLife;
  varying float vRoll;
  varying float vHot;
  varying float vViewZ;

  ${noiseGLSL}
  ${VOID_SPINE_GLSL}
  ${ROTATION_GLSL}

  void main() {
    float period = max(uLife, 0.05);
    float phase = hash11(aFlake * 1.37 + uSeed * 0.31);
    float loop = uTime / period + phase;
    float generation = floor(loop);
    float life = fract(loop);
    float age = life * period;

    // Re-rolled every time the slot recycles.
    float base = aFlake * 3.71 + generation * 17.13 + uSeed;
    float r1 = hash11(base + 1.7);
    float r2 = hash11(base + 5.3);
    float r3 = hash11(base + 9.1);
    float r4 = hash11(base + 13.9);
    vec3  r5 = hash31(base + 21.7);
    float r6 = hash11(base + 29.3);

    /* ---- where the lance was when this flake came off it ---- */
    // Only the time the head spent moving laid any trail down; once it has
    // stopped this freezes, and a slot that recycles after the strike is not
    // reborn at the impact point. It is a trail, and a trail does not detonate.
    float flightAge = max(age - uStopped, 0.0);
    float sBirth = uFront + uLead - flightAge * uHeadSpeed;
    float born = step(0.0, sBirth) * step(uStopped, age);

    // Momentum kept along the path: a flake keeping uCarry of the head's speed
    // is slipping back down the spine at the remaining fraction.
    float slip = (1.0 - uCarry) * uHeadSpeed * flightAge;
    float sNow = uFront + uLead - slip;

    vec3 tangent, side, up;
    voidFrame(sNow, tangent, side, up);
    vec3 root = voidSpine(sNow);

    /* ---- its own flight since ---- */
    float a = r1 * TAU;
    vec3 radial = side * cos(a) + up * sin(a);
    vec3 launch = normalize(tangent * uForward + radial * uSpread + 1e-5);

    float speed = uThrow * (0.35 + r2 * 1.3);
    float drag = max(uDrag, 0.001);
    float travel = speed * (1.0 - exp(-drag * age)) / drag;

    vec3 center = root
                + radial * uRadius * (0.15 + r3)
                + launch * travel
                - vec3(0.0, 0.5 * uGravity * age * age, 0.0);

    /* ---- size: born small, snaps out, shrinks away ---- */
    float grow = smoothstep(0.0, max(uGrowIn, 0.01), life);
    float die = 1.0 - smoothstep(uShrinkOut, 1.0, life);
    float roll = mix(1.0 - uSizeVariance, 1.0 + uSizeVariance, r4 * r4);
    float size = uSize * roll * grow * die * uFade * born;

    float slender = r3;
    vec3 scale = vec3(size * mix(1.2, uLong, slender), size, size * mix(1.0, 0.7, slender));

    /* ---- tumble ---- */
    vec3 axis = normalize(r5 * 2.0 - 1.0 + vec3(1e-4));
    mat3 rot = rotationAbout(axis, (0.4 + r2 * 1.4) * uSpin * TAU * age + r1 * TAU);

    vec3 world = center + rot * (position * scale);
    vec3 worldNormal = normalize(rot * (normal / max(scale, vec3(1e-5))));

    vBary = aBary;
    vNormal = worldNormal;
    vWorld = world;
    vLocal = vec2(position.x, position.z);
    vLife = life;
    vRoll = r2;
    vHot = step(r6, uHot);

    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const DEBRIS_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform float uHotGlow;      // the light still in the hot ones
  uniform float uHotPulse;     // ... breathing, per second
  uniform float uFlash;        // white-violet the instant it comes away
  uniform float uFlashLife;
  uniform float uIntensity;
  uniform float uRolloff;
  uniform float uOpacity;
  uniform float uSoftFade;
  uniform float uFade;
  uniform vec3  uColorGlow;
  uniform vec3  uColorFlash;

  uniform sampler2D uSceneDepth;
  uniform vec2  uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uShaderIntensity;
  uniform float uGlobalGlow;

  varying vec3  vBary;
  varying vec3  vNormal;
  varying vec3  vWorld;
  varying vec2  vLocal;
  varying float vLife;
  varying float vRoll;
  varying float vHot;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}
  ${OBSIDIAN_GLSL}

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(cameraPosition - vWorld);

    float edge;
    vec3 color = obsidianBody(N, V, vBary, edge);
    color *= uIntensity * uShaderIntensity;
    color /= 1.0 + color * uRolloff;

    // The hot ones: void light still in the glass, pooled along a vein and
    // draining as the flake ages.
    float pulse = 0.6 + 0.4 * sin(uTime * uHotPulse * TAU + vRoll * TAU);
    float vein = 1.0 - smoothstep(0.0, 0.22, abs(vLocal.y));
    color += uColorGlow * vHot * uHotGlow * (0.35 + 0.65 * vein) * pulse * (1.0 - vLife * 0.6);

    color += uColorEdge * edge * uEdge;

    float flash = pow(1.0 - clamp(vLife / max(uFlashLife, 0.01), 0.0, 1.0), 3.0);
    color = mix(color, uColorFlash, clamp(flash * uFlash, 0.0, 1.0));

    // Never fades - it shrinks - so alpha is flat and the depth buffer sorts
    // the field against itself.
    float alpha = uOpacity * uFade;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.02) discard;

    color *= uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * @param {object} spine shared uniform block from `createVoidSpineUniforms()`
 * @returns {THREE.ShaderMaterial} with `userData.sync({ headSpeed, stopped, fade })`
 */
export function createVoidDebrisMaterial(spine) {
  const material = new ShaderMaterial({
    name: 'VoidDebris',
    transparent: true,
    depthWrite: true,
    depthTest: true,
    blending: NormalBlending,
    side: FrontSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...spine,
      ...obsidianUniforms(),

      uLife: { value: 1.5 },
      uHeadSpeed: { value: 30 },
      uLead: { value: -3.5 },
      uRadius: { value: 0.5 },
      uThrow: { value: 2.6 },
      uForward: { value: 0.25 },
      uSpread: { value: 0.9 },
      uCarry: { value: 0.7 },
      uDrag: { value: 1.2 },
      uGravity: { value: 1 },
      uSize: { value: 0.17 },
      uSizeVariance: { value: 0.6 },
      uLong: { value: 1.6 },
      uSpin: { value: 0.7 },
      uGrowIn: { value: 0.08 },
      uShrinkOut: { value: 0.6 },
      uHot: { value: 0.3 },
      uStopped: { value: 0 },
      uFade: { value: 1 },

      uHotGlow: { value: 1.2 },
      uHotPulse: { value: 2.5 },
      uFlash: { value: 0.9 },
      uFlashLife: { value: 0.14 },
      uIntensity: { value: 1.1 },
      uRolloff: { value: 0.5 },
      uOpacity: { value: 1 },
      uSoftFade: { value: 0.2 },
      uColorGlow: { value: new Color(0.56, 0.3, 1) },
      uColorFlash: { value: new Color(0.93, 0.88, 1) }
    }),
    vertexShader: DEBRIS_VERTEX,
    fragmentShader: DEBRIS_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.voidslash;
    const g = settings.global;
    const u = material.uniforms;

    u.uHeadSpeed.value = state.headSpeed;
    u.uStopped.value = state.stopped;
    u.uFade.value = state.fade;

    u.uLife.value = c.debrisLife * g.particleLifetime;
    u.uLead.value = c.debrisLead;
    u.uRadius.value = c.debrisRadius;
    u.uThrow.value = c.debrisThrow * g.particleSpeed;
    u.uForward.value = c.debrisForward;
    u.uSpread.value = c.debrisSpread;
    u.uCarry.value = c.debrisCarry;
    u.uDrag.value = c.debrisDrag;
    u.uGravity.value = c.debrisGravity;
    u.uSize.value = c.debrisSize * g.particleSize;
    u.uSizeVariance.value = c.debrisSizeVariance * g.randomness;
    u.uLong.value = c.debrisLong;
    u.uSpin.value = c.debrisSpin * g.animationSpeed;
    u.uGrowIn.value = c.debrisGrowIn;
    u.uShrinkOut.value = c.debrisShrinkOut;
    u.uHot.value = c.debrisHot;

    u.uHotGlow.value = c.debrisHotGlow;
    u.uHotPulse.value = c.debrisHotPulse * g.noiseSpeed;
    u.uFlash.value = c.debrisFlash;
    u.uFlashLife.value = c.debrisFlashLife;
    u.uIntensity.value = c.debrisIntensity;
    u.uRolloff.value = c.debrisRolloff;
    u.uOpacity.value = 1;
    u.uSoftFade.value = c.debrisSoftFade;
    u.uColorGlow.value.copy(getColor(c.colorDebrisGlow));
    u.uColorFlash.value.copy(getColor(c.colorDebrisFlash));

    syncObsidian(u);
  };

  return material;
}

/* ------------------------------------------------------------------ */
/* 3 · the shadow ribbon trails                                        */
/* ------------------------------------------------------------------ */

const RIBBON_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586
  #define PI  3.141592653589793

  attribute float aStrand;

  uniform float uTime;
  uniform float uStrands;
  uniform float uSpan;         // metres of path the ribbons reach back over
  uniform float uLead;         // where they start, metres ahead of the front (negative: inside the lance)
  uniform float uRadius;       // how far off the axis a ribbon bows at the tail, metres
  uniform float uHeadRadius;   // ... x that, at the head - the wake opens
  uniform float uFlatten;      // vertical component of the bow, x the lateral
  uniform float uCoil;         // turns one ribbon makes over the span
  uniform float uSpin;         // turns/second the weave rolls
  uniform float uBow;          // how sharply the ribbons converge at the ends
  uniform float uWander;
  uniform float uWanderScale;
  uniform float uWanderSpeed;
  uniform float uWidth;        // half-width at its broadest, metres
  uniform float uWidthBow;
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
  ${VOID_SPINE_GLSL}

  vec3 ribbonAt(float t, float phase, float radius, float coil) {
    float s = max(uFront + uLead - t * uSpan, 0.0);

    vec3 tangent, side, up;
    voidFrame(s, tangent, side, up);
    vec3 axis = voidSpine(s);

    // Pinched at both ends, and opening toward the tail: the wake is narrow
    // where it leaves the lance and wide where it has had time to spread.
    float profile = pow(sin(clamp(t, 0.0, 1.0) * PI), max(uBow, 0.05));
    float open = mix(uHeadRadius, 1.0, t);

    float a = phase + t * coil * TAU - uTime * uSpin * TAU;
    vec3 offset = (side * cos(a) + up * sin(a) * uFlatten) * radius * open * profile;

    float n1 = snoise(vec3(t * uWanderScale, uTime * uWanderSpeed, phase * 3.1));
    float n2 = snoise(vec3(t * uWanderScale + 19.3, uTime * uWanderSpeed, phase * 3.1 + 7.7));
    offset += (side * n1 + up * n2) * uWander * profile;

    return axis + offset;
  }

  void main() {
    float strand = aStrand;
    float roll = hash11(strand * 4.11 + uSeed);
    float roll2 = hash11(strand * 8.37 + uSeed + 13.1);

    float phase = (strand / max(uStrands, 1.0)) * TAU + roll * 1.1 + uSeed;
    float handed = mod(strand, 2.0) < 1.0 ? 1.0 : -1.0;
    float radius = uRadius * (0.7 + roll * 0.7);
    float coil = uCoil * (0.6 + roll2 * 1.0) * handed;

    float t = clamp(position.x, 0.0, 1.0);
    const float H = 0.01;
    vec3 p0 = ribbonAt(t, phase, radius, coil);
    vec3 p1 = ribbonAt(min(t + H, 1.0), phase, radius, coil);
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

    float taper = pow(sin(clamp(t, 0.0, 1.0) * PI), max(uWidthBow, 0.05));
    float halfWidth = uWidth * taper * uFade * (0.7 + roll * 0.6);

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

const RIBBON_FRAGMENT = /* glsl */ `
  #define PI 3.141592653589793

  uniform float uTime;
  uniform float uSoft;         // falloff across the strip
  uniform float uFiber;        // how hard the body breaks into fibres
  uniform float uFiberScale;
  uniform float uFiberSpeed;
  uniform float uHem;          // width of the lit line inside each border
  uniform float uHemGlow;
  uniform float uHeadGlow;
  uniform float uPulse;
  uniform float uPulseFreq;
  uniform float uPulseSpeed;
  uniform float uInner;        // how much of the body colour shows through the shadow
  uniform float uOpacity;
  uniform float uSoftFade;
  uniform float uFade;
  uniform vec3  uColorShadow;  // the dark of the silk
  uniform vec3  uColorBody;    // ... and its violet
  uniform vec3  uColorHem;     // the light along its edge

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
    float across = clamp(1.0 - abs(vV), 0.0, 1.0);
    float body = pow(across, max(uSoft, 0.05));

    /* fibres travelling back down the silk */
    float fiber = snoise01(vec3(vT * uFiberScale, vV * 2.3, uTime * uFiberSpeed + vStrand * 7.0));
    float density = body * mix(1.0, fiber * 1.4, uFiber);
    // Edge-on the same silk is thicker.
    density *= mix(1.25, 1.0, vFacing);

    /* the lit hem: a thin line just inside each border */
    float hemW = max(uHem, 0.01);
    float av = abs(vV);
    float hem = smoothstep(1.0 - hemW, 1.0 - hemW * 0.35, av) * (1.0 - smoothstep(1.0 - hemW * 0.35, 1.0, av));
    hem *= sin(clamp(vT, 0.0, 1.0) * PI);

    /* charge running up it to the head */
    float phase = fract(vT * uPulseFreq + uTime * uPulseSpeed + vStrand * 0.37);
    float pulse = pow(1.0 - abs(phase * 2.0 - 1.0), 4.0) * uPulse;
    float head = pow(1.0 - vT, 4.0) * uHeadGlow;

    float cover = clamp(density, 0.0, 1.0);
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    float depthFade = softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    float alpha = cover * uOpacity * uFade * depthFade;

    // The shadow: covers what is behind it, premultiplied.
    vec3 col = mix(uColorShadow, uColorBody, clamp(fiber * uInner + pulse, 0.0, 1.0)) * alpha;
    // The light: hem, head and pulses, added with no coverage of their own.
    vec3 glow = uColorHem * (hem * uHemGlow * (0.5 + 0.5 * fiber) + head * cover + pulse * cover * 0.5);
    glow *= uShaderIntensity * uFade * depthFade;

    if (alpha < 0.003 && max(glow.r, max(glow.g, glow.b)) < 0.003) discard;

    gl_FragColor = vec4((col + glow) * uGlobalGlow, alpha);
  }
`;

/**
 * @param {object} spine shared uniform block from `createVoidSpineUniforms()`
 * @returns {THREE.ShaderMaterial} with `userData.sync({ strands, span, fade })`
 */
export function createVoidRibbonMaterial(spine) {
  const material = new ShaderMaterial({
    name: 'VoidRibbon',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    ...PREMULTIPLIED,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...spine,

      uStrands: { value: 4 },
      uSpan: { value: 14 },
      uLead: { value: -1.5 },
      uRadius: { value: 1.1 },
      uHeadRadius: { value: 0.25 },
      uFlatten: { value: 0.8 },
      uCoil: { value: 1.3 },
      uSpin: { value: 0.2 },
      uBow: { value: 0.45 },
      uWander: { value: 0.25 },
      uWanderScale: { value: 1.8 },
      uWanderSpeed: { value: 0.6 },
      uWidth: { value: 0.5 },
      uWidthBow: { value: 0.5 },
      uTwist: { value: 0.85 },
      uTwistTurns: { value: 1.2 },
      uTwistSpeed: { value: 0.2 },
      uTwistFace: { value: 0.15 },
      uFade: { value: 1 },

      uSoft: { value: 1.2 },
      uFiber: { value: 0.7 },
      uFiberScale: { value: 4 },
      uFiberSpeed: { value: 1.2 },
      uHem: { value: 0.12 },
      uHemGlow: { value: 1.6 },
      uHeadGlow: { value: 0.8 },
      uPulse: { value: 0.5 },
      uPulseFreq: { value: 1.4 },
      uPulseSpeed: { value: 1.2 },
      uInner: { value: 0.8 },
      uOpacity: { value: 0.75 },
      uSoftFade: { value: 0.4 },
      uColorShadow: { value: new Color(0.07, 0.03, 0.12) },
      uColorBody: { value: new Color(0.23, 0.1, 0.48) },
      uColorHem: { value: new Color(0.65, 0.43, 1) }
    }),
    vertexShader: RIBBON_VERTEX,
    fragmentShader: RIBBON_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.voidslash;
    const g = settings.global;
    const u = material.uniforms;

    u.uStrands.value = state.strands;
    u.uSpan.value = state.span;
    u.uFade.value = state.fade;

    u.uLead.value = c.ribbonLead;
    u.uRadius.value = c.ribbonRadius;
    u.uHeadRadius.value = c.ribbonHeadRadius;
    u.uFlatten.value = c.ribbonFlatten;
    u.uCoil.value = c.ribbonCoil;
    u.uSpin.value = c.ribbonSpin * g.animationSpeed;
    u.uBow.value = c.ribbonBow;
    u.uWander.value = c.ribbonWander * g.noiseStrength;
    u.uWanderScale.value = c.ribbonWanderScale * g.noiseFrequency;
    u.uWanderSpeed.value = c.ribbonWanderSpeed * g.noiseSpeed;
    u.uWidth.value = c.ribbonWidth;
    u.uWidthBow.value = c.ribbonWidthBow;
    u.uTwist.value = c.ribbonTwist;
    u.uTwistTurns.value = c.ribbonTwistTurns;
    u.uTwistSpeed.value = c.ribbonTwistSpeed * g.animationSpeed;
    u.uTwistFace.value = c.ribbonTwistFace;

    u.uSoft.value = c.ribbonSoft;
    u.uFiber.value = c.ribbonFiber * g.randomness;
    u.uFiberScale.value = c.ribbonFiberScale * g.noiseFrequency;
    u.uFiberSpeed.value = c.ribbonFiberSpeed * g.noiseSpeed;
    u.uHem.value = c.ribbonHem;
    u.uHemGlow.value = c.ribbonHemGlow;
    u.uHeadGlow.value = c.ribbonHeadGlow;
    u.uPulse.value = c.ribbonPulse;
    u.uPulseFreq.value = c.ribbonPulseFreq;
    u.uPulseSpeed.value = c.ribbonPulseSpeed * g.noiseSpeed;
    u.uInner.value = c.ribbonInner;
    u.uOpacity.value = c.ribbonOpacity * g.opacity;
    u.uSoftFade.value = c.ribbonSoftFade;
    u.uColorShadow.value.copy(getColor(c.colorRibbonShadow));
    u.uColorBody.value.copy(getColor(c.colorRibbon));
    u.uColorHem.value.copy(getColor(c.colorRibbonHem));
  };

  return material;
}

/* ------------------------------------------------------------------ */
/* 4 · the energy sparks, and the glare at the point                   */
/* ------------------------------------------------------------------ */

const SPARK_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  attribute float aSprite;

  uniform float uTime;
  uniform float uTrail;        // how many slots are the trail; the rest are the burst
  uniform float uLife;
  uniform float uHeadSpeed;
  uniform float uLead;
  uniform float uRadius;
  uniform float uThrow;
  uniform float uCarry;
  uniform float uDrag;
  uniform float uGravity;
  uniform float uSize;         // half-size of a spark's quad, metres
  uniform float uSizeVariance;
  uniform float uRayLength;    // reach of the rays, x the quad
  uniform float uLongRays;     // fraction of sparks with rays three times as long
  uniform float uGlareSize;    // the point of light at the tip
  uniform float uGlareRays;
  uniform float uFlare;        // the strike, on the glare
  uniform float uBurstLife;
  uniform float uBurstThrow;
  uniform float uBurstDrag;
  uniform float uBurstSize;
  uniform vec3  uImpact;
  uniform float uStopped;
  uniform float uFade;

  varying vec2  vUv;
  varying float vSeed;
  varying float vLife;
  varying float vKind;         // 0 the glare, 1 the trail, 2 the burst
  varying float vRays;         // reach of the rays in quad units, <= 1
  varying float vScale;        // how far the quad was grown to hold them
  varying float vViewZ;

  ${noiseGLSL}
  ${VOID_SPINE_GLSL}

  void main() {
    vec3 center = vec3(0.0);
    float size = 0.0;
    float life = 0.0;
    float kind = 0.0;
    float rays = 1.0;
    float seed = 0.0;
    float spin = 0.0;

    if (aSprite < 0.5) {
      /* ---- the point of light at the tip ---- */
      center = voidSpine(uFront + uLead);
      size = uGlareSize * (1.0 + uFlare) * uFade;
      kind = 0.0;
      rays = uGlareRays;
      seed = uSeed;
      spin = uTime * 0.15 * TAU;
    } else if (aSprite < uTrail + 0.5) {
      /* ---- the trail, shed off the lance ---- */
      float period = max(uLife, 0.05);
      float phase = hash11(aSprite * 1.37 + uSeed * 0.31);
      float loop = uTime / period + phase;
      float generation = floor(loop);
      life = fract(loop);
      float age = life * period;

      float base = aSprite * 3.71 + generation * 17.13 + uSeed;
      float r1 = hash11(base + 1.7);
      float r2 = hash11(base + 5.3);
      float r3 = hash11(base + 9.1);
      float r4 = hash11(base + 13.9);
      vec3  r5 = hash31(base + 21.7);

      float flightAge = max(age - uStopped, 0.0);
      float sBirth = uFront + uLead - flightAge * uHeadSpeed;
      float born = step(0.0, sBirth) * step(uStopped, age);
      float slip = (1.0 - uCarry) * uHeadSpeed * flightAge;
      float sNow = uFront + uLead - slip;

      vec3 tangent, side, up;
      voidFrame(sNow, tangent, side, up);
      vec3 root = voidSpine(sNow);

      float a = r1 * TAU;
      vec3 radial = side * cos(a) + up * sin(a);
      vec3 launch = normalize(radial + tangent * (r4 - 0.5) * 0.6);
      float speed = uThrow * (0.3 + r2 * 1.4);
      float drag = max(uDrag, 0.001);
      float travel = speed * (1.0 - exp(-drag * age)) / drag;

      center = root + radial * uRadius * (0.1 + r3) + launch * travel
             - vec3(0.0, 0.5 * uGravity * age * age, 0.0);

      float grow = smoothstep(0.0, 0.08, life);
      float die = 1.0 - smoothstep(0.5, 1.0, life);
      size = uSize * mix(1.0 - uSizeVariance, 1.0 + uSizeVariance, r4 * r4) * grow * die * born * uFade;
      kind = 1.0;
      rays = uRayLength * (0.6 + r5.y * 0.6 + step(r5.x, uLongRays) * 2.2);
      seed = base;
      spin = r5.z * TAU + age * (r2 - 0.5) * 2.0;
    } else {
      /* ---- the shell thrown on the strike ---- */
      float i = aSprite - uTrail - 1.0;
      float base = i * 5.13 + uSeed + 77.0;
      float r1 = hash11(base + 1.7);
      float r2 = hash11(base + 5.3);
      float r3 = hash11(base + 9.1);
      float r4 = hash11(base + 13.9);
      vec3  r5 = hash31(base + 21.7);

      // Staggered a little, so the shell is not one perfect sphere.
      float age = max(uStopped - r1 * 0.06, 0.0);
      float period = max(uBurstLife, 0.05);
      life = age / period;
      float born = step(0.0001, uStopped) * step(life, 1.0);

      vec3 dir = normalize(r5 * 2.0 - 1.0 + uDir * 0.35 + vec3(1e-4));
      float speed = uBurstThrow * (0.3 + r2 * 1.2);
      float drag = max(uBurstDrag, 0.001);
      float travel = speed * (1.0 - exp(-drag * age)) / drag;

      center = uImpact + dir * travel - vec3(0.0, 0.5 * uGravity * age * age, 0.0);

      float env = smoothstep(0.0, 0.05, life) * (1.0 - smoothstep(0.45, 1.0, life));
      size = uBurstSize * mix(1.0 - uSizeVariance, 1.0 + uSizeVariance, r4 * r4) * env * born * uFade;
      kind = 2.0;
      rays = uRayLength * (0.8 + r3 * 1.4);
      seed = base;
      spin = r4 * TAU;
    }

    // Rays longer than the quad grow the quad; the fragment stage scales the
    // core and the ray thickness back down so only the reach changes.
    float grown = max(rays, 1.0);
    size *= grown;

    float cs = cos(spin);
    float sn = sin(spin);
    vec2 q = vec2(position.x * cs - position.y * sn, position.x * sn + position.y * cs);

    vec4 mv = viewMatrix * vec4(center, 1.0);
    mv.xy += q * size;

    vUv = position.xy;
    vSeed = seed;
    vLife = life;
    vKind = kind;
    vRays = rays / grown;
    vScale = grown;
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const SPARK_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform float uCoreTight;    // how tight the hot centre is
  uniform float uRays;         // brightness of the four rays
  uniform float uRaySharp;     // how thin they are
  uniform float uTwinkle;
  uniform float uTwinkleSpeed;
  uniform float uGlareIntensity;
  uniform float uFlare;
  uniform float uIntensity;
  uniform float uSoftFade;
  uniform float uFade;
  uniform vec3  uColorCore;
  uniform vec3  uColorBody;

  uniform sampler2D uSceneDepth;
  uniform vec2  uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uShaderIntensity;
  uniform float uGlobalGlow;

  varying vec2  vUv;
  varying float vSeed;
  varying float vLife;
  varying float vKind;
  varying float vRays;
  varying float vScale;
  varying float vViewZ;

  ${commonGLSL}

  void main() {
    vec2 p = vUv;
    // Back in the spark's own units, whatever the quad was grown to.
    vec2 ps = p * vScale;
    float d = length(ps);

    float core = exp(-d * d * uCoreTight);

    float reach = clamp(vRays, 0.05, 1.0);
    float rx = pow(max(1.0 - abs(p.x) / reach, 0.0), 2.0) * exp(-abs(ps.y) * uRaySharp);
    float ry = pow(max(1.0 - abs(p.y) / reach, 0.0), 2.0) * exp(-abs(ps.x) * uRaySharp);
    float rays = (rx + ry) * uRays;

    float tw = 0.5 + 0.5 * sin(uTime * uTwinkleSpeed * TAU + vSeed * TAU);
    float twinkle = mix(1.0, tw, uTwinkle * (vKind < 0.5 ? 0.35 : 1.0));

    float energy = (core + rays) * twinkle;
    if (vKind < 0.5) energy *= uGlareIntensity * (1.0 + uFlare);
    if (energy < 0.003) discard;

    vec3 color = mix(uColorBody, uColorCore, clamp(core * 1.5, 0.0, 1.0));
    color *= energy * uIntensity * uShaderIntensity;

    float alpha = clamp(energy, 0.0, 1.0) * uFade;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    color *= uGlobalGlow;
    color /= 1.0 + color * 0.15;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * @param {object} spine shared uniform block from `createVoidSpineUniforms()`
 * @returns {THREE.ShaderMaterial} with
 *   `userData.sync({ trail, headSpeed, stopped, flare, impact, fade })`
 */
export function createVoidSparkMaterial(spine) {
  const material = new ShaderMaterial({
    name: 'VoidSpark',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...spine,

      uTrail: { value: 90 },
      uLife: { value: 0.7 },
      uHeadSpeed: { value: 30 },
      uLead: { value: -0.6 },
      uRadius: { value: 0.5 },
      uThrow: { value: 2.8 },
      uCarry: { value: 0.8 },
      uDrag: { value: 1.5 },
      uGravity: { value: 0.6 },
      uSize: { value: 0.09 },
      uSizeVariance: { value: 0.6 },
      uRayLength: { value: 0.7 },
      uLongRays: { value: 0.25 },
      uGlareSize: { value: 0.9 },
      uGlareRays: { value: 1.4 },
      uFlare: { value: 0 },
      uBurstLife: { value: 0.8 },
      uBurstThrow: { value: 12 },
      uBurstDrag: { value: 2.5 },
      uBurstSize: { value: 0.12 },
      uImpact: { value: new Vector3() },
      uStopped: { value: 0 },
      uFade: { value: 1 },

      uCoreTight: { value: 9 },
      uRays: { value: 0.9 },
      uRaySharp: { value: 14 },
      uTwinkle: { value: 0.7 },
      uTwinkleSpeed: { value: 6 },
      uGlareIntensity: { value: 2.6 },
      uIntensity: { value: 2.2 },
      uSoftFade: { value: 0.15 },
      uColorCore: { value: new Color(1, 1, 1) },
      uColorBody: { value: new Color(0.79, 0.65, 1) }
    }),
    vertexShader: SPARK_VERTEX,
    fragmentShader: SPARK_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.voidslash;
    const g = settings.global;
    const u = material.uniforms;

    u.uTrail.value = state.trail;
    u.uHeadSpeed.value = state.headSpeed;
    u.uStopped.value = state.stopped;
    u.uFlare.value = state.flare;
    u.uImpact.value.copy(state.impact);
    u.uFade.value = state.fade;

    u.uLife.value = c.sparkLife * g.particleLifetime;
    u.uLead.value = c.sparkLead;
    u.uRadius.value = c.sparkRadius;
    u.uThrow.value = c.sparkThrow * g.particleSpeed;
    u.uCarry.value = c.sparkCarry;
    u.uDrag.value = c.sparkDrag;
    u.uGravity.value = c.sparkGravity;
    u.uSize.value = c.sparkSize * g.particleSize;
    u.uSizeVariance.value = c.sparkSizeVariance * g.randomness;
    u.uRayLength.value = c.sparkRayLength;
    u.uLongRays.value = c.sparkLongRays;
    u.uGlareSize.value = c.glareSize;
    u.uGlareRays.value = c.glareRays;
    u.uBurstLife.value = c.sparkBurstLife * g.particleLifetime;
    u.uBurstThrow.value = c.sparkBurstThrow * g.particleSpeed * g.explosionIntensity;
    u.uBurstDrag.value = c.sparkBurstDrag;
    u.uBurstSize.value = c.sparkBurstSize * g.particleSize;

    u.uCoreTight.value = c.sparkCoreTight;
    u.uRays.value = c.sparkRays;
    u.uRaySharp.value = c.sparkRaySharp;
    u.uTwinkle.value = c.sparkTwinkle * g.randomness;
    u.uTwinkleSpeed.value = c.sparkTwinkleSpeed * g.noiseSpeed;
    u.uGlareIntensity.value = c.glareIntensity;
    u.uIntensity.value = c.sparkIntensity;
    u.uSoftFade.value = c.sparkSoftFade;
    u.uColorCore.value.copy(getColor(c.colorSparkCore));
    u.uColorBody.value.copy(getColor(c.colorSpark));
  };

  return material;
}

/* ------------------------------------------------------------------ */
/* 6 · the lingering shadow motes                                      */
/* ------------------------------------------------------------------ */

const MOTE_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  attribute float aSprite;

  uniform float uTime;
  uniform float uLife;         // seconds a puff lasts, and its spawn period
  uniform float uHeadSpeed;
  uniform float uLead;         // metres ahead of the front it is laid down (negative: behind the lance)
  uniform float uRadius;       // how far off the axis, metres
  uniform float uCarry;        // fraction of the head's speed it keeps - nearly none, it lingers
  uniform float uRise;         // metres/second it climbs
  uniform float uSpread;       // metres/second it spreads outward, dragged to a stop
  uniform float uDrag;
  uniform float uSize;         // half-size of a puff at birth, metres
  uniform float uGrow;         // ... and how much it swells over its life, x
  uniform float uSizeVariance;
  uniform float uSpin;         // turns/second a puff turns
  uniform float uBright;       // fraction that are bright motes instead of puffs
  uniform float uBrightSize;
  uniform float uStopped;
  uniform float uFade;

  varying vec2  vUv;
  varying float vSeed;
  varying float vLife;
  varying float vBright;
  varying float vViewZ;

  ${noiseGLSL}
  ${VOID_SPINE_GLSL}

  void main() {
    float period = max(uLife, 0.05);
    float phase = hash11(aSprite * 1.37 + uSeed * 0.31);
    float loop = uTime / period + phase;
    float generation = floor(loop);
    float life = fract(loop);
    float age = life * period;

    float base = aSprite * 3.71 + generation * 17.13 + uSeed;
    float r1 = hash11(base + 1.7);
    float r2 = hash11(base + 5.3);
    float r3 = hash11(base + 9.1);
    float r4 = hash11(base + 13.9);
    vec3  r5 = hash31(base + 21.7);
    float r6 = hash11(base + 29.3);

    float flightAge = max(age - uStopped, 0.0);
    float sBirth = uFront + uLead - flightAge * uHeadSpeed;
    float born = step(0.0, sBirth) * step(uStopped, age);
    float slip = (1.0 - uCarry) * uHeadSpeed * flightAge;
    float sNow = uFront + uLead - slip;

    vec3 tangent, side, up;
    voidFrame(sNow, tangent, side, up);
    vec3 root = voidSpine(sNow);

    float bright = step(r6, uBright);

    float a = r1 * TAU;
    vec3 radial = side * cos(a) + up * sin(a);
    float drag = max(uDrag, 0.001);
    float travel = uSpread * (0.3 + r2) * (1.0 - exp(-drag * age)) / drag;

    vec3 center = root
                + radial * (uRadius * (0.2 + r3 * 0.8) * mix(1.0, 1.3, bright) + travel)
                + vec3(0.0, uRise * age * mix(1.0, 1.6, bright), 0.0);

    float roll = mix(1.0 - uSizeVariance, 1.0 + uSizeVariance, r4);
    float puff = uSize * roll * (1.0 + uGrow * smoothstep(0.0, 1.0, life));
    float size = mix(puff, uBrightSize * roll, bright) * born;

    // A puff turns slowly; a mote does not.
    float spin = r5.x * TAU + age * uSpin * TAU * (r5.y - 0.5) * 2.0 * (1.0 - bright);
    float cs = cos(spin);
    float sn = sin(spin);
    vec2 q = vec2(position.x * cs - position.y * sn, position.x * sn + position.y * cs);

    vec4 mv = viewMatrix * vec4(center, 1.0);
    mv.xy += q * size;

    vUv = position.xy;
    vSeed = r5.z * 10.0 + r1;
    vLife = life;
    vBright = bright;
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const MOTE_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform float uErode;        // how much of a puff the noise eats
  uniform float uNoiseScale;
  uniform float uNoiseSpeed;
  uniform float uInnerGlow;    // lit from inside while young
  uniform float uOpacity;
  uniform float uBrightIntensity;
  uniform float uTwinkleSpeed;
  uniform float uSoftFade;
  uniform float uFade;
  uniform vec3  uColorShadow;
  uniform vec3  uColorBody;
  uniform vec3  uColorGlow;
  uniform vec3  uColorBright;

  uniform sampler2D uSceneDepth;
  uniform vec2  uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uShaderIntensity;
  uniform float uGlobalGlow;

  varying vec2  vUv;
  varying float vSeed;
  varying float vLife;
  varying float vBright;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    vec2 p = vUv;
    float d = length(p);
    if (d > 1.0) discard;

    vec2 screenUV = gl_FragCoord.xy / uResolution;
    float depthFade = softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);

    if (vBright > 0.5) {
      /* ---- a mote: a point of light, no coverage ---- */
      float g = exp(-d * d * 9.0);
      float tw = 0.55 + 0.45 * sin(uTime * uTwinkleSpeed * TAU + vSeed * TAU);
      float env = smoothstep(0.0, 0.1, vLife) * (1.0 - smoothstep(0.5, 1.0, vLife));
      vec3 color = uColorBright * g * tw * env * uBrightIntensity * uShaderIntensity * uFade * depthFade;
      if (max(color.r, max(color.g, color.b)) < 0.003) discard;
      gl_FragColor = vec4(color * uGlobalGlow, 0.0);
      return;
    }

    /* ---- a puff: smoke, eaten from its edges in as it dies ---- */
    float disc = 1.0 - smoothstep(0.15, 1.0, d);
    vec3 np = vec3(p * uNoiseScale + vSeed * 7.3, uTime * uNoiseSpeed + vSeed);
    float n = snoise01(np) * 0.65 + snoise01(np * 2.3 + 11.0) * 0.35;
    float erode = uErode + vLife * 0.35;
    float density = disc * smoothstep(erode - 0.25, erode + 0.25, n * (0.55 + 0.45 * disc));

    float env = smoothstep(0.0, 0.12, vLife) * (1.0 - smoothstep(0.45, 1.0, vLife));
    float alpha = clamp(density, 0.0, 1.0) * uOpacity * env * uFade * depthFade;
    if (alpha < 0.003) discard;

    vec3 col = mix(uColorShadow, uColorBody, density);
    col += uColorGlow * pow(density, 2.0) * uInnerGlow * (1.0 - vLife) * uShaderIntensity;

    gl_FragColor = vec4(col * alpha * uGlobalGlow, alpha);
  }
`;

/**
 * @param {object} spine shared uniform block from `createVoidSpineUniforms()`
 * @returns {THREE.ShaderMaterial} with `userData.sync({ headSpeed, stopped, fade })`
 */
export function createVoidMoteMaterial(spine) {
  const material = new ShaderMaterial({
    name: 'VoidMote',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    ...PREMULTIPLIED,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...spine,

      uLife: { value: 2.6 },
      uHeadSpeed: { value: 30 },
      uLead: { value: -4.5 },
      uRadius: { value: 1.2 },
      uCarry: { value: 0.06 },
      uRise: { value: 0.35 },
      uSpread: { value: 0.6 },
      uDrag: { value: 1.5 },
      uSize: { value: 0.9 },
      uGrow: { value: 1.4 },
      uSizeVariance: { value: 0.5 },
      uSpin: { value: 0.08 },
      uBright: { value: 0.3 },
      uBrightSize: { value: 0.07 },
      uStopped: { value: 0 },
      uFade: { value: 1 },

      uErode: { value: 0.5 },
      uNoiseScale: { value: 1.8 },
      uNoiseSpeed: { value: 0.35 },
      uInnerGlow: { value: 0.8 },
      uOpacity: { value: 0.6 },
      uBrightIntensity: { value: 2 },
      uTwinkleSpeed: { value: 3 },
      uSoftFade: { value: 0.6 },
      uColorShadow: { value: new Color(0.05, 0.02, 0.09) },
      uColorBody: { value: new Color(0.2, 0.09, 0.42) },
      uColorGlow: { value: new Color(0.49, 0.27, 0.9) },
      uColorBright: { value: new Color(0.85, 0.77, 1) }
    }),
    vertexShader: MOTE_VERTEX,
    fragmentShader: MOTE_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.voidslash;
    const g = settings.global;
    const u = material.uniforms;

    u.uHeadSpeed.value = state.headSpeed;
    u.uStopped.value = state.stopped;
    u.uFade.value = state.fade;

    u.uLife.value = c.moteLife * g.particleLifetime;
    u.uLead.value = c.moteLead;
    u.uRadius.value = c.moteRadius;
    u.uCarry.value = c.moteCarry;
    u.uRise.value = c.moteRise * g.particleSpeed;
    u.uSpread.value = c.moteDrift * g.particleSpeed;
    u.uDrag.value = c.moteDrag;
    u.uSize.value = c.moteSize * g.particleSize;
    u.uGrow.value = c.moteGrow;
    u.uSizeVariance.value = c.moteSizeVariance * g.randomness;
    u.uSpin.value = c.moteSpin * g.animationSpeed;
    u.uBright.value = c.moteBright;
    u.uBrightSize.value = c.moteBrightSize * g.particleSize;

    u.uErode.value = c.moteErode;
    u.uNoiseScale.value = c.moteNoiseScale * g.noiseFrequency;
    u.uNoiseSpeed.value = c.moteNoiseSpeed * g.noiseSpeed;
    u.uInnerGlow.value = c.moteInnerGlow;
    u.uOpacity.value = c.moteOpacity * g.opacity;
    u.uBrightIntensity.value = c.moteBrightIntensity;
    u.uTwinkleSpeed.value = c.moteTwinkleSpeed * g.noiseSpeed;
    u.uSoftFade.value = c.moteSoftFade;
    u.uColorShadow.value.copy(getColor(c.colorMoteShadow));
    u.uColorBody.value.copy(getColor(c.colorMote));
    u.uColorGlow.value.copy(getColor(c.colorMoteGlow));
    u.uColorBright.value.copy(getColor(c.colorMoteBright));
  };

  return material;
}
