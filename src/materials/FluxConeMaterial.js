import { AdditiveBlending, Color, DoubleSide, ShaderMaterial } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { FLUX_SPINE_GLSL } from './FluxSpine.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * THE CONICAL MESH TRAIL — layer 1 of the breakdown.
 *
 * The funnel **trails**. Its nose is the front of the whole ability and it
 * flares open behind, so the flux ploughs point-first and the trails stream out
 * through its mouth. That is the way round the reference sheet has it, and it
 * is not interchangeable with the other one: a cone whose wide end goes first
 * is an arrowhead with a net stretched over it, no matter how the lattice is
 * tuned, because the silhouette closes on a point in the direction of travel.
 *
 * Drawn as a **mesh** rather than as a glow — rings across it, ribs around it,
 * and helices winding down its length — which is the whole point of the panel.
 * A cone of soft light is a cone of soft light; a cone you can see the
 * *construction* of tells you the thing that made it was built out of
 * something.
 *
 * The geometry it runs on holds no metres (`assets/FluxGeometry.js`): every
 * vertex is `(u, v)` and this stage puts it on the flight path, so the trail
 * bends along the curve the projectile actually took instead of being a rigid
 * cone bolted to its back.
 *
 * Four things stop it reading as a wireframe party hat:
 *
 *  - **the lines are screen-space wide.** A line width in parameter space is a
 *    line that goes fat at the mouth and vanishes at the nose; wireLine
 *    measures its width in pixels off the derivative of the coordinate, so the
 *    mesh reads at the same weight two metres away and twenty-five downrange.
 *  - **the surface is eaten.** An fbm sampled *cyclically* around the cone —
 *    through cos/sin, so there is no seam at v = 0 — punches holes through it,
 *    and the holes travel. Without this the cone is a solid object with a
 *    pattern on it.
 *  - **the rim carries the volume.** A fresnel term brightens the silhouette,
 *    which is the only thing that says "this is a surface enclosing air"
 *    rather than "this is a decal shaped like a triangle".
 *  - **it dies before it ends.** Energy falls off toward the mouth and the
 *    erosion bites harder there, so the funnel dissolves into the trail behind
 *    it instead of closing on a hoop.
 *
 * Every dimension is resolved against `settings.flux` each frame, so dragging
 * `coneLength` re-scales a trail that is already in the air.
 */

const CONE_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform float uSpan;         // metres of path the funnel reaches back over
  uniform float uRadius;       // radius at the trailing mouth, metres
  uniform float uTip;          // radius at the leading nose, × the mouth's
  uniform float uFlare;        // <1 trumpet, 1 straight cone, >1 horn
  uniform float uWobble;       // how far the surface is pushed off a clean cone
  uniform float uWobbleScale;
  uniform float uWobbleSpeed;
  uniform float uBurst;        // 0..1 — the funnel blowing open on impact
  uniform float uBurstFlare;

  varying float vU;
  varying float vV;
  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vViewZ;

  ${noiseGLSL}
  ${FLUX_SPINE_GLSL}

  /**
   * Radius profile, as a fraction of uRadius.
   *
   * u = 0 is the **leading nose** and u = 1 the trailing mouth, so the funnel
   * ploughs point-first and flares open behind it — which is the way round
   * assets/FluxGeometry.js has always described this parameter, and the way
   * round the sheet has it. A cone whose wide end goes first is an arrowhead
   * with a net on it; a cone that opens behind is a wake, and the trails leave
   * through the mouth rather than out of a spike.
   */
  float coneProfile(float u) {
    return mix(uTip, 1.0, pow(clamp(u, 0.0, 1.0), max(uFlare, 0.05)));
  }

  void main() {
    float u = position.x;
    float v = position.y;
    vU = u;
    vV = v;

    float s = uFront - u * uSpan;

    vec3 tangent, side, up;
    fluxFrame(s, tangent, side, up);
    vec3 axis = fluxSpine(s);

    float angle = v * TAU;
    vec3 radial = side * cos(angle) + up * sin(angle);

    // The chaos in the surface. Sampled through cos/sin of the angle so the
    // field is genuinely cyclic and there is no seam where v wraps.
    float wob = 1.0 + uWobble * snoise(vec3(
      cos(angle) * uWobbleScale,
      sin(angle) * uWobbleScale,
      u * uWobbleScale * 1.5 - uTime * uWobbleSpeed + uSeed
    ));

    float profile = coneProfile(u);
    // The mouth is what blows open on the strike; the nose barely moves.
    float flare = 1.0 + uBurst * uBurstFlare * (0.35 + 0.65 * u);
    float r = uRadius * profile * wob * flare;

    // Analytic normal. The surface is axis(s) + radial·r(u), so its two
    // tangents cross to span·radial + (dr/du)·tangent — no second and third
    // evaluation of the path needed. dr/du is taken off the profile alone: the
    // wobble moves the surface far less than it would move a difference.
    const float H = 0.01;
    float drdu = uRadius * (coneProfile(u + H) - coneProfile(u - H)) / (2.0 * H);
    // Named nrm, not normal: three declares a normal attribute in every vertex
    // prefix, and shadowing it here would work but read as a mistake.
    vec3 nrm = normalize(max(uSpan, 0.05) * radial + drdu * tangent);

    vec3 world = axis + radial * r;
    vNormalW = nrm;
    vViewDir = cameraPosition - world;

    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const CONE_FRAGMENT = /* glsl */ `
  #define TAU 6.283185307179586

  uniform float uTime;
  uniform float uSeed;
  uniform float uRings;        // rings across the funnel
  uniform float uRibs;         // ribs around it
  uniform float uSpiralArms;   // helices wound down it
  uniform float uSpiralTurns;  // turns each makes over the length
  uniform float uSpiralSpin;   // turns/second they roll
  uniform float uFlow;         // rings/second travelling toward the head
  uniform float uWire;         // line width, pixels
  uniform float uSpiralWire;
  uniform float uMesh;         // strength of the rings and ribs
  uniform float uSpiral;       // strength of the helices
  uniform float uFill;         // the wash between the lines
  uniform float uFresnel;
  uniform float uFresnelPower;
  uniform float uErode;
  uniform float uErodeScale;
  uniform float uErodeSpeed;
  uniform float uHead;         // how far back the white leading rim reaches
  uniform float uNoseFade;     // how much of the leading point is capped off
  uniform float uTailFade;     // where along u the funnel starts dying
  uniform float uPulse;
  uniform float uPulseFreq;
  uniform float uPulseSpeed;
  uniform float uBurst;
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

  varying float vU;
  varying float vV;
  varying vec3  vNormalW;
  varying vec3  vViewDir;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  /**
   * One line of a repeating family, px pixels wide.
   *
   * The width is taken from the derivative of the *coordinate* rather than of
   * the folded triangle wave: fwidth() across the fold of a fract() reads as a
   * whole period and would draw a bright band there every time.
   */
  float wireLine(float q, float px) {
    float x = abs(fract(q + 0.5) - 0.5) * 2.0;
    float w = max(fwidth(q) * 2.0 * max(px, 0.05), 1e-4);
    return 1.0 - smoothstep(0.0, w, x);
  }

  void main() {
    float angle = vV * TAU;

    /* ---- the mesh ---- */
    float rings = wireLine(vU * uRings - uTime * uFlow, uWire);
    float ribs = wireLine(vV * uRibs, uWire);
    float spiral = wireLine(vV * uSpiralArms + vU * uSpiralTurns - uTime * uSpiralSpin, uSpiralWire);
    float mesh = clamp((rings + ribs) * uMesh + spiral * uSpiral, 0.0, 3.0);

    /* ---- the surface it is drawn on, eaten into ---- */
    // Cyclic in v for the same reason the vertex stage is: a seam here would
    // run the whole length of the funnel.
    float ero = fbm3(vec3(
      cos(angle) * uErodeScale,
      sin(angle) * uErodeScale,
      vU * uErodeScale * 1.6 - uTime * uErodeSpeed + uSeed
    )) * 0.5 + 0.5;
    // Bites harder toward the mouth, so the wide end comes apart where it hands
    // over to the trails rather than ending on a shape.
    float bite = mix(0.5, 1.0, vU) * uErode;
    float surface = clamp(1.0 - bite * (1.0 - ero) * 2.0, 0.0, 1.0);

    /* ---- the volume ---- */
    float fres = fresnelTerm(vViewDir, vNormalW, uFresnelPower, 1.0);

    /* ---- charge running up the funnel toward the head ---- */
    float phase = fract(vU * uPulseFreq + uTime * uPulseSpeed + vV * 0.21);
    float pulse = pow(1.0 - abs(phase * 2.0 - 1.0), 5.0) * uPulse;

    float energy = (mesh * (1.0 + pulse) + uFill * (0.35 + 0.65 * ero) + fres * uFresnel) * surface;
    // Dead at BOTH ends. At the nose because every ring, rib and helix
    // converges on u = 0, and additive lines meeting at a point make a star
    // there the size of the mouth; capping it leaves a soft leading tip.
    energy *= smoothstep(0.0, max(uNoseFade, 1e-3), vU);
    // At the mouth because a lattice that runs right to u = 1 closes on a crisp
    // ellipse, and a crisp ellipse across the back of the body reads as a hoop
    // the ability is towing. Dissolving it lets the ribbons leave through the
    // mouth instead of past a rim.
    energy *= 1.0 - smoothstep(uTailFade, 1.0, vU);
    // ... and it tears itself apart on the strike.
    energy *= 1.0 - smoothstep(0.0, 1.0, uBurst) * smoothstep(0.15, 0.9, vU * (0.4 + ero));

    if (energy < 0.002) discard;

    vec3 color = mix(uColorBody, uColorTail, smoothstep(0.2, 0.9, vU));
    // White at the leading rim, where the thing is actually going through air.
    // Only the leading rim and the charge go white. Letting the mesh term push
    // the colour was the difference between a crimson funnel and a fishing net:
    // every line it drew went to the core colour at once.
    float hot = (1.0 - smoothstep(0.0, max(uHead, 0.01), vU)) + pulse * 0.8 + mesh * 0.06;
    color = mix(color, uColorCore, clamp(hot, 0.0, 1.0));
    color *= energy * uIntensity * uShaderIntensity;

    float alpha = clamp(energy, 0.0, 1.0) * uOpacity * uFade;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.004) discard;

    color *= uGlobalGlow;
    // Rolled off, or the crossings where three families of line meet clip to
    // white and the mesh stops being legible exactly where it is densest.
    color /= 1.0 + color * 0.16;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * @param {object} spine shared uniform block from `createFluxSpineUniforms()`
 * @returns {THREE.ShaderMaterial} with `userData.sync({ span, burst, fade })`
 */
export function createFluxConeMaterial(spine) {
  const material = new ShaderMaterial({
    name: 'FluxCone',
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: AdditiveBlending,
    side: DoubleSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...spine,

      uSpan: { value: 6 },
      uRadius: { value: 1.1 },
      uTip: { value: 0.12 },
      uFlare: { value: 1.15 },
      uWobble: { value: 0.16 },
      uWobbleScale: { value: 1.6 },
      uWobbleSpeed: { value: 1.1 },
      uBurst: { value: 0 },
      uBurstFlare: { value: 0.8 },

      uRings: { value: 22 },
      uRibs: { value: 16 },
      uSpiralArms: { value: 3 },
      uSpiralTurns: { value: 5 },
      uSpiralSpin: { value: 0.5 },
      uFlow: { value: 1.6 },
      uWire: { value: 1.1 },
      uSpiralWire: { value: 1.8 },
      uMesh: { value: 0.55 },
      uSpiral: { value: 1.1 },
      uFill: { value: 0.06 },
      uFresnel: { value: 0.5 },
      uFresnelPower: { value: 2.6 },
      uErode: { value: 0.55 },
      uErodeScale: { value: 1.7 },
      uErodeSpeed: { value: 1.2 },
      uHead: { value: 0.12 },
      uNoseFade: { value: 0.06 },
      uTailFade: { value: 0.6 },
      uPulse: { value: 1.1 },
      uPulseFreq: { value: 2.2 },
      uPulseSpeed: { value: 1.3 },
      uIntensity: { value: 1.5 },
      uOpacity: { value: 0.85 },
      uSoftFade: { value: 0.4 },
      uFade: { value: 1 },
      uColorCore: { value: new Color(1, 1, 1) },
      uColorBody: { value: new Color(1, 0.16, 0.3) },
      uColorTail: { value: new Color(0.36, 0.06, 0.17) }
    }),
    vertexShader: CONE_VERTEX,
    fragmentShader: CONE_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.flux;
    const g = settings.global;
    const u = material.uniforms;

    u.uSpan.value = state.span;
    u.uBurst.value = state.burst;
    u.uFade.value = state.fade;

    u.uRadius.value = c.coneRadius;
    u.uTip.value = c.coneTip;
    u.uFlare.value = c.coneFlare;
    u.uWobble.value = c.coneWobble * g.noiseStrength;
    u.uWobbleScale.value = c.coneWobbleScale * g.noiseFrequency;
    u.uWobbleSpeed.value = c.coneWobbleSpeed * g.noiseSpeed;
    u.uBurstFlare.value = c.coneBurstFlare * g.explosionIntensity;

    // Rounded: the ribs and the helices wrap a closed circle, and a fractional
    // count puts a discontinuity down the seam where v wraps back to 0.
    u.uRings.value = Math.round(c.coneRings);
    u.uRibs.value = Math.round(c.coneRibs);
    u.uSpiralArms.value = Math.round(c.coneSpiralArms);
    u.uSpiralTurns.value = c.coneSpiralTurns;
    u.uSpiralSpin.value = c.coneSpiralSpin * g.animationSpeed;
    u.uFlow.value = c.coneFlow * g.noiseSpeed;
    u.uWire.value = c.coneWire;
    u.uSpiralWire.value = c.coneSpiralWire;
    u.uMesh.value = c.coneMesh;
    u.uSpiral.value = c.coneSpiral;
    u.uFill.value = c.coneFill;
    u.uFresnel.value = c.coneFresnel * g.fresnel;
    u.uFresnelPower.value = c.coneFresnelPower;
    u.uErode.value = c.coneErode * g.noiseStrength;
    u.uErodeScale.value = c.coneErodeScale * g.noiseFrequency;
    u.uErodeSpeed.value = c.coneErodeSpeed * g.noiseSpeed;
    u.uHead.value = c.coneHead;
    u.uNoseFade.value = c.coneNoseFade;
    u.uTailFade.value = c.coneTailFade;
    u.uPulse.value = c.conePulse;
    u.uPulseFreq.value = c.conePulseFreq;
    u.uPulseSpeed.value = c.conePulseSpeed * g.noiseSpeed;
    u.uIntensity.value = c.coneIntensity;
    u.uOpacity.value = c.coneOpacity * g.opacity;
    u.uSoftFade.value = c.coneSoftFade;

    u.uColorCore.value.copy(getColor(c.colorConeCore));
    u.uColorBody.value.copy(getColor(c.colorCone));
    u.uColorTail.value.copy(getColor(c.colorConeTail));
  };

  return material;
}
