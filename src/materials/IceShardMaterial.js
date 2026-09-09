import { Color, FrontSide, NormalBlending, ShaderMaterial } from 'three';
import { noiseGLSL } from '../shaders/lib/noise.glsl.js';
import { commonGLSL } from '../shaders/lib/common.glsl.js';
import { sharedUniforms } from '../core/FrameUniforms.js';
import { TWILIGHT_SPINE_GLSL } from './TwilightSpine.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';

/**
 * STYLIZED ICE PARTICLES — panel 2 of the breakdown.
 *
 * The sheet's crystals are **solids**, and everything that makes them read that
 * way is a consequence of having a real normal per facet:
 *
 *  1. **flat, posterised facets.** Not smooth shading with a gradient across
 *     them — flat values that *step*. The geometry is non-indexed with face
 *     normals (see `assets/TwilightGeometry.js`), and the diffuse term is
 *     quantised into `uBands` steps on top of that. Two crystals side by side
 *     at slightly different angles land on different steps, which is what makes
 *     a cloud of them read as many objects instead of one glittering mass.
 *  2. **a hairline on every edge.** Barycentric coordinates from the buffer,
 *     `fwidth` for the width, so the line is a constant number of *pixels*
 *     regardless of how close the crystal is. This is the single detail the
 *     reference is built on and the one a sprite cannot fake at any resolution.
 *  3. **dispersion on the silhouette.** The fresnel term is evaluated at three
 *     different exponents for R, G and B, so grazing edges split cyan on one
 *     side and violet on the other. Two lines, and it is the whole difference
 *     between "ice" and "blue plastic".
 *  4. **light through the thin ends.** A back-lit term that only survives where
 *     the facet points away from the key, tinted toward the core colour. Ice is
 *     translucent, and a crystal with a black shadow side is a rock.
 *  5. **a glint that twinkles.** A tight specular lobe gated by a noise on the
 *     facet normal and the clock, so individual facets catch and lose the light
 *     as the crystal tumbles rather than the whole cloud shimmering together.
 *
 * ## Where each crystal is, without a single byte of CPU state
 *
 * The crystals are the **wake**: struck off at the burning tip and left behind,
 * fanning wider the further back they get. That is the way round the composite
 * has it, and the only way round that makes sense of the shape, because debris
 * spreads out behind a moving thing rather than in front of it.
 *
 * Every shard is a pure function of its instance index, the clock, how far the
 * head has flown and `settings.twilight`. Slot `i` runs its own loop of length
 * `uLife`, and the moment it is reborn it is struck off the head — so the
 * question "where was the head `age` seconds ago" has to be answerable in the
 * vertex shader. It is, exactly, because the spine is a pure function of
 * distance and distance is speed times time:
 *
 *     s_birth = uFront − age · uHeadSpeed
 *
 * That momentum is kept **along the path** rather than as a world vector: a
 * crystal holding `uCarry` of the head's speed is slipping back down the spine
 * at the remaining fraction, which is one subtraction and stays correct however
 * the path bends. On top of that slip it flies its own ballistic — an outward
 * launch, drag integrated in closed form (`v/k · (1 − e^{−kt})`), and a little
 * gravity so the wake sags. No history buffer, no per-frame writes, nothing to
 * keep in sync — and dragging `iceThrow` while the cast is paused re-flies
 * every crystal already in the air.
 *
 * Rolls are re-drawn per *generation* (`floor` of the same loop), so a slot does
 * not spit the same crystal down the same path twice.
 *
 * ## Why it writes depth
 *
 * Alone among the transparent layers in this project, this one does. Two
 * hundred crystals in one draw call have to occlude each other or the cloud
 * reads as a flat decal, and the depth buffer is the only thing that sorts
 * within a single instanced draw. It is affordable here because a crystal never
 * fades: it is born small, snaps to size and **shrinks** away again, so alpha
 * stays at one and there are no half-written depth values to go wrong.
 */

const ICE_VERTEX = /* glsl */ `
  #define TAU 6.283185307179586

  attribute float aShard;
  attribute vec3  aBary;
  attribute float aFacing;

  uniform float uTime;
  uniform float uLife;        // seconds one crystal lasts, and its spawn period
  uniform float uHeadSpeed;   // metres/second the head is making — unwinds history
  uniform float uLead;        // metres ahead of the head they are struck off
  uniform float uRadius;      // how far off the axis they are born, metres
  uniform float uThrow;       // launch speed, metres/second
  uniform float uForward;     // how much of that is along the heading ...
  uniform float uSpread;      // ... and how much is radial
  uniform float uCarry;       // fraction of the head's own speed they keep
  uniform float uDrag;
  uniform float uGravity;
  uniform float uSize;        // metres across, before the per-crystal roll
  uniform float uSizeVariance;
  uniform float uLong;        // how slender the slenderest crystal is
  uniform float uSpin;        // tumble, turns/second
  uniform float uGrowIn;      // fraction of life spent snapping to size
  uniform float uShrinkOut;   // ... and where the shrink starts
  uniform float uBurst;       // 0..1, the strike
  uniform float uBurstThrow;  // extra launch speed it adds, x
  uniform float uBurstSize;   // ... and extra size
  uniform float uFade;

  varying vec3  vBary;
  varying vec3  vNormal;
  varying vec3  vWorld;
  varying float vAxis;        // the vertex's height on the crystal's long axis
  varying float vFacing;      // 0 lower pyramid, 1 upper
  varying float vLife;        // 0..1 through this crystal's life
  varying float vRoll;        // per-crystal colour die
  varying float vViewZ;

  ${noiseGLSL}
  ${TWILIGHT_SPINE_GLSL}

  /** Rodrigues, as a matrix — the crystal tumbles about one fixed axis. */
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

  void main() {
    float period = max(uLife, 0.05);
    // Each slot on its own phase, so the field does not pulse in lockstep.
    float phase = hash11(aShard * 1.37 + uSeed * 0.31);
    float loop = uTime / period + phase;
    float generation = floor(loop);
    float life = fract(loop);
    float age = life * period;

    // Re-rolled every time the slot recycles: a crystal that flies the same arc
    // every 1.2 seconds reads as a looping animation, which is exactly what it is.
    float base = aShard * 3.71 + generation * 17.13 + uSeed;
    float r1 = hash11(base + 1.7);
    float r2 = hash11(base + 5.3);
    float r3 = hash11(base + 9.1);
    float r4 = hash11(base + 13.9);
    vec3  r5 = hash31(base + 21.7);

    /* ---- where the head was when this crystal was struck off it ---- */
    float sBirth = uFront + uLead - age * uHeadSpeed;
    // Behind the caster is *before the cast*, and nothing was struck off then.
    // Without this the whole field — every slot older than the shot itself —
    // clamps onto the origin and piles up in the caster's hand for the first
    // second of every cast. Gated off, the cloud fills in as the shot flies,
    // which is the honest reading and the one the sheet shows.
    float born = step(0.0, sBirth);

    // Momentum is kept *along the path*, not as a world vector. A crystal that
    // keeps uCarry of the head's speed is simply slipping back down the spine
    // at the remaining fraction, so this is one subtraction. Carrying it as
    // tangent(sBirth) * uCarry * uHeadSpeed * age instead — the obvious way —
    // is only right on a straight path: on the rise out of the hand that
    // tangent points nearly twenty degrees up, and the oldest crystals get
    // thrown along it into the sky.
    float slip = (1.0 - uCarry) * uHeadSpeed * age;
    float sNow = uFront + uLead - slip;

    vec3 tangent, side, up;
    twilightFrame(sNow, tangent, side, up);
    vec3 root = twilightSpine(sNow);

    /* ---- its own flight since ---- */
    float a = r1 * TAU;
    vec3 radial = side * cos(a) + up * sin(a);
    vec3 launch = normalize(tangent * uForward + radial * uSpread + 1e-5);

    float speed = uThrow * (0.35 + r2 * 1.3) * (1.0 + uBurst * uBurstThrow);
    float drag = max(uDrag, 0.001);
    // Closed-form drag: ∫v·e^(−kt) dt. Crystals leap out and settle, which is
    // what shattering looks like; linear motion looks like they were placed.
    float travel = speed * (1.0 - exp(-drag * age)) / drag;

    vec3 center = root
                + radial * uRadius * (0.15 + r3)
                + launch * travel
                - vec3(0.0, 0.5 * uGravity * age * age, 0.0);

    /* ---- size: born small, snaps out, shrinks away ---- */
    // The fade is carried by *scale*, never by alpha — see the header. r4 is
    // squared so most crystals are small and a few are large, which is the size
    // distribution on the sheet.
    float grow = smoothstep(0.0, max(uGrowIn, 0.01), life);
    float die = 1.0 - smoothstep(uShrinkOut, 1.0, life);
    float roll = mix(1.0 - uSizeVariance, 1.0 + uSizeVariance, r4 * r4);
    float size = uSize * roll * grow * die * uFade * born * (1.0 + uBurst * uBurstSize);

    // Slender ones are longer and narrower at once, so the family runs from a
    // fat gem to a splinter without the buffer knowing about either.
    float slender = mix(0.0, 1.0, r3);
    // Narrowed only mildly against the stretch. At half width against 1.8x
    // height the slender roll produced a blade, and a blade seen flat-on is a
    // shard of glass rather than a gem.
    vec3 scale = vec3(size * mix(1.0, 0.72, slender),
                      size * mix(0.85, uLong, slender),
                      size * mix(1.0, 0.72, slender));

    /* ---- tumble ---- */
    vec3 axis = normalize(r5 * 2.0 - 1.0 + vec3(1e-4));
    mat3 rot = rotationAbout(axis, (0.4 + r2 * 1.4) * uSpin * TAU * age + r1 * TAU);

    vec3 world = center + rot * (position * scale);
    // Inverse-transpose of a diagonal scale is its reciprocal — one divide
    // keeps the facet normals honest under the slenderness stretch.
    vec3 worldNormal = normalize(rot * (normal / max(scale, vec3(1e-5))));

    vBary = aBary;
    vNormal = worldNormal;
    vWorld = world;
    vAxis = position.y;
    vFacing = aFacing;
    vLife = life;
    vRoll = r2;

    vec4 mv = viewMatrix * vec4(world, 1.0);
    vViewZ = mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const ICE_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform float uBands;        // steps the diffuse term is quantised into
  uniform float uPosterize;    // how far toward those steps it is pushed
  uniform float uScreenKey;    // how far the key swings from the sun to the camera
  uniform float uAmbient;
  uniform float uRim;
  uniform float uRimPower;
  uniform float uDispersion;
  uniform float uEdge;         // the hairline along every facet boundary
  uniform float uEdgeWidth;    // ... in pixels
  uniform float uCore;         // the light inside it
  uniform float uTip;          // and how much brighter the two points are
  uniform float uTipStart;
  uniform float uBack;         // light coming through the shadow side
  uniform float uBackPower;
  uniform float uSpecular;
  uniform float uGloss;
  uniform float uTwinkle;      // how hard the glint blinks
  uniform float uTwinkleSpeed;
  uniform float uFlash;        // incandescence at the instant it is struck off
  uniform float uFlashLife;
  uniform float uIntensity;
  uniform float uRolloff;
  uniform float uOpacity;
  uniform float uSoftFade;
  uniform float uFade;
  uniform vec3  uColorDeep;    // the facet turned away from the key
  uniform vec3  uColorBody;
  uniform vec3  uColorLit;     // ... and the one facing it
  uniform vec3  uColorCore;    // the light inside, and the edges
  uniform vec3  uColorFlash;

  uniform vec3  uLightDir;
  uniform sampler2D uSceneDepth;
  uniform vec2  uResolution;
  uniform float uCameraNear;
  uniform float uCameraFar;
  uniform float uShaderIntensity;
  uniform float uGlobalGlow;

  varying vec3  vBary;
  varying vec3  vNormal;
  varying vec3  vWorld;
  varying float vAxis;
  varying float vFacing;
  varying float vLife;
  varying float vRoll;
  varying float vViewZ;

  ${noiseGLSL}
  ${commonGLSL}

  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(cameraPosition - vWorld);
    vec3 L = normalize(uLightDir);

    /* ================= the body: matter, and it stays matter ============= */

    /* ---- 1 · the key, swung toward the camera ---- */
    // The sheet is an illustration and its crystals are lit from the upper left
    // *in screen space*: every one of them shows a lit face and a shadow face,
    // whatever way up it happens to be.
    //
    // That is not decoration, it is load-bearing. A bipyramid's facets sit
    // symmetrically about its long axis, so under the scene's overhead sun the
    // four upper facets land on nearly the same lambert value, posterise onto
    // the same band, and the crystal draws as one flat tone — a paper cut-out.
    // Blending the key toward a camera-relative direction guarantees a value
    // range across the facets of every crystal from every angle, which is the
    // whole reason the reference's crystals read as solids.
    //
    // The camera's basis is the first two columns of the view matrix read as
    // rows; no extra uniform needed.
    vec3 camRight = normalize(vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]));
    vec3 camUp = normalize(vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]));
    vec3 screenKey = normalize(-camRight * 0.55 + camUp * 0.72 + V * 0.4);
    vec3 K = normalize(mix(L, screenKey, clamp(uScreenKey, 0.0, 1.0)));

    /* ---- 2 · flat facets, posterised. This is the layer. ---- */
    // Half-lambert, so the shadow side keeps a value and the crystal is still
    // readable in silhouette. Then quantised: the steps are the style.
    float lambert = dot(N, K) * 0.5 + 0.5;
    float steps = max(uBands, 1.0);
    float banded = floor(lambert * steps + 0.5) / steps;
    float lit = mix(lambert, banded, uPosterize);

    // The stops are placed *between* the posterised levels, not across them.
    // At three bands the quantiser can only return 0, 1/3, 2/3 or 1, so putting
    // each smoothstep in the gap between two of those makes the three tones
    // come out flat and distinct — which is the look. Ramps that straddle a
    // level smear it back into a gradient and undo the posterisation.
    vec3 color = mix(uColorDeep, uColorBody, smoothstep(0.34, 0.66, lit));
    color = mix(color, uColorLit, smoothstep(0.68, 0.99, lit));
    color += uColorDeep * uAmbient;

    /* ---- 2 · the prism terms, kept quiet ---- */
    float facing = clamp(dot(N, V), 0.0, 1.0);
    float f = 1.0 - facing;
    // One exponent per channel. Grazing facets go cyan on one flank and violet
    // on the other, which is the whole of "this is a prism".
    vec3 rim = vec3(
      pow(f, max(uRimPower * (1.0 + uDispersion * 0.45), 0.05)),
      pow(f, max(uRimPower, 0.05)),
      pow(f, max(uRimPower * (1.0 - uDispersion * 0.35), 0.05))
    );
    color += rim * uColorCore * uRim;

    /* ---- 3 · light through the thin side ---- */
    float back = pow(clamp(dot(-N, K), 0.0, 1.0), max(uBackPower, 0.1));
    color += uColorCore * back * uBack;

    /* ---- the light inside, pooled toward the two points ---- */
    float tip = smoothstep(uTipStart, 1.0, abs(vAxis));
    color += uColorCore * (uCore * facing * 0.5 + uTip * tip);

    color *= uIntensity * uShaderIntensity;

    /* ---- 4 · hold the body under the bloom threshold ---- */
    // Everything above this line is the crystal's body, and the body has to
    // stay matter. The sheet's crystals are lit solids with hard edges, not
    // light sources: the moment the body blooms, the silhouette softens and the
    // black between crystals fills with haze — which is exactly what made every
    // earlier pass read as glowing debris instead of ice. settings.post
    // thresholds bloom at 0.88, so this compression is tuned to land the
    // brightest facet just under it while keeping the shadow facet's hue.
    color /= 1.0 + color * uRolloff;

    /* ============ and the two things that ARE allowed to bloom =========== */

    /* ---- 5 · the hairline along every facet boundary ---- */
    // Constant width in *pixels*: fwidth gives the barycentric's screen-space
    // rate of change, so a crystal at two metres and one at twenty carry the
    // same line. This is why it cannot be a texture. Added after the roll-off
    // so it is the crisp thing on top of a matte body, which is the order the
    // sheet draws it in.
    float e = min(min(vBary.x, vBary.y), vBary.z);
    float w = fwidth(e) * max(uEdgeWidth, 0.1);
    float edge = 1.0 - smoothstep(0.0, w, e);
    color += uColorCore * edge * uEdge;

    /* ---- 6 · the glint, blinking per facet ---- */
    vec3 H = normalize(K + V);
    float spec = pow(clamp(dot(N, H), 0.0, 1.0), max(uGloss, 1.0));
    // Gated on the facet's own normal and the clock, so facets catch the key
    // one at a time as the crystal turns rather than the cloud flaring at once.
    float twinkle = snoise01(N * 6.0 + vec3(vRoll * 30.0, uTime * uTwinkleSpeed, 0.0));
    spec *= mix(1.0, smoothstep(0.35, 0.95, twinkle), uTwinkle);
    color += vec3(1.0) * spec * uSpecular;

    /* ---- struck off white-hot ---- */
    float flash = pow(1.0 - clamp(vLife / max(uFlashLife, 0.01), 0.0, 1.0), 3.0);
    color = mix(color, uColorFlash, clamp(flash * uFlash, 0.0, 1.0));

    // The crystal never fades — it shrinks (see the header), so alpha is flat
    // and the depth buffer can be trusted to sort the cloud against itself.
    float alpha = uOpacity * uFade;
    vec2 screenUV = gl_FragCoord.xy / uResolution;
    alpha *= softFade(uSceneDepth, screenUV, vViewZ, uCameraNear, uCameraFar, uSoftFade);
    if (alpha < 0.02) discard;

    color *= uGlobalGlow;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * @param {object} spine shared uniform block from `createTwilightSpineUniforms()`
 * @returns {THREE.ShaderMaterial} with `userData.sync({ headSpeed, burst, fade })`
 */
export function createIceShardMaterial(spine) {
  const material = new ShaderMaterial({
    name: 'IceShard',
    transparent: true,
    // The one transparent layer in this project that writes depth. See header.
    depthWrite: true,
    depthTest: true,
    blending: NormalBlending,
    side: FrontSide,
    toneMapped: false,
    uniforms: sharedUniforms({
      ...spine,

      uLife: { value: 1.1 },
      uHeadSpeed: { value: 26 },
      uLead: { value: 1.2 },
      uRadius: { value: 0.35 },
      uThrow: { value: 3.4 },
      uForward: { value: 0.55 },
      uSpread: { value: 1 },
      uCarry: { value: 0.92 },
      uDrag: { value: 1.6 },
      uGravity: { value: 1.4 },
      uSize: { value: 0.3 },
      uSizeVariance: { value: 0.7 },
      uLong: { value: 2.1 },
      uSpin: { value: 0.55 },
      uGrowIn: { value: 0.1 },
      uShrinkOut: { value: 0.6 },
      uBurst: { value: 0 },
      uBurstThrow: { value: 2.2 },
      uBurstSize: { value: 0.35 },
      uFade: { value: 1 },

      uBands: { value: 4 },
      uPosterize: { value: 0.72 },
      uScreenKey: { value: 0.75 },
      uAmbient: { value: 0.35 },
      uRim: { value: 1.5 },
      uRimPower: { value: 2.2 },
      uDispersion: { value: 0.6 },
      uEdge: { value: 1.6 },
      uEdgeWidth: { value: 1.4 },
      uCore: { value: 0.5 },
      uTip: { value: 0.7 },
      uTipStart: { value: 0.45 },
      uBack: { value: 0.8 },
      uBackPower: { value: 2 },
      uSpecular: { value: 1.4 },
      uGloss: { value: 26 },
      uTwinkle: { value: 0.7 },
      uTwinkleSpeed: { value: 1.6 },
      uFlash: { value: 0.85 },
      uFlashLife: { value: 0.16 },
      uIntensity: { value: 1.15 },
      uRolloff: { value: 0.55 },
      uOpacity: { value: 1 },
      uSoftFade: { value: 0.2 },
      uColorDeep: { value: new Color(0.09, 0.24, 0.5) },
      uColorBody: { value: new Color(0.42, 0.72, 0.98) },
      uColorLit: { value: new Color(0.86, 0.96, 1) },
      uColorCore: { value: new Color(0.72, 0.94, 1) },
      uColorFlash: { value: new Color(1, 1, 1) }
    }),
    vertexShader: ICE_VERTEX,
    fragmentShader: ICE_FRAGMENT
  });

  material.userData.sync = (state) => {
    const c = settings.twilight;
    const g = settings.global;
    const u = material.uniforms;

    u.uHeadSpeed.value = state.headSpeed;
    u.uBurst.value = state.burst;
    u.uFade.value = state.fade;

    u.uLife.value = c.iceLife * g.particleLifetime;
    u.uLead.value = c.iceLead;
    u.uRadius.value = c.iceRadius;
    u.uThrow.value = c.iceThrow * g.particleSpeed;
    u.uForward.value = c.iceForward;
    u.uSpread.value = c.iceSpread;
    u.uCarry.value = c.iceCarry;
    u.uDrag.value = c.iceDrag;
    u.uGravity.value = c.iceGravity;
    u.uSize.value = c.iceSize * g.particleSize;
    u.uSizeVariance.value = c.iceSizeVariance * g.randomness;
    u.uLong.value = c.iceLong;
    u.uSpin.value = c.iceSpin * g.animationSpeed;
    u.uGrowIn.value = c.iceGrowIn;
    u.uShrinkOut.value = c.iceShrinkOut;
    u.uBurstThrow.value = c.iceBurstThrow * g.explosionIntensity;
    u.uBurstSize.value = c.iceBurstSize;

    u.uBands.value = c.iceBands;
    u.uPosterize.value = c.icePosterize;
    u.uScreenKey.value = c.iceScreenKey;
    u.uAmbient.value = c.iceAmbient;
    u.uRim.value = c.iceRim * g.fresnel;
    u.uRimPower.value = c.iceRimPower;
    u.uDispersion.value = c.iceDispersion;
    u.uEdge.value = c.iceEdge;
    u.uEdgeWidth.value = c.iceEdgeWidth;
    u.uCore.value = c.iceCore;
    u.uTip.value = c.iceTip;
    u.uTipStart.value = c.iceTipStart;
    u.uBack.value = c.iceBack;
    u.uBackPower.value = c.iceBackPower;
    u.uSpecular.value = c.iceSpecular;
    u.uGloss.value = c.iceGloss;
    u.uTwinkle.value = c.iceTwinkle * g.randomness;
    u.uTwinkleSpeed.value = c.iceTwinkleSpeed * g.noiseSpeed;
    u.uFlash.value = c.iceFlash;
    u.uFlashLife.value = c.iceFlashLife;
    u.uIntensity.value = c.iceIntensity;
    u.uRolloff.value = c.iceRolloff;
    u.uOpacity.value = c.iceOpacity * g.opacity;
    u.uSoftFade.value = c.iceSoftFade;

    u.uColorDeep.value.copy(getColor(c.colorIceDeep));
    u.uColorBody.value.copy(getColor(c.colorIce));
    u.uColorLit.value.copy(getColor(c.colorIceLit));
    u.uColorCore.value.copy(getColor(c.colorIceEdge));
    u.uColorFlash.value.copy(getColor(c.colorIceFlash));
  };

  return material;
}
