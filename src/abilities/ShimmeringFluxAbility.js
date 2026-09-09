import { Mesh, PlaneGeometry, Vector3 } from 'three';
import { Ability } from './Ability.js';
import { createConeTrailGeometry } from '../assets/FluxGeometry.js';
import { createBoltRibbonGeometry } from '../assets/ProceduralGeometry.js';
import {
  createFluxSpineUniforms,
  fluxSpineFrame,
  fluxSpinePoint,
  syncFluxSpine
} from '../materials/FluxSpine.js';
import { createFluxConeMaterial } from '../materials/FluxConeMaterial.js';
import { createBloodLigamentMaterial } from '../materials/BloodLigamentMaterial.js';
import { createChaosRibbonMaterial } from '../materials/ChaosRibbonMaterial.js';
import { createFluxWarpMaterial } from '../materials/FluxWarpMaterial.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { Easing, randRange, saturate } from '../utils/math.js';

/** Hard ceilings. The editor's sliders clamp here. */
const MAX_RIBBONS = 12;
const MAX_LIGAMENTS = 16;

/** Tessellation. Nothing about the *shape* of either mesh lives here. */
const CONE_RINGS = 80;
const CONE_SEGMENTS = 36;
const RIBBON_NODES = 128;
const LIGAMENT_NODES = 40;

/** How many points along the trail one frame's motes are split between. */
const TRAIL_BATCHES = 3;

const _emit = {};
const _pos = new Vector3();
const _dir = new Vector3();
const _inherit = new Vector3();
const _tangent = new Vector3();
const _side = new Vector3();
const _up = new Vector3();
const _head = new Vector3();
const _worldUp = new Vector3(0, 1, 0);

/**
 * SHIMMERING FLUX OF CHAOS — a linear cast, built to the six-panel breakdown
 * and to nothing else.
 *
 * The sheet names six layers and this file draws six layers. There is no
 * seventh: no fireball shell at the end, no scorch ring on the floor, no white
 * screen flash on the strike. Those are the reflexes that make an effect look
 * like every other effect, and the whole point of a breakdown sheet is that
 * somebody already decided what this one is made of.
 *
 * In the order the eye reads them:
 *
 *  1. **the conical mesh trail** — a funnel that *trails*: its nose is the
 *     front of the ability and it flares open behind, where the trails take
 *     over and leave through its mouth. Drawn as rings, ribs and helices
 *     rather than as a wash of light, eaten open at both ends, and kept dimmer
 *     than the trails so it reads as structure they pass through.
 *     See `materials/FluxConeMaterial.js`.
 *  2. **the fluid blood splatter** — ligaments of liquid torn off the head,
 *     stretching, necking and pinching off into droplets. Half mesh, half
 *     particles, and the only opaque thing in the ability.
 *     See `materials/BloodLigamentMaterial.js`.
 *  3. **the chaotic energy ribbons** — flat strips twisting about the flight
 *     line, half crimson and half rose, their path taken from noise rather
 *     than from a helix. See `materials/ChaosRibbonMaterial.js`.
 *  4. **the glinting sparkles** — a star-shaped particle that twinkles on its
 *     own clock (`ParticleShape.GLINT`).
 *  5. **the distortion wave** — a lens riding the head, boiling, shedding ring
 *     packets, on `LAYER.DISTORTION`. See `materials/FluxWarpMaterial.js`.
 *  6. **the lingering crimson motes** — the slow, soft embers left hanging in
 *     the corridor long after everything else has gone.
 *
 * All six place themselves against **one curve**, `materials/FluxSpine.js`,
 * which is a pure function of distance travelled. That is what makes the trail
 * a record of where the projectile actually went rather than a shape that
 * swims along behind it, and it is why the blood is thrown from where the head
 * *was* rather than from where it is.
 *
 * **The rule that makes the editor work.** A cast captures exactly one number —
 * `_seed` — plus timestamps. Every metre, radian and second is resolved against
 * `settings.flux` each frame, on a zero-length frame included: dragging
 * `coneLength` re-scales a funnel already in the air, dragging `ribbonChaos`
 * re-tangles ribbons already drawn, dragging `weave` re-flies the whole path
 * and everything hung off it follows. That is what pausing with **P**
 * mid-flight is for.
 */
export class ShimmeringFluxAbility extends Ability {
  constructor(context) {
    super('flux', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * One spine, three materials, one write per value per frame.
     *
     * The uniform boxes are created here and *shared by identity* with the
     * cone, the ligaments and the ribbons, so `syncFluxSpine` cannot leave two
     * of them disagreeing about where the flight path is — which is the one
     * failure this ability could not survive.
     */
    this.spine = createFluxSpineUniforms();
    /** The cast's own frame, in the shape `FluxSpine` reads. */
    this._path = {
      origin: new Vector3(),
      dir: new Vector3(0, 0, 1),
      side: new Vector3(1, 0, 0),
      seed: 0
    };

    /* ---- 1 · the conical mesh trail ---- */
    this.coneGeometry = createConeTrailGeometry(CONE_RINGS, CONE_SEGMENTS);
    this.coneMaterial = createFluxConeMaterial(this.spine);
    this.coneMesh = new Mesh(this.coneGeometry, this.coneMaterial);
    this.coneMesh.frustumCulled = false;
    this.coneMesh.matrixAutoUpdate = false;
    this.coneMesh.layers.set(LAYER.VFX);
    this.coneMesh.renderOrder = 12;
    this.group.add(this.coneMesh);

    /* ---- 3 · the chaotic energy ribbons ---- */
    this.ribbonGeometry = createBoltRibbonGeometry(RIBBON_NODES, MAX_RIBBONS);
    this.ribbonMaterial = createChaosRibbonMaterial(this.spine);
    this.ribbonMesh = new Mesh(this.ribbonGeometry, this.ribbonMaterial);
    this.ribbonMesh.frustumCulled = false;
    this.ribbonMesh.matrixAutoUpdate = false;
    this.ribbonMesh.layers.set(LAYER.VFX);
    this.ribbonMesh.renderOrder = 14;
    this.group.add(this.ribbonMesh);

    /* ---- 2 · the fluid blood splatter (the mesh half) ---- */
    // Drawn *last* of everything, and that is deliberate. Depth writes are off
    // across the whole ability, so the order these are submitted in is the
    // order they land in; putting the one opaque layer at the end lets it
    // genuinely occlude the glow instead of being washed out by it. Blood that
    // additive light shines through is not blood.
    this.ligamentGeometry = createBoltRibbonGeometry(LIGAMENT_NODES, MAX_LIGAMENTS);
    this.ligamentMaterial = createBloodLigamentMaterial(this.spine);
    this.ligamentMesh = new Mesh(this.ligamentGeometry, this.ligamentMaterial);
    this.ligamentMesh.frustumCulled = false;
    this.ligamentMesh.matrixAutoUpdate = false;
    this.ligamentMesh.layers.set(LAYER.VFX);
    this.ligamentMesh.renderOrder = 16;
    this.group.add(this.ligamentMesh);

    /* ---- 5 · the distortion wave ---- */
    this.warpGeometry = new PlaneGeometry(1, 1);
    this.warpMaterial = createFluxWarpMaterial();
    this.warpMesh = new Mesh(this.warpGeometry, this.warpMaterial);
    this.warpMesh.frustumCulled = false;
    this.warpMesh.layers.set(LAYER.DISTORTION);
    this.group.add(this.warpMesh);

    /** Re-rolled per cast, so no two casts weave, tangle or splatter alike. */
    this._seed = 0;
    /** Seconds since the strike; < 0 while the projectile is still flying. */
    this._burstTime = -1;
    this._ribbonCount = 1;
    this._ligamentCount = 1;

    // Scratch handed to the four materials each frame. One object each, reused.
    this._coneState = { span: 1, burst: 0, fade: 1 };
    this._ribbonState = { span: 1, strands: 1, fade: 1 };
    this._bloodState = { speed: 0, burst: 0, fade: 1 };
    this._warpState = { dir: new Vector3(0, 0, 1), size: 4, seed: 0, burst: 0, burstFront: 0, fade: 1 };
  }

  createParticles() {
    const particles = this.ctx.particles;

    /* ---- 2 · the droplets the ligaments break into ---- */
    // Non-additive and barely dragged: these are beads of liquid on a ballistic
    // arc, not sparks. `stretch` elongates the bead along its own velocity,
    // which is what a fast droplet does and what ties it back visually to the
    // ligament it was pinched off.
    this.drops = particles.get('flux.blood', {
      capacity: 3000,
      shape: ParticleShape.DROPLET,
      additive: false,
      stretch: true,
      softFade: 0.2
    });
    this.drops.uniforms.uDrag.value = 0.35;
    this.drops.uniforms.uEndSize.value = 0.75;
    this.drops.uniforms.uSizeIn.value = 0.02;
    this.drops.uniforms.uFadeIn.value = 0.02;
    this.drops.uniforms.uFadeOut.value = 0.78;
    // Matter, drawn over the glow, for the same reason the ligaments are.
    this.drops.object3D.renderOrder = 15;

    /* ---- 4 · the glinting sparkles ---- */
    this.glints = particles.get('flux.glints', {
      capacity: 4000,
      shape: ParticleShape.GLINT,
      additive: true,
      softFade: 0.25
    });
    this.glints.uniforms.uDrag.value = 2.2;
    this.glints.uniforms.uEndSize.value = 0.25;
    this.glints.uniforms.uSizeIn.value = 0.05;
    this.glints.uniforms.uFadeIn.value = 0.06;
    this.glints.uniforms.uFadeOut.value = 0.42;

    /* ---- 6 · the lingering crimson motes ---- */
    // Curl-driven and heavily dragged, so they stop dead where the projectile
    // left them and then drift. They outlive everything else in the ability by
    // design: the corridor is supposed to still be smouldering.
    this.motes = particles.get('flux.motes', {
      capacity: 4000,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.4
    });
    this.motes.uniforms.uDrag.value = 1.7;
    this.motes.uniforms.uEndSize.value = 0.35;
    this.motes.uniforms.uSizeIn.value = 0.12;
    this.motes.uniforms.uFadeIn.value = 0.12;
    this.motes.uniforms.uFadeOut.value = 0.3;

    this.dropEmitter = new RateEmitter();
    this.glintEmitter = new RateEmitter();
    this.moteEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    // The funnel, the tangle, the splatter and the lens.
    return 2 + this._ribbonCount + this._ligamentCount;
  }

  /** The strike: how long the flux takes to tear itself apart. */
  get impactDuration() {
    return Math.max(0.05, settings.flux.burstTime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.flux.fadeTime * settings.global.lifetime);
  }

  /**
   * Chaos does not pulse on a clock and it does not gutter like a flame — it
   * *stutters*. Three incommensurable sines multiplied together never repeat
   * over the length of a cast, which is the cheapest honest way to say
   * "unstable" with one number.
   */
  lightShimmer() {
    const c = settings.flux;
    const t = this.age * c.lightFlickerSpeed;
    const n = Math.sin(t * 1.7) * Math.sin(t * 3.1 + 1.3) * Math.sin(t * 0.7 + 2.9);
    return 1 - c.lightFlicker * 0.5 * (1 - n);
  }

  /** Nominal travel speed, metres/second. What the blood unwinds history by. */
  get travelSpeed() {
    return settings.flux.speed * settings.global.speed;
  }

  /* ------------------------------------------------------------------ */
  /* Where the head is — every metre resolved from live settings          */
  /* ------------------------------------------------------------------ */

  /**
   * The head, in world space.
   *
   * The base class puts `position` on the floor because that is what the aim
   * indicator targets; the flux flies, so the height belongs to the spine and
   * this is simply where it has got to.
   */
  _headPoint(out) {
    return fluxSpinePoint(this._path, this.front, out);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    for (const emitter of [this.dropEmitter, this.glintEmitter, this.moteEmitter]) emitter.reset();

    this._seed = Math.random() * 100;
    this._burstTime = -1;

    this._path.origin.copy(this.origin);
    this._path.dir.copy(this.direction);
    // The shader's lateral is `up × dir`; taking the same one here is what
    // keeps the JS and GLSL halves of the spine on the same side of the line.
    this._path.side.crossVectors(_worldUp, this.direction).normalize();
    this._path.seed = this._seed;

    this._syncUniforms(0, 1);
    this._castFx();
  }

  /** The flux tearing open in the caster's hand. Six layers, none of them new. */
  _castFx() {
    const c = settings.flux;
    const g = settings.global;
    const time = frame.uTime.value;

    this._headPoint(_pos);
    fluxSpineFrame(this._path, 0, _tangent, _side, _up);

    _emit.position = _pos;
    _emit.radius = 0.25;
    _emit.direction = _dir.copy(_tangent).multiplyScalar(-0.3).setY(0.6).normalize();
    _emit.speed = c.glintSpeed * 1.6;
    _emit.speedVariance = 0.85;
    _emit.spread = 1.0;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.glintSize;
    _emit.sizeVariance = 0.7;
    _emit.life = c.glintLifetime;
    _emit.lifeVariance = 0.6;
    _emit.spin = c.glintSpin;
    _emit.tint = null;
    _emit.time = time;
    this.glints.emit(Math.round(c.castGlints * g.particleCount), _emit);

    _emit.speed = c.moteSpeed * 1.4;
    _emit.size = c.moteSize;
    _emit.life = c.moteLifetime;
    _emit.spin = 0;
    this.motes.emit(Math.round(c.castMotes * g.particleCount), _emit);

    this.lightBoost = c.lightIntensity * 0.4 * g.explosionIntensity;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the cast's state into all four materials and
   * all three particle systems.
   *
   * @param {number} burst 0..1 — the flux coming apart on the strike
   * @param {number} fade  1 while it is flying, ramping to 0 as it dies
   */
  _syncUniforms(burst, fade) {
    const c = settings.flux;
    const g = settings.global;

    syncFluxSpine(this.spine, this._path, this.front);
    this._headPoint(_head);

    /* ---- 1 · the funnel ---- */
    // It can never reach further back than the projectile has flown, or the
    // mouth hangs out of the caster's back on the first frame.
    const coneState = this._coneState;
    coneState.span = Math.max(0.25, Math.min(c.coneLength, this.front));
    coneState.burst = burst;
    coneState.fade = fade;
    this.coneMaterial.userData.sync(coneState);

    /* ---- 3 · the tangle ---- */
    this._ribbonCount = Math.max(1, Math.min(MAX_RIBBONS, Math.round(c.ribbons)));
    this.ribbonGeometry.instanceCount = this._ribbonCount;

    const ribbonState = this._ribbonState;
    ribbonState.span = Math.max(0.5, Math.min(c.ribbonSpan, this.front + c.ribbonLead));
    ribbonState.strands = this._ribbonCount;
    // The ribbons are carried by the thing, so they go with it — they snap back
    // rather than hanging in the air over the splatter.
    ribbonState.fade = fade * (1 - burst * 0.85);
    this.ribbonMaterial.userData.sync(ribbonState);

    /* ---- 2 · the splatter ---- */
    this._ligamentCount = Math.max(1, Math.min(MAX_LIGAMENTS, Math.round(c.ligaments)));
    this.ligamentGeometry.instanceCount = this._ligamentCount;

    const bloodState = this._bloodState;
    // Zero once the head has stopped: with no travel left to unwind, every
    // ligament roots at the impact point, which is exactly where a splash is.
    bloodState.speed = this.u < 1 ? this.travelSpeed : 0;
    bloodState.burst = burst;
    bloodState.fade = fade;
    this.ligamentMaterial.userData.sync(bloodState);

    /* ---- 5 · the lens ---- */
    const warpState = this._warpState;
    warpState.dir.copy(this.direction);
    warpState.size = c.warpSize * (1 + burst * c.warpBurstSize * g.explosionIntensity);
    warpState.seed = this._seed;
    if (this._burstTime >= 0) {
      const life = Math.max(0.05, c.warpBurstLife);
      warpState.burst = c.warpBurst * Math.max(0, 1 - this._burstTime / life);
      // Normalised across the proxy's own radius, which is what the shader's
      // wavefront is measured in.
      warpState.burstFront = saturate((this._burstTime * c.warpBurstSpeed) / Math.max(0.01, warpState.size));
    } else {
      warpState.burst = 0;
      warpState.burstFront = 0;
    }
    warpState.fade = fade;
    this.warpMaterial.userData.sync(warpState);
    this.warpMesh.position.copy(_head);

    /* ---- the particle systems ---- */
    this.drops.setGradient(
      getColor(c.colorDropA),
      getColor(c.colorDropB),
      getColor(c.colorDropC),
      getColor(c.colorDropD)
    );
    this.drops.uniforms.uGravity.value.set(0, -c.dropGravity, 0);
    // The emitters hand over `dropSize` and friends straight, so the scale here
    // is only the global multiplier and every size in the settings block is a
    // width in metres. Folding the setting in twice — once here, once at the
    // emit — is how a 5 cm droplet ends up 4 mm and invisible.
    this.drops.uniforms.uSizeScale.value = g.particleSize;
    this.drops.uniforms.uLifeScale.value = c.dropLifetime * 0.5 * g.particleLifetime;
    this.drops.uniforms.uSpeedScale.value = g.particleSpeed;
    this.drops.uniforms.uOpacity.value = c.dropOpacity * g.opacity;
    this.drops.uniforms.uGlow.value = c.dropGlow;
    this.drops.uniforms.uStretch.value = c.dropStretch;
    this.drops.uniforms.uTurbulence.value = 0.1 * g.turbulence;

    this.glints.setGradient(
      getColor(c.colorGlintA),
      getColor(c.colorGlintB),
      getColor(c.colorGlintC),
      getColor(c.colorGlintD)
    );
    this.glints.uniforms.uGravity.value.set(0, c.glintRise, 0);
    this.glints.uniforms.uSizeScale.value = g.particleSize;
    this.glints.uniforms.uLifeScale.value = c.glintLifetime * 0.5 * g.particleLifetime;
    this.glints.uniforms.uSpeedScale.value = g.particleSpeed;
    this.glints.uniforms.uOpacity.value = g.opacity;
    this.glints.uniforms.uGlow.value = c.glintGlow * g.glow;
    this.glints.uniforms.uTurbulence.value = c.glintTurbulence * g.turbulence;

    this.motes.setGradient(
      getColor(c.colorMoteA),
      getColor(c.colorMoteB),
      getColor(c.colorMoteC),
      getColor(c.colorMoteD)
    );
    this.motes.uniforms.uGravity.value.set(0, c.moteRise, 0);
    this.motes.uniforms.uSizeScale.value = g.particleSize;
    this.motes.uniforms.uLifeScale.value = c.moteLifetime * 0.5 * g.particleLifetime;
    this.motes.uniforms.uSpeedScale.value = g.particleSpeed;
    this.motes.uniforms.uOpacity.value = c.moteOpacity * g.opacity;
    this.motes.uniforms.uGlow.value = c.moteGlow * g.glow;
    this.motes.uniforms.uTurbulence.value = c.moteTurbulence * g.turbulence;
  }

  /**
   * A point on the trail behind the head, and the frame there.
   *
   * @param {number} back metres behind the head
   */
  _trailPoint(back, out) {
    const s = Math.max(0, this.front - back);
    fluxSpinePoint(this._path, s, out);
    fluxSpineFrame(this._path, s, _tangent, _side, _up);
    return out;
  }

  /**
   * What the flux sheds while it flies — layers 2, 4 and 6.
   * @param {number} scale 0..1, thinned out as it dies
   */
  _trailFx(dt, scale) {
    const c = settings.flux;
    const g = settings.global;
    const time = frame.uTime.value;
    const reach = Math.min(c.trailSpan, this.front);

    /* ---- 6 · the motes, left the whole length of the corridor ---- */
    let moteCount = Math.round(this.moteEmitter.tick(dt, c.moteRate * scale) * g.particleCount);
    if (moteCount > 0) {
      _emit.speed = c.moteSpeed;
      _emit.speedVariance = 0.8;
      _emit.spread = 0.9;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = c.moteSize;
      _emit.sizeVariance = 0.75;
      _emit.life = c.moteLifetime;
      _emit.lifeVariance = 0.55;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;

      // Split along the trail: one emission point per frame reads as a jet off
      // the nose rather than as a corridor being filled.
      const per = Math.ceil(moteCount / TRAIL_BATCHES);
      while (moteCount > 0) {
        this._trailPoint(Math.random() * reach, _pos);
        _emit.position = _pos;
        _emit.radius = c.moteRadius;
        // Backwards and slightly up: they are being left behind, not thrown.
        _emit.direction = _dir
          .copy(_tangent)
          .multiplyScalar(-c.moteDrift)
          .addScaledVector(_up, 0.3)
          .normalize();
        this.motes.emit(Math.min(per, moteCount), _emit);
        moteCount -= per;
      }
    }

    /* ---- 4 · the sparkles, clustered up near the head ---- */
    const glintCount = Math.round(this.glintEmitter.tick(dt, c.glintRate * scale) * g.particleCount);
    if (glintCount > 0) {
      // Densest at the *trailing* end and thinning forward, which is the way
      // round the sheet has it: the glitter is the cloud the tail comes apart
      // into, well past where the ribbons have given up, not a sheen on the
      // nose. One minus a squared roll puts most of them in the last few
      // metres, and the cloud opens out as it goes back — a sparkle field that
      // stays inside the ribbon envelope is read as part of the ribbons.
      // Density rising linearly toward the tail — sqrt of a flat roll. Biasing
      // them hard onto the last metre instead heaped the whole cloud on the
      // caster, since the trail's far end *is* the caster until the flux has
      // flown past `trailSpan`.
      const along = Math.sqrt(Math.random());
      const back = along * reach;
      this._trailPoint(back, _pos);
      _emit.position = _pos;
      _emit.radius = c.glintRadius * (0.35 + along);
      _emit.direction = _dir
        .copy(_side)
        .multiplyScalar(randRange(-1, 1))
        .addScaledVector(_up, randRange(-0.4, 1))
        .addScaledVector(_tangent, -c.glintDrift)
        .normalize();
      _emit.speed = c.glintSpeed;
      _emit.speedVariance = 0.9;
      _emit.spread = 0.6;
      _emit.inherit = null;
      _emit.anchor = null;
      _emit.size = c.glintSize;
      _emit.sizeVariance = 0.8;
      _emit.life = c.glintLifetime;
      _emit.lifeVariance = 0.6;
      _emit.spin = c.glintSpin;
      _emit.tint = null;
      _emit.time = time;
      this.glints.emit(glintCount, _emit);
    }

    /* ---- 2 · the beads the ligaments pinch off ---- */
    const dropCount = Math.round(this.dropEmitter.tick(dt, c.dropRate * scale) * g.particleCount);
    if (dropCount > 0) {
      // From a little way back, because that is where a ligament has had time
      // to stretch far enough to break.
      this._trailPoint(randRange(0, c.bloodThrow * c.bloodLife * 0.5), _pos);
      const angle = Math.random() * Math.PI * 2;
      _emit.position = _pos;
      _emit.radius = c.dropRadius;
      _emit.direction = _dir
        .copy(_side)
        .multiplyScalar(Math.cos(angle) * c.bloodSpread)
        .addScaledVector(_up, Math.sin(angle) * c.bloodSpread)
        .addScaledVector(_tangent, -c.bloodBack)
        .normalize();
      _emit.speed = c.bloodThrow;
      _emit.speedVariance = 0.7;
      _emit.spread = 0.35;
      // The fluid keeps some of the head's own momentum, exactly as the
      // ligaments do — the two halves of this layer have to agree.
      _emit.inherit = _inherit.copy(_tangent).multiplyScalar(c.bloodCarry * this.travelSpeed);
      _emit.anchor = null;
      _emit.size = c.dropSize;
      _emit.sizeVariance = 0.85;
      _emit.life = c.dropLifetime;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.drops.emit(dropCount, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.flux;
    const g = settings.global;

    this._syncUniforms(0, 1);
    // The light rides the head, not the floor under it — and so does the camera.
    this._headPoint(this.position);

    this._trailFx(dt, 1);
    this.ctx.shake.rumble(c.rumble * g.cameraShake, dt);
  }

  onImpact() {
    const c = settings.flux;
    const g = settings.global;
    const time = frame.uTime.value;

    this._burstTime = 0;
    this._headPoint(_head);
    fluxSpineFrame(this._path, this.front, _tangent, _side, _up);

    /* ---- 2 · the splash, thrown forward off something that stopped ---- */
    _emit.position = _head;
    _emit.radius = 0.3;
    _emit.direction = _dir.copy(_tangent).multiplyScalar(c.bloodForward).setY(0.35).normalize();
    _emit.speed = c.bloodThrow * (1 + c.bloodBurstThrow);
    _emit.speedVariance = 0.85;
    _emit.spread = 0.9;
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.size = c.dropSize * 1.35;
    _emit.sizeVariance = 0.9;
    _emit.life = c.dropLifetime * 1.4;
    _emit.lifeVariance = 0.55;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.drops.emit(Math.round(c.burstDrops * g.particleCount * g.explosionIntensity), _emit);

    /* ---- 4 · the sparkles thrown out of it ---- */
    _emit.radius = 0.4;
    _emit.direction = _dir.copy(_tangent).multiplyScalar(0.3).setY(0.4).normalize();
    _emit.speed = c.glintSpeed * 2.6;
    _emit.spread = 1.0;
    _emit.size = c.glintSize * 1.25;
    _emit.life = c.glintLifetime * 1.5;
    _emit.spin = c.glintSpin;
    this.glints.emit(Math.round(c.burstGlints * g.particleCount * g.explosionIntensity), _emit);

    /* ---- 6 · and the motes that will still be there afterwards ---- */
    _emit.radius = 0.6;
    _emit.speed = c.moteSpeed * 2.2;
    _emit.spread = 1.0;
    _emit.size = c.moteSize * 1.3;
    _emit.life = c.moteLifetime * 1.5;
    _emit.spin = 0;
    this.motes.emit(Math.round(c.burstMotes * g.particleCount * g.explosionIntensity), _emit);

    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      24
    );
    this.lightBoost = c.lightIntensity * 1.1 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.flux;

    if (this._burstTime >= 0) this._burstTime += dt;

    // `t` runs 0..1 while the flux comes apart, then 1..2 while what is left of
    // it goes out.
    const burst = saturate(t);
    const fade = t > 1 ? 1 - Easing.inQuad(saturate(t - 1)) : 1;

    this._syncUniforms(burst, fade);
    this._headPoint(this.position);

    // The splatter keeps going for the first half of the burst and then stops;
    // the motes carry on to the end, because layer 6 is the one that lingers.
    this._trailFx(dt, Math.max(0, 1 - burst * 1.7) * fade);

    if (t <= 1) this.ctx.shake.rumble(c.burnShake * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this._burstTime = -1;
    this._ribbonCount = 1;
    this._ligamentCount = 1;
    this.ribbonGeometry.instanceCount = 1;
    this.ligamentGeometry.instanceCount = 1;
    this.coneMaterial.uniforms.uFade.value = 0;
    this.coneMaterial.uniforms.uBurst.value = 0;
    this.ribbonMaterial.uniforms.uFade.value = 0;
    this.ligamentMaterial.uniforms.uFade.value = 0;
    this.warpMaterial.uniforms.uFade.value = 0;
    this.warpMaterial.uniforms.uBurst.value = 0;
  }

  dispose() {
    this.coneGeometry.dispose();
    this.coneMaterial.dispose();
    this.ribbonGeometry.dispose();
    this.ribbonMaterial.dispose();
    this.ligamentGeometry.dispose();
    this.ligamentMaterial.dispose();
    this.warpGeometry.dispose();
    this.warpMaterial.dispose();
    super.dispose();
  }
}
