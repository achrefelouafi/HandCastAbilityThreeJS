import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  Object3D,
  PlaneGeometry,
  SphereGeometry,
  Vector3
} from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { createShatterPlateGeometry } from '../assets/ShatterGeometry.js';
import { IceStatue } from '../effects/IceStatue.js';
import {
  TOXIC_MAX_RINGS,
  TOXIC_MAX_SPARS,
  createBarrierMaterial,
  createBarrierRefractionMaterial,
  createGlassBodyMaterial,
  createShockRingMaterial,
  createToxicCrustMaterial,
  syncToxic,
  toxicUniforms
} from '../materials/ToxicShieldMaterials.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { Easing, lerp, randRange, saturate } from '../utils/math.js';

const TAU = Math.PI * 2;
/** Bodies one cast can hold in glass at once. */
const MAX_STATUES = 8;
/** How many points round the rim one frame's gas is split between. One origin reads as a hose. */
const GAS_BATCHES = 4;

const _vel = new Vector3();
const _n = new Vector3();
const _t = new Vector3();
const _dummy = new Object3D();
const _emit = {
  position: new Vector3(),
  direction: new Vector3(),
  inherit: null,
  anchor: null,
  radius: 0,
  speed: 1,
  speedVariance: 0.3,
  spread: 0.5,
  size: 0.2,
  sizeVariance: 0.3,
  life: 1,
  lifeVariance: 0.3,
  spin: 0,
  tint: null,
  time: 0
};

/**
 * THE TOXIC SHIELD OF CONQUEST — a far cast, built to a four-panel sheet.
 *
 * There is no arriving: the shield lands where it is aimed on the frame it is
 * cast, and the floor breaks. Then, in the order the sheet stacks them:
 *
 *   1. the crystalline barrier — a sphere of toxic glass assembled over
 *      the rupture facet by facet, a lattice of crystal spars grown over it,
 *      bright where they cross, poison swirling inside, the stage bending
 *      through it.
 *   2. the poison gas miasma — puffs of eroded smoke seeping out from under
 *      the barrier and coiling round it as they thin, green where the light
 *      gets it and bruise purple in its own shadow (the same smoke the
 *      Corrupted Shard coils round its cluster).
 *   3. the ground rupture — the floor inside the circle cut into slabs and
 *      heaved, toxic light coming up through every seam, embers still
 *      burning along the cracks.
 *   4. the radial shockwave — a ring of light thrown across the floor as it
 *      lands, spiked, and again on every pulse while it stands.
 *
 * And what it does to a body: everything standing in the circle is turned
 * to glass where it stands — the fracture seams light up over it first, a
 * lattice climbing from the feet, and the glass sets behind them cell by
 * cell, the dark body visible inside — held, cracked along the seams it will
 * break on, and shattered into pieces of glass that fly, land, lie there and
 * dissolve into vapour. The pieces are real: the body's own pose cut into
 * Voronoi cells, each a rigid body (see `effects/IceStatue.js`).
 *
 * It stands for `lifetime` seconds and then dies the way glass does: the
 * barrier's facets flash and fall out one by one, the slabs sink back into
 * the floor, the seams go dark, the gas thins.
 */
export class ToxicShieldAbility extends Ability {
  constructor(context) {
    super('toxic', context);
  }

  get impactDuration() {
    return Math.max(0.05, settings.toxic.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.toxic.fadeTime);
  }

  get instanceCount() {
    return this._flyingChunks + this._liveRings;
  }

  /** Followed hard once it is up: the shield is the show. Let go as it breaks. */
  get cameraWeight() {
    if (this.u < 1) return saturate(1 - this.u * 0.4);
    return lerp(0.8, 0.15, this.burn);
  }

  /**
   * The pieces outlive the shield.
   *
   * A body glassed late is still lying on the floor in forty pieces when the
   * barrier has gone, and a cast that retired on the barrier's clock would
   * take them with it in one frame. So the fade is held open, quiet - every
   * layer already at its end - until the last piece has dissolved.
   */
  update(dt) {
    super.update(dt);
    if (this.phase !== AbilityPhase.DONE) return;
    for (const slot of this.slots) {
      if (!slot.live) continue;
      this.phase = AbilityPhase.FADE;
      this.fadeTime = this.fadeDuration;
      return;
    }
  }

  /** It picks what it takes; the field's disc would knock them over instead. */
  get handlesOwnHits() {
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const environment = this.ctx.environment;
    this.toxic = toxicUniforms();

    /* ---- 3 · the ground rupture ---- */
    this.crustMaterial = createToxicCrustMaterial(environment, this.toxic);
    this._plateKey = '';
    this.crust = new Mesh(this._buildPlate(), this.crustMaterial);
    // On WORLD so it takes the sun and the statues' shadows; not a caster,
    // because three would build that shadow from the undeformed disc.
    this.crust.layers.set(LAYER.WORLD);
    this.crust.castShadow = false;
    this.crust.receiveShadow = true;
    this.crust.frustumCulled = false;
    this.crust.renderOrder = 1;
    this.group.add(this.crust);
    this._crustState = { grown: 0, heat: 0, rumble: 0 };

    /* ---- 1 · the barrier: the far wall, the near wall, the refraction ---- */
    const ball = new SphereGeometry(1, 80, 56);
    this.domeFarMaterial = createBarrierMaterial(this.toxic, true);
    this.domeNearMaterial = createBarrierMaterial(this.toxic, false);
    // One lattice, written once, read by both walls.
    this.domeNearMaterial.uniforms.uSpar.value = this.domeFarMaterial.uniforms.uSpar.value;
    this.domeNearMaterial.uniforms.uSparTan.value = this.domeFarMaterial.uniforms.uSparTan.value;
    this.domeFar = new Mesh(ball, this.domeFarMaterial);
    this.domeFar.layers.set(LAYER.VFX);
    this.domeFar.renderOrder = 9;
    this.domeFar.frustumCulled = false;
    this.group.add(this.domeFar);
    this.domeNear = new Mesh(ball, this.domeNearMaterial);
    this.domeNear.layers.set(LAYER.VFX);
    this.domeNear.renderOrder = 10;
    this.domeNear.frustumCulled = false;
    this.group.add(this.domeNear);

    this.refractMaterial = createBarrierRefractionMaterial();
    this.refract = new Mesh(ball, this.refractMaterial);
    this.refract.layers.set(LAYER.DISTORTION);
    this.refract.frustumCulled = false;
    this.group.add(this.refract);

    /* ---- 4 · the shockwaves ---- */
    const quad = new PlaneGeometry(2, 2);
    quad.rotateX(-Math.PI / 2);
    this._ringData = new InstancedBufferAttribute(new Float32Array(TOXIC_MAX_RINGS * 4), 4).setUsage(
      DynamicDrawUsage
    );
    quad.setAttribute('aRing', this._ringData);
    this.ringMaterial = createShockRingMaterial(this.toxic);
    this.rings = new InstancedMesh(quad, this.ringMaterial, TOXIC_MAX_RINGS);
    this.rings.count = 0;
    this.rings.layers.set(LAYER.VFX);
    this.rings.renderOrder = 4;
    this.rings.frustumCulled = false;
    this.group.add(this.rings);
    this.ringSlots = [];
    for (let i = 0; i < TOXIC_MAX_RINGS; i++) {
      this.ringSlots.push({ live: false, age: 0, life: 1, seed: 0, strength: 1, reach: 1, width: 0.03 });
    }
    this._liveRings = 0;

    /* ---- the bodies ---- */
    // One statue is built now so its shaders compile behind the loading
    // screen with everything else; the rest are cut from the same program
    // the first time a cast needs them.
    this.statues = [];
    this.slots = [];
    this._statue();
    this._targets = [];
    this._flyingChunks = 0;

    /* ---- state ---- */
    this.centre = new Vector3();
    this.fieldAge = 0;
    this.burn = 0;
    this.reveal = 0;
    this._nextPulse = 0;
    this._breakRung = false;
    this._spores = new RateEmitter(40);
    this._gas = new RateEmitter(44);
    this._embers = new RateEmitter(30);
    this._vapour = new RateEmitter(20);
    this._shards = new RateEmitter(60);
  }

  /** The plate is re-cut only when a shape control moves. */
  _buildPlate() {
    const c = this.config;
    this._plateKey = `${c.plateCells}|${c.plateDepth}|${c.plateRagged}|${c.plateBias}`;
    return createShatterPlateGeometry({
      seed: 3 + Math.random() * 40,
      cells: c.plateCells,
      depth: c.plateDepth,
      bias: c.plateBias,
      ragged: c.plateRagged
    });
  }

  _syncPlate() {
    const c = this.config;
    const key = `${c.plateCells}|${c.plateDepth}|${c.plateRagged}|${c.plateBias}`;
    if (key === this._plateKey) return;
    const old = this.crust.geometry;
    this.crust.geometry = this._buildPlate();
    old.dispose();
  }

  /** A statue and the slot that drives it. */
  _statue() {
    const statue = new IceStatue(createGlassBodyMaterial(this.ctx.environment, this.toxic));
    this.group.add(statue.mesh);
    this.statues.push(statue);
    this.slots.push({ statue, live: false, delay: 0, time: 0, shattered: false, done: false, away: new Vector3() });
    return this.slots[this.slots.length - 1];
  }

  createParticles() {
    const P = this.ctx.particles;
    this.spores = P.get('toxicSpore', {
      capacity: 1200,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.3
    });
    this.chips = P.get('toxicChip', {
      capacity: 1400,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      stretch: false,
      softFade: 0.2
    });
    this.vapour = P.get('toxicVapour', {
      capacity: 500,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 0.6
    });
    this.embers = P.get('toxicEmber', {
      capacity: 600,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.25
    });

    /* ---- 2 · the miasma ---- */
    // Non-additive: the puffs *occlude* what is behind them, and an additive
    // version is a green haze the barrier loses its depth in. Swirl, so a
    // puff born under the foot of the barrier coils round it as it seeps out.
    this.gas = P.get('toxicGas', {
      capacity: 2600,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      swirl: true,
      softFade: 1.1
    });
    this.gas.uniforms.uDrag.value = 1.6;
    this.gas.uniforms.uEndSize.value = 2.6;
    this.gas.uniforms.uSizeIn.value = 0.14;
    this.gas.uniforms.uFadeIn.value = 0.2;
    this.gas.uniforms.uFadeOut.value = 0.35;
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.pointAt(1, this.centre);
    this.fieldAge = 0;
    this.burn = 0;
    this.reveal = 0;
    this._flyingChunks = 0;
    this._liveRings = 0;
    this._nextPulse = 0;
    this._breakRung = false;
    this._spores.reset();
    this._gas.reset();
    this._embers.reset();
    this._vapour.reset();
    this._shards.reset();
    for (const slot of this.ringSlots) slot.live = false;
    for (const slot of this.slots) this._freeSlot(slot);

    // Fresh every time: the same seed would grow the same lattice on every
    // cast and cut the same cracks under it.
    const seed = Math.random() * 10;
    this.crustMaterial.userData.uniforms.uSeed.value = Math.random() * 10;
    this.domeFarMaterial.uniforms.uSeed.value = seed;
    this.domeNearMaterial.uniforms.uSeed.value = seed;
    this.refractMaterial.uniforms.uSeed.value = seed;
    this._growLattice();

    this.crust.visible = false;
    this.domeFar.visible = false;
    this.domeNear.visible = false;
    this.refract.visible = false;
    this.rings.count = 0;
  }

  onDestroy() {
    for (const slot of this.slots) this._freeSlot(slot);
    this.crust.visible = false;
    this.domeFar.visible = false;
    this.domeNear.visible = false;
    this.refract.visible = false;
    this.rings.count = 0;
  }

  /** Let a glassed body go, whatever state its statue was in. */
  _freeSlot(slot) {
    if (slot.statue.dummy) slot.statue.dummy.vanish();
    slot.statue.hide();
    slot.live = false;
    slot.done = false;
    slot.shattered = false;
    slot.time = 0;
  }

  /**
   * Lay the lattice: a spar is a great circle of the sphere cut to an arc.
   *
   * Random planes through the centre, a tangent in each to measure along,
   * an arc length drawn from short splinters to spars that reach most of
   * the way round, and a brightness. Written once per cast; the shader does
   * the rest.
   */
  _growLattice() {
    const c = this.config;
    const spar = this.domeFarMaterial.uniforms.uSpar.value;
    const tan = this.domeFarMaterial.uniforms.uSparTan.value;
    for (let i = 0; i < TOXIC_MAX_SPARS; i++) {
      _n.set(randRange(-1, 1), randRange(-1, 1), randRange(-1, 1)).normalize();
      _t.set(randRange(-1, 1), randRange(-1, 1), randRange(-1, 1)).cross(_n).normalize();
      const k = i * 4;
      spar[k] = _n.x;
      spar[k + 1] = _n.y;
      spar[k + 2] = _n.z;
      spar[k + 3] = Math.random();
      tan[k] = _t.x;
      tan[k + 1] = _t.y;
      tan[k + 2] = _t.z;
      tan[k + 3] = lerp(c.sparMinArc, c.sparMaxArc, Math.pow(Math.random(), 1.4));
    }
  }

  /* ------------------------------------------------------------------ */
  /* no arriving                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * The shield does not run out from the caster's feet: it is simply there,
   * where it was aimed, on the first frame. The front is jumped to the end
   * of the line so the base class lands it at once.
   */
  advance(_dt) {
    this.front = this.length;
    this.u = 1;
    this.pointAt(1, this.position);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* the landing                                                         */
  /* ------------------------------------------------------------------ */

  onImpact() {
    const c = this.config;
    const g = settings.global;
    const time = frame.uTime.value;
    const R = c.zoneRadius;

    this.pointAt(1, this.centre);
    this.position.copy(this.centre);
    this.position.y = 1;
    this.fieldAge = 0;
    this._nextPulse = c.pulsePeriod;

    this._syncPlate();
    this.crust.visible = true;
    this.crust.rotation.y = Math.random() * TAU;
    this.domeFar.visible = true;
    this.domeNear.visible = true;
    this.refract.visible = true;

    /* 4 · the shockwave */
    this._ring(c.ringReach, c.ringTime, c.ringIntensity, c.ringWidth);

    /* spores thrown up as the floor breaks */
    const spores = Math.round(c.landSpores * g.particleCount);
    for (let i = 0; i < spores; i++) {
      const a = Math.random() * TAU;
      const r = Math.sqrt(Math.random()) * R;
      _emit.position.set(this.centre.x + Math.cos(a) * r, 0.05, this.centre.z + Math.sin(a) * r);
      _emit.anchor = null;
      _emit.direction.set(0, 1, 0);
      _emit.inherit = null;
      _emit.radius = 0.05;
      _emit.speed = randRange(0.8, 3.0);
      _emit.speedVariance = 0.4;
      _emit.spread = 0.45;
      _emit.size = c.sporeSize * 1.4;
      _emit.sizeVariance = 0.5;
      _emit.life = c.sporeLife;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.spores.emit(1, _emit);
    }

    /* 2 · the gout of gas as the floor breaks */
    this._gasDefaults(time);
    _emit.position.copy(this.centre).setY(0.2);
    _emit.radius = R * c.gasRadius * 0.6;
    _emit.direction.set(0, 1, 0);
    _emit.speed = c.gasSpeed * 2.4;
    _emit.spread = 0.9;
    _emit.size = 1.2;
    _emit.life = c.gasLifetime * 0.9;
    _emit.spin = 0.35;
    this.gas.emit(Math.round(c.gasBurst * g.particleCount), _emit);

    this.lightBoost = c.landLight * g.explosionIntensity;
    this.ctx.shake.add(c.landShake * g.explosionIntensity * g.cameraShake, 2.2, 14);

    this._freezeTargets();
    this._dress();
  }

  /** Throw a ring across the floor. */
  _ring(reach, life, strength, width) {
    let slot = null;
    for (const s of this.ringSlots) {
      if (!s.live) {
        slot = s;
        break;
      }
    }
    if (!slot) {
      // Every ring is out: take the oldest.
      slot = this.ringSlots[0];
      for (const s of this.ringSlots) if (s.age > slot.age) slot = s;
    }
    slot.live = true;
    slot.age = 0;
    slot.life = Math.max(0.05, life);
    slot.seed = Math.random() * 10;
    slot.strength = strength;
    slot.reach = reach;
    slot.width = width;
  }

  /* ------------------------------------------------------------------ */
  /* the shield standing                                                 */
  /* ------------------------------------------------------------------ */

  /** @param {number} t 0..1 standing, 1..2 dying */
  onFade(dt, t) {
    const c = this.config;
    this.fieldAge += dt;
    this.burn = t > 1 ? saturate(t - 1) : 0;

    // The barrier assembles a beat after the floor breaks - the facets flash
    // in one by one, the way they will fall out.
    this.reveal = saturate((this.fieldAge - c.domeDelay) / Math.max(0.05, c.domeRiseTime));

    // Anything that stands up inside while the shield holds is taken too.
    if (this.burn <= 0) this._freezeTargets();

    // The shield beats: a ring off its foot every period while it stands,
    // and one as it breaks.
    if (this.burn <= 0 && c.pulsePeriod > 0 && this.fieldAge >= this._nextPulse) {
      this._nextPulse += Math.max(0.2, c.pulsePeriod);
      this._ring(c.pulseReach, c.ringTime * 1.2, c.pulseIntensity, c.ringWidth * 0.8);
    }
    if (this.burn > 0 && !this._breakRung) {
      this._breakRung = true;
      this._ring(c.ringReach * 0.8, c.ringTime, c.ringIntensity * 0.7, c.ringWidth);
      this.lightBoost = Math.max(this.lightBoost, c.landLight * 0.5 * settings.global.explosionIntensity);
      this.ctx.shake.add(c.landShake * 0.5 * settings.global.explosionIntensity * settings.global.cameraShake, 2.4, 16);
    }

    this._bodies(dt);
    this._rings(dt);
    this._dress();
    this._emitters(dt);
  }

  /* ---- what it does to a body ---- */

  /**
   * Take everything standing in the circle that is not glass already.
   *
   * Each body gets a statue baked from its pose on this frame and a clock
   * of its own, staggered by how far from the centre it stands so the
   * conversion is seen to reach the outer bodies a beat after the inner ones.
   */
  _freezeTargets() {
    const c = this.config;
    const field = this.ctx.dummies;
    if (!field?.findTargets) return;
    const R = c.zoneRadius * Math.max(0.05, c.convertReach);
    const found = field.findTargets(this.centre.x, this.centre.z, R, this._targets);

    for (const dummy of found) {
      let slot = null;
      for (const s of this.slots) {
        if (!s.live) {
          slot = s;
          break;
        }
      }
      if (!slot) {
        if (this.slots.length >= MAX_STATUES) break;
        slot = this._statue();
      }

      if (!dummy.freeze()) continue;
      if (!slot.statue.bake(dummy, c.shatterChunks, Math.random() * 100)) {
        dummy.vanish();
        continue;
      }
      slot.live = true;
      slot.done = false;
      slot.shattered = false;
      slot.time = 0;
      const dx = dummy.position.x - this.centre.x;
      const dz = dummy.position.z - this.centre.z;
      const dist = Math.hypot(dx, dz);
      slot.delay = c.convertDelay + (dist / Math.max(0.1, c.zoneRadius)) * c.convertStagger;
      if (dist > 1e-4) slot.away.set(dx / dist, 0, dz / dist);
      else slot.away.copy(this.direction);
      slot.statue.material.userData.sync();
    }
  }

  /**
   * Run every glassed body through its clock: the lattice climbs, the glass
   * sets, the cracks spread, the pieces fly, the pieces dissolve.
   */
  _bodies(dt) {
    const c = this.config;
    const g = settings.global;
    const time = frame.uTime.value;
    const physics = { gravity: c.shatterGravity, bounce: c.shatterBounce, friction: c.shatterFriction };
    const convertTime = Math.max(0.05, c.convertTime);
    const crackAt = convertTime + Math.max(0, c.holdTime);
    const shatterAt = crackAt + Math.max(0.05, c.crackTime);
    const dissolveAt = shatterAt + Math.max(0, c.dissolveDelay);
    const dissolveTime = Math.max(0.05, c.dissolveTime);
    let flying = 0;

    for (const slot of this.slots) {
      if (!slot.live) continue;
      const statue = slot.statue;
      const u = statue.uniforms;
      statue.material.userData.sync();
      slot.time += dt;
      // The break takes what the glass still holds: a body taken too late to
      // run its own clock is jumped to its cracks as the shield dies.
      if (this.burn > 0 && !slot.shattered) {
        slot.time = Math.max(slot.time, slot.delay + crackAt + Math.max(0.05, c.crackTime) * 0.5);
      }
      const t = slot.time - slot.delay;
      if (t < 0) continue;

      /* the conversion climbs the body from the feet, the seams leading */
      const convert = saturate(t / convertTime);
      u.uFreeze.value = convert;
      const span = statue.top - statue.base;
      u.uFrostLine.value = statue.base - 0.1 + (span + 0.35) * Easing.outQuad(convert);

      /* the cracks run up it */
      u.uCrack.value = slot.shattered ? 0 : saturate((t - crackAt) / Math.max(0.05, c.crackTime));

      /* the break */
      if (!slot.shattered && t >= shatterAt) {
        slot.shattered = true;
        statue.shatter(slot.away, {
          speed: c.shatterSpeed * g.particleSpeed,
          lift: c.shatterLift * g.particleSpeed,
          out: c.shatterOut,
          spin: c.shatterSpin
        });
        this._shatterBurst(statue, time);
        // The slot is the field's again from here; the pieces are ours.
        statue.dummy?.vanish();
        statue.dummy = null;
        this.lightBoost = Math.max(this.lightBoost, c.shatterLight * g.explosionIntensity);
        this.ctx.shake.add(c.shatterShake * g.explosionIntensity * g.cameraShake, 2.4, 20);
      }

      /* the dissolve */
      const melt = slot.shattered ? saturate((t - dissolveAt) / dissolveTime) : 0;
      u.uMelt.value = melt * 1.05;
      statue.update(dt, physics, melt, (i, impact) => this._chipLanding(statue, i, impact, time));
      flying += statue.flying;

      if (slot.shattered && melt > 0 && melt < 1) {
        // Vapour off the pieces as they go.
        const n = this._vapour.tick(dt, c.dissolveVapour * g.particleCount);
        for (let i = 0; i < n; i++) {
          statue.chunkPosition(Math.floor(Math.random() * statue.chunks), _emit.position);
          _emit.anchor = null;
          _emit.direction.set(0, 1, 0);
          _emit.inherit = null;
          _emit.radius = 0.08;
          _emit.speed = 0.4;
          _emit.speedVariance = 0.5;
          _emit.spread = 0.6;
          _emit.size = 0.22;
          _emit.sizeVariance = 0.4;
          _emit.life = 1.5;
          _emit.lifeVariance = 0.4;
          _emit.spin = 0.6;
          _emit.tint = null;
          _emit.time = time;
          this.vapour.emit(1, _emit);
        }
      }

      if (melt >= 1) {
        statue.hide();
        slot.live = false;
        slot.done = true;
      }
    }
    this._flyingChunks = flying;
  }

  /** Splinters, vapour and spores out of a body as it comes apart. */
  _shatterBurst(statue, time) {
    const c = this.config;
    const g = settings.global;
    const chips = Math.round(c.shatterChips * g.particleCount);
    for (let i = 0; i < chips; i++) {
      const k = Math.floor(Math.random() * statue.chunks);
      statue.chunkPosition(k, _emit.position);
      _vel.fromArray(statue.velocity, k * 3);
      _emit.anchor = null;
      _emit.direction.copy(_vel).normalize();
      _emit.inherit = _vel.multiplyScalar(0.45);
      _emit.radius = 0.08;
      _emit.speed = randRange(1.5, 4.5);
      _emit.speedVariance = 0.5;
      _emit.spread = 0.7;
      _emit.size = c.chipSize;
      _emit.sizeVariance = 0.6;
      _emit.life = 1.4;
      _emit.lifeVariance = 0.4;
      _emit.spin = 9;
      _emit.tint = null;
      _emit.time = time;
      this.chips.emit(1, _emit);
    }
    _emit.inherit = null;

    const spores = Math.round(c.shatterChips * 0.6 * g.particleCount);
    for (let i = 0; i < spores; i++) {
      _emit.position.copy(statue.centre);
      _emit.position.y = lerp(statue.base, statue.top, Math.random());
      _emit.direction.set(randRange(-1, 1), randRange(0.2, 1), randRange(-1, 1)).normalize();
      _emit.radius = 0.25;
      _emit.speed = 2.5;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.6;
      _emit.size = c.sporeSize * 1.3;
      _emit.sizeVariance = 0.5;
      _emit.life = 1.2;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.spores.emit(1, _emit);
    }

    const puffs = Math.round(6 * g.particleCount);
    for (let i = 0; i < puffs; i++) {
      _emit.position.copy(statue.centre);
      _emit.position.y = lerp(statue.base, statue.top, Math.random());
      _emit.direction.set(randRange(-1, 1), 0.4, randRange(-1, 1)).normalize();
      _emit.radius = 0.2;
      _emit.speed = 1.6;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.5;
      _emit.size = 0.28;
      _emit.sizeVariance = 0.4;
      _emit.life = 1.3;
      _emit.lifeVariance = 0.3;
      _emit.spin = 0.8;
      _emit.time = time;
      this.vapour.emit(1, _emit);
    }
  }

  /** A few splinters where a piece hits the floor. */
  _chipLanding(statue, index, impact, time) {
    const c = this.config;
    const g = settings.global;
    const n = Math.round(Math.min(8, impact * 1.2) * g.particleCount);
    if (n <= 0) return;
    statue.chunkPosition(index, _emit.position);
    _emit.position.y = 0.03;
    _emit.anchor = null;
    _emit.direction.set(0, 1, 0);
    _emit.inherit = null;
    _emit.radius = 0.04;
    _emit.speed = 1 + impact * 0.3;
    _emit.speedVariance = 0.5;
    _emit.spread = 0.8;
    _emit.size = c.chipSize * 0.7;
    _emit.sizeVariance = 0.5;
    _emit.life = 0.9;
    _emit.lifeVariance = 0.4;
    _emit.spin = 8;
    _emit.tint = null;
    _emit.time = time;
    this.chips.emit(n, _emit);
  }

  /* ---- 4 · the shockwaves ---- */

  _rings(dt) {
    const c = this.config;
    const g = settings.global;
    const data = this._ringData;
    let used = 0;
    let live = 0;

    for (let i = 0; i < TOXIC_MAX_RINGS; i++) {
      const slot = this.ringSlots[i];
      if (slot.live) {
        slot.age += dt;
        if (slot.age >= slot.life) slot.live = false;
      }
      if (!slot.live) {
        data.setXYZW(i, 0, 0, 0, 0.01);
        _dummy.position.set(0, -999, 0);
        _dummy.scale.setScalar(0.0001);
        _dummy.quaternion.identity();
        _dummy.updateMatrix();
        this.rings.setMatrixAt(i, _dummy.matrix);
        continue;
      }
      const k = slot.age / slot.life;
      // Out fast, then coasting; gone before it stops.
      const r = lerp(0.08, 1.0, Easing.outCubic(k));
      const strength = Easing.outQuad(saturate(k / 0.08)) * (1 - Easing.inQuad(saturate((k - 0.25) / 0.75)));
      const reach = c.zoneRadius * slot.reach;
      _dummy.position.set(this.centre.x, 0.02 + i * 0.004, this.centre.z);
      _dummy.quaternion.identity();
      _dummy.scale.set(reach, 1, reach);
      _dummy.updateMatrix();
      this.rings.setMatrixAt(i, _dummy.matrix);
      data.setXYZW(i, r, slot.seed, strength * slot.strength * g.glow * g.shaderIntensity, slot.width);
      used = i + 1;
      live++;
    }
    this.rings.count = used;
    this.rings.instanceMatrix.needsUpdate = true;
    data.needsUpdate = true;
    this._liveRings = live;
  }

  /* ---- settings → uniforms, every frame ---- */

  _dress() {
    const c = this.config;
    const g = settings.global;
    const R = c.zoneRadius;
    const fade = 1 - Easing.inQuad(this.burn);
    syncToxic(this.toxic, c);

    /* 3 · the ground rupture */
    {
      this._syncPlate();
      const sink = Easing.inCubic(this.burn);
      const plateR = R * c.plateReach;
      this.crust.position.set(this.centre.x, 0.012 - sink * (c.plateDepth * plateR + 0.35), this.centre.z);
      this.crust.scale.setScalar(plateR);
      const state = this._crustState;
      state.grown = Easing.outQuad(saturate(this.fieldAge / Math.max(0.05, c.plateBreakTime))) * 1.3;
      state.heat = fade;
      state.rumble = this.burn > 0 && this.burn < 0.6 ? c.plateRumble : 0;
      this.crustMaterial.userData.sync(state);
      this.crust.visible = this.burn < 0.999;
    }

    /* 1 · the barrier */
    {
      // Full size from the first frame; it is the facets that arrive.
      const grow = this.reveal;
      const y = R * (1 - c.domeSink);
      const spin = this.fieldAge * c.domeSpin;
      for (const mesh of [this.domeFar, this.domeNear, this.refract]) {
        mesh.position.set(this.centre.x, y, this.centre.z);
        mesh.scale.setScalar(R);
        mesh.rotation.set(0, spin, 0);
      }
      const spars = Math.min(TOXIC_MAX_SPARS, Math.max(0, Math.round(c.sparCount)));
      for (const material of [this.domeFarMaterial, this.domeNearMaterial]) {
        const u = material.uniforms;
        u.uBuild.value = grow;
        u.uOpacity.value = c.domeOpacity * g.opacity;
        u.uBody.value = c.domeBody;
        u.uRimPower.value = c.domeRimPower;
        u.uRimGlow.value = c.domeRimGlow * g.glow;
        u.uSparCount.value = spars;
        u.uSparWidth.value = c.sparWidth;
        u.uSparSpeed.value = c.sparSpeed * g.noiseSpeed;
        u.uSparGrow.value = Easing.outCubic(saturate(grow / 0.85));
        u.uSparGlow.value = c.sparGlow * g.glow * g.shaderIntensity;
        u.uCellScale.value = c.cellScale;
        u.uCellWidth.value = c.cellWidth;
        u.uCellGlow.value = c.cellGlow * g.glow;
        u.uSwirl.value = c.domeSwirl * g.glow;
        u.uSwirlScale.value = c.domeSwirlScale * g.noiseFrequency;
        u.uSwirlSpeed.value = c.domeSwirlSpeed * g.noiseSpeed;
        u.uFootGlow.value = c.domeFootGlow * g.glow;
        u.uBurn.value = this.burn;
        u.uFade.value = 1;
      }
      const visible = grow > 0.001 && this.burn < 0.999;
      this.domeFar.visible = visible;
      this.domeNear.visible = visible;

      const r = this.refractMaterial.uniforms;
      r.uBuild.value = grow;
      r.uStrength.value = c.domeRefraction;
      r.uCellScale.value = c.cellScale;
      r.uBurn.value = this.burn;
      r.uFade.value = 1;
      this.refract.visible = visible && c.domeRefraction > 0.001;
    }

    /* 4 · the shockwaves */
    {
      const u = this.ringMaterial.uniforms;
      u.uSpikes.value = c.ringSpikes;
      u.uSpikeReach.value = c.ringSpikeReach;
      u.uFade.value = g.opacity;
    }

    /* the particle systems — shared, so re-dressed every frame */
    {
      const u = this.gas.uniforms;
      this.gas.setGradient(getColor(c.colorGasA), getColor(c.colorGasB), getColor(c.colorGasC), getColor(c.colorGasD));
      u.uGravity.value.set(0, c.gasRise, 0);
      u.uSizeScale.value = c.gasSize * g.particleSize;
      u.uLifeScale.value = c.gasLifetime * 0.5 * g.particleLifetime;
      u.uSpeedScale.value = c.gasSpeed * g.particleSpeed;
      u.uOpacity.value = c.gasOpacity * g.opacity;
      u.uTurbulence.value = c.gasTurbulence * 0.5 * g.turbulence;
      u.uSwirl.value = c.gasSwirl;
      u.uSwirlExpand.value = c.gasSwirlExpand;
      u.uGlow.value = 1;
    }
    {
      const u = this.spores.uniforms;
      this.spores.setGradient(getColor(c.colorLattice), getColor(c.colorGlow), getColor(c.colorGlass), getColor(c.colorVenom));
      u.uGravity.value.set(0, c.sporeRise, 0);
      u.uDrag.value = 1.4;
      u.uTurbulence.value = 0.45 * g.turbulence;
      u.uTurbFrequency.value = 0.7;
      u.uTurbSpeed.value = 0.5;
      u.uEndSize.value = 0.5;
      u.uSizeIn.value = 0.1;
      u.uFadeIn.value = 0.1;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = c.sporeGlow * g.glow;
      u.uOpacity.value = g.opacity;
    }
    {
      const u = this.chips.uniforms;
      this.chips.setGradient(getColor(c.colorGlow), getColor(c.colorGlass), getColor(c.colorGlass), getColor(c.colorDeep));
      u.uGravity.value.set(0, c.shatterGravity * 0.8, 0);
      u.uDrag.value = 0.6;
      u.uTurbulence.value = 0.1;
      u.uEndSize.value = 0.5;
      u.uSizeIn.value = 0.02;
      u.uFadeIn.value = 0.02;
      u.uFadeOut.value = 0.35;
      u.uGlow.value = 1.1 * g.glow;
      u.uOpacity.value = g.opacity;
      u.uLightDir.value.copy(frame.uLightDir.value);
    }
    {
      const u = this.vapour.uniforms;
      this.vapour.setGradient(getColor(c.colorGlow), getColor(c.colorGlass), getColor(c.colorVenom), getColor(c.colorVenom));
      u.uGravity.value.set(0, 0.35, 0);
      u.uDrag.value = 1.4;
      u.uTurbulence.value = 0.5 * g.turbulence;
      u.uTurbFrequency.value = 0.6;
      u.uTurbSpeed.value = 0.3;
      u.uEndSize.value = 1.8;
      u.uSizeIn.value = 0.1;
      u.uFadeIn.value = 0.15;
      u.uFadeOut.value = 0.6;
      u.uGlow.value = 0.5 * g.glow;
      u.uOpacity.value = 0.32 * g.opacity;
    }
    {
      const u = this.embers.uniforms;
      this.embers.setGradient(getColor('#fff1c0'), getColor(c.colorEmber), getColor('#c02a08'), getColor('#3a0a02'));
      u.uGravity.value.set(0, c.emberRise, 0);
      u.uDrag.value = 1.1;
      u.uTurbulence.value = 0.6 * g.turbulence;
      u.uTurbFrequency.value = 0.9;
      u.uTurbSpeed.value = 0.7;
      u.uEndSize.value = 0.3;
      u.uSizeIn.value = 0.05;
      u.uFadeIn.value = 0.05;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = 1.6 * g.glow;
      u.uOpacity.value = g.opacity;
    }
  }

  /* ---- what lives in the air ---- */

  _emitters(dt) {
    const c = this.config;
    const g = settings.global;
    const time = frame.uTime.value;
    const R = c.zoneRadius;
    const live = (1 - this.burn) * saturate(this.reveal);

    /* spores drifting up through the gas inside the barrier */
    const spores = this._spores.tick(dt, c.sporeRate * g.particleCount * live);
    for (let i = 0; i < spores; i++) {
      const a = Math.random() * TAU;
      const r = Math.sqrt(Math.random()) * R * 0.9;
      _emit.position.set(this.centre.x + Math.cos(a) * r, randRange(0.02, 0.5), this.centre.z + Math.sin(a) * r);
      _emit.anchor = null;
      _emit.direction.set(0, 1, 0);
      _emit.inherit = null;
      _emit.radius = 0.05;
      _emit.speed = randRange(0.1, 0.5);
      _emit.speedVariance = 0.4;
      _emit.spread = 0.4;
      _emit.size = c.sporeSize;
      _emit.sizeVariance = 0.6;
      _emit.life = c.sporeLife;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.spores.emit(1, _emit);
    }

    /* embers off the cracks in the floor */
    const embers = this._embers.tick(dt, c.emberRate * g.particleCount * (1 - this.burn));
    for (let i = 0; i < embers; i++) {
      const a = Math.random() * TAU;
      const r = Math.sqrt(Math.random()) * R * c.plateReach * 0.85;
      _emit.position.set(this.centre.x + Math.cos(a) * r, 0.06, this.centre.z + Math.sin(a) * r);
      _emit.direction.set(0, 1, 0);
      _emit.radius = 0.05;
      _emit.speed = randRange(0.3, 1.2);
      _emit.speedVariance = 0.5;
      _emit.spread = 0.35;
      _emit.size = c.emberSize;
      _emit.sizeVariance = 0.6;
      _emit.life = c.emberLife;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.embers.emit(1, _emit);
    }

    /* 2 · gas seeping out from under the barrier */
    if (this.fieldAge >= c.gasDelay) {
      let gas = this._gas.tick(dt, c.gasRate * g.particleCount * (1 - this.burn));
      if (gas > 0) {
        this._gasDefaults(time);
        _emit.speed = c.gasSpeed;
        _emit.spread = 0.5;
        _emit.size = 0.85;
        _emit.life = c.gasLifetime;
        _emit.spin = 0.3;
        _emit.radius = 0.3;
        const per = Math.ceil(gas / Math.min(gas, GAS_BATCHES));
        while (gas > 0) {
          const a = Math.random() * TAU;
          const r = R * c.gasRadius * randRange(0.85, 1.08);
          _emit.position.set(this.centre.x + Math.cos(a) * r, randRange(0.1, 0.4), this.centre.z + Math.sin(a) * r);
          // Out, and low: it seeps from under the barrier along the floor.
          _emit.direction.set(Math.cos(a), 0.25, Math.sin(a)).normalize();
          this.gas.emit(Math.min(per, gas), _emit);
          gas -= per;
        }
      }
    }

    /* the barrier coming apart: glass thrown off it as the facets fall out */
    if (this.burn > 0 && this.burn < 0.98) {
      const shards = this._shards.tick(dt, c.breakChips * g.particleCount);
      const y0 = R * (1 - c.domeSink);
      for (let i = 0; i < shards; i++) {
        // A point on the sphere above the floor, thrown out and down.
        _n.set(randRange(-1, 1), randRange(-0.2, 1), randRange(-1, 1)).normalize();
        _emit.position.set(this.centre.x + _n.x * R, Math.max(0.05, y0 + _n.y * R), this.centre.z + _n.z * R);
        _emit.direction.copy(_n).setY(_n.y * 0.4 - 0.3).normalize();
        _emit.radius = 0.06;
        _emit.speed = randRange(0.8, 2.6);
        _emit.speedVariance = 0.5;
        _emit.spread = 0.5;
        _emit.size = c.chipSize * 1.2;
        _emit.sizeVariance = 0.6;
        _emit.life = 1.6;
        _emit.lifeVariance = 0.4;
        _emit.spin = 7;
        _emit.time = time;
        this.chips.emit(1, _emit);
      }
    }
  }

  /**
   * The emit record for a gas puff: anchored on the centre so the swirl
   * coils it round the barrier, wide variance so no two puffs match.
   */
  _gasDefaults(time) {
    _emit.inherit = null;
    _emit.anchor = this.centre;
    _emit.tint = null;
    _emit.time = time;
    _emit.sizeVariance = 0.6;
    _emit.lifeVariance = 0.45;
    _emit.speedVariance = 0.7;
  }

  dispose() {
    super.dispose();
    this.crustMaterial.dispose();
    this.crust.geometry.dispose();
    this.domeFarMaterial.dispose();
    this.domeNearMaterial.dispose();
    this.refractMaterial.dispose();
    this.domeFar.geometry.dispose();
    this.ringMaterial.dispose();
    this.rings.geometry.dispose();
    for (const statue of this.statues) {
      statue.material.userData.depth.dispose();
      statue.material.dispose();
      statue.dispose();
    }
  }
}
