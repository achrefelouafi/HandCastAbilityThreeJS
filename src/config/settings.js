/**
 * settings.js — the single source of truth for every tweakable value in the sandbox.
 *
 * Nothing in the renderer owns state that lives here: shaders, particle systems,
 * lights and post processing all *read* these objects every frame. That is what
 * makes the real-time editor work without rebuilding anything — mutating a field
 * is immediately visible on screen, including on a prison that is already
 * standing, and including while the clock is paused (`P`), which is when the
 * shapes are actually worth tuning.
 *
 * The one rule that keeps that promise: a system may only ever *sample* these
 * values. It must never copy one into a record at spawn time and read it back
 * later — see `CorruptedShardAbility`, whose cast captures nothing but a seed
 * and a handful of timestamps, and resolves every metre, radian and second
 * against this file each frame.
 *
 * Conventions
 *  - Colours are stored as `#rrggbb` strings so lil-gui can bind them directly.
 *    Use `utils/color.js#getColor()` to read them as a cached THREE.Color.
 *  - `global` holds multipliers that scale everything at once (1 = neutral).
 *  - The per-ability blocks (`flux`, `twilight`, `voidslash`, `drone`, …) hold absolute values.
 *
 * Every ability block is keyed by its id in `ELEMENTS`, and the shared systems
 * that need to know about "the ability the player is currently holding" — the
 * aim controller, the cooldown, the HUD — look it up as `settings[element]`.
 * The four fields they rely on being present are `range`, `minRange`, `speed`
 * and `cooldown`; everything else in a block is that ability's own business.
 * A **far cast** (`CastShape.ZONE`, declared in `ELEMENT_META`) adds a fifth:
 * `zoneRadius`, the footprint the circle indicator measures out.
 */

/**
 * The cast animations shipped alongside the rig, in `public/models/<id>.fbx`.
 *
 * Every ability block carries a `castAnim` naming one of these, so each spell
 * can throw the body differently; `CharacterController` loads all of them once
 * at boot and keeps only their clips, and the editor turns this array straight
 * into the per-ability dropdown.
 */
export const CAST_ANIMATIONS = ['cast1', 'cast2', 'cast3'];

export const settings = {
  /* ------------------------------------------------------------------ */
  /* Global multipliers                                                  */
  /* ------------------------------------------------------------------ */
  global: {
    timeScale: 1.0, // slow-mo / fast forward for the whole simulation
    speed: 1.0, // eruption travel speed multiplier
    lifetime: 1.0, // ability lifetime multiplier
    glow: 1.0, // emissive multiplier fed into bloom
    shaderIntensity: 1.0, // master strength of every procedural shader effect
    noiseStrength: 1.0,
    noiseFrequency: 1.0,
    noiseSpeed: 1.0,
    turbulence: 1.0,
    randomness: 1.0, // per-instance / per-particle jitter multiplier
    particleCount: 1.0,
    particleLifetime: 1.0,
    particleSpeed: 1.0,
    particleSize: 1.0,
    emissionRate: 1.0,
    lightIntensity: 1.0,
    lightRadius: 1.0,
    distortion: 1.0,
    fresnel: 1.0,
    opacity: 1.0,
    animationSpeed: 1.0, // character animation playback rate
    cameraShake: 1.0,
    explosionIntensity: 1.0
  },

  /* ------------------------------------------------------------------ */
  /* The aim indicator — the ground arrow drawn while the cast is armed  */
  /* ------------------------------------------------------------------ */
  /**
   * A League-style skillshot indicator: one ground quad with a signed-distance
   * arrow in its fragment shader, so every dimension below is in *metres* and
   * nothing is a texture. The quad is rebuilt from these numbers each frame,
   * which is why dragging `range` while aiming stretches the arrow live.
   */
  aim: {
    /* --- silhouette (metres) --- */
    shaftWidth: 0.42, // half-width of the shaft
    headLength: 2.6, // length of the arrowhead
    headWidth: 1.35, // half-width at the base of the head
    round: 0.12, // corner rounding of the whole silhouette
    startOffset: 0.9, // gap between the caster and the tail of the arrow

    /* --- rendering --- */
    edge: 0.09, // outline thickness, metres
    edgeGlow: 2.6, // how hard the outline blooms
    softness: 0.06, // feather on the outer edge
    fill: 0.3, // opacity of the interior wash
    fillFalloff: 1.1, // how fast the wash fades from the axis to the edge
    opacity: 1.0,

    /* --- energy running up the shaft --- */
    stripes: 0.55, // chevrons per metre
    stripeSharp: 0.62, // 0 = soft gradient, 1 = hard bars
    stripeDepth: 0.55, // how much they modulate the fill
    scrollSpeed: 2.4, // metres/second they travel toward the tip
    pulse: 0.28, // brightness breathing
    pulseSpeed: 2.2,

    /* --- frost break-up --- */
    noise: 0.45, // how much noise eats into the fill
    noiseScale: 1.6, // features per metre
    noiseSpeed: 0.35,
    crystals: 0.55, // voronoi frost plates over the interior
    crystalScale: 2.4,

    /* --- furniture --- */
    baseRing: 0.62, // radius of the ring at the caster's feet, metres
    baseRingWidth: 0.06,
    tipGlyph: 0.9, // strength of the crystal rosette at the impact point
    tipGlyphSize: 1.15, // radius of that rosette, metres
    tipSpin: 0.45, // revolutions/second
    rangeArc: 0.55, // brightness of the max-range cap
    reveal: 0.055, // seconds for the arrow to sweep out when armed

    /* --- colour --- */
    colorCore: '#ecfbff',
    colorEdge: '#3fb4ff',
    colorInvalid: '#ff6a5c', // shown when the target is inside `minRange`

    height: 0.035 // hover distance above the floor, metres
  },

  /* ------------------------------------------------------------------ */
  /* The far-cast indicator — the circle drawn at the target point       */
  /* ------------------------------------------------------------------ */
  /**
   * The other half of the targeting vocabulary. Where `aim` draws an arrow
   * along a line, this draws the **footprint**: a disc dropped at the cursor
   * with a deliberately thick boundary, because the one thing a ground-targeted
   * AoE has to answer before you click is *how much space is this going to
   * take*. The band is the answer, and the ability's own field is built to land
   * exactly on it.
   *
   * Two meshes, both parametric:
   *  - the **footprint**, a quad whose fragment shader is a signed-distance
   *    ring evaluated in metres from the target;
   *  - the **reach ring**, a ribbon strip bent into a circle at the caster's
   *    feet at `range` — a far cast needs to show where its arm ends.
   *
   * Shared by every far cast, so a new one inherits the whole indicator and
   * only brings its own `zoneRadius`.
   */
  zone: {
    /* --- the boundary (metres) --- */
    boundary: 0.34, // thickness of the band that *is* the footprint edge
    // Held under 2: the band is already the widest mark on the circle, and
    // pushing the gain past this clips it to flat white and throws away the
    // hue that says which ability you are holding.
    boundaryGlow: 1.8, // how hard it blooms
    boundaryBias: 0.35, // <0.5 grows the band inward, >0.5 outward
    liner: 0.05, // thin bright liner riding the inside of the band
    softness: 0.05, // feather on both lips

    /* --- the interior --- */
    fill: 0.22, // opacity of the wash inside the circle
    fillFalloff: 1.5, // >1 keeps the middle clear and crowds it to the rim
    rings: 2.0, // concentric contour rings across the radius
    ringWidth: 0.05,
    ringSpeed: 0.35, // how fast they travel outward, radii/second
    crawl: 0.75, // filaments crawling over the interior
    crawlScale: 1.3, // filaments per metre
    crawlSpeed: 0.45,
    noise: 0.4, // break-up eating into the wash
    noiseScale: 1.2,

    /* --- furniture --- */
    ticks: 24, // marks stepping around the boundary
    tickLength: 0.42, // how far they reach in, metres
    tickWidth: 0.2, // duty cycle, 0..1
    tickSpin: 0.06, // revolutions/second
    sweep: 0.55, // radar sweep brightness
    sweepSpeed: 0.4, // revolutions/second
    core: 0.85, // the mark at the exact target point
    coreSize: 0.4, // its radius, metres
    crosshair: 0.5, // four arms pointing out of the core
    crosshairLength: 1.1,
    pulse: 0.22, // brightness breathing
    pulseSpeed: 2.0,

    /* --- the reach ring at the caster --- */
    reach: 0.7, // brightness of the max-range circle, 0 hides it
    reachWidth: 0.05, // its half-width, metres
    reachDashes: 64, // dashes around it (0 = solid)
    reachDashGap: 0.42, // fraction of each dash that is gap
    reachSpin: 0.03, // revolutions/second the dashes creep
    reachLead: 0.9, // how much brighter the arc nearest the cursor is
    reachSegments: 192, // tessellation of that circle

    /* --- rendering --- */
    opacity: 1.0,
    reveal: 0.07, // seconds the circle takes to snap out when armed
    snap: 1.18, // how far past its radius it overshoots on the way out
    height: 0.035, // hover distance above the floor, metres

    /* --- colour --- */
    colorCore: '#eaf7ff',
    colorEdge: '#7c6bff',
    colorInvalid: '#ff6a5c' // shown when the target is inside `minRange`
  },

  /* ------------------------------------------------------------------ */
  /* Character                                                           */
  /* ------------------------------------------------------------------ */
  character: {
    /* --- blending the cast clip over the idle --- */
    // The idle loops forever; a cast clip is a one-shot laid over the top of it,
    // so these are the two edges of that overlap. In fast, out soft: the throw
    // has to land on the frame you clicked, the recovery does not.
    castBlendIn: 0.12, // seconds to cross-fade from the idle into the cast
    castBlendOut: 0.3, // seconds to fall back to the idle once it finishes

    /* --- how the body sells the cast --- */
    turnToAim: true, // face the arrow while aiming
    turnRate: 0.0002, // fraction of the heading gap left after 1s (lower = snappier)
    castLean: 0.34, // radians the torso pitches forward on release
    castRecoil: 0.16, // metres the body is shoved back
    castSettle: 2.6 // seconds⁻¹ the lunge decays at
  },

  /* ------------------------------------------------------------------ */
  /* Target dummies — what the abilities are aimed at                    */
  /* ------------------------------------------------------------------ */
  /**
   * The practice targets: rigged bodies standing in a ring, one-shot by any
   * cast that reaches them, thrown by a ragdoll rather than an animation.
   *
   * See `combat/DummyField.js` for how a hit is derived (no ability knows these
   * exist — the volume is read off the cast line every frame) and
   * `combat/Ragdoll.js` for the fall itself.
   */
  dummies: {
    enabled: true,
    /** How many are standing at any moment. */
    count: 6,
    /** Metres from the caster they stand inside, and no nearer than. */
    radius: 13.0,
    minRadius: 5.0,
    /** Metres between two of them, so they never share a patch of floor. */
    separation: 2.4,
    /** Normalised height, metres — the same treatment the player's rig gets.
     *  Read once, when the model is loaded. */
    height: 1.78,
    /** The cylinder a cast has to touch to count as a hit, metres. */
    bodyRadius: 0.42,

    /** Whether they turn to watch the caster, and how fast (lower = snappier). */
    watch: true,
    turnRate: 0.02,

    /** Seconds a corpse lies there, then the seconds it takes to burn away. */
    corpseTime: 4.5,
    dissolveTime: 1.3,
    /** Seconds before a burnt-away body stands back up somewhere else. */
    respawnDelay: 2.0,

    /**
     * What lands the hit.
     *
     * A line cast sweeps a capsule of `radius` from the caster to its front; a
     * far cast is a disc of `zoneRadius × zoneScale` at the target point, armed
     * the frame the front gets there. One touch is a kill — these are targets,
     * not enemies, and the numbers below are about how the body *flies*.
     */
    hit: {
      enabled: true,
      radius: 1.5, // half-width of a line cast's kill capsule, metres
      zoneScale: 1.0, // the far cast's own footprint, × its circle
      impulse: 6.0, // metres/second the body leaves at, along the blow
      lift: 3.4, // metres/second it is thrown upward
      spin: 1.4 // extra impulse per body-height above the hips — the torque
    },

    /**
     * The look. The export carries no textures at all, so this is authored
     * rather than imported: a cold near-black body with a bright rim, which is
     * the one combination that stays legible at fifteen metres against a floor
     * this dark, and the ember burn that takes the corpse away.
     */
    look: {
      color: '#1b2029',
      roughness: 0.78,
      metalness: 0.15,
      /** The rim that draws the silhouette. */
      rimColor: '#6fd2ff',
      rimPower: 2.6,
      rimEmissive: 1.5,
      /** The burn edge as they dissolve, and how wide that band is. */
      edgeColor: '#8fe6ff',
      edgeEmissive: 6.0,
      edgeWidth: 0.12,
      /** Features per metre in the dissolve noise. */
      dissolveDetail: 9.0
    },

    /**
     * The ragdoll — see `combat/Ragdoll.js` for what these actually drive.
     *
     * It is a particle per joint, the bone lengths as distance constraints and
     * a few braces across the pelvis and chest, solved by relaxation. `gravity`
     * is deliberately heavier than earth: a body that falls at 9.8 on a screen
     * this size reads as slow motion, and every game does the same thing.
     */
    ragdoll: {
      gravity: -19.0,
      /** Fraction of the velocity the air takes per second. */
      damping: 0.06,
      /** Relaxation passes per substep. More = stiffer. */
      iterations: 7,
      /** How hard the braces pull compared to the bones themselves. */
      brace: 0.45,
      /** Metres a joint stands off the floor, and how it lands on it. */
      radius: 0.075,
      friction: 0.75,
      bounce: 0.06,
      /** Below this much movement per second, the body is asleep and free. */
      sleep: 0.03
    }
  },

  /* ------------------------------------------------------------------ */
  /* The cut                                                             */
  /* ------------------------------------------------------------------ */
  /**
   * What happens to a body when the blow that felled it came with an edge on
   * it — see `combat/Dummy.js#_cut` and `combat/Ragdoll.js#collideRagdolls`.
   *
   * Nothing in the sandbox slices by default: a cast has to *ask* for it by
   * passing `slice = true` to `Dummy#kill`, and nothing in the current set does
   * — the machinery stays for the next one that wants it. Everything here is about the
   * two halves — where the plane sits, how hard they are driven apart, what
   * each of them does with the blow, and how they behave once they are lying on
   * each other.
   */
  slice: {
    enabled: true,
    /**
     * Where the plane sits, as a fraction of the body's own height.
     *
     * 0.60 is the waist on this export — between the hip joint and the base of
     * the spine. Below it and the plane goes through the pelvis, which leaves
     * the top half with a slab of hip hanging off it; much above and the legs
     * walk away with the ribcage.
     */
    height: 0.6,
    /** Degrees it is tilted off horizontal, tipping away along the blow. */
    tilt: 16,
    /** Metres the upper half is lifted clear on the frame the body parts. */
    separation: 0.09,
    /**
     * m/s the halves are driven *apart* along the blow, on top of whatever each
     * already took of it.
     *
     * The top half gets it the way the lance went and the legs get it the other
     * way, so the two travel in opposite directions instead of following each
     * other into the same heap — the difference between reading the cut and
     * reading a body that fell over in two bits. Added evenly rather than
     * weighted up the body (`Ragdoll#shove`), so neither half is spun by it:
     * the fold is the blow's doing, this only separates them.
     */
    split: 1.8,
    /**
     * What each half does with the blow, as multipliers on `impulse` / `lift` /
     * `spin`. The top of a body cut in half leaves with most of what the lance
     * had; the bottom is a pair of legs that fold.
     *
     * Well under 1 rather than over it, which reads backwards until you see
     * why: `spin` is applied per *body height*, and half a body is half as
     * tall, so the same number throws its head twice as hard.
     */
    upper: { impulse: 0.78, lift: 0.72, spin: 0.55 },
    lower: { impulse: 0.22, lift: 0.1, spin: 0.2 },

    /**
     * The two halves as solid things — see `collideRagdolls`.
     *
     * `radius` is the base; every joint scales it by its own size (a pelvis is
     * a chunk, a wrist is not). `maxPush` is what keeps it from exploding: it
     * caps how far one frame may separate a pair, so an overlap that starts
     * deep opens over several frames instead of firing the halves apart.
     */
    collide: {
      enabled: true,
      /** Metres, before each joint's own size multiplier. */
      radius: 0.09,
      /** How much of the closing speed comes back, and how much slide is lost. */
      bounce: 0.2,
      friction: 0.45,
      /** Metres a single frame may push one pair apart. */
      maxPush: 0.05
    },

    /** What the cut opens, and how much it glows in its own right. */
    interiorColor: '#2a1a14',
    interiorEmissive: 0.35,
    /** The hot line the edge leaves, and how wide that band is (× height). */
    edgeColor: '#b9ff72',
    edgeEmissive: 4.0,
    edgeWidth: 0.014
  },

  /* ================================================================== */
  /* FLUX — Shimmering Flux of Chaos                                     */
  /* ================================================================== */
  /**
   * A crimson tear thrown down the aimed line. Reference for the look: the
   * six-panel VFX breakdown sheet — conical mesh trail, fluid blood splatter,
   * chaotic energy ribbons, glinting sparkles, distortion wave, lingering
   * crimson motes — and this block is grouped in exactly those six sections so
   * that a panel of the sheet and a folder of the editor are the same thing.
   *
   * There is no seventh section, and that is a decision rather than an
   * omission: no impact shell, no scorch decal, no screen flash. The sheet says
   * what this effect is made of, and anything else added at the strike would be
   * the reflex that makes every ability look like every other one.
   *
   * Two units are in play, and mixing them up is the only way to get lost here:
   *
   *  - anything about the **cast** is in metres, because it is laid out against
   *    the aim indicator — `range`, `coneLength`, `coneRadius`, `ribbonSpan`;
   *  - anything about the **cone's surface** is in its own parameter space,
   *    where `u` runs 0 → 1 from the head to the mouth and `v` goes once
   *    around. `coneRings`, `coneRibs`, `coneSpiralTurns` and `coneHead` are
   *    counts and fractions in that space, not metres, which is what lets a
   *    two-metre funnel and a ten-metre one carry the same mesh.
   *
   * The palette is the load-bearing decision and it is worth stating plainly:
   * the **energy is crimson going rose** and the **matter is dark**. Blood
   * that glows is not blood — it is more light — so the one non-additive layer
   * in here is kept nearly black in shadow and earns its brightness from a wet
   * highlight instead. Swapping that round gives a red firework with pink
   * confetti in it, which is exactly what the sheet is not.
   */
  flux: {
    /* --- the cast --- */
    range: 28.0, // maximum cast distance, metres
    minRange: 3.5, // closer than this and the cast is refused
    speed: 24.0, // how fast the flux flies, metres/second
    burstTime: 0.8, // seconds it takes to tear itself apart on impact
    fadeTime: 1.1, // seconds what is left of it takes to go out
    cooldown: 1.4,
    castAnim: 'cast3', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- the flight path (materials/FluxSpine.js) --- */
    // Not a straight line. The whole ability is placed against p(s), a pure
    // function of metres travelled, so the weave below is *the shape of the
    // corridor* — the funnel bends along it, the ribbons wind about it and the
    // motes are left lying on it. Two sines rather than noise, because the JS
    // and GLSL halves of that function have to agree to the last digit.
    weave: 0.7, // amplitude of the wander, metres
    weaveWaves: 0.5, // radians per metre — the long swing
    weaveWaves2: 1.15, // ... and the short one riding on it
    weaveRise: 0.7, // the vertical wander, × the lateral one
    launchHeight: 1.35, // where it leaves the caster's hand, metres
    flightHeight: 1.9, // its cruise height
    riseDistance: 4.5, // metres it takes to settle onto that height
    trailSpan: 11.0, // metres of trail the emitters seed along

    /* --- 1 · the conical mesh trail --- */
    // The funnel trails: its nose is the front of the whole ability and it
    // flares open behind, where the trails take over and leave through it.
    coneLength: 5.6, // metres of path the funnel reaches back over
    coneRadius: 1.7, // radius at the trailing mouth, metres
    coneTip: 0.12, // radius at the leading nose, x the mouth's
    coneFlare: 0.7, // 1 is a straight-sided cone, <1 a trumpet, >1 a horn
    coneRings: 13.0, // rings across it (integers — the mesh wraps)
    coneRibs: 15.0, // ribs around it
    coneSpiralArms: 2.0, // helices wound down it
    coneSpiralTurns: 1.4, // turns each makes over the length
    coneSpiralSpin: 0.45, // turns/second they roll
    coneFlow: 1.4, // rings/second travelling toward the head
    coneWire: 1.0, // ring and rib width, pixels
    coneSpiralWire: 1.3, // helix width, pixels
    coneMesh: 0.5, // how strongly the rings and ribs read
    coneSpiral: 0.62, // ... and the helices, which carry the panel
    coneFill: 0.4, // the translucent membrane between the lines
    coneFresnel: 0.85, // the silhouette term that makes it a volume
    coneFresnelPower: 2.6,
    coneErode: 0.35, // how hard the noise eats through the surface
    coneErodeScale: 1.7,
    coneErodeSpeed: 1.1,
    coneWobble: 0.15, // how far the surface is pushed off a clean cone
    coneWobbleScale: 1.6,
    coneWobbleSpeed: 1.0,
    coneHead: 0.03, // how far back the white nose tip reaches
    coneNoseFade: 0.12, // how much of the leading point is capped — see the shader
    coneTailFade: 0.96, // where along the funnel the mouth starts dissolving
    conePulse: 1.0, // charge running up it toward the head
    conePulseFreq: 2.0,
    conePulseSpeed: 1.2,
    coneBurstFlare: 0.9, // how far the mouth blows open on the strike
    coneIntensity: 1.5,
    coneOpacity: 0.85,
    coneSoftFade: 0.4, // metres of soft fade where it meets geometry
    colorConeCore: '#ffbccd',
    colorCone: '#ff2d55',
    colorConeTail: '#4a0c22',

    /* --- 2 · the fluid blood splatter --- */
    // Half mesh, half particles. The ligaments are drawn as strands that
    // stretch (`bloodNeck` — the trailing end is thrown slower than the leading
    // one) and bead (`bloodBeads`) until they pinch off; the droplets are what
    // they pinch off *into*, so both halves are thrown with the same numbers
    // and read as one substance.
    ligaments: 14.0, // strands in flight (capped at 16)
    bloodRate: 3.2, // throws per second, per strand
    bloodLife: 0.7, // seconds one ligament lasts
    bloodThrow: 3.6, // how hard the fluid is thrown, metres/second
    bloodBack: 1.15, // how much of that is backwards along the path
    bloodForward: 0.9, // ... and forwards instead, on the strike
    bloodBurstThrow: 1.6, // extra throw on the strike, × the above
    bloodSpread: 1.0, // how far off the axis
    bloodCarry: 0.32, // fraction of the head's own speed the fluid keeps
    bloodRootSpread: 5.0, // metres back along the trail a strand may tear from
    bloodGravity: 7.5,
    bloodNeck: 0.72, // how much slower the trailing end is — the stretch
    bloodCurl: 1.9, // how far a strand bows as it flies
    bloodWidth: 0.2, // half-width at the fat end, metres
    bloodTaper: 1.5, // how fast it thins toward the tail
    bloodBeads: 0.7, // the capillary beading along it
    bloodBeadFreq: 2.2, // beads over the strand
    bloodNeckDepth: 0.65, // how far it thins before it breaks
    bloodGloss: 28.0, // tightness of the wet highlight
    bloodSheen: 0.9, // its strength
    bloodRim: 0.55, // light coming through where the strand is thin
    bloodOpacity: 1.0,
    bloodSoftFade: 0.25,
    colorBloodDeep: '#26010a', // in its own shadow
    colorBlood: '#6e0512', // lit
    colorBloodSheen: '#ffb9bf', // the wet highlight — the colour of the light
    colorBloodRim: '#c01526', // lit through, where it has necked

    /* --- 2 · ... and the droplets it breaks into --- */
    dropRate: 90.0, // droplets/second
    dropRadius: 0.14, // how far off the strand they are born, metres
    dropSize: 0.12, // metres across
    dropLifetime: 1.1,
    dropGravity: 9.5,
    dropStretch: 0.5, // how far a fast bead elongates
    dropOpacity: 1.0,
    dropGlow: 1.0, // matter, not light — leave this at 1
    burstDrops: 160.0, // thrown by the strike
    colorDropA: '#d8455a',
    colorDropB: '#8e0a19',
    colorDropC: '#5e0611',
    colorDropD: '#1e0206',

    /* --- 3 · the chaotic energy ribbons --- */
    ribbons: 9.0, // strands (capped at 12)
    ribbonSpan: 13.0, // metres of path they reach back over
    ribbonLead: 0.0, // ... and where they start: negative, so they leave the
    //                     cone's apex rather than its mouth
    ribbonRadius: 0.95, // the coil under the chaos, metres
    ribbonCoil: 0.7, // turns each makes over the span
    ribbonSpin: 0.3, // turns/second the tangle rolls
    ribbonSwell: 0.55, // how fast they splay out behind the head
    ribbonChaos: 1.7, // how far the noise throws them off, metres
    ribbonChaosScale: 1.05,
    ribbonChaosSpeed: 0.45,
    // The composite has two kinds of trail behind the cone and needs both: the
    // straight ones hold the line of the shot, the rest tangle around them.
    ribbonStraight: 0.16, // fraction of strands that run straight
    ribbonStraightRadius: 0.22, // their orbit radius, × the tangle's
    ribbonStraightChaos: 0.12, // their wander, × the tangle's
    ribbonStraightWidth: 0.6, // their width, × the tangle's
    ribbonWidth: 0.3, // half-width at the head, metres
    ribbonWidthTip: 0.16, // that width at the tail, as a multiple
    ribbonTwist: 0.9, // how much the strip rolls about its own tangent
    ribbonTwistTurns: 2.0, // turns of that over the span
    ribbonTwistSpeed: 0.35, // turns/second on top
    ribbonTwistFace: 0.15, // the floor under the width when it is edge-on
    ribbonSharp: 2.0, // falloff across the ribbon
    ribbonCore: 40.0, // the hard thread down the middle of it
    ribbonPulse: 1.1, // charge running up it
    ribbonPulseFreq: 2.0,
    ribbonPulseSpeed: 1.2,
    ribbonFlicker: 0.35, // it is chaos — let it stutter
    ribbonFlickerScale: 6.0,
    ribbonFlickerSpeed: 2.4,
    ribbonTailFade: 0.82, // where it dissolves into the wake
    ribbonIntensity: 1.05,
    ribbonOpacity: 0.72,
    ribbonSoftFade: 0.35,
    colorRibbonCore: '#ffa9c0',
    colorRibbon: '#ff2447', // half the strands run crimson ...
    colorRibbonAlt: '#ff3d6e', // ... and half a deeper rose. This split is the layer.
    colorRibbonTail: '#54061e',

    /* --- 4 · the glinting sparkles --- */
    glintRate: 300.0, // sparkles/second
    glintRadius: 2.2, // how far off the trail they are born, metres
    glintSize: 0.17, // metres across
    glintLifetime: 1.5,
    glintSpeed: 1.2,
    glintRise: 0.15,
    glintDrift: 0.5, // how hard they are left behind
    glintSpin: 1.2, // radians/second the star turns
    glintTurbulence: 0.35,
    glintGlow: 2.6,
    castGlints: 40.0, // thrown as the flux opens in the hand
    burstGlints: 220.0, // ... and by the strike
    colorGlintA: '#ffffff',
    colorGlintB: '#ffd0d8',
    colorGlintC: '#ff3a5c',
    colorGlintD: '#5e0c22',

    /* --- 5 · the distortion wave (LAYER.DISTORTION) --- */
    warpSize: 3.6, // the proxy's reach around the head, metres
    warpLens: 0.75, // the bulb that displaces along the heading
    warpLensPower: 1.7, // how tightly it is packed into the middle
    warpChurn: 0.5, // how hard the lens boils
    warpScale: 1.6,
    warpSpeed: 1.3,
    warpWave: 0.65, // the ring packets shed off the head
    warpWaveRate: 1.5, // waves/second
    warpWaveWidth: 0.15, // depth of one packet, × the proxy's radius
    warpRipples: 9.0, // bands inside it
    warpBurst: 1.5, // the wave the strike fires
    warpBurstLife: 0.7, // seconds it lasts
    warpBurstSpeed: 16.0, // metres/second it crosses
    warpBurstSize: 1.6, // how far the proxy grows for it, × its size
    warpBurstWidth: 0.2,
    warpStrength: 1.0,

    /* --- 6 · the lingering crimson motes --- */
    // The layer that is still on screen when everything else has gone. Long
    // lived, heavily dragged and curl driven, so they stop where the flux left
    // them and then drift rather than flying anywhere.
    moteRate: 260.0, // motes/second
    moteRadius: 1.6, // how far off the trail they are born, metres
    moteSize: 0.16, // metres across - small, many and faint: the haze
    moteLifetime: 3.0,
    moteSpeed: 0.8,
    moteRise: 0.22,
    moteDrift: 0.7, // how hard they are left behind rather than carried
    moteTurbulence: 0.75,
    moteOpacity: 0.1,
    moteGlow: 1.0,
    castMotes: 25.0,
    burstMotes: 140.0,
    colorMoteA: '#ff7f92',
    colorMoteB: '#e01e3c',
    colorMoteC: '#6d0c1f',
    colorMoteD: '#2a0510',

    /* --- the strike, in the camera --- */
    // Everything the strike does that is not one of the six layers lives here,
    // and it is deliberately only two things: a shove and a rumble.
    impactShake: 0.3,
    shakeDuration: 0.45,
    rumble: 0.028, // while it flies
    burnShake: 0.045, // while it comes apart

    /* --- the light it carries --- */
    lightColor: '#ff3a54',
    lightIntensity: 36.0,
    lightRadius: 11.0,
    lightFlicker: 0.4, // it is unstable — the light stutters
    lightFlickerSpeed: 7.0
  },
  /* ------------------------------------------------------------------ */
  /* Scorched Twilight of Rage — line cast                               */
  /* ------------------------------------------------------------------ */
  /**
   * Three layers, from a three-panel breakdown sheet, and nothing else. The
   * folder in the editor is laid out the same way, so judging the composite
   * means walking down it zeroing `wispOpacity`, `iceOpacity` and
   * `plumeOpacity` in turn — each one takes exactly one panel of the reference
   * out of the frame.
   *
   * Two units are in play. Anything about the cast, the path or a layer's reach
   * is in **metres**; anything that is a count, a fraction or an exponent is
   * unitless. Nothing anywhere in this block is in pixels except
   * `iceEdgeWidth`, which is a screen-space hairline and says so.
   */
  twilight: {
    /* --- the cast --- */
    range: 30.0, // maximum cast distance, metres
    minRange: 4.0, // closer than this and the cast is refused
    speed: 26.0, // how fast the shot flies, metres/second
    burstTime: 0.7, // seconds it takes to come apart on impact
    fadeTime: 1.0, // seconds what is left of it takes to go out
    cooldown: 1.3,
    castAnim: 'cast2', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- the flight path (materials/TwilightSpine.js) --- */
    // Almost straight, and that is the point: the composite is one clean
    // diagonal, and every curve you read in it belongs to the braid winding
    // about this line rather than to the line itself. Give the spine its own
    // chaos and the braid stops being legible.
    drift: 0.45, // amplitude of the lazy wander, metres
    driftWaves: 0.2, // radians per metre
    driftRise: 0.5, // the vertical wander, x the lateral one
    launchHeight: 1.4, // where it leaves the caster's hand, metres
    flightHeight: 2.1, // its cruise height
    riseDistance: 6.0, // metres it takes to settle onto that height

    /* --- 1 · the wispy beam core --- */
    // A braid, not a helix: the strands cross. `wispFlatten` squashes the orbit
    // vertically so it reads as a wide S weave in the frame, and both the orbit
    // radius and the width run off the same sin(pi t) profile, so every strand
    // is pinched to a point at the tip and again at the muzzle.
    wisps: 3.0, // strands (capped at 8)
    wispSpan: 9.0, // metres of path the braid reaches back over. Deliberately
    //                shorter than the ice wake: on the sheet the crystals are
    //                the furthest-back element, carrying on past where the
    //                ribbons have faded out.
    wispLead: 0.15, // ... and how far past the head it runs
    wispRadius: 0.58, // how far off the axis a strand bows, metres
    wispFlatten: 0.75, // the vertical half of that bow, x the lateral.
    //                     Nearly round, and it has to be: `side` is the
    //                     horizontal perpendicular to the shot, which for a
    //                     camera looking across the line points into the
    //                     screen. Flatten the orbit onto it and the braid
    //                     does all its weaving in depth, where none of it is
    //                     visible, and three strands read as one blade.
    wispCoil: 1.7, // turns one strand makes over the span. Under one turn
    //                 can only ever make a single bow, and a single bow is a
    //                 lens rather than a braid — the strands have to pass
    //                 over each other more than once for the layer to read.
    wispSpin: 0.15, // turns/second the braid rolls
    wispBow: 0.4, // how sharply the strands converge at the ends
    wispWander: 0.2, // noise off the braid, metres
    wispWanderScale: 2.4,
    wispWanderSpeed: 0.7,
    wispWidth: 0.19, // half-width at its fattest, metres. Thin, and it has to
    //                   be: the sheet's ribbons are a fortieth of the streak
    //                   across. At 0.3 they read as satin sashes rather than
    //                   as strands of energy.
    wispWidthBow: 0.45, // how sharply it comes to a point at both ends. Low,
    //                      because sin(pi t) raised much above a half spends
    //                      most of the span near zero: at 0.7 a twelve-metre
    //                      braid was drawing as four.
    wispTwist: 0.8, // how much the strip rolls about its own tangent
    wispTwistTurns: 1.5, // turns of that over the span
    wispTwistSpeed: 0.25, // turns/second on top
    wispTwistFace: 0.2, // the floor under the width when it is edge-on
    wispSoft: 1.9, // falloff across the strip — low is wispy
    wispCore: 16.0, // the hard thread down the middle of it
    wispCoreWeight: 0.5, // ... and how loud that thread is. A wisp has no
    //                        hard core; at 0.55 the braid was a laser.
    wispFiber: 0.5, // how hard the body breaks into travelling fibres
    wispFiberScale: 5.5,
    wispFiberSpeed: 1.6,
    wispPulse: 0.9, // charge running up it toward the tip
    wispPulseFreq: 1.6,
    wispPulseSpeed: 1.1,
    wispHeadGlow: 0.5, // the leading end runs hotter
    wispIntensity: 2.6,
    wispOpacity: 0.9,
    wispSoftFade: 0.3, // metres of soft fade where it meets geometry
    colorWispCore: '#f2feff',
    colorWisp: '#25c8ff', // saturated, not pale — see the reference
    colorWispTail: '#0b3f9c',

    /* --- 2 · the stylized ice particles --- */
    // Real faceted solids, two silhouettes, placed and lit entirely in the
    // vertex stage — see `materials/IceShardMaterial.js`. A crystal is struck
    // off the burning tip, keeps only `iceCarry` of its momentum and flies out
    // on its own drag curve, so the field falls back down the path and opens
    // out as it goes. That is the wake, and it is the widest part of the whole
    // silhouette — behind the flame, never in front of it.
    iceCount: 40.0, // crystals of the main shape (capped at 220). Low, and
    //                  that is the layer: the sheet has about twenty crystals
    //                  in the whole cloud, each big enough to read as a gem
    //                  on its own with black around it. Sixty small ones in
    //                  the same volume is a shattered windscreen.
    iceSplinters: 0.45, // slivers alongside them, x the above
    iceLife: 1.6, // seconds one crystal lasts, and its respawn period
    iceLead: -5.0, // metres ahead of the head they are struck off. Negative by
    //                  at least `tipLength`: the crystals have to be struck
    //                  off *past the cone's mouth*. Both layers are
    //                  solids that write depth, so spawning the wake inside
    //                  the fire has the two of them fighting over the same
    //                  pixels and the tip loses its shape.
    iceRadius: 0.4, // how far off the axis they are born, metres — tight at
    //                   the tip. The fanning is done by the throw over the
    //                   crystal's life, which is what makes the wake widen
    //                   with distance instead of being a uniform tube.
    iceThrow: 3.2, // launch speed, metres/second
    iceForward: 0.3, // how much of that is along the heading ...
    iceSpread: 0.85, // ... and how much is radial
    iceCarry: 0.68, // fraction of the head's own speed they keep. Everything
    //                   it does not keep is the length of the wake: at 26 m/s
    //                   over a 1.2 s life, 0.68 leaves a ten-metre trail.
    iceDrag: 1.1, // they leap out and settle rather than sailing
    iceGravity: 1.2, // just enough for the wake to sag
    iceSize: 0.28, // metres across, before the per-crystal roll. Measured off
    //                 the sheet: one crystal is about a tenth of the streak's
    //                 length there. Much past that they overlap into paper.
    iceSizeVariance: 0.55, // squared, so most are small and a few are large
    iceLong: 1.5, // how slender the slenderest crystal is
    iceSpin: 0.5, // tumble, turns/second
    iceGrowIn: 0.09, // fraction of life spent snapping to size
    iceShrinkOut: 0.55, // ... and where the shrink starts
    // There is deliberately no burst here. The crystals are a trail — laid down
    // from the first frame of the cast and frozen where they were drawn when
    // the shot lands — and a wake that throws harder and larger on impact reads
    // as a firework going off at the end of it. See `IceShardMaterial.js`.
    iceBands: 3.0, // steps the diffuse term is quantised into — the style
    icePosterize: 0.9, // how far toward those steps it is pushed
    iceScreenKey: 0.85, // how far the key swings from the scene's sun to a
    //                     camera-relative direction. The sheet lights every
    //                     crystal from the upper left in screen space, and it
    //                     has to: under the overhead sun alone a bipyramid's
    //                     visible facets all land on one posterised band and
    //                     the crystal draws as a flat paper cut-out.
    iceAmbient: 0.1,
    iceRim: 0.25, // the silhouette term — kept low, because a strong rim
    //                fills the gaps between crystals with haze and the black
    //                between them is half of what makes them read
    iceRimPower: 3.0, // its tightness
    iceDispersion: 0.6, // how far R, G and B split across that rim
    iceEdge: 0.5, // the hairline along every facet boundary. Small, because
    //                 it is now added *after* the body roll-off — it is the one
    //                 part of the crystal allowed through the bloom threshold.
    iceEdgeWidth: 1.3, // ... in pixels, and only this is in pixels
    iceCore: 0.1, // the light inside it
    iceTip: 0.15, // ... pooled toward the two points
    iceTipStart: 0.45,
    iceBack: 0.2, // light coming through the shadow side
    iceBackPower: 2.0,
    iceSpecular: 0.35, // the glint
    iceGloss: 34.0, // its tightness
    iceTwinkle: 0.6, // how hard it blinks, per facet
    iceTwinkleSpeed: 1.6,
    iceFlash: 0.85, // incandescence at the instant it is struck off
    iceFlashLife: 0.15,
    iceIntensity: 1.15,
    iceRolloff: 0.55, // compresses the *body* to land just under the bloom
    //                    threshold (settings.post.bloomThreshold). Raise it and
    //                    the crystals go matte; drop it and they start to glow
    //                    and the black between them fills with haze.
    iceOpacity: 1.0, // this layer fades by *shrinking* — leave this at 1
    iceSoftFade: 0.2,
    colorIceDeep: '#14417e', // the facet turned away from the key. Genuinely
    //                          darker than the body: the sheet's crystals carry
    //                          a pale face against a notably deeper blue one,
    //                          and that contrast *within* a single crystal is
    //                          what stops it reading as a flat pale card.
    colorIce: '#5aa9e8',
    colorIceLit: '#eaf6ff', // ... and the one facing it
    colorIceEdge: '#cfeeff', // the hairline, the rim and the light inside.
    //                          Saturated on purpose: six terms are tinted
    //                          with it and they outweigh the base facet
    //                          colour, so a near-white here makes the whole
    //                          crystal white whatever the palette says.
    colorIceFlash: '#ffffff',

    /* --- 3 · the burning tip: the body --- */
    // A painted teardrop, drawn as a solid — front faces, depth write, hard
    // silhouette — because a fan of additive strips cannot have an edge
    // however it is tuned, and a cone carved into a few strips has an edge but
    // reads as a faceted dart. The same surface is drawn twice: an orange skin
    // whose back half is cut into sharp teeth, over a smaller, paler core that
    // shows through the gaps. See `materials/FlameConeMaterial.js`.
    tipLength: 3.6, // metres from the apex back to the end of the longest
    //                 tooth — a bit over a third of `wispSpan`, so the fire
    //                 stays the nose of the shot and the braid behind it is
    //                 what carries the length
    tipRadius: 0.72, // the envelope radius, metres — the body is about half
    //                  as wide as it is long, measured off the sheet
    tipSwell: 0.5, // where along the length the needle has swollen to that
    //                 radius. Ahead of it the tip is a point; behind it, a body
    tipFlare: 1.6, // >1 concave and needle-like out of the apex, 1 straight
    tipSplay: 0.35, // how much the back keeps opening past the swell
    // The back half is cut into teeth around the circumference, and that is
    // what makes it fire rather than a dart. Ahead of `tipBodyEnd` the surface
    // is continuous; behind it each slot becomes one triangular tooth with its
    // own reach, and the gaps between them open onto the core.
    tipTeeth: 21.0, // slots around the circumference, one tooth each
    tipBodyEnd: 0.42, // where along the length the solid body ends
    tipToothLength: 0.4, // how far past that a short tooth reaches, as a
    //                      fraction of the length (rolled between 0.3x and 1x)
    tipStreamers: 0.2, // fraction of the teeth that run to the very end. The
    //                    contrast between these and the short ones is the
    //                    silhouette — one uniform reach is a crown
    tipToothWidth: 0.72, // fraction of its slot a tooth keeps just behind the
    //                      body; the rest is the gap that opens onto the core
    tipToothTaper: 1.3, // how it comes to its point — >1 concave and sharp
    tipToothLean: 0.5, // how far a tooth's centre line drifts sideways to
    //                    its point, in slots — a lick, not a spoke
    tipFlicker: 0.06, // how far each tooth's reach wanders, in length
    tipFlickerSpeed: 2.5,
    tipCurl: 0.22, // how far a tooth swings off its own spoke, radians
    tipCurlScale: 2.2,
    tipCurlSpeed: 1.4,
    tipSpread: 0.2, // how far a tooth leaves the envelope, x the radius
    tipRipple: 0.08, // how far the surface is pushed off a clean teardrop.
    //                  Scaled by the profile in the shader, so it dies away at
    //                  the point — applied evenly it chews the apex off
    tipRippleFreq: 3.0,
    tipRippleScale: 2.0,
    tipRippleSpeed: 1.5,
    tipErode: 0.25, // how raggedly the tooth edges are eaten into
    tipErodeFreq: 2.0,
    tipErodeScale: 3.0,
    tipErodeSpeed: 1.6,
    // The colour is keyed on a heat field, not on the length: heat falls off
    // from the apex, cools toward every silhouette and along each tooth to its
    // point, then is stepped into flat tones whose boundaries wander. Those
    // are the brush-stroke edges of the painting, curving round the body
    // rather than ringing a cone.
    tipHeatFalloff: 0.7, // how fast the heat drops off behind the apex — under
    //                      1 stays hot for most of the body
    tipRimCool: 0.35, // how much the silhouette cools — the orange edge
    tipRimPower: 2.0, // its tightness
    tipToothCool: 0.55, // how much a tooth cools to its point — the red tips
    tipBands: 3.0, // flat tones the heat is stepped into
    tipPosterize: 0.85, // how far toward those steps it is pushed
    tipWobble: 0.1, // how far noise pushes the band edges around
    tipWobbleScale: 2.5,
    tipWobbleSpeed: 1.2,
    tipApex: 0.6, // extra heat piled into the point. Watch it against
    //                `tipFlare`: white piled onto a blunt apex rounds it into
    //                a bulb and the front of the shot stops reading as a point
    tipApexTight: 6.0,
    tipCoreScale: 0.55, // the inner shell, x the skin's radius
    tipCoreLength: 0.9, // ... and x its length
    tipCoreHeat: 0.35, // ... and how much hotter it runs throughout, so it is
    //                    the yellow heart the sheet paints inside the orange
    tipInner: 0.7, // how much dimmer the inside of a shell is, seen through
    //                the gaps — so they read as depth rather than as holes
    tipIntensity: 1.6,
    tipRolloff: 0.2, // keeps the body's own colour instead of blowing to white
    tipOpacity: 1.0,
    tipSoftFade: 0.26,
    tipBurstFlare: 1.5, // how far the body blows open on the strike
    colorTipCore: '#fff8d6', // white-hot, at the point and in the heart
    colorTipHot: '#ffd23c', // the yellow of the body
    colorTip: '#ff7d14', // the orange of the back half and the teeth
    colorTipBase: '#c42d08', // the red the teeth die at

    /* --- 3 · ... and the leaves streaming off its flanks --- */
    // Opaque, flat-painted flame leaves — a fat triangular base, a sharp
    // point, a yellow thread up the middle and a red edge — rooted along the
    // back half of the body and streaming *backward* off it, a few short ones
    // poking forward past the point. The sheet calls this panel "Source Muzzle
    // Glow" and that label will talk you into rooting it behind the head with
    // the tongues running forward — which flies the ability tail first. Go by
    // the shapes in the composite, not the caption.
    plumeTongues: 22.0, // leaves in the fan (capped at 40)
    plumeRoot: 1.0, // metres behind the head the first root sits — inside the
    //                 body, so the leaves emerge from it rather than off its
    //                 point
    plumeRootSpread: 1.6, // metres the roots are strung out over, behind that
    plumeRootRadius: 0.2, // metres off the axis a leaf leaves the body
    plumeLength: 1.8, // how far *back* a leaf streams, metres
    plumeSplay: 0.85, // how far off the axis its point ends up, metres
    plumeSplayPow: 1.6, // >1 hugs the body and opens late
    plumeFlatten: 0.35, // depth of the fan, x its width across the view. The
    //                     leaves fan out in the *picture plane* about the path,
    //                     as the sheet draws them, with this much of the fan
    //                     turned toward the eye for volume. At 1 it is a round
    //                     cone of leaves, and from the rig's elevated seat its
    //                     top half dominates and the flame reads as swept
    //                     upward, off the line
    plumeWidth: 0.26, // half-width at the root, metres. Fat: these are the
    //                    tongues of the flame, not hairs off it
    plumeNoseWidth: 0.55, // the pinch at the root, x the body width
    plumeTaper: 1.1, // how it comes to a point — 1 is straight-sided, a
    //                    triangle; higher is concave and needle-like
    plumeNeedles: 0.25, // fraction of leaves that are long and thin
    plumeNeedleLength: 1.6, // ... how much longer, x
    plumeNeedleWidth: 0.4, // ... and how much thinner, x
    plumeSpikes: 0.1, // fraction that lick forward past the point instead
    plumeSpikeLength: 0.25, // ... how far forward, x the backward reach
    plumeLick: 0.4, // how far noise pushes a leaf off its spoke
    plumeLickScale: 2.2,
    plumeLickSpeed: 1.7,
    plumeRoll: 0.0, // turns/second the whole fan rotates. Off: fire does not
    //                  spin, and with opaque leaves every tongue is distinct
    //                  enough that even a slow roll reads as the tip turning
    plumeBurstFlare: 0.8, // how far the strike blows it open
    plumeEat: 0.35, // how raggedly the edge is eaten into
    plumeEatScale: 3.4,
    plumeEatSpeed: 2.2,
    // Cel-shaded off the same kind of heat field as the body: hottest at the
    // root and up the spine, coolest at the point and the edge, stepped into
    // flat tones.
    plumeHeat: 0.8, // how fast the heat drops off toward the point
    plumeEdgeCool: 0.45, // how much the edge cools — the red rim
    plumeEdgePower: 2.5, // its tightness
    plumeCore: 3.0, // how tight the thread up the middle is
    plumeCoreHeat: 0.3, // ... and how much hotter it runs
    plumeBands: 3.0, // flat tones
    plumePosterize: 0.85,
    plumeWobble: 0.1, // how far noise pushes the band edges around
    plumeFlicker: 0.3, // it is fire — let it gutter
    plumeFlickerSpeed: 9.0,
    plumeIntensity: 1.6,
    plumeRolloff: 0.2, // keeps the orange instead of blowing to white
    plumeOpacity: 1.0,
    plumeSoftFade: 0.3,
    colorPlumeCore: '#fff2c4', // the incandescent root
    colorPlumeHot: '#ffcc33',
    colorPlume: '#ff700f',
    colorPlumeTip: '#b8260a', // the red the points die at

    /* --- the strike, in the camera --- */
    // Everything the strike does that is not one of the three layers, and it is
    // deliberately only two things: a shove and a rumble.
    impactShake: 0.28,
    shakeDuration: 0.42,
    rumble: 0.025, // while it flies
    burnShake: 0.04, // while it comes apart

    /* --- the two lights it carries --- */
    // One at each end, at opposite temperatures. Lighting the floor a single
    // colour under this ability throws away half of what the sheet is about.
    // The inherited light rides the burning tip; the second stands back in the
    // ice wake.
    lightColor: '#ff8226', // the burning tip
    lightIntensity: 32.0,
    lightRadius: 10.0,
    lightGutter: 0.45, // it is fire — it gutters
    lightGutterSpeed: 8.0,
    wakeLightColor: '#7fd8ff', // the cold wake behind it
    wakeLightIntensity: 24.0,
    wakeLightRadius: 12.0,
    wakeLightBack: 4.5, // metres behind the tip it stands
    wakeBreath: 0.25, // ice glints, it does not gutter
    wakeBreathSpeed: 3.2
  },

  /* ------------------------------------------------------------------ */
  /* Linear Void Slash — the six-layer obsidian lance                    */
  /* ------------------------------------------------------------------ */
  /**
   * A line cast built to a six-panel breakdown sheet: shadow core beam,
   * particle debris, shadow ribbon trails, energy sparks, distortion wave,
   * lingering shadow motes. Six layers, and the ability draws six layers.
   *
   * It flies *point first*. The composite's obsidian lance is the compact,
   * pointed shape and everything streams away from it in one direction; the
   * debris fans wider the further back it is, the ribbons taper away from it,
   * the motes are the furthest back of all. So the lance is the nose and the
   * rest is the wake. See `abilities/VoidSlashAbility.js`.
   *
   * Every layer is placed in its vertex stage as a pure function of the clock
   * and how far the head has flown, so every slider here re-flies a cast that
   * is already in the air.
   */
  voidslash: {
    /* --- the cast --- */
    range: 30.0, // maximum cast distance, metres
    minRange: 4.0, // closer than this and the cast is refused
    speed: 30.0, // how fast the lance flies, metres/second
    burstTime: 0.55, // seconds the lance takes to come apart on impact
    fadeTime: 2.4, // seconds what is left of it takes to go out. Long: the
    //                 motes have to be the last thing on screen
    cooldown: 1.2,
    castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws

    /* --- the flight path (materials/VoidSpine.js) --- */
    // Almost straight: the composite is one clean diagonal, and every curve
    // you read in it belongs to the ribbons winding about this line.
    drift: 0.2, // amplitude of the lazy wander, metres
    driftWaves: 0.18, // radians per metre
    driftRise: 0.4, // the vertical wander, x the lateral one
    launchHeight: 1.3, // where it leaves the caster's hand, metres
    flightHeight: 1.7, // its cruise height
    riseDistance: 5.0, // metres it takes to settle onto that height

    /* --- 1 · the shadow core beam: the lance --- */
    // A pointed envelope shingled with flakes of black glass, one instanced
    // draw, solid, depth-written - the one layer with a silhouette, which is
    // what makes the front of the shot read as a point. Measured off the
    // sheet: the lance is about a third of the visible streak, and its rear
    // radius about a tenth of its length.
    lanceRows: 14.0, // rows of scales from the point to the rear (capped at 24)
    lanceAround: 8.0, // scales around each row (capped at 12)
    lanceLength: 4.5, // metres, point to rear
    lanceLead: 0.0, // metres the point runs ahead of the front
    lanceRadius: 0.5, // envelope radius at the rear, metres
    lanceFlare: 1.35, // >1 concave and needle-like, 1 straight-sided
    lanceScale: 0.17, // half-width of a rear scale, metres. A scale is
    //                    `lanceLong` times longer than wide, so at 14 rows
    //                    over 4.5 m each one overlaps the next two - shingles,
    //                    not tiles
    lanceTipScale: 0.35, // how much smaller the point's scales are, x
    lanceLong: 2.4, // a scale's long axis, x its width
    lanceTilt: 0.12, // radians a scale leans off the tangent - the envelope's
    //                   own slope
    lanceJitter: 0.35, // placement jitter, so the shingles are not milled
    lanceFrayStart: 0.55, // where along the length the scales start lifting
    //                       off. Ahead of it the lance is one surface; behind
    //                       it the scales lift, stand off and come away
    lanceLift: 0.55, // radians the rearmost scales lift
    lanceFraySpread: 0.35, // metres they stand off the envelope
    lanceFlutter: 0.12, // the lifted scales shiver
    lanceFlutterSpeed: 3.0,
    lanceVein: 1.2, // the lit crack of void light down each scale
    lanceVeinWidth: 0.16, // ... as a fraction of the scale's width
    lanceVeinFlow: 3.0, // pulses per lance length ...
    lanceVeinSpeed: 2.2, // ... running to the point, per second
    lanceTipGlow: 1.4, // the point is lit from inside
    lanceTipPow: 3.5, // how tightly that light pools at the point
    lanceBurstSpeed: 9.0, // metres/second the scales are blown off at
    lanceBurstSpin: 2.5, // turns/second they tumble
    lanceBurstDrag: 2.2,
    lanceBurstHeat: 1.0, // they flash white-violet as they go
    lanceIntensity: 1.1,
    lanceRolloff: 0.5, // compresses the body under the bloom threshold: the
    //                    glass is matter and the light in it is what blooms
    lanceOpacity: 1.0,
    lanceSoftFade: 0.2,
    colorLanceGlow: '#8a46ff', // the violet the light leaks as
    colorLanceHot: '#efe4ff', // the white-violet at the point

    /* --- how the black glass is lit (the lance and the debris) --- */
    // Flat posterised facets off a camera-relative key, a violet rim on the
    // silhouette, one tight glass highlight, and a screen-space hairline along
    // every facet edge. The body colours are dark by design: the read is the
    // rim and the edges against black.
    obsidianBands: 3.0, // facet steps
    obsidianPosterize: 0.85,
    obsidianScreenKey: 0.85, // key: scene sun -> camera-relative. A flake is
    //                          thin; under the sun alone both faces land on
    //                          one band and it draws as a paper cut-out
    obsidianAmbient: 0.15,
    obsidianRim: 0.9, // the violet on the silhouette
    obsidianRimPower: 2.6,
    obsidianEdge: 0.7, // the hairline along every facet boundary
    obsidianEdgeWidth: 1.2, // ... in pixels
    obsidianSpecular: 0.5, // the glass highlight
    obsidianGloss: 40.0,
    colorObsidianDeep: '#07040f', // the facet turned away from the key
    colorObsidian: '#180d2e',
    colorObsidianLit: '#3b2566', // ... and the one facing it
    colorObsidianEdge: '#a16bff', // the rim and the hairline

    /* --- 1 · ... and the beam down its axis --- */
    // A white-violet filament on the axis with a few tight satellites winding
    // about it, pinched to nothing at the point, thinning away behind the
    // lance. Additive: this is the light the lance is built around.
    beamStrands: 4.0, // the axis plus satellites (capped at 8)
    beamSpan: 12.0, // metres of path it reaches back over
    beamLead: 0.0, // ... and how far past the front its point sits
    beamRadius: 0.16, // how far off the axis a satellite winds, metres
    beamCoil: 3.5, // turns a satellite makes over the span
    beamSpin: 1.2, // turns/second they roll
    beamWidth: 0.26, // half-width of the filament at its fattest, metres
    beamSatellite: 0.35, // a satellite's width, x that
    beamBow: 0.5, // how sharply it is pinched at the point
    beamTailThin: 0.35, // how thin it is at the tail, x the head
    beamWander: 0.05,
    beamWanderScale: 3.0,
    beamWanderSpeed: 1.5,
    beamSoft: 1.6, // falloff across the strip
    beamCore: 14.0, // the hard thread down the middle
    beamCoreWeight: 0.8,
    beamFiber: 0.45, // how hard the body breaks into travelling fibres
    beamFiberScale: 6.0,
    beamFiberSpeed: 2.5,
    beamPulse: 1.0, // charge running up it to the point
    beamPulseFreq: 2.2,
    beamPulseSpeed: 2.0,
    beamHeadGlow: 1.2, // the point runs hotter
    beamFlare: 2.0, // how far the point blows open on the strike
    beamIntensity: 2.4,
    beamOpacity: 0.9,
    beamSoftFade: 0.3,
    colorBeamCore: '#f4ecff',
    colorBeam: '#9b5cff',
    colorBeamTail: '#3a1680',

    /* --- 2 · the particle debris --- */
    // The same flakes, loosed off the rear of the lance. Each keeps most of
    // the head's speed as a slip back down the spine and flies out on its own
    // drag curve, so the field falls back and opens out - the wake, and the
    // widest part of the silhouette. Measured: a chip is about a fortieth of
    // the streak, and the cloud spreads to about two metres either side.
    debrisCount: 70.0, // chips (capped at 220)
    debrisSlivers: 0.5, // long slivers alongside them, x the above
    debrisLife: 1.5, // seconds one flake lasts, and its respawn period
    debrisLead: -3.0, // metres ahead of the front they come off: negative,
    //                   they come off the lance's frayed rear
    debrisRadius: 0.5, // how far off the axis they are born, metres
    debrisThrow: 2.6, // launch speed, metres/second
    debrisForward: 0.25, // how much of that is along the heading ...
    debrisSpread: 0.9, // ... and how much is radial
    debrisCarry: 0.7, // fraction of the head's own speed they keep. What
    //                   they do not keep is the length of the wake
    debrisDrag: 1.2,
    debrisGravity: 1.0,
    debrisSize: 0.12, // metres, before the per-flake roll
    debrisSizeVariance: 0.6, // squared, so most are small and a few are large
    debrisLong: 1.6, // how long the longest sliver is, x its width
    debrisSpin: 0.7, // tumble, turns/second
    debrisGrowIn: 0.08, // fraction of life spent snapping to size
    debrisShrinkOut: 0.6, // ... and where the shrink starts. No burst: this
    //                       is a trail, and a trail does not detonate
    debrisHot: 0.3, // fraction still carrying the void's light inside
    debrisHotGlow: 1.2,
    debrisHotPulse: 2.5, // ... breathing, per second
    debrisFlash: 0.9, // white-violet the instant a flake comes away
    debrisFlashLife: 0.14,
    debrisIntensity: 1.1,
    debrisRolloff: 0.5,
    debrisSoftFade: 0.2,
    colorDebrisGlow: '#8f4dff',
    colorDebrisFlash: '#ece0ff',

    /* --- 3 · the shadow ribbon trails --- */
    // Broad silks wound about the wake, opening wider toward the tail and
    // pinched to a point at both ends. Drawn premultiplied-over: the body
    // *darkens* what is behind it and only the hem and the pulses add light.
    // Measured: a ribbon is about a thirtieth of the streak across, and the
    // weave reaches a metre and a half off the axis at its widest.
    ribbons: 4.0, // strands (capped at 8)
    ribbonSpan: 14.0, // metres of path they reach back over
    ribbonLead: -1.5, // where they start: inside the lance, so they leave its
    //                   frayed rear rather than its point
    ribbonRadius: 1.4, // how far off the axis a ribbon bows at the tail, metres
    ribbonHeadRadius: 0.2, // ... x that, where it leaves the lance
    ribbonFlatten: 0.8, // the vertical half of the bow, x the lateral
    ribbonCoil: 1.3, // turns one ribbon makes over the span
    ribbonSpin: 0.2, // turns/second the weave rolls
    ribbonBow: 0.45, // how sharply they converge at the ends
    ribbonWander: 0.25,
    ribbonWanderScale: 1.8,
    ribbonWanderSpeed: 0.6,
    ribbonWidth: 0.36, // half-width at its broadest, metres
    ribbonWidthBow: 0.5,
    ribbonTwist: 0.85, // how far the silk rolls about its own tangent
    ribbonTwistTurns: 1.2,
    ribbonTwistSpeed: 0.2,
    ribbonTwistFace: 0.15, // the floor under the width when it is edge-on
    ribbonSoft: 1.2, // falloff across the strip
    ribbonFiber: 0.7, // how hard the body breaks into fibres
    ribbonFiberScale: 4.0,
    ribbonFiberSpeed: 1.2,
    ribbonHem: 0.12, // width of the lit line inside each border
    ribbonHemGlow: 1.6,
    ribbonHeadGlow: 0.8, // the end nearest the lance runs hotter
    ribbonPulse: 0.5, // charge running up it
    ribbonPulseFreq: 1.4,
    ribbonPulseSpeed: 1.2,
    ribbonInner: 0.8, // how much violet shows through the shadow
    ribbonOpacity: 0.75,
    ribbonSoftFade: 0.4,
    colorRibbonShadow: '#12071f', // the dark of the silk
    colorRibbon: '#3b1a7a', // ... and its violet
    colorRibbonHem: '#a56dff', // the light along its edge

    /* --- 4 · the energy sparks --- */
    // Four-rayed points of light: a trail shed off the lance, a shell thrown
    // on the strike, and one large glare pinned to the point.
    sparkCount: 90.0, // in the trail (capped at 200)
    sparkLife: 0.7,
    sparkLead: -0.6, // metres ahead of the front they are shed: off the lance
    sparkRadius: 0.5,
    sparkThrow: 2.8,
    sparkCarry: 0.8,
    sparkDrag: 1.5,
    sparkGravity: 0.6,
    sparkSize: 0.09, // half-size of a spark, metres
    sparkSizeVariance: 0.6,
    sparkRayLength: 0.7, // reach of the rays, x the spark
    sparkLongRays: 0.25, // fraction with rays three times as long - the
    //                      hairlines on the sheet
    sparkCoreTight: 9.0, // how tight the hot centre is
    sparkRays: 0.9, // brightness of the rays
    sparkRaySharp: 14.0, // how thin they are
    sparkTwinkle: 0.7,
    sparkTwinkleSpeed: 6.0,
    sparkIntensity: 2.2,
    sparkSoftFade: 0.15,
    glareSize: 0.9, // the point of light at the tip, half-size in metres
    glareRays: 1.4, // its rays' reach, x that
    glareIntensity: 2.6,
    glareFlare: 2.5, // how far it blows open on the strike
    sparkBurst: 70.0, // thrown on the strike (capped at 200)
    sparkBurstLife: 0.8,
    sparkBurstThrow: 12.0, // metres/second
    sparkBurstDrag: 2.5,
    sparkBurstSize: 0.12,
    colorSparkCore: '#ffffff',
    colorSpark: '#c9a6ff',

    /* --- 6 · the lingering shadow motes --- */
    // Soft puffs of violet smoke laid down where the lance passed and left
    // there - they keep almost none of its speed - swelling and thinning from
    // their edges in, with a few bright motes drifting up through them. The
    // layer still on screen when everything else has gone.
    moteCount: 90.0, // puffs and motes together (capped at 260)
    moteBright: 0.3, // fraction that are bright motes instead of puffs
    moteLife: 2.6, // seconds one lasts
    moteLead: -4.5, // metres ahead of the front it is laid down: behind the lance
    moteRadius: 1.2, // how far off the axis, metres
    moteCarry: 0.06, // fraction of the head's speed it keeps: it lingers
    moteRise: 0.35, // metres/second it climbs
    moteDrift: 0.6, // metres/second it spreads outward, dragged to a stop
    moteDrag: 1.5,
    moteSize: 0.55, // half-size of a puff at birth, metres
    moteGrow: 1.2, // ... and how much it swells over its life, x
    moteSizeVariance: 0.5,
    moteSpin: 0.08, // turns/second a puff turns
    moteErode: 0.5, // how much of a puff the noise eats
    moteNoiseScale: 1.8,
    moteNoiseSpeed: 0.35,
    moteInnerGlow: 0.8, // lit from inside while young
    moteOpacity: 0.6,
    moteBrightSize: 0.07, // half-size of a bright mote, metres
    moteBrightIntensity: 2.0,
    moteTwinkleSpeed: 3.0,
    moteSoftFade: 0.6,
    colorMoteShadow: '#0d0618',
    colorMote: '#33176a',
    colorMoteGlow: '#7d45e6',
    colorMoteBright: '#d9c4ff',

    /* --- the strike, in the camera --- */
    // Everything the strike does that is not one of the six layers, and it is
    // deliberately only two things: a shove and a rumble.
    impactShake: 0.3,
    shakeDuration: 0.4,
    rumble: 0.02, // while it flies
    burnShake: 0.03, // while it comes apart

    /* --- the two lights it carries --- */
    // One at the point and one standing back in the wake, so the floor is lit
    // along the length of the streak rather than under one spot of it.
    lightColor: '#8f52ff', // the point
    lightIntensity: 30.0,
    lightRadius: 10.0,
    lightFlicker: 0.3, // void light stutters
    lightFlickerSpeed: 10.0,
    wakeLightColor: '#5a2ccc', // the wake
    wakeLightIntensity: 18.0,
    wakeLightRadius: 12.0,
    wakeLightBack: 5.0, // metres behind the point it stands
    wakeBreath: 0.3,
    wakeBreathSpeed: 2.5
  },

  /* ------------------------------------------------------------------ */
  /* Sentinel Drone — the summon                                         */
  /* ------------------------------------------------------------------ */
  /**
   * The one ability that is not a cast: a **toggle**. Press it and an armed
   * hexacopter prints itself in over the caster's head and stays on station
   * until it is recalled; while it is up, every other slot is locked.
   *
   * It is flown, not aimed. The on-screen stick (or WASD, or the open hand
   * pushed off the middle of the frame) is a velocity; letting go holds
   * position. Closing the fist (or holding fire) puts it to work: it picks the
   * nearest body inside its ground ring, turns onto it, locks, and empties a
   * burst into it — and keeps doing that for as long as the fist stays shut.
   *
   * `range` is the ring; `speed` is here only because the shared contract
   * expects it, the drone never advances a front. See `abilities/DroneAbility.js`.
   */
  drone: {
    /* --- the cast --- */
    range: 7.0, // radius of the kill ring on the floor, metres
    minRange: 0,
    speed: 1, // unused — the summon has no front
    cooldown: 2.5, // starts on recall
    castAnim: 'cast2',

    /* --- the airframe --- */
    size: 2.1, // rotor tip to rotor tip, metres
    altitude: 3.6, // hover height, metres above the floor
    bladeSpeed: 18.0, // revolutions per second at full spin
    bladeSpinUp: 1.2, // seconds from still to full spin
    bladeBlur: 0.75, // how solid the blur disc reads at full spin
    counterRotate: true, // alternate rotors turn the other way

    /* --- the hover --- */
    hoverAmplitude: 0.11, // metres of bob
    hoverFrequency: 0.55, // bobs per second
    sway: 0.03, // radians of idle wobble
    swaySpeed: 0.8,
    bank: 0.3, // radians the body leans at full speed
    bankRate: 0.03, // fraction of the lean gap left after 1s (lower = snappier)
    aimPitch: 0.35, // radians the nose dips onto a target

    /* --- flight --- */
    maxSpeed: 7.0, // metres/second at full stick
    acceleration: 0.04, // fraction of the velocity gap left after 1s
    leash: 12.0, // furthest it may fly from the caster, metres
    turnRate: 0.03, // heading follows the velocity (fraction left after 1s)
    stickDeadZone: 0.08, // of the on-screen stick's throw
    stickExpo: 1.5, // >1 softens the middle of the stick
    handDeadZone: 0.22, // NDC radius round the centre where the hand holds
    handFullRange: 0.75, // NDC radius at which the hand is full stick
    watch: true, // the caster turns to follow it

    /* --- deploy & recall --- */
    deployTime: 1.5, // seconds to rise and print in
    recallTime: 1.0, // seconds to fly home and print out
    launchHeight: 1.9, // metres above the floor it appears at
    downwash: 26, // dust particles/second thrown off the floor under it
    downwashSize: 0.8,
    deployShake: 0.12,

    /* --- the look of the metal --- */
    revealColor: '#7fe0ff',
    revealWidth: 0.1, // metres the hot edge spans
    revealGlow: 7.0,
    rimColor: '#6fd2ff',
    rimStrength: 0.5,
    rimPower: 2.8,
    navLights: 1.2, // nav light brightness
    navSize: 0.11, // metres
    strobeRate: 1.4, // strobe flashes per second
    navColorFront: '#ff3b2f',
    navColorBack: '#3bff7a',

    /* --- the range ring --- */
    ringWidth: 0.22,
    ringGlow: 1.6,
    ringSoftness: 0.06,
    ringFill: 0.1,
    ringTicks: 36,
    ringTickLength: 0.35,
    ringTickWidth: 0.22,
    ringTickSpin: 0.04,
    ringSweep: 0.55,
    ringSweepSpeed: 0.3,
    ringPulse: 0.9,
    ringOpacity: 1.0,
    colorRing: '#5fd0ff',
    colorRingHot: '#ff3b2f',

    /* --- the searchlight --- */
    beamAngle: 9.0, // half-angle, degrees
    beamIntensity: 0.32,
    beamEdge: 1.6, // how fast the cone fades to its silhouette
    beamFalloff: 0.55, // how fast it fades from the drone to the floor
    beamNoise: 0.35,
    beamNoiseScale: 2.0,
    beamSwing: 0.002, // fraction of the aim gap left after 1s
    spotIntensity: 0.55, // the pool on the floor
    colorBeam: '#bfe9ff',
    colorBeamHot: '#ff5a3c',

    /* --- targeting --- */
    aimTurnRate: 0.0015, // fraction of the heading gap left after 1s
    lockTime: 0.4, // seconds the reticle takes to close
    lockCone: 0.18, // radians of heading error it will fire within
    aimHeight: 0.62, // fraction of a body's height the shot is aimed at
    retarget: 0.3, // seconds between one burst and the next lock
    reticleSize: 1.4, // metres
    reticleGlow: 1.6,
    colorReticle: '#ffc46a',
    colorLocked: '#ff3b2f',

    /* --- the burst --- */
    rounds: 6,
    burstTime: 0.32, // seconds the rounds are spread over
    tracerSpeed: 60.0, // metres/second
    tracerSize: 0.09,
    tracerLength: 1.4, // metres
    spread: 0.035, // radians
    casings: true,
    fireShake: 0.1,
    fireFlash: 0.05,
    muzzleSize: 0.55,
    colorTracer: '#fff1c4',
    colorTracerTail: '#ff8a3c',
    colorFlash: '#ffd9a8',
    impactSparks: 22,
    colorSpark: '#ffd27a',
    scorch: true,
    hit: {
      impulse: 7.5, // metres/second the body leaves at, along the shot
      lift: 3.2,
      spin: 1.3
    },

    /* --- light --- */
    lightIntensity: 9.0, // the body light
    lightRadius: 7.0,
    lightColor: '#9fdcff',
    muzzleLight: 40.0, // the punch each round adds
    spotLight: 6.0, // the floor light under the beam
    spotLightRadius: 6.0
  },

  /* ------------------------------------------------------------------ */
  /* Monowheel Bot — the second summon                                   */
  /* ------------------------------------------------------------------ */
  /**
   * The drone's principle on the ground: a **toggle** that prints an armoured
   * one-wheeled sentry in on the floor in front of the caster and keeps it
   * there until it is recalled, locking every other slot while it is out.
   *
   * It is driven, not flown. The same stick, keys and open hand hand it the
   * same screen-relative demand, but a wheel cannot strafe: free, it turns to
   * face the stick and drives along its heading; locked onto a target it faces
   * the target and the stick is a tank's throttle. Closing the fist (or
   * holding fire) puts it to work exactly as it does the drone — nearest body
   * in the ring, turn on, lock, burst — with the burst alternating the two
   * guns on its nose.
   *
   * `range` is the ring; `speed` is here only because the shared contract
   * expects it. See `abilities/MonowheelAbility.js`.
   */
  monowheel: {
    /* --- the cast --- */
    range: 7.0, // radius of the kill ring on the floor, metres
    minRange: 0,
    speed: 1, // unused — the summon has no front
    cooldown: 2.5, // starts on recall
    castAnim: 'cast2',

    /* --- the chassis --- */
    size: 1.7, // floor to the top of the hull, metres
    deployDistance: 2.4, // metres in front of the caster it prints in at

    /* --- the balance --- */
    lean: 0.2, // radians the hull leans forward at full speed
    leanRate: 0.03, // fraction of the lean gap left after 1s (lower = snappier)
    bankIntoTurns: 0.16, // radians of lean per rad/s of turn, at full speed
    recoil: 0.05, // radians the hull rocks back per round
    wobble: 0.012, // radians of idle balancing wobble
    wobbleSpeed: 1.8,

    /* --- the drive --- */
    maxSpeed: 6.5, // metres/second at full stick
    acceleration: 0.03, // fraction of the speed gap left after 1s
    leash: 12.0, // furthest it may drive from the caster, metres
    turnRate: 0.004, // heading follows the stick (fraction left after 1s)
    stickDeadZone: 0.08, // of the on-screen stick's throw
    stickExpo: 1.5, // >1 softens the middle of the stick
    handDeadZone: 0.22, // NDC radius round the centre where the hand holds
    handFullRange: 0.75, // NDC radius at which the hand is full stick
    watch: true, // the caster turns to follow it
    treadDust: 44, // dust particles/second off the tread at full speed
    treadDustSize: 0.55,

    /* --- deploy & recall --- */
    deployTime: 1.4, // seconds to print in
    recallTime: 0.9, // seconds to brake and print out
    deployShake: 0.1,

    /* --- the look of the metal --- */
    revealColor: '#ffc46a',
    revealWidth: 0.1, // metres the hot edge spans
    revealGlow: 7.0,
    rimColor: '#d9c08a',
    rimStrength: 0.45,
    rimPower: 2.8,

    /* --- the range ring --- */
    ringWidth: 0.22,
    ringGlow: 1.6,
    ringSoftness: 0.06,
    ringFill: 0.1,
    ringTicks: 36,
    ringTickLength: 0.35,
    ringTickWidth: 0.22,
    ringTickSpin: 0.04,
    ringSweep: 0.55,
    ringSweepSpeed: 0.3,
    ringPulse: 0.9,
    ringOpacity: 1.0,
    colorRing: '#e0c46a',
    colorRingHot: '#ff3b2f',

    /* --- the headlamp --- */
    beamAngle: 7.0, // half-angle, degrees
    beamIntensity: 0.26,
    beamEdge: 1.6, // how fast the cone fades to its silhouette
    beamFalloff: 0.55, // how fast it fades from the nose to the floor
    beamNoise: 0.35,
    beamNoiseScale: 2.0,
    beamSwing: 0.002, // fraction of the aim gap left after 1s
    headlightReach: 5.0, // metres ahead it lights when it has nothing to shoot
    spotIntensity: 0.5, // the pool on the floor
    colorBeam: '#ffe9bf',
    colorBeamHot: '#ff5a3c',

    /* --- targeting --- */
    aimTurnRate: 0.0015, // fraction of the heading gap left after 1s
    lockTime: 0.4, // seconds the reticle takes to close
    lockCone: 0.18, // radians of heading error it will fire within
    aimHeight: 0.62, // fraction of a body's height the shot is aimed at
    retarget: 0.3, // seconds between one burst and the next lock
    reticleSize: 1.4, // metres
    reticleGlow: 1.6,
    colorReticle: '#ffc46a',
    colorLocked: '#ff3b2f',

    /* --- the burst --- */
    rounds: 8, // alternates the two guns
    burstTime: 0.4, // seconds the rounds are spread over
    tracerSpeed: 60.0, // metres/second
    tracerSize: 0.09,
    tracerLength: 1.4, // metres
    spread: 0.03, // radians
    casings: true,
    fireShake: 0.1,
    fireFlash: 0.05,
    muzzleSize: 0.6, // the hot core on the muzzle, metres
    muzzleLength: 0.9, // metres the flame reaches out of the barrel
    muzzleStreaks: 6, // streaks in each flame
    colorTracer: '#fff1c4',
    colorTracerTail: '#ff8a3c',
    colorFlash: '#ffd9a8',
    impactSparks: 22,
    colorSpark: '#ffd27a',
    scorch: true,
    hit: {
      impulse: 7.5, // metres/second the body leaves at, along the shot
      lift: 3.2,
      spin: 1.3
    },

    /* --- light --- */
    lightIntensity: 7.0, // the body light, on the nose
    lightRadius: 6.0,
    lightColor: '#ffd9a8',
    muzzleLight: 40.0, // the punch each round adds
    spotLight: 5.0, // the floor light under the headlamp
    spotLightRadius: 5.0
  },

  /* ------------------------------------------------------------------ */
  /* Serpent Tide Field — the phoenix                                    */
  /* ------------------------------------------------------------------ */
  /**
   * A far cast that summons a phoenix onto the point. Built to a seven-panel
   * breakdown: the bird (a fresnel of fire), serpentine fire trails, wispy
   * flame waves, the scorched crust, a heat field, floating embers and the
   * sub-surface glow. Every temperature below is in kelvin, because the fire
   * is shaded as a radiator: the colours are what a grey body emits between
   * `tempEdge` and `tempCore`, and `palette` blends the four authored stops
   * over that.
   */
  phoenix: {
    /* --- the cast --- */
    range: 22.0, // max cast distance, metres
    minRange: 0,
    speed: 30.0, // the seed's flight, m/s
    cooldown: 5.0,
    castAnim: 'cast3',
    zoneRadius: 5.0, // the field's footprint on the floor, metres
    lifetime: 11.0, // seconds the phoenix hunts
    fadeTime: 1.7, // seconds it takes to burn out
    seedHeight: 1.4, // metres the seed leaves the hand at
    seedArc: 2.2, // metres of lob over the flight
    seedTrail: 140, // embers/second behind the seed
    seedSize: 0.4, // metres, the seed comet's head radius

    /* --- the eruption --- */
    eruptionEmbers: 160, // embers thrown up out of the pyre
    eruptionLight: 90.0,
    eruptionShake: 0.45,
    eruptionFlash: 0.14,
    spreadTime: 0.55, // seconds the scorch takes to reach its edge

    /* --- 1 · the phoenix --- */
    wingspan: 4.6, // metres, tip to tip
    altitude: 2.7, // metres the body hovers at
    riseTime: 1.3, // seconds to climb out of the pyre
    riseFrom: -0.7, // metres under the floor it starts
    hoverAmplitude: 0.16, // metres of bob
    hoverFrequency: 0.45, // bobs per second
    sway: 0.035, // radians of idle wobble
    swaySpeed: 0.9,
    flapSpeed: 1.0, // flap cycle rate
    turnRate: 0.004, // fraction of the heading gap left after 1s
    bank: 0.35, // radians it banks into a turn
    bankRate: 0.03, // fraction of the lean gap left after 1s
    aimPitch: 0.3, // radians the head dips onto a target
    divePitch: 0.75, // radians of nose-down in the dive
    burnClimb: 1.4, // m/s it lifts as it burns out
    flareStrength: 0.7, // how much brighter it runs as it spits and kicks

    /* --- the fire it is made of --- */
    tempCore: 3600, // K, the white-hot rim
    tempEdge: 1450, // K, the deep red body
    emissionCurve: 2.4, // radiated power goes as (T/Tcore)^this
    palette: 0.3, // 0 pure radiator → 1 the four colours below
    colorCore: '#fff3d0',
    colorMid: '#ff9a22',
    colorEdge: '#ff3a08',
    colorEmber: '#3a0a02',
    bodyHeat: 0.55, // how hot the plumage runs, 0 ember → 1 white
    rimPower: 2.2,
    rimStrength: 1.5, // the fresnel of fire
    flameScale: 1.5, // flame noise over the body, 1/m
    flameRise: 1.9, // m/s the flames climb it
    flameStrength: 0.6, // how much the flames move the heat
    lick: 1.4, // how far the rim drags the flames upward
    paintShow: 0.3, // how much of the painted plumage shows through
    emission: 2.4,
    featherBurn: 0.35, // how much the feather edges flicker away
    auraSize: 0.05, // metres the fire stands off the body
    auraStrength: 1.3,
    auraThreshold: 0.48, // higher = sparser tongues
    revealWidth: 0.2, // metres of molten edge as it rises
    revealGlow: 7.0,

    /* --- the hunt --- */
    fireRange: 9.0, // metres from the centre it engages
    retarget: 0.35, // seconds between one body and the next
    aimTime: 0.28, // seconds the beak takes to come onto a body
    lockCone: 0.2, // radians of heading error it will spit within
    aimHeight: 0.62, // fraction of a body's height the shot is aimed at
    spread: 0.03, // radians

    /* --- the volley --- */
    volleyRounds: 3,
    volleyInterval: 0.15, // seconds between them
    fireballSpeed: 19.0, // metres/second
    fireballSize: 0.36, // metres, the head's radius
    fireballTail: 3.0, // metres of burning wake behind it
    fireballArc: 0.35, // lift it leaves with, as a fraction of its speed
    fireballHoming: 0.02, // fraction of the aim gap left after 1s
    /* the volume each round is marched as: every length in head radii */
    fireballIntensity: 3.5, // emission
    fireballWakeWidth: 0.5, // the wake pinches to this just behind the head
    fireballWakeSpread: 0.6, // ...and spent gas swells back out by this
    fireballPlume: 1.5, // how far the wake's gas climbs, as a stretch
    fireballBulge: 0.28, // lobes in the silhouette
    fireballShred: 1.3, // how hard the fringe is torn
    fireballNoiseScale: 3.0, // turbulence, per head radius
    fireballFlow: 1.0, // gas streams back at this fraction of the round's speed
    fireballBuoyancy: 2.2, // how fast the flame field climbs
    fireballVortex: 0.8, // roll-up of the wake into billows
    fireballDetach: 0.8, // how far down the wake it tears into puffs
    fireballSoftness: 0.6, // hard sheets of gas → soft cloud
    fireballTailHeat: 0.45, // how hot the end of the wake still runs
    fireballDensity: 1.1,
    fireballSoot: 1.3, // how hard the cool gas blocks what is behind it
    fireballSteps: 26, // march samples per ray
    fireballHalo: 0.8, // the light round the head
    trailRate: 40, // embers, sparks and smoke shed per second by each round
    spitFlash: 0.7, // metres
    spitLight: 30.0,
    spitShake: 0.05,
    impactRadius: 1.0, // metres the burst reaches
    impactSparks: 26,
    impactScorch: true,
    hitShake: 0.14,
    hitFlash: 0.04,
    fireballLight: 38.0,
    hit: {
      impulse: 9.5, // metres/second the body leaves at, along the shot
      lift: 4.2,
      spin: 1.6
    },

    /* --- the kick --- */
    kickRange: 3.4, // metres from the centre within which it uses the talons
    kickTime: 0.95, // seconds for the dive and the climb back
    kickHeight: 0.15, // metres above the chest the talons stop
    kickBurst: 1.6, // metres the gout of fire reaches
    kickShake: 0.3,
    kickHit: {
      impulse: 13.0,
      lift: 6.5,
      spin: 2.6
    },

    /* --- 2 · serpentine fire trails --- */
    serpents: 3,
    serpentGrowTime: 1.4, // seconds they grow out of their heads
    serpentRadius: 0.72, // of the zone radius
    serpentWeave: 0.32, // how far the S-bends swing, of that radius
    serpentWaves: 3, // bends per lap
    serpentHeight: 0.45, // metres they rise and dip
    serpentLift: 0.3, // metres the spine sits off the floor
    serpentLength: 0.42, // fraction of a lap each trail covers
    serpentSpeed: 0.26, // laps per second
    serpentWidth: 0.5, // metres
    serpentFloorWidth: 1.3, // metres, the pool of light under each
    serpentNoiseScale: 1.3,
    serpentFlow: 1.2,
    serpentRise: 0.9,
    serpentShred: 1.3,
    serpentHeadGlow: 1.4,
    serpentIntensity: 1.5,
    serpentFloorGlow: 0.5,
    serpentEmbers: 18, // embers/second off each head

    /* --- 3 · wispy flame waves --- */
    skirtRadius: 0.52, // of the zone radius
    skirtHeight: 1.9, // metres
    skirtRiseTime: 0.7, // seconds it stands up in
    skirtFlare: 0.3, // how far the top leans out
    skirtBreathe: 0.07,
    skirtNoiseScale: 1.8,
    skirtRise: 1.5, // m/s the tongues climb
    skirtShred: 1.4,
    skirtWisp: 0.7, // ridged wisps at the top
    skirtWaveSpeed: 0.8, // waves per second rolling round it
    skirtWaveDepth: 0.45,
    skirtHeat: 1.0,
    skirtIntensity: 1.3,
    skirtOpacity: 0.7,
    smokeRate: 10, // smoke puffs/second off the top of it
    smokeOpacity: 0.3,

    /* --- 4 · the scorch --- */
    scorchRadius: 1.0, // of the zone radius
    scorchDark: 0.92,
    colorScorch: '#0a0503',
    crackScale: 1.3, // plates per metre
    crackWidth: 0.05,
    crackGlow: 2.0,
    crackReach: 0.8, // of the scorch radius the cracks run out to
    groundEmbers: 0.9,

    /* --- 5 · floating fire embers --- */
    emberRate: 110, // embers/second across the field
    bodyEmbers: 45, // embers/second off the bird
    emberSize: 0.075,
    emberLife: 2.8,
    emberRise: 1.4, // m/s^2 of lift
    emberGlow: 2.6,

    /* --- 6 · sub-surface heat glow --- */
    glowRadius: 1.15, // of the zone radius
    glowIntensity: 0.5,
    glowPulse: 0.4, // how hard it breathes
    glowPulseSpeed: 1.5,
    colorGlow: '#ff5a10',

    /* --- light --- */
    lightIntensity: 28.0, // the bird
    lightRadius: 14.0,
    lightColor: '#ff8a2a',
    lightGutter: 0.25,
    lightGutterSpeed: 11.0,
    fieldLight: 22.0, // under the pyre
    fieldLightRadius: 12.0
  },

  /* ================================================================== */
  /* SHARD — Corrupted Shard Spawn                                       */
  /* ================================================================== */
  /**
   * A far cast built to the six-panel breakdown sheet — ground rune decal,
   * rising crystal shards, radial water splash, dark mist tendrils, glow
   * flash, corrupted droplets — and this block is grouped in exactly those six
   * sections, so a panel of the sheet and a folder of the editor are the same
   * thing. A seventh section, **the beam**, is what the composite implies and
   * the sheet does not draw: the glow flash is a *light source*, and once it is
   * lit it fires a beam of that light at whatever is standing in reach.
   *
   * The palette is the load-bearing decision. Everything here is one hue —
   * violet — pushed two ways: **cold** toward indigo and near-black for the
   * water, the mist and the crystal bases; **hot** toward magenta and white for
   * the corruption sealed inside the gems, the flare and the beam. The single
   * pure white on the sheet is the flash, and the beam carries it out.
   *
   * Two units are in play. Anything about the **footprint** — where the
   * crystals are planted, how wide the splash is, the rune's rails — is a
   * fraction of `zoneRadius`, so dragging the footprint re-seats the whole
   * spawn. Anything about a **single thing** — a crystal's height, a rail's
   * stroke, a droplet's size — is in metres.
   */
  shard: {
    /* --- the cast --- */
    range: 22.0, // maximum cast distance, metres
    minRange: 0.0, // it can be planted at the caster's own feet
    zoneRadius: 3.6, // the footprint — what the circle indicator measures out
    speed: 64.0, // how fast the seed runs to the point, metres/second
    cooldown: 3.0,
    castAnim: 'cast1', // which clip in `CAST_ANIMATIONS` the body throws
    lifetime: 7.0, // seconds the spawn stands, once it is lit
    fadeTime: 1.7, // seconds it takes to go out

    /* --- the order things happen in, seconds from the seed landing --- */
    /**
     * The spawn is a *sequence*: the rune is cut before anything comes through
     * it, the water is thrown by the crystals breaking the floor, the flash
     * ignites once the crystals are standing around it, and the beam is only
     * armed once there is a light to fire it from.
     */
    runeTime: 0.4, // the rune races out to the boundary
    splashRise: 0.2, // the crown goes up over
    splashHold: 0.08, // ... hangs for
    splashFall: 0.6, // ... and falls away over
    crystalDelay: 0.08, // the first crystal breaks the floor at
    crystalTime: 0.5, // how long one takes to reach full height
    crystalStagger: 0.55, // how much later the last one may leave than the first
    crystalOvershoot: 0.12, // how far past full height the punch throws it
    crystalSettle: 0.28, // seconds it takes to drop back onto its seat
    flareDelay: 0.42, // the flash ignites at
    flareTime: 0.3, // ... and reaches full brightness over
    mistDelay: 0.15, // the tendrils start rising at
    fireDelay: 0.35, // seconds after the flash is lit before the first beam

    /* --- where the seed leaves the caster --- */
    handHeight: 1.25, // metres above the floor
    handForward: 0.62, // metres in front of the caster
    handSide: -0.14, // metres to the side (+ follows `Ability#side`)

    /* --- the pulse everything glowing rides --- */
    /**
     * Fast and shallow, with a *snap* in it:
     * this is not a plant, it is a light source with something wrong sealed in
     * it. Two sines a fifth apart, sharpened.
     */
    pulseRate: 1.7, // radians/second through the envelope
    pulseDepth: 0.45, // how hard it modulates, 0 = flatline

    /* ------------------------------------------------------------------ */
    /* Layer 1 — the ground rune                                           */
    /* ------------------------------------------------------------------ */
    runeRailWidth: 0.03, // stroke thickness, metres
    runeRailOuter: 1.0, // the boundary rail, × footprint
    runeRailTwin: 0.955, // the second rail just inside it
    runeRailInner: 0.84, // the rail the glyph band sits against
    runeRailMid: 0.6, // the rail the star is inscribed in
    runeRailHub: 0.15, // the hub
    runeRailGlow: 1.8,
    runeSpin: 0.018, // revolutions/second the ring turns

    runeGlyphs: 42, // glyphs around the band
    runeGlyphBand: 0.27, // height of the band, metres
    runeGlyphSeat: 0.905, // where it sits, × footprint
    runeGlyphWeight: 0.055, // stroke thickness, cell space
    runeGlyphStrokes: 0.55, // how many candidate strokes a glyph keeps
    runeGlyphSweep: 1.6, // brightness of the read head running round it
    runeGlyphSweepSpeed: 0.17, // revolutions/second
    runeGlyphSweepWidth: 0.1, // how much of the ring it covers
    runeGlyphFlicker: 0.28, // per-glyph brightness stutter
    runeGlyphGlow: 2.4,

    runeStar: 1.1, // the hexagram inscribed in the mid rail
    runeStarWidth: 0.028, // metres
    runeStarSpin: -0.011, // counter to the ring
    runeHex: 0.7, // the hexagon through the star's points
    runeOrbits: 0.9, // the small circles on those points
    runeOrbitRadius: 0.1, // × footprint
    runeSpokes: 6, // radial lines from the hub to the inner rail
    runeSpokeWidth: 0.018, // metres
    runeSpokeGlow: 0.65,
    runeTicks: 0.8, // graduations on the outer rail
    runeTickCount: 60,
    runeTickWidth: 0.3,
    runeTickLength: 0.05, // × footprint

    runeWash: 0.34, // the wash of light inside the circle
    runeWashFalloff: 2.0,
    runeGrain: 0.5, // break-up over that wash
    runeGrainScale: 2.4,
    runeOpacity: 1.0,
    runeGlow: 1.2,
    runeHeight: 0.03, // hover distance above the floor, metres

    /* ------------------------------------------------------------------ */
    /* Layer 2 — the crystal shards                                        */
    /* ------------------------------------------------------------------ */
    /**
     * Three populations, as the sheet draws them: one **spire** in the middle
     * that owns the silhouette, a ring of **blades** around it leaning outward,
     * and a skirt of short fat **shards** at the foot that stop the cluster
     * floating on the rune. Capacity is 24; the count is dealt round the three.
     */
    crystals: 12,
    spireHeight: 3.7, // the middle one, metres
    bladeHeight: 2.3, // the ring, metres
    shardHeight: 1.0, // the skirt, metres
    crystalHeightJitter: 0.35,
    crystalRadius: 0.36, // base radius of a blade, metres
    crystalRadiusJitter: 0.3,
    bladeSeat: 0.36, // where the ring is planted, × footprint
    shardSeat: 0.62, // ... and the skirt
    crystalSeatJitter: 0.25,
    bladeLean: 0.42, // radians the ring leans outward
    shardLean: 0.6, // ... and the skirt
    crystalLeanJitter: 0.35,
    crystalTwist: 1.0, // how far each is yawed about its own axis
    crystalFacets: 6, // sides on the prism
    crystalTaper: 0.11, // tip radius, × base
    crystalRough: 0.32, // how far facets are pushed off a clean prism
    crystalBend: 0.16, // sideways curve from base to tip
    crystalSinkTime: 0.9, // seconds they take to withdraw as the spawn goes
    shatterChips: 90, // fragments thrown as they go

    /* --- what the stone is made of --- */
    gemDepthTint: 1.3, // how hard the body darkens where you look into it
    gemFresnel: 2.0,
    gemFresnelPower: 2.6,
    gemDispersion: 0.6, // how far the rim splits into its colours
    gemFacetSharp: 0.75, // how hard facets are lifted toward the camera
    gemScreenKey: 0.7, // how much of that lift comes from a screen-space key
    gemCleave: 0.7, // internal cleavage planes
    gemCleaveScale: 7.0,
    gemVein: 1.1, // the corruption sealed in the flaws
    gemVeinScale: 3.2,
    gemVeinFlow: 0.4, // how fast it climbs
    gemVeinBase: 0.3, // how much thinner it is at the tip than the base
    gemVeinSharp: 5.0,
    gemBaseDark: 0.28, // how far up the obsidian foot reaches, 0..1
    gemTipFrost: 0.55, // the milky band at the tip
    gemTipStart: 0.62,
    gemGlint: 0.7,
    gemGlintScale: 28,
    gemGlintSpeed: 0.6,
    gemGlow: 0.75,
    gemEdgeGlow: 0.6,
    gemBodyGlow: 0.45, // the glass lit from inside — what keeps it violet on a dark stage
    gemBirthGlow: 0.6, // how incandescent a crystal is as it tears out
    gemBirthFade: 0.45, // seconds that takes to cool
    gemChargeGlow: 2.0, // how hot the veins run as the beam winds up
    gemCoreBleed: 0.55, // how much of the flash's light lands on the facets
    gemCoreBleedRadius: 3.6, // metres it carries
    gemOpacity: 0.96,
    gemRoughness: 0.14,
    gemEnv: 1.0,

    /* ------------------------------------------------------------------ */
    /* Layer 3 — the radial water splash                                   */
    /* ------------------------------------------------------------------ */
    splashRadius: 0.5, // where the crown stands, × footprint
    splashHeight: 2.1, // how high the fingers reach, metres
    splashFingers: 24, // roughly how many
    splashFingerDepth: 0.9, // how much lower the wall is between them
    splashFlare: 0.3, // how far the wall leans out as it stands
    splashLean: 1.1, // ... and how much further as it falls
    splashCurl: 0.18, // how far the tips curl back in
    splashWobble: 0.08, // how far the wall wanders off round
    splashWobbleScale: 2.2,
    splashTear: 0.55, // how far down the crest is torn into spray
    splashFresnel: 1.3,
    splashOpacity: 1.0,
    splashGlow: 1.0,
    splashRipple: 1.25, // the ring that runs out across the floor, × footprint
    splashDrops: 160, // droplets flung off the crown
    splashDropSpeed: 6.0,
    splashDropSize: 0.14,
    splashDropLife: 1.3,

    /* ------------------------------------------------------------------ */
    /* Layer 4 — the dark mist tendrils                                    */
    /* ------------------------------------------------------------------ */
    mistRate: 40.0, // puffs per second while it stands
    mistSize: 0.9,
    mistLifetime: 2.8,
    mistSpeed: 0.8,
    mistRise: 0.6,
    mistSwirl: 1.6, // radians/second it coils round the cluster
    mistSwirlExpand: 0.5, // how far out it drifts as it coils
    mistOpacity: 0.75,
    mistTurbulence: 0.85,
    mistBurst: 60, // the gout as the floor breaks

    /* ------------------------------------------------------------------ */
    /* Layer 5 — the glow flash                                            */
    /* ------------------------------------------------------------------ */
    flareHeight: 1.45, // metres above the floor — the heart of the cluster
    flareSize: 1.45, // half-width of the quad, metres
    flareCore: 1.0, // the white point
    flareCoreSize: 0.13, // × the quad
    flareRays: 1.0, // the four long rays
    flareRayLength: 1.0, // × the quad
    flareRaySharp: 3.2, // how narrow they are
    flareDiagonals: 0.42, // the four short rays between them
    flareStreak: 0.75, // the horizontal lens streak
    flareStreakLength: 1.0, // × the quad
    flareHalo: 0.55, // the soft bloom around it
    flareHaloFalloff: 2.4,
    flareRing: 0.12, // the faint ring at the edge of the halo
    flareRingRadius: 0.5, // × the quad
    flareSpin: 0.03, // revolutions/second the rays turn
    flareFlicker: 0.14, // how hard it stutters
    flareChargeGain: 1.6, // how much bigger and brighter it runs as a beam winds up
    flareIgnite: 2.6, // the pop as it lights
    flareIntensity: 2.2,
    flareOpacity: 1.0,

    /* ------------------------------------------------------------------ */
    /* Layer 6 — the corrupted droplets                                    */
    /* ------------------------------------------------------------------ */
    beadRate: 24.0, // beads per second shed while it stands
    beadSize: 0.1,
    beadLifetime: 2.6,
    beadSpeed: 0.7,
    beadRise: 0.12,
    beadSwirl: 0.8, // radians/second they drift round the cluster
    beadBurst: 80, // thrown as the flash ignites
    glintRate: 14.0, // the pinpoints of light among them
    glintSize: 0.07,
    glintLifetime: 1.4,

    /* ------------------------------------------------------------------ */
    /* The beam                                                            */
    /* ------------------------------------------------------------------ */
    /**
     * What the flash does once it is lit.
     *
     * It picks the nearest body still standing inside `laserRange` of the
     * spawn, winds up for `laserWarmup` — the flare swells and the veins in
     * every crystal run hot, which is the only warning a body gets — then fires
     * a beam of its own light straight through it. What it hits is thrown, and
     * then burnt out from the inside.
     */
    laserEnabled: true,
    laserRange: 12.0, // metres from the spawn
    laserInterval: 0.55, // seconds between shots
    laserWarmup: 0.3, // seconds the flash charges before one leaves
    laserVolley: 1, // targets taken per shot
    laserLife: 0.4, // seconds a beam is on screen
    laserWidth: 1.0, // master on its thickness
    laserAim: 0.58, // where up the body it lands, 0 feet 1 head
    laserShake: 0.16, // the knock on the camera
    laserFlash: 0.16, // and the flash
    /** How the body leaves. A beam is a *push*, so it goes back and up. */
    laserHit: { impulse: 5.5, lift: 3.4, spin: 2.0 },

    /* --- what the light does to a body it has gone through --- */
    burn: {
      enabled: true,
      stain: 2.6, // how fast the violet takes the body over, per second
      onset: 0.3, // seconds after the hit before it starts to go
      rate: 1.1, // how fast it is burnt away once it starts, per second
      look: {
        color: '#170a2a', // the flesh, lit from inside
        rimColor: '#e070ff', // the silhouette, while it still has one
        rimEmissive: 2.2,
        edgeColor: '#fff2ff', // the line the burn runs along
        edgeEmissive: 4.4,
        edgeWidth: 0.05
      }
    },
    impactBeads: 46, // what comes out of a body the beam has gone through
    impactGlints: 28,
    impactScorch: 0.7, // the mark under it, metres

    beamRadius: 0.06, // half-width at the far end, metres
    beamMuzzleRadius: 0.13, // ... and where it leaves the flash
    beamRadiusCurve: 0.7,
    beamFlare: 0.6, // how much it opens where it lands
    beamFlareWidth: 0.12,
    beamRipple: 0.08, // pressure ripple along its width
    beamRippleBands: 7,
    beamRippleSpeed: 6.0,
    beamStrike: 0.1, // fraction of its life spent arriving
    beamHold: 0.5, // ... and how long before it starts to go
    beamCoreFill: 2.2, // how hard the white is weighted to the axis
    beamEdgePower: 2.4,
    beamSheath: 0.8,
    beamPulse: 1.2, // charge racing along it
    beamPulseBands: 6,
    beamPulseSpeed: 9.0,
    beamPulseSharp: 7.0,
    beamHeadGlow: 2.6,
    beamHeadWidth: 0.07,
    beamMuzzleGlow: 1.7,
    beamMuzzleWidth: 0.08,
    beamIntensity: 2.6,
    beamOpacity: 1.0,
    beamSoftFade: 0.3,

    /* ------------------------------------------------------------------ */
    /* Impact, camera and light                                            */
    /* ------------------------------------------------------------------ */
    muzzleSize: 0.5, // the flash at the caster's hand
    muzzleIntensity: 1.3,
    castFlash: 0.1,
    seedBeads: 22, // thrown from the hand as the seed leaves
    creepRate: 30, // beads off the seed while it runs across the floor
    igniteFlash: 0.3, // the screen flash as the flare lights
    igniteShake: 0.34,
    shakeDuration: 0.5,
    holdShake: 0.03, // the standing rumble
    rumble: 0.03, // ... and the one while the seed is running
    stainLife: 6.0, // the mark left on the floor
    stainIntensity: 0.55,

    lightIntensity: 16,
    lightRadius: 13,
    lightHeight: 0.85, // where the light sits, 0 the floor 1 the flare
    lightPulse: 0.4, // how much of it the pulse owns

    /* --- the palette --- */
    colorRune: '#c65cff',
    colorRuneCore: '#f4dcff',
    colorGlyph: '#e28cff',
    colorRuneWash: '#4d1a80',
    colorRuneFront: '#ffd8ff',

    colorGem: '#8347e6',
    colorGemDeep: '#341466',
    colorGemRim: '#c48cff',
    colorVein: '#ff2e8e',
    colorGemTip: '#f4e6ff',
    colorGemBase: '#110a1c',

    colorWater: '#1b1745',
    colorWaterDeep: '#09071f',
    colorWaterRim: '#a89cff',
    colorWaterCrest: '#ece8ff',
    colorDropA: '#c9c2ff',
    colorDropB: '#5b4fd6',
    colorDropC: '#221a5e',
    colorDropD: '#0b0826',

    colorMistA: '#4a2470',
    colorMistB: '#2a1146',
    colorMistC: '#150826',
    colorMistD: '#06020e',

    colorFlareCore: '#ffffff',
    colorFlareGlow: '#f1cbff',
    colorFlareHalo: '#a35cff',
    colorFlareStreak: '#dba8ff',

    colorBeadA: '#d05cf0',
    colorBeadB: '#7a2ad0',
    colorBeadC: '#2a0f55',
    colorBeadD: '#0e0420',
    colorGlintA: '#ffffff',
    colorGlintB: '#ff9cf0',
    colorGlintC: '#c050ff',
    colorGlintD: '#2a0a4a',

    colorBeamCore: '#ffffff',
    colorBeamInner: '#f2b0ff',
    colorBeamOuter: '#8a2ee6',
    colorBeamPulse: '#ff5ad8',

    colorBurstA: '#f2e0ff',
    colorBurstB: '#a45cff',
    colorBurstC: '#2c0f5c',
    colorScorch: '#1a0f2a',
    colorScorchEdge: '#8a3cd8',
    colorCastFlash: '#d8b0ff',
    colorFlash: '#f0d8ff',
    lightColor: '#b46cff'
  },

  /* ------------------------------------------------------------------ */
  /* Camera rig                                                          */
  /* ------------------------------------------------------------------ */
  camera: {
    // Opens fully zoomed out — this matches `maxDistance`, so the first frame
    // shows the whole arena and the wheel only ever pulls in from there.
    distance: 30,
    minDistance: 3.5,
    maxDistance: 30,
    zoomSpeed: 1.0,
    zoomDamping: 0.002,
    minPolar: 0.35,
    maxPolar: 1.32,
    fov: 46,
    targetHeight: 1.35,
    damping: 0.06,
    autoFrame: 0.35, // how strongly the rig drifts toward an active cast

    /*
     * Edge panning — how the view is steered while a cast is armed.
     *
     * The whole middle of the frame is dead: nothing moves until the aim cursor
     * (the hand, in camera mode) reaches the border, which is what keeps an
     * unsteady hand from dragging the camera around while it is trying to hold
     * an aim. Past the dead zone the speed ramps in with the *square* of how
     * far into the margin the cursor has gone, so the edge starts as a nudge
     * and only reaches `panSpeed` when the hand is right out at the rim.
     */
    panDeadZone: 0.7, // |ndc| below this never pans — the still centre
    panSpeed: 5.0, // metres/second at the very edge of the view
    panRange: 10.0, // furthest the view may be pushed from the caster, metres
    panRecenter: 0.35 // fraction of the offset still left 1s after disarming
  },

  /* ------------------------------------------------------------------ */
  /* Environment & lighting                                              */
  /* ------------------------------------------------------------------ */
  environment: {
    // A dark cinematic stage: one cool key, a colder rim from behind, and very
    // little fill, so the ice is the brightest thing on screen and the fog can
    // swallow the floor into the backdrop.
    sunIntensity: 2.6,
    sunColor: '#e8f3ff',
    sunAzimuth: 2.95,
    sunElevation: 0.6,
    ambientIntensity: 0.14,
    ambientColor: '#8ea8d8',
    hemiIntensity: 0.36,
    hemiSkyColor: '#bdd7ff',
    hemiGroundColor: '#3a4552',
    rimIntensity: 1.1,
    rimColor: '#9ec2ff',
    rimAzimuth: 5.45,
    rimElevation: 0.35,
    envIntensity: 0.32,
    backgroundColor: '#121820',
    // Fog is pulled well back so it only dissolves the far edge of the floor into
    // the backdrop rather than sitting on top of the action. Toggle and range are
    // both live in the editor (Environment → Backdrop, fog & dust).
    fogEnabled: true,
    fogColor: '#121820',
    fogNear: 26,
    fogFar: 135,
    shadowBias: -0.0008,
    shadowRadius: 2.2,
    floorColor: '#191f27',
    floorTint: '#232b35',
    floorRoughness: 0.88,
    floorSheen: 0.34,
    floorPool: 0.8,
    // The stone tiling that dresses the floor: ambientCG Rock030 (CC0), a rough
    // natural rock, living in public/textures/cathedral. `floorTextureScale` is metres of floor
    // one tile covers; `floorTexTint` grades the grey stone toward `floorTint` so
    // it sits inside the cool stage palette instead of fighting it.
    floorTexture: false,
    floorTextureScale: 12.0,
    floorNormalScale: 0.85,
    floorTexTint: 0.4,
    dustAmount: 0.85,
    contactShadow: 0.55
  },

  /* ------------------------------------------------------------------ */
  /* Post processing                                                     */
  /* ------------------------------------------------------------------ */
  post: {
    enabled: true,
    exposure: 1.05,
    // Threshold sits above the ice body's lit value on purpose: only the rim,
    // the glints and the impact should bloom, not the whole crystal field.
    // Strength is deliberately near zero — the crystal silhouette carries the
    // read, and bloom was the thing eating it. Push it up if you want the halo.
    bloomStrength: 0.03,
    bloomRadius: 0.6,
    bloomThreshold: 0.88,
    vignette: 0.52,
    chromaticAberration: 0.4,
    contrast: 1.12,
    saturation: 1.08,
    temperature: -0.03, // + warm / - cool
    lift: -0.008,
    gain: 1.0,
    grain: 0.045,
    // Master gain on the screen-space warp written by LAYER.DISTORTION — the
    // last link in the heat-haze chain. Screen widths, so it stays put when the
    // window resizes.
    distortion: 0.045,
    flashStrength: 1.0
  },
  frost: {
    /* --- the cast --- */
    range: 20.0, // max cast distance, metres
    minRange: 3.0,
    cooldown: 7.0,
    castAnim: 'cast2',
    zoneRadius: 3.2, // the prison's footprint, metres
    lifetime: 4.8, // seconds it stands
    fadeTime: 1.7, // seconds it takes to thaw

    /* --- the landing --- */
    landShake: 0.28,
    landLight: 60.0,
    landGlints: 220, // glints thrown up as the floor freezes
    landMotes: 160, // frost blown off the rim

    /* --- 1 · the ice cylinder --- */
    wallDelay: 0.12, // seconds after the floor freezes
    wallRiseTime: 0.97, // seconds it takes to stand
    wallHeight: 6.9, // metres
    wallOpacity: 0.71,
    wallBody: 0.33, // how solid the clear ice is
    wallTopFade: 0.1, // fraction of the height the top starts thinning at
    wallRimPower: 3.2, // fresnel
    wallRimGlow: 0.61, // cold light at the graze
    wallFrostScale: 1.93, // frost patches per metre
    wallFrost: 0.9, // how much of the wall is frosted
    wallStriaScale: 1.7, // vertical striations per metre
    wallFlow: 0.33, // m/s the caustic light climbs
    wallCaustic: 0.8,
    wallFootGlow: 1.3, // lit from the floor
    wallCracks: 0.74, // hairline cracks
    wallRefraction: 0, // how far the stage bends through it

    /* --- 2 · frost particles --- */
    glintRate: 70, // glints/s lifting inside the wall
    glintSize: 0.09,
    glintLife: 2.6,
    glintRise: 0.35, // m/s² of lift
    glintGlow: 2.0,
    moteRate: 45, // snow/s settling out of the air
    moteSize: 0.06,
    moteLife: 3.2,
    moteFall: -0.35, // m/s² (negative falls)

    /* --- 3 · ground ice --- */
    floorReach: 1.35, // × the footprint the hoarfrost feathers out to
    floorFreezeTime: 0.4, // seconds the front takes to reach the frost
    floorOpacity: 0.86, // the sheet
    floorFrost: 0.75, // the feathers beyond it
    floorFrostScale: 1.6, // feathers per metre
    crackScale: 1.1, // crack cells per metre
    crackWidth: 0.035, // metres
    crackGlow: 1.6, // lit from within
    crackDepth: 0.12, // metres under the surface the cracks sit
    spokes: 9, // radial cracks out of the centre
    footGlow: 1.2, // the ring where the wall stands
    floorSparkle: 1.0, // glitter in the frost
    floorPulse: 0.25, // breathing of the crack light

    /* --- 4 · cold air mist --- */
    // The same smoke the Corrupted Shard coils round its cluster: eroded
    // puffs, not a raymarched volume. Born at the foot of the wall, rolled
    // outward and coiling round the prison as they thin.
    mistRate: 44.0, // puffs per second while it stands
    mistDelay: 0.05,
    mistSize: 1.9,
    mistLifetime: 3.2,
    mistSpeed: 0.65, // m/s it rolls off the rim
    mistRise: -0.35, // m/s² (heavy air settles)
    mistSwirl: -1.4, // radians/second it coils round the wall
    mistSwirlExpand: 0, // how far out it drifts as it coils
    mistOpacity: 0.17,
    mistTurbulence: 0,
    mistBurst: 87, // the gout as the floor freezes

    /* --- 5 · rising shards --- */
    shardCount: 48, // splinters in the air at once
    shardDelay: 0.3, // seconds after the landing they start lifting
    shardSize: 0.16, // metres
    shardRise: 0.5, // m/s
    shardLife: 3.4, // seconds one is in the air
    shardSpin: 0.9, // rad/s
    crownCount: 30, // crystals at the foot of the wall
    crownDelay: 0.1,
    crownGrowTime: 0.5, // seconds they take to grow
    crownHeight: 0.85, // metres
    crownBase: 0.17, // base radius, metres
    crownRadius: 0.97, // × the footprint they stand at
    crownLean: 0.3, // radians outward
    crystalOpacity: 0.92,
    crystalScreenKey: 0.55, // how far the key is turned toward the camera
    crystalInclusions: 5.0, // frost inside the crystals, features per metre
    crystalRim: 0.8, // cold light at the graze

    /* --- 6 · ambient glow --- */
    glowRadius: 1.3, // × the footprint
    glowHeight: 0.9, // metres off the floor
    glowIntensity: 0.4,
    glowPulse: 0.2,
    glowPulseSpeed: 1.8,

    /* --- the frozen bodies --- */
    freezeReach: 1.0, // × the footprint a body has to stand inside
    freezeDelay: 0.1, // seconds after the landing the frost takes the first body
    freezeStagger: 0.2, // seconds more per footprint radius from the centre
    freezeTime: 0.55, // seconds the frost takes to climb a body
    holdTime: 1.1, // seconds it stands frozen
    crackTime: 0.45, // seconds the cracks take to run up it
    bodyCrackWidth: 0.02, // metres
    crackGlowBody: 3.0,
    shatterChunks: 30, // pieces it breaks into (of 48)
    shatterGap: 0.012, // metres opened between the pieces
    shatterSpeed: 3.0, // m/s the pieces leave at
    shatterLift: 3.2, // m/s upward
    shatterOut: 1.2, // share of the throw pointed out of the circle
    shatterSpin: 8.0, // rad/s the pieces tumble
    shatterGravity: -14.0,
    shatterBounce: 0.25,
    shatterFriction: 0.55,
    shatterChips: 160, // splinters thrown off the break
    chipSize: 0.07,
    shatterLight: 50.0,
    shatterShake: 0.16,
    meltDelay: 1.5, // seconds the pieces lie there
    meltTime: 1.3, // seconds they take to melt away
    meltVapour: 12, // puffs/s off the melting pieces
    bodyFrostScale: 9.0, // frost patches per metre on the ice
    iceRough: 0.08, // clear ice
    frostRough: 0.55, // frosted ice
    iceGlow: 0.5, // cold light in the ice
    iceRim: 1.0, // ...at the graze
    iceClearcoat: 0.7, // the glass coat
    iceEnv: 1.3, // the probe in it

    /* --- the ice --- */
    colorDeep: '#0d3b5e',
    colorIce: '#7cc6ee',
    colorFrost: '#eaf7ff',
    colorGlow: '#8fe3ff',
    colorMistA: '#f4faff', // the cold air, bright as it leaves the wall ...
    colorMistB: '#c9dff2',
    colorMistC: '#8fb6d9', // ... going to the blue of the ice ...
    colorMistD: '#3d6690', // ... and dark as it thins
    envStrength: 1.0, // the probe in every raw surface
    sunSpec: 1.2, // the sun highlight on every raw surface

    /* --- the light --- */
    lightColor: '#8fdcff',
    lightIntensity: 40.0,
    lightRadius: 16.0
  },
  toxic: {
    /* --- the cast --- */
    range: 20.0, // max cast distance, metres
    minRange: 3.0,
    cooldown: 8.0,
    castAnim: 'cast3',
    zoneRadius: 3.4, // the barrier's radius, metres
    lifetime: 5.5, // seconds it stands
    fadeTime: 1.6, // seconds it takes to break

    /* --- the landing --- */
    landShake: 0.32,
    landLight: 70.0,
    landSpores: 180, // spores thrown up as the floor breaks

    /* --- 1 · the crystalline barrier --- */
    domeDelay: 0.05, // seconds after the floor breaks
    domeRiseTime: 0.6, // seconds the facets take to all arrive
    domeSink: 0.45, // fraction of the radius the sphere sits under the floor
    domeSpin: 0.05, // rad/s the lattice turns
    domeOpacity: 0.9,
    domeBody: 0.1, // how solid the clear glass is
    domeRimPower: 2.6, // fresnel
    domeRimGlow: 0.55, // venom light at the graze
    sparCount: 24, // crystal spars in the lattice (of 28)
    sparWidth: 0.011, // their thickness, as a fraction of the radius
    sparSpeed: 2.5, // the light running along them
    sparGlow: 1.7,
    sparMinArc: 0.5, // radians a spar reaches either side of its middle
    sparMaxArc: 3.1,
    cellScale: 3.2, // facets per radius
    cellWidth: 0.03, // the facet seams
    cellGlow: 0.2,
    domeSwirl: 0.28, // the poison moving inside the glass
    domeSwirlScale: 2.2,
    domeSwirlSpeed: 0.12,
    domeFootGlow: 0.5, // lit from the rupture at its foot
    domeRefraction: 0, // how far the stage bends through it

    /* --- 2 · the poison gas miasma --- */
    // The same smoke the Corrupted Shard coils round its cluster: eroded
    // puffs, not a raymarched volume. Born under the foot of the barrier,
    // seeping outward and coiling round it as they thin.
    gasRate: 44.0, // puffs per second while it stands
    gasDelay: 0.05,
    gasRadius: 0.9, // × the radius the puffs are born at
    gasSize: 1.9,
    gasLifetime: 3.2,
    gasSpeed: 0.65, // m/s they seep outward
    gasRise: -0.35, // m/s² (heavy gas settles, like the prison mist)
    gasSwirl: -1.4, // radians/second it coils round the barrier
    gasSwirlExpand: 0, // how far out it drifts as it coils
    gasOpacity: 0.17,
    gasTurbulence: 0,
    gasBurst: 87, // the gout as the floor breaks
    sporeRate: 45, // spores/s drifting up inside the barrier
    sporeSize: 0.07,
    sporeLife: 2.8,
    sporeRise: 0.3, // m/s² of lift
    sporeGlow: 2.2,

    /* --- 3 · the ground rupture --- */
    plateReach: 1.0, // × the radius the plate is cut to
    plateCells: 48, // slabs the disc is cut into
    plateDepth: 0.12, // slab thickness, fraction of the radius
    plateRagged: 0.24, // how far the outline bites in
    plateBias: 0.5, // <0.5 makes the middle cells finer
    plateBreakTime: 0.32, // seconds the fracture takes to reach the rim
    plateGap: 0.06, // seam opening, fraction of a slab
    plateHeave: 0.075, // dome, fraction of the radius
    plateTilt: 0.24, // radians the middle slabs cant
    plateRumble: 0.01, // metres the slabs shiver as the shield breaks
    plateWallDark: 0.6,
    colorStain: '#0a1a0e', // the venom stain on the stone
    colorEmber: '#ff7a1a', // the fire still burning in the cracks
    seamGlow: 3.2, // the venom lighting the seams and walls
    crustCrackScale: 2.2, // the top-face fracture network, features per metre
    crustCrackWidth: 0.05,
    crustCrackGlow: 2.2,
    crustCrackReach: 0.9, // fraction of the radius it runs out to
    crustStain: 0.65,
    crustEmber: 1.0, // embers along the cracks
    crustEmberScale: 9.0, // embers per metre
    crustPulse: 0.3, // breathing of the seam light
    crustPulseSpeed: 2.0,
    emberRate: 26, // embers/s lifting off the cracks
    emberSize: 0.06,
    emberLife: 1.6,
    emberRise: 1.4, // m/s² of lift
    texScale: 2.6, // the stone scan
    texAmount: 1.0,
    normalScale: 1.3,
    stoneRough: 1.0,
    stoneRoughFloor: 0.34,
    stoneAO: 1.0,
    dustCoatSharp: 1.5,
    dustCoatScale: 1.2,
    stoneDesat: 0.3,
    stoneGrade: 0.7,
    colorStoneGrade: '#4f5350',
    colorStone: '#565a55',
    colorStoneDeep: '#1e211f',
    colorDustCoat: '#cfc6b3',

    /* --- 4 · the radial shockwave --- */
    ringReach: 1.9, // × the radius the landing ring runs out to
    ringTime: 0.9, // seconds it takes
    ringWidth: 0.028, // thickness, fraction of its reach
    ringSpikes: 28, // flares round it
    ringSpikeReach: 12, // how far the longest flare reaches, × the width
    ringIntensity: 1.4,
    pulsePeriod: 1.4, // seconds between the pulses while it stands (0 = none)
    pulseReach: 1.5, // × the radius a pulse runs out to
    pulseIntensity: 0.55,

    /* --- the bodies turned to glass --- */
    convertReach: 0.85, // × the radius a body has to stand inside
    convertDelay: 0.15, // seconds after the landing the first body is taken
    convertStagger: 0.25, // seconds more per radius from the centre
    convertTime: 0.75, // seconds the conversion takes to climb a body
    convertCellWise: 0.65, // 0 a waterline → 1 whole cells at a time
    convertLead: 0.35, // how far ahead of the front the seams light, of the body
    holdTime: 1.2, // seconds it stands as glass
    crackTime: 0.45, // seconds the cracks take to run up it
    bodyCrackWidth: 0.02, // metres
    crackGlowBody: 3.0,
    bodySeamWidth: 0.012, // the lattice on the body, metres
    bodySeamGlow: 2.6,
    bodySeamSet: 0.3, // how much of it stays lit once the glass has set
    bodySwirl: 0.35, // the poison moving inside the glass
    bodySwirlScale: 4.0,
    glassGlow: 0.55, // venom light in the glass
    glassRim: 1.0, // ...at the graze
    glassClearcoat: 0.85, // the glass coat
    glassRough: 0.08,
    glassEnv: 1.4, // the probe in it
    shatterChunks: 32, // pieces it breaks into (of 48)
    shatterGap: 0.012, // metres opened between the pieces
    shatterSpeed: 3.2, // m/s the pieces leave at
    shatterLift: 3.4, // m/s upward
    shatterOut: 1.1, // share of the throw pointed out of the circle
    shatterSpin: 8.0, // rad/s the pieces tumble
    shatterGravity: -14.0,
    shatterBounce: 0.28,
    shatterFriction: 0.55,
    shatterChips: 170, // splinters thrown off the break
    chipSize: 0.07,
    shatterLight: 55.0,
    shatterShake: 0.18,
    dissolveDelay: 1.4, // seconds the pieces lie there
    dissolveTime: 1.2, // seconds they take to go to vapour
    dissolveVapour: 12, // puffs/s off the dissolving pieces
    breakChips: 90, // glass/s thrown off the barrier as it breaks

    /* --- the glass --- */
    colorDeep: '#05281a',
    colorGlass: '#2ebf73',
    colorGlow: '#73ffb8',
    colorLattice: '#c7ffea',
    colorVenom: '#7a3db3',
    colorGasA: '#a8e89a', // the gas, green where the light gets it ...
    colorGasB: '#4fa85e',
    colorGasC: '#5a3a8e', // ... bruise purple in its own shadow ...
    colorGasD: '#1a0e30', // ... and dark as it thins
    envStrength: 1.0, // the probe in every raw surface
    sunSpec: 1.2, // the sun highlight on every raw surface

    /* --- the light --- */
    lightColor: '#5cff9e',
    lightIntensity: 45.0,
    lightRadius: 17.0
  }
};

/**
 * How an ability is aimed.
 *
 * `LINE` is the skillshot the sandbox started with: an arrow swung about the
 * caster, cast along its length. `ZONE` is the **far cast** — a circle with a
 * thick boundary dropped at the cursor, which answers the only question a
 * ground-targeted AoE has to answer before you commit: how much space is this
 * going to take. Both resolve to the same `cast(origin, direction, distance)`
 * event, so an ability never has to care which one aimed it; a zone ability
 * simply reads its target as `pointAt(1)` and works outward from there.
 */
export const CastShape = Object.freeze({
  LINE: 'line',
  ZONE: 'zone',
  /**
   * A **summon** — not aimed at all. Pressing the slot toggles a construct on
   * and off, and while it stands every other slot is locked. The aim
   * controller draws nothing for it; `App` routes the press to the construct.
   */
  SUMMON: 'summon'
});

/**
 * Ability ids, in slot order.
 *
 * `AbilityManager`, the HUD, the aim controller and the editor all key off this
 * array, and the index is the slot the keyboard binds to — adding a tenth
 * ability is a new file, an entry here and a settings block above.
 */
export const ELEMENTS = [
  'flux',
  'twilight',
  'voidslash',
  'drone',
  'phoenix',
  'monowheel',
  'shard',
  'frost',
  'toxic'
];

/**
 * Registry metadata: how an ability is presented, and how it is aimed.
 *
 * `key` must match `InputManager`. `cast` is read by `AimController` to pick
 * between the arrow and the circle; omit it and the ability is a line cast.
 * `deck` is the badge the control deck wears while a summon is out.
 */
export const ELEMENT_META = {
  flux: {
    label: 'Shimmering Flux',
    accent: '#ff2b4e',
    key: 'Q',
    hint: 'Shimmering Flux of Chaos'
  },
  twilight: {
    label: 'Scorched Twilight',
    accent: '#63c8ff',
    key: 'E',
    hint: 'Scorched Twilight of Rage'
  },
  voidslash: {
    label: 'Void Slash',
    accent: '#a45cff',
    key: 'R',
    hint: 'Linear Void Slash — an obsidian lance with a wake of shadow'
  },
  drone: {
    label: 'Sentinel Drone',
    accent: '#ff5a3c',
    key: 'F',
    hint: 'Sentinel Drone — toggle to deploy',
    cast: CastShape.SUMMON,
    deck: 'DRONE'
  },
  phoenix: {
    label: 'Serpent Tide Field',
    accent: '#ff8a22',
    key: 'V',
    hint: 'Serpent Tide Field — a phoenix that hunts',
    cast: CastShape.ZONE
  },
  monowheel: {
    label: 'Monowheel Bot',
    accent: '#e0c46a',
    key: 'X',
    hint: 'Monowheel Army Bot — toggle to deploy',
    cast: CastShape.SUMMON,
    deck: 'BOT'
  },
  shard: {
    label: 'Corrupted Shard',
    accent: '#c65cff',
    key: 'B',
    hint: 'Corrupted Shard Spawn — a light that fires back',
    cast: CastShape.ZONE
  },
  frost: {
    label: 'Glacial Prison',
    accent: '#8fdcff',
    key: 'Z',
    hint: 'Glacial Prison — freezes what stands in it, then shatters it',
    cast: CastShape.ZONE
  },
  toxic: {
    label: 'Toxic Shield',
    accent: '#73ffb8',
    key: 'N',
    hint: 'Toxic Shield of Conquest — turns what stands in it to glass, then shatters it',
    cast: CastShape.ZONE
  }
};

/** How the given ability is aimed. Line unless its metadata says otherwise. */
export function castShapeOf(element) {
  return ELEMENT_META[element]?.cast ?? CastShape.LINE;
}

/** Whether the ability is a toggled construct rather than a cast. */
export function isSummon(element) {
  return castShapeOf(element) === CastShape.SUMMON;
}

/** The footprint a far cast will cover, metres. 0 for a line cast. */
export function zoneRadiusOf(element) {
  return castShapeOf(element) === CastShape.ZONE ? (settings[element]?.zoneRadius ?? 0) : 0;
}

/** Immutable snapshot used by "Reset to defaults" and the preset system. */
export const DEFAULT_SETTINGS = structuredClone(settings);

/**
 * Deep-merge a plain object into `settings` in place.
 * Existing object identity is preserved so every live binding keeps working.
 */
export function applySettings(patch, target = settings) {
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (target[key] && typeof target[key] === 'object') applySettings(value, target[key]);
    } else if (key in target) {
      target[key] = value;
    }
  }
  return target;
}

/** Restore every value to the shipped defaults (in place). */
export function resetSettings() {
  applySettings(structuredClone(DEFAULT_SETTINGS));
}

/** Serialisable clone of the current state. */
export function snapshotSettings() {
  return structuredClone(settings);
}
