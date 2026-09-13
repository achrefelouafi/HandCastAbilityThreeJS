import {
  CircleGeometry,
  CylinderGeometry,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Vector3
} from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { createCrystalGeometry } from '../assets/ProceduralGeometry.js';
import { IceStatue } from '../effects/IceStatue.js';
import {
  createColdGlowMaterial,
  createIceBodyMaterial,
  createIceCrystalMaterial,
  createIceFloorMaterial,
  createIceWallMaterial,
  createWallRefractionMaterial,
  iceUniforms,
  syncIce
} from '../materials/GlacialMaterials.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { Easing, hash11, lerp, randRange, saturate } from '../utils/math.js';

const TAU = Math.PI * 2;
/** Crystals standing at the foot of the wall, and splinters rising inside it. */
const CROWN_SLOTS = 48;
const RISER_SLOTS = 72;
/** Bodies one cast can hold frozen at once. */
const MAX_STATUES = 8;
/** How many points round the rim one frame's mist is split between. One origin reads as a hose. */
const MIST_BATCHES = 4;

const _vel = new Vector3();
const _axis = new Vector3();
const _turn = new Quaternion();
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
 * THE GLACIAL PRISON — a far cast, built to a six-panel sheet.
 *
 * There is no arriving: the prison lands where it is aimed on the frame it is
 * cast, and the ground freezes. Then, in the order the sheet stacks them:
 *
 *   1. the ice cylinder — a shell of ice stands up out of the frozen floor to
 *      twice a body's height, striated where it froze upward, frosted in
 *      patches, clear elsewhere, the stage bending through it.
 *   2. the frost particles — glints drifting up through the air inside it,
 *      and a fine snow falling.
 *   3. the ground ice — the floor inside the circle frozen into a sheet with
 *      cracks glowing from within at a depth, hoarfrost feathering out past
 *      the rim.
 *   4. the cold air mist — puffs of eroded smoke rolling out of the foot of
 *      the wall, hugging the floor and coiling round the prison as they
 *      thin (the same smoke the Corrupted Shard coils round its cluster).
 *   5. the rising shards — a crown of crystals growing at the foot of the
 *      wall and splinters lifting off the floor inside, faceted, twinkling.
 *   6. the ambient glow — the cold light over the middle of it.
 *
 * And what it does to a body: everything standing in the circle is frozen
 * where it stands — the frost climbs it from the feet, it turns to glass with
 * the dark body visible inside — held, cracked along the seams it will break
 * on, and shattered into pieces of ice that fly, land, lie there and melt.
 * The pieces are real: the body's own pose cut into Voronoi cells, each a
 * rigid body (see `effects/IceStatue.js`).
 *
 * It stands for `lifetime` seconds and then dies the way ice does: the wall
 * goes from the top down behind a rime edge, the crystals melt back into the
 * floor, the sheet loses its light and the frost recedes, the mist thins.
 */
export class GlacialPrisonAbility extends Ability {
  constructor(context) {
    super('frost', context);
  }

  get impactDuration() {
    return Math.max(0.05, settings.frost.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.frost.fadeTime);
  }

  get instanceCount() {
    return this._liveCrystals + this._flyingChunks;
  }

  /** Followed hard once it is up: the prison is the show. Let go as it thaws. */
  get cameraWeight() {
    if (this.u < 1) return saturate(1 - this.u * 0.4);
    return lerp(0.8, 0.15, this.burn);
  }

  /**
   * The pieces outlive the prison.
   *
   * A body frozen late is still lying on the floor in forty pieces when the
   * wall has gone, and a cast that retired on the wall's clock would take
   * them with it in one frame. So the fade is held open, quiet - every layer
   * already at its end - until the last piece has melted.
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

  /** It picks what it freezes; the field's disc would knock them over instead. */
  get handlesOwnHits() {
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const environment = this.ctx.environment;
    this.ice = iceUniforms();

    /* ---- 3 · the ground ice ---- */
    const disc = new CircleGeometry(1, 96);
    disc.rotateX(-Math.PI / 2);
    this.floorMaterial = createIceFloorMaterial(this.ice);
    this.floor = new Mesh(disc, this.floorMaterial);
    this.floor.layers.set(LAYER.VFX);
    this.floor.renderOrder = 2;
    this.floor.frustumCulled = false;
    this.group.add(this.floor);

    /* ---- 1 · the ice cylinder, and its refraction ---- */
    const tube = new CylinderGeometry(1, 1, 1, 128, 1, true);
    tube.translate(0, 0.5, 0);
    this.wallMaterial = createIceWallMaterial(this.ice);
    this.wall = new Mesh(tube, this.wallMaterial);
    this.wall.layers.set(LAYER.VFX);
    this.wall.renderOrder = 10;
    this.wall.frustumCulled = false;
    this.group.add(this.wall);

    this.refractMaterial = createWallRefractionMaterial();
    this.refract = new Mesh(tube, this.refractMaterial);
    this.refract.layers.set(LAYER.DISTORTION);
    this.refract.frustumCulled = false;
    this.group.add(this.refract);

    /* ---- 5 · the crystals ---- */
    this.crystalMaterial = createIceCrystalMaterial(this.ice);
    this.crown = this._crystals(
      createCrystalGeometry({ seed: 3.3, sides: 6, taper: 0.1, roughness: 0.32, bend: 0.18 }),
      CROWN_SLOTS,
      4
    );
    this.risers = this._crystals(
      createCrystalGeometry({ seed: 8.1, sides: 4, taper: 0.08, roughness: 0.5, bend: 0.1 }),
      RISER_SLOTS,
      5
    );
    this.crownSlots = [];
    for (let i = 0; i < CROWN_SLOTS; i++) {
      this.crownSlots.push({ angle: 0, lean: 0, yaw: 0, height: 1, width: 1, seed: Math.random() });
    }
    this.riserSlots = [];
    for (let i = 0; i < RISER_SLOTS; i++) {
      this.riserSlots.push({
        live: false,
        position: new Vector3(),
        orientation: new Quaternion(),
        spinAxis: new Vector3(0, 1, 0),
        spinRate: 0,
        rise: 0.5,
        drift: 0,
        size: 1,
        age: 0,
        life: 1,
        seed: Math.random()
      });
    }
    this._liveCrystals = 0;

    /* ---- 6 · the glow ---- */
    this.glowMaterial = createColdGlowMaterial(this.ice);
    this.glow = new Mesh(new PlaneGeometry(1, 1), this.glowMaterial);
    this.glow.layers.set(LAYER.VFX);
    this.glow.renderOrder = 11;
    this.glow.frustumCulled = false;
    this.group.add(this.glow);

    /* ---- the frozen bodies ---- */
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
    this._glints = new RateEmitter(60);
    this._motes = new RateEmitter(40);
    this._mist = new RateEmitter(44);
    this._vapour = new RateEmitter(20);
  }

  /** One instanced set of crystals, with its per-instance fade. */
  _crystals(geometry, slots, order) {
    const data = new InstancedBufferAttribute(new Float32Array(slots * 2), 2).setUsage(DynamicDrawUsage);
    for (let i = 0; i < slots; i++) data.array[i * 2 + 1] = Math.random() * 10;
    geometry.setAttribute('aData', data);
    const mesh = new InstancedMesh(geometry, this.crystalMaterial, slots);
    mesh.count = 0;
    mesh.layers.set(LAYER.VFX);
    mesh.renderOrder = order;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    this.group.add(mesh);
    mesh.userData.data = data;
    return mesh;
  }

  /** A statue and the slot that drives it. */
  _statue() {
    const statue = new IceStatue(createIceBodyMaterial(this.ctx.environment, this.ice));
    this.group.add(statue.mesh);
    this.statues.push(statue);
    this.slots.push({ statue, live: false, delay: 0, time: 0, shattered: false, done: false, away: new Vector3() });
    return this.slots[this.slots.length - 1];
  }

  createParticles() {
    const P = this.ctx.particles;
    this.glints = P.get('frostGlint', {
      capacity: 1600,
      shape: ParticleShape.GLINT,
      additive: true,
      curl: true,
      softFade: 0.3
    });
    this.motes = P.get('frostMote', {
      capacity: 1200,
      shape: ParticleShape.SOFT,
      additive: false,
      curl: true,
      softFade: 0.4
    });
    this.chips = P.get('frostChip', {
      capacity: 1400,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      stretch: false,
      softFade: 0.2
    });
    this.vapour = P.get('frostVapour', {
      capacity: 500,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 0.6
    });

    /* ---- 4 · the mist ---- */
    // Non-additive: the puffs *occlude* what is behind them, and an additive
    // version is a pale haze the wall loses its depth in. Swirl, so a puff
    // born at the foot of the wall coils round the prison as it rolls out.
    this.mist = P.get('frostMist', {
      capacity: 2600,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      swirl: true,
      softFade: 1.1
    });
    this.mist.uniforms.uDrag.value = 1.6;
    this.mist.uniforms.uEndSize.value = 2.6;
    this.mist.uniforms.uSizeIn.value = 0.14;
    this.mist.uniforms.uFadeIn.value = 0.2;
    this.mist.uniforms.uFadeOut.value = 0.35;
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.pointAt(1, this.centre);
    this.fieldAge = 0;
    this.burn = 0;
    this.reveal = 0;
    this._liveCrystals = 0;
    this._flyingChunks = 0;
    this._glints.reset();
    this._motes.reset();
    this._mist.reset();
    this._vapour.reset();
    for (const slot of this.riserSlots) slot.live = false;
    for (const slot of this.slots) this._freeSlot(slot);

    // Fresh cracks every time: the same seed would put the same fracture
    // under every cast.
    this.floorMaterial.uniforms.uSeed.value = Math.random() * 10;
    const wallSeed = Math.random() * 10;
    this.wallMaterial.uniforms.uSeed.value = wallSeed;
    this.refractMaterial.uniforms.uSeed.value = wallSeed;

    this.floor.visible = false;
    this.wall.visible = false;
    this.refract.visible = false;
    this.glow.visible = false;
    this.crown.count = 0;
    this.risers.count = 0;
  }

  onDestroy() {
    for (const slot of this.slots) this._freeSlot(slot);
    this.floor.visible = false;
    this.wall.visible = false;
    this.refract.visible = false;
    this.glow.visible = false;
    this.crown.count = 0;
    this.risers.count = 0;
  }

  /** Let a frozen body go, whatever state its statue was in. */
  _freeSlot(slot) {
    if (slot.statue.dummy) slot.statue.dummy.vanish();
    slot.statue.hide();
    slot.live = false;
    slot.done = false;
    slot.shattered = false;
    slot.time = 0;
  }

  /* ------------------------------------------------------------------ */
  /* no arriving                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * The prison does not run out from the caster's feet: it is simply there,
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

    this.floor.visible = true;
    this.wall.visible = true;
    this.refract.visible = true;
    this.glow.visible = true;

    /* 5 · the crown takes its places round the rim */
    const crown = Math.min(CROWN_SLOTS, Math.max(0, Math.round(c.crownCount)));
    for (let i = 0; i < crown; i++) {
      const slot = this.crownSlots[i];
      slot.seed = Math.random();
      slot.angle = (i / crown) * TAU + randRange(-0.4, 0.4) / Math.max(1, crown * 0.12);
      slot.lean = c.crownLean * randRange(0.4, 1.4);
      slot.yaw = Math.random() * TAU;
      slot.height = randRange(0.5, 1.35);
      slot.width = randRange(0.65, 1.3);
    }

    /* 2 · the air fills with glints as the floor freezes */
    const glints = Math.round(c.landGlints * g.particleCount);
    for (let i = 0; i < glints; i++) {
      const a = Math.random() * TAU;
      const r = Math.sqrt(Math.random()) * R;
      _emit.position.set(this.centre.x + Math.cos(a) * r, 0.05, this.centre.z + Math.sin(a) * r);
      _emit.anchor = null;
      _emit.direction.set(0, 1, 0);
      _emit.inherit = null;
      _emit.radius = 0.05;
      _emit.speed = randRange(0.6, 2.4);
      _emit.speedVariance = 0.4;
      _emit.spread = 0.5;
      _emit.size = c.glintSize * 1.3;
      _emit.sizeVariance = 0.5;
      _emit.life = c.glintLife;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.glints.emit(1, _emit);
    }
    const motes = Math.round(c.landMotes * g.particleCount);
    for (let i = 0; i < motes; i++) {
      const a = Math.random() * TAU;
      _emit.position.set(this.centre.x + Math.cos(a) * R, 0.15, this.centre.z + Math.sin(a) * R);
      _emit.direction.set(Math.cos(a), 0.6, Math.sin(a)).normalize();
      _emit.radius = 0.2;
      _emit.speed = 2.2;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.5;
      _emit.size = c.moteSize * 2;
      _emit.sizeVariance = 0.5;
      _emit.life = 1.6;
      _emit.lifeVariance = 0.4;
      _emit.time = time;
      this.motes.emit(1, _emit);
    }

    /* 4 · the gout of cold air as the floor freezes */
    this._mistDefaults(time);
    _emit.position.copy(this.centre).setY(0.2);
    _emit.radius = R * 0.6;
    _emit.direction.set(0, 1, 0);
    _emit.speed = c.mistSpeed * 2.4;
    _emit.spread = 0.9;
    _emit.size = 1.2;
    _emit.life = c.mistLifetime * 0.9;
    _emit.spin = 0.35;
    this.mist.emit(Math.round(c.mistBurst * g.particleCount), _emit);

    this.lightBoost = c.landLight * g.explosionIntensity;
    this.ctx.shake.add(c.landShake * g.explosionIntensity * g.cameraShake, 2.2, 14);

    this._freezeTargets();
    this._dress();
  }

  /* ------------------------------------------------------------------ */
  /* the prison standing                                                 */
  /* ------------------------------------------------------------------ */

  /** @param {number} t 0..1 standing, 1..2 dying */
  onFade(dt, t) {
    const c = this.config;
    this.fieldAge += dt;
    this.burn = t > 1 ? saturate(t - 1) : 0;

    // The wall stands up a beat after the floor freezes.
    const rise = saturate((this.fieldAge - c.wallDelay) / Math.max(0.05, c.wallRiseTime));
    this.reveal = Math.min(1.12, Easing.outBack(rise));

    // Anything that stands up inside while the prison holds is taken too.
    if (this.burn <= 0) this._freezeTargets();

    this._bodies(dt);
    this._risers(dt);
    this._dress();
    this._emitters(dt);
  }

  /* ---- what it does to a body ---- */

  /**
   * Freeze everything standing in the circle that is not frozen already.
   *
   * Each body gets a statue baked from its pose on this frame and a clock
   * of its own, staggered by how far from the centre it stands so the
   * freeze is seen to reach the outer bodies a beat after the inner ones.
   */
  _freezeTargets() {
    const c = this.config;
    const field = this.ctx.dummies;
    if (!field?.findTargets) return;
    const R = c.zoneRadius * Math.max(0.05, c.freezeReach);
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
      slot.delay = c.freezeDelay + (dist / Math.max(0.1, c.zoneRadius)) * c.freezeStagger;
      if (dist > 1e-4) slot.away.set(dx / dist, 0, dz / dist);
      else slot.away.copy(this.direction);
      slot.statue.material.userData.sync();
    }
  }

  /**
   * Run every frozen body through its clock: the frost climbs, the ice
   * holds, the cracks spread, the pieces fly, the pieces melt.
   */
  _bodies(dt) {
    const c = this.config;
    const g = settings.global;
    const time = frame.uTime.value;
    const physics = { gravity: c.shatterGravity, bounce: c.shatterBounce, friction: c.shatterFriction };
    const freezeTime = Math.max(0.05, c.freezeTime);
    const crackAt = freezeTime + Math.max(0, c.holdTime);
    const shatterAt = crackAt + Math.max(0.05, c.crackTime);
    const meltAt = shatterAt + Math.max(0, c.meltDelay);
    const meltTime = Math.max(0.05, c.meltTime);
    let flying = 0;

    for (const slot of this.slots) {
      if (!slot.live) continue;
      const statue = slot.statue;
      const u = statue.uniforms;
      statue.material.userData.sync();
      slot.time += dt;
      // The thaw breaks what the frost still holds: a body frozen too late to
      // run its own clock is jumped to its cracks as the prison dies.
      if (this.burn > 0 && !slot.shattered) {
        slot.time = Math.max(slot.time, slot.delay + crackAt + Math.max(0.05, c.crackTime) * 0.5);
      }
      const t = slot.time - slot.delay;
      if (t < 0) continue;

      /* the frost climbs the body from the feet */
      const freeze = saturate(t / freezeTime);
      u.uFreeze.value = freeze;
      const span = statue.top - statue.base;
      u.uFrostLine.value = statue.base - 0.12 + (span + 0.3) * Easing.outQuad(freeze);

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

      /* the melt */
      const melt = slot.shattered ? saturate((t - meltAt) / meltTime) : 0;
      u.uMelt.value = melt * 1.05;
      statue.update(dt, physics, melt, (i, impact) => this._chipLanding(statue, i, impact, time));
      flying += statue.flying;

      if (slot.shattered && melt > 0 && melt < 1) {
        // Cold vapour off the pieces as they go.
        const n = this._vapour.tick(dt, c.meltVapour * g.particleCount);
        for (let i = 0; i < n; i++) {
          statue.chunkPosition(Math.floor(Math.random() * statue.chunks), _emit.position);
          _emit.anchor = null;
          _emit.direction.set(0, 1, 0);
          _emit.inherit = null;
          _emit.radius = 0.08;
          _emit.speed = 0.35;
          _emit.speedVariance = 0.5;
          _emit.spread = 0.6;
          _emit.size = 0.22;
          _emit.sizeVariance = 0.4;
          _emit.life = 1.4;
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

  /** Splinters, vapour and glints out of a body as it comes apart. */
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

    const glints = Math.round(c.shatterChips * 0.6 * g.particleCount);
    for (let i = 0; i < glints; i++) {
      _emit.position.copy(statue.centre);
      _emit.position.y = lerp(statue.base, statue.top, Math.random());
      _emit.direction.set(randRange(-1, 1), randRange(0.2, 1), randRange(-1, 1)).normalize();
      _emit.radius = 0.25;
      _emit.speed = 2.5;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.6;
      _emit.size = c.glintSize * 1.2;
      _emit.sizeVariance = 0.5;
      _emit.life = 1.2;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.glints.emit(1, _emit);
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

  /* ---- 5 · the rising shards ---- */

  _risers(dt) {
    const c = this.config;
    const g = settings.global;
    const R = c.zoneRadius;
    const count = Math.min(RISER_SLOTS, Math.max(0, Math.round(c.shardCount * g.particleCount)));
    const data = this.risers.userData.data;
    const fade = 1 - Easing.inQuad(this.burn);
    let used = 0;
    let live = 0;

    for (let i = 0; i < RISER_SLOTS; i++) {
      const slot = this.riserSlots[i];
      if (slot.live) {
        slot.age += dt;
        if (slot.age >= slot.life) slot.live = false;
      }
      // Reborn off the floor while the prison stands; the air empties as it dies.
      if (!slot.live && i < count && this.burn <= 0 && this.fieldAge > c.shardDelay + hash11(i * 3.7) * 1.5) {
        const a = Math.random() * TAU;
        const r = Math.sqrt(Math.random()) * R * 0.85;
        slot.position.set(this.centre.x + Math.cos(a) * r, 0.02, this.centre.z + Math.sin(a) * r);
        slot.orientation.setFromAxisAngle(
          _axis.set(randRange(-1, 1), randRange(-1, 1), randRange(-1, 1)).normalize(),
          Math.random() * TAU
        );
        slot.spinAxis.set(randRange(-1, 1), randRange(-1, 1), randRange(-1, 1)).normalize();
        slot.spinRate = randRange(0.4, 1) * c.shardSpin * (Math.random() < 0.5 ? -1 : 1);
        slot.rise = c.shardRise * randRange(0.65, 1.35);
        slot.drift = randRange(-0.5, 0.5);
        slot.size = randRange(0.45, 1.4);
        slot.age = 0;
        slot.life = c.shardLife * randRange(0.7, 1.3);
        slot.live = true;
      }

      if (!slot.live) {
        data.setXY(i, 0, slot.seed * 10);
        _dummy.position.set(0, -999, 0);
        _dummy.scale.setScalar(0.0001);
        _dummy.quaternion.identity();
        _dummy.updateMatrix();
        this.risers.setMatrixAt(i, _dummy.matrix);
        if (i < count) used = i + 1;
        continue;
      }

      // Lifts off, spirals a little, tumbles slowly.
      slot.position.y += slot.rise * g.particleSpeed * dt;
      const ang = Math.atan2(slot.position.z - this.centre.z, slot.position.x - this.centre.x) + slot.drift * dt;
      const rad = Math.hypot(slot.position.x - this.centre.x, slot.position.z - this.centre.z);
      slot.position.x = this.centre.x + Math.cos(ang) * rad;
      slot.position.z = this.centre.z + Math.sin(ang) * rad;
      _turn.setFromAxisAngle(slot.spinAxis, slot.spinRate * dt);
      slot.orientation.premultiply(_turn);

      const k = slot.age / slot.life;
      const alpha = Easing.outQuad(saturate(k / 0.15)) * (1 - Easing.inQuad(saturate((k - 0.6) / 0.4))) * fade;
      const size = c.shardSize * slot.size * g.particleSize;
      _dummy.position.copy(slot.position);
      _dummy.quaternion.copy(slot.orientation);
      _dummy.scale.set(size * 0.55, size * 2.2, size * 0.55);
      _dummy.updateMatrix();
      this.risers.setMatrixAt(i, _dummy.matrix);
      data.setXY(i, alpha, slot.seed * 10);
      used = i + 1;
      live++;
    }

    this.risers.count = used;
    this.risers.instanceMatrix.needsUpdate = true;
    data.needsUpdate = true;
    this._liveCrystals = live;
  }

  /** The crown: crystals grown at the foot of the wall, melting back as it dies. */
  _crown() {
    const c = this.config;
    const g = settings.global;
    const R = c.zoneRadius;
    const count = Math.min(CROWN_SLOTS, Math.max(0, Math.round(c.crownCount)));
    const data = this.crown.userData.data;
    const melt = Easing.inQuad(this.burn);
    let live = 0;

    for (let i = 0; i < count; i++) {
      const slot = this.crownSlots[i];
      const grow = Easing.outBack(saturate((this.fieldAge - c.crownDelay - slot.seed * 0.3) / Math.max(0.05, c.crownGrowTime)));
      const scale = Math.max(0, grow) * (1 - melt);
      const h = c.crownHeight * slot.height * scale;
      const w = c.crownBase * slot.width * Math.min(1, scale * 1.15);
      const r = R * c.crownRadius;

      _dummy.position.set(this.centre.x + Math.cos(slot.angle) * r, -0.02, this.centre.z + Math.sin(slot.angle) * r);
      // Leaning outward, off the wall, each turned on its own axis.
      _dummy.quaternion.setFromAxisAngle(_axis.set(0, 1, 0), slot.yaw);
      _turn.setFromAxisAngle(_axis.set(-Math.sin(slot.angle), 0, Math.cos(slot.angle)), -slot.lean);
      _dummy.quaternion.premultiply(_turn);
      _dummy.scale.set(w, Math.max(1e-4, h), w);
      _dummy.updateMatrix();
      this.crown.setMatrixAt(i, _dummy.matrix);
      data.setXY(i, saturate(scale * 1.5) * g.opacity, slot.seed * 10);
      if (h > 0.01) live++;
    }
    this.crown.count = count;
    this.crown.instanceMatrix.needsUpdate = true;
    data.needsUpdate = true;
    this._liveCrystals += live;
  }

  /* ---- settings → uniforms, every frame ---- */

  _dress() {
    const c = this.config;
    const g = settings.global;
    const R = c.zoneRadius;
    const fade = 1 - Easing.inQuad(this.burn);
    syncIce(this.ice, c);

    /* 3 · the ground ice */
    {
      const u = this.floorMaterial.uniforms;
      const outer = R * Math.max(1.02, c.floorReach);
      const front = outer * Easing.outCubic(saturate(this.fieldAge / Math.max(0.05, c.floorFreezeTime)));
      u.uRadius.value = R;
      u.uOuter.value = outer;
      // Dying, the frost recedes: the front runs back in past the rim.
      u.uFront.value = this.burn > 0 ? Math.max(0, outer - (outer - R * 0.2) * Easing.inCubic(this.burn) * 1.3) : Math.max(0.01, front);
      u.uOpacity.value = c.floorOpacity * g.opacity;
      u.uFrost.value = c.floorFrost * g.opacity;
      u.uFrostScale.value = c.floorFrostScale * g.noiseFrequency;
      u.uCrackScale.value = c.crackScale;
      u.uCrackWidth.value = c.crackWidth;
      u.uCrackGlow.value = c.crackGlow * g.glow * g.shaderIntensity;
      u.uDepth.value = c.crackDepth;
      u.uSpokes.value = Math.max(1, Math.round(c.spokes));
      u.uFootGlow.value = c.footGlow * g.glow * this.reveal;
      u.uSparkle.value = c.floorSparkle;
      u.uPulse.value = c.floorPulse;
      u.uFade.value = 1 - Easing.inCubic(this.burn) * 0.85;
      u.uGlowFade.value = fade;
      this.floor.position.set(this.centre.x, 0.012, this.centre.z);
      this.floor.scale.setScalar(outer);
    }

    /* 1 · the wall */
    {
      const H = c.wallHeight;
      const u = this.wallMaterial.uniforms;
      u.uReveal.value = this.reveal;
      u.uHeight.value = H;
      u.uRadius.value = R;
      u.uOpacity.value = c.wallOpacity * g.opacity;
      u.uBody.value = c.wallBody;
      u.uTopFade.value = c.wallTopFade;
      u.uRimPower.value = c.wallRimPower;
      u.uRimGlow.value = c.wallRimGlow * g.glow;
      u.uFrostScale.value = c.wallFrostScale * g.noiseFrequency;
      u.uFrostAmount.value = c.wallFrost;
      u.uStriaScale.value = c.wallStriaScale * g.noiseFrequency;
      u.uFlow.value = c.wallFlow * g.noiseSpeed;
      u.uCaustic.value = c.wallCaustic * g.glow;
      u.uFootGlow.value = c.wallFootGlow * g.glow;
      u.uCrackAmount.value = c.wallCracks;
      u.uBurn.value = this.burn;
      u.uFade.value = 1;
      this.wall.position.set(this.centre.x, 0, this.centre.z);
      this.wall.scale.set(R, H, R);
      this.wall.visible = this.reveal > 0.001 && this.burn < 0.999;

      const r = this.refractMaterial.uniforms;
      r.uReveal.value = this.reveal;
      r.uHeight.value = H;
      r.uRadius.value = R;
      r.uStrength.value = c.wallRefraction;
      r.uTopFade.value = c.wallTopFade;
      r.uStriaScale.value = c.wallStriaScale * g.noiseFrequency;
      r.uBurn.value = this.burn;
      r.uFade.value = 1;
      this.refract.position.copy(this.wall.position);
      this.refract.scale.copy(this.wall.scale);
      this.refract.visible = this.wall.visible && c.wallRefraction > 0.001;
    }

    /* 5 · the crystals */
    {
      const u = this.crystalMaterial.uniforms;
      u.uOpacity.value = c.crystalOpacity * g.opacity;
      u.uScreenKey.value = c.crystalScreenKey;
      u.uInclusions.value = c.crystalInclusions * g.noiseFrequency;
      u.uRim.value = c.crystalRim * g.glow;
      u.uFade.value = 1;
      this._crown();
    }

    /* 6 · the glow */
    {
      const u = this.glowMaterial.uniforms;
      const size = R * c.glowRadius * 2;
      u.uWidth.value = size;
      u.uHeight.value = size * 0.7;
      u.uIntensity.value = c.glowIntensity * g.glow * g.shaderIntensity * Easing.outQuad(saturate(this.fieldAge / 0.5));
      u.uPulse.value = c.glowPulse;
      u.uPulseSpeed.value = c.glowPulseSpeed;
      u.uFade.value = fade * g.opacity;
      this.glow.position.set(this.centre.x, c.glowHeight, this.centre.z);
      this.glow.visible = fade > 0.001;
    }

    /* the particle systems — shared, so re-dressed every frame */
    {
      const u = this.mist.uniforms;
      this.mist.setGradient(getColor(c.colorMistA), getColor(c.colorMistB), getColor(c.colorMistC), getColor(c.colorMistD));
      u.uGravity.value.set(0, c.mistRise, 0);
      u.uSizeScale.value = c.mistSize * g.particleSize;
      u.uLifeScale.value = c.mistLifetime * 0.5 * g.particleLifetime;
      u.uSpeedScale.value = c.mistSpeed * g.particleSpeed;
      u.uOpacity.value = c.mistOpacity * g.opacity;
      u.uTurbulence.value = c.mistTurbulence * 0.5 * g.turbulence;
      u.uSwirl.value = c.mistSwirl;
      u.uSwirlExpand.value = c.mistSwirlExpand;
      u.uGlow.value = 1;
    }
    {
      const u = this.glints.uniforms;
      this.glints.setGradient(getColor('#ffffff'), getColor(c.colorFrost), getColor(c.colorGlow), getColor(c.colorIce));
      u.uGravity.value.set(0, c.glintRise, 0);
      u.uDrag.value = 1.2;
      u.uTurbulence.value = 0.35 * g.turbulence;
      u.uTurbFrequency.value = 0.6;
      u.uTurbSpeed.value = 0.4;
      u.uEndSize.value = 0.6;
      u.uSizeIn.value = 0.1;
      u.uFadeIn.value = 0.1;
      u.uFadeOut.value = 0.45;
      u.uGlow.value = c.glintGlow * g.glow;
      u.uOpacity.value = g.opacity;
    }
    {
      const u = this.motes.uniforms;
      this.motes.setGradient(getColor(c.colorFrost), getColor(c.colorFrost), getColor(c.colorIce), getColor(c.colorIce));
      u.uGravity.value.set(0, c.moteFall, 0);
      u.uDrag.value = 1.6;
      u.uTurbulence.value = 0.5 * g.turbulence;
      u.uTurbFrequency.value = 0.5;
      u.uTurbSpeed.value = 0.3;
      u.uEndSize.value = 0.8;
      u.uSizeIn.value = 0.15;
      u.uFadeIn.value = 0.2;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = 0.9 * g.glow;
      u.uOpacity.value = 0.7 * g.opacity;
    }
    {
      const u = this.chips.uniforms;
      this.chips.setGradient(getColor(c.colorFrost), getColor(c.colorIce), getColor(c.colorIce), getColor(c.colorDeep));
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
      this.vapour.setGradient(getColor(c.colorFrost), getColor(c.colorFrost), getColor(c.colorIce), getColor(c.colorIce));
      u.uGravity.value.set(0, 0.25, 0);
      u.uDrag.value = 1.4;
      u.uTurbulence.value = 0.5 * g.turbulence;
      u.uTurbFrequency.value = 0.6;
      u.uTurbSpeed.value = 0.3;
      u.uEndSize.value = 1.7;
      u.uSizeIn.value = 0.1;
      u.uFadeIn.value = 0.15;
      u.uFadeOut.value = 0.6;
      u.uGlow.value = 0.5 * g.glow;
      u.uOpacity.value = 0.3 * g.opacity;
    }
  }

  /* ---- 2 · the frost in the air ---- */

  _emitters(dt) {
    const c = this.config;
    const g = settings.global;
    const time = frame.uTime.value;
    const R = c.zoneRadius;
    const live = (1 - this.burn) * this.reveal;

    /* glints lifting through the air inside the wall */
    const glints = this._glints.tick(dt, c.glintRate * g.particleCount * live);
    for (let i = 0; i < glints; i++) {
      const a = Math.random() * TAU;
      const r = Math.sqrt(Math.random()) * R * 0.95;
      _emit.position.set(this.centre.x + Math.cos(a) * r, randRange(0.02, 0.6), this.centre.z + Math.sin(a) * r);
      _emit.anchor = null;
      _emit.direction.set(0, 1, 0);
      _emit.inherit = null;
      _emit.radius = 0.05;
      _emit.speed = randRange(0.1, 0.5);
      _emit.speedVariance = 0.4;
      _emit.spread = 0.4;
      _emit.size = c.glintSize;
      _emit.sizeVariance = 0.6;
      _emit.life = c.glintLife;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.glints.emit(1, _emit);
    }

    /* a fine snow settling out of the cold air */
    const motes = this._motes.tick(dt, c.moteRate * g.particleCount * live);
    for (let i = 0; i < motes; i++) {
      const a = Math.random() * TAU;
      const r = Math.sqrt(Math.random()) * R * 1.1;
      _emit.position.set(this.centre.x + Math.cos(a) * r, randRange(1.2, c.wallHeight * 0.8), this.centre.z + Math.sin(a) * r);
      _emit.direction.set(0, -1, 0);
      _emit.radius = 0.1;
      _emit.speed = 0.15;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.5;
      _emit.size = c.moteSize;
      _emit.sizeVariance = 0.5;
      _emit.life = c.moteLife;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.time = time;
      this.motes.emit(1, _emit);
    }

    /* 4 · cold air rolling off the foot of the wall */
    if (this.fieldAge >= c.mistDelay) {
      let mist = this._mist.tick(dt, c.mistRate * g.particleCount * (1 - this.burn));
      if (mist > 0) {
        this._mistDefaults(time);
        _emit.speed = c.mistSpeed;
        _emit.spread = 0.5;
        _emit.size = 0.85;
        _emit.life = c.mistLifetime;
        _emit.spin = 0.3;
        _emit.radius = 0.3;
        const per = Math.ceil(mist / Math.min(mist, MIST_BATCHES));
        while (mist > 0) {
          const a = Math.random() * TAU;
          const r = R * randRange(0.85, 1.05);
          _emit.position.set(this.centre.x + Math.cos(a) * r, randRange(0.1, 0.45), this.centre.z + Math.sin(a) * r);
          // Out, and low: heavy air rolls off the wall along the floor.
          _emit.direction.set(Math.cos(a), 0.22, Math.sin(a)).normalize();
          this.mist.emit(Math.min(per, mist), _emit);
          mist -= per;
        }
      }
    }
  }

  /**
   * The emit record for a mist puff: anchored on the centre so the swirl
   * coils it round the prison, wide variance so no two puffs match.
   */
  _mistDefaults(time) {
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
    this.floorMaterial.dispose();
    this.floor.geometry.dispose();
    this.wallMaterial.dispose();
    this.refractMaterial.dispose();
    this.wall.geometry.dispose();
    this.crystalMaterial.dispose();
    this.crown.geometry.dispose();
    this.risers.geometry.dispose();
    this.glowMaterial.dispose();
    this.glow.geometry.dispose();
    for (const statue of this.statues) {
      statue.material.userData.depth.dispose();
      statue.material.dispose();
      statue.dispose();
    }
  }
}
