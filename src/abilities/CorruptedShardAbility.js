import {
  CylinderGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Vector3
} from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { createCrystalGeometry } from '../assets/ProceduralGeometry.js';
import { createLanceGeometry } from '../assets/GrowthGeometry.js';
import { createShardRuneMaterial } from '../materials/ShardRuneMaterial.js';
import { createShardCrystalMaterial } from '../materials/ShardCrystalMaterial.js';
import { createShardSplashMaterial } from '../materials/ShardSplashMaterial.js';
import { createShardFlareMaterial } from '../materials/ShardFlareMaterial.js';
import { createShardBeamMaterial, MAX_BEAMS } from '../materials/ShardBeamMaterial.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { saturate, lerp, Easing, randRange } from '../utils/math.js';

const TAU = Math.PI * 2;
/** The golden angle. Deals any count of crystals evenly round a ring. */
const GOLDEN = 2.399963229728653;

/** Hard ceiling on crystals per cast. The editor's count slider clamps to this. */
const MAX_CRYSTALS = 24;
/**
 * Distinct crystal silhouettes. Each is its own InstancedMesh — three draw
 * calls buys variety that per-instance scaling cannot, because the *facets*
 * differ, not just the proportions.
 */
const VARIANTS = 3;
const SLOTS = Math.ceil(MAX_CRYSTALS / VARIANTS);

const CROWN_SEGMENTS = 128;
const CROWN_RINGS = 20;

/** Bodies the beam can be burning at once. */
const MAX_BURNING = 12;

/** How many points one frame's particles are split between. One origin reads as a hose. */
const BATCHES = 4;

/**
 * What a crystal in the cluster is. The sheet's second panel is three
 * populations, and reading it as one is what makes a procedural cluster look
 * like a sea urchin.
 */
const Tier = Object.freeze({
  /** The one in the middle that owns the silhouette. */
  SPIRE: 0,
  /** The ring around it, leaning outward. */
  BLADE: 1,
  /** The short fat skirt at the foot. */
  SHARD: 2
});

const _emit = {};
const _pos = new Vector3();
const _centre = new Vector3();
const _dir = new Vector3();
const _lean = new Vector3();
const _axis = new Vector3();
const _aimAt = new Vector3();
const _up = new Vector3(0, 1, 0);
const _dummy = new Object3D();
const _spin = new Quaternion();
const _tilt = new Quaternion();

/**
 * The pulse, 0..1 — the envelope every glowing pass is driven off.
 *
 * Two sines a fifth apart, so it never lands twice on the same rhythm inside
 * one cast, and *sharpened*: this is a light source with something wrong sealed
 * in it, and it should snap where a plant would breathe.
 *
 * @param {number} t phase, seconds × `pulseRate`
 */
function pulseEnvelope(t) {
  const a = Math.sin(t);
  const b = Math.sin(t * 1.5 + 1.7);
  const raw = saturate(((a + b * 0.62) / 1.62) * 0.5 + 0.5);
  return raw * raw * (3 - 2 * raw);
}

/**
 * SHARD — the Corrupted Shard Spawn.
 *
 * A seed of violet light runs across the floor to the aimed circle. A rune is
 * cut into the floor there and races out to the boundary; a crown of dark water
 * is thrown up as the crystals break the floor under it; a cluster of
 * corrupted amethyst tears up out of the rune, spire first and skirt last; a
 * lens star ignites in the heart of them; and dark mist and beads of corruption
 * coil up round the whole thing for as long as it stands. Then it goes to work:
 * a beam of that white light to the nearest body still standing, one at a time,
 * and what it goes through is thrown, and then burnt out from the inside.
 *
 * ## The six layers, and the seventh
 *
 * The reference sheet lists six and this class is the only place they are not
 * separate:
 *
 *   1. the **ground rune** (`ShardRuneMaterial`)
 *   2. the **crystal shards** (`ShardCrystalMaterial`, three instanced draws)
 *   3. the **radial water splash** (`ShardSplashMaterial`, a vertex-stage lathe)
 *   4. the **dark mist tendrils** (particles, coiling round the cluster)
 *   5. the **glow flash** (`ShardFlareMaterial`, one billboard)
 *   6. the **corrupted droplets** (particles: dark beads and the glints among them)
 *
 * and the seventh, which the composite implies: the flash is a *light source*,
 * so it fires (`ShardBeamMaterial`, one instanced draw for the whole volley).
 *
 * Two things hold the layers together. `_flareAt` — where the flash is — is
 * handed to the crystal material every frame, so the gems are lit by the light
 * standing among them rather than by a glow parked inside a pile of crystals;
 * and `_charge` — how wound up the beam is — is handed to the flare, the
 * crystals *and* the rune, so the whole spawn visibly gathers itself before a
 * beam leaves. The warmup is not a delay; it is the tell.
 *
 * ## The rule that keeps the editor honest
 *
 * A cast captures a seed and a handful of timestamps. Not one metre, radian or
 * second is recorded: the footprint, the cluster, the crown, the flare and the
 * light are all resolved against `settings.shard` inside the update loop, which
 * runs on a zero-length frame too. Drag `footprint radius` while a spawn is
 * standing and the rune, the crystals and the crown all re-seat around it.
 */
export class CorruptedShardAbility extends Ability {
  constructor(context) {
    super('shard', context);
  }

  /** The field must not fell what this is about to pick out one at a time. */
  get handlesOwnHits() {
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const environment = this.ctx.environment;

    /* ---- layer 1: the rune ---- */
    this.runeGeometry = new PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2);
    this.runeMaterial = createShardRuneMaterial();
    this.rune = new Mesh(this.runeGeometry, this.runeMaterial);
    this.rune.name = 'ShardRune';
    this.rune.layers.set(LAYER.VFX);
    this.rune.renderOrder = 6;
    this.rune.frustumCulled = false;
    this.rune.visible = false;
    this.group.add(this.rune);

    /* ---- layer 2: the crystals ---- */
    this.crystalMaterial = createShardCrystalMaterial(environment);
    /** Signature of the geometry controls, so a rebuild only happens on a change. */
    this._shapeKey = '';
    this.crystalMeshes = [];
    this.birthAttributes = [];

    for (let v = 0; v < VARIANTS; v++) {
      const geometry = this._buildGeometry(v);

      const seeds = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
      const births = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
      const flows = new InstancedBufferAttribute(new Float32Array(SLOTS), 1);
      for (let i = 0; i < SLOTS; i++) {
        seeds.array[i] = Math.random() * 10;
        // The phase of the corruption climbing inside this gem. Not reset per
        // cast: it is a property of the stone, not of the event.
        flows.array[i] = Math.random();
      }
      geometry.setAttribute('aSeed', seeds);
      geometry.setAttribute('aBirth', births);
      geometry.setAttribute('aFlow', flows);

      const mesh = new InstancedMesh(geometry, this.crystalMaterial, SLOTS);
      mesh.name = `ShardCrystals${v}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      // Solid world geometry: it belongs in the depth prepass so the mist and
      // the beads fade softly where they intersect it.
      mesh.layers.set(LAYER.WORLD);
      mesh.renderOrder = 2;
      mesh.visible = false;
      this.group.add(mesh);

      this.crystalMeshes.push(mesh);
      this.birthAttributes.push(births);
    }

    /**
     * Fixed-size record pool — a cast allocates nothing. Dice only, no
     * dimensions: see the class comment.
     */
    this.records = [];
    for (let i = 0; i < MAX_CRYSTALS; i++) {
      this.records.push({
        tier: Tier.BLADE,
        angle: 0, // bearing from the centre, radians
        seatJitter: 0, // -1..1
        heightJitter: 0,
        radiusJitter: 0,
        leanJitter: 0,
        yaw: 0,
        stagger: 0, // 0..1 of `crystalStagger`
        eruptTime: -1, // seconds after the landing it was triggered at, or -1
        breached: false // has it thrown its spray yet
      });
    }

    /* ---- layer 3: the splash ---- */
    // A bare unit cylinder: every metre of the crown is built in the vertex
    // stage from live settings, so this buffer is never rebuilt.
    this.splashGeometry = new CylinderGeometry(1, 1, 1, CROWN_SEGMENTS, CROWN_RINGS, true)
      .translate(0, 0.5, 0);
    this.splashMaterial = createShardSplashMaterial();
    this.splash = new Mesh(this.splashGeometry, this.splashMaterial);
    this.splash.name = 'ShardSplash';
    this.splash.layers.set(LAYER.VFX);
    this.splash.renderOrder = 11;
    this.splash.frustumCulled = false;
    this.splash.visible = false;
    this.group.add(this.splash);

    /* ---- layer 5: the flare ---- */
    this.flareGeometry = new PlaneGeometry(1, 1, 1, 1);
    this.flareMaterial = createShardFlareMaterial();
    this.flare = new Mesh(this.flareGeometry, this.flareMaterial);
    this.flare.name = 'ShardFlare';
    this.flare.layers.set(LAYER.VFX);
    this.flare.renderOrder = 20; // over everything: it is the light
    this.flare.frustumCulled = false;
    this.flare.visible = false;
    this.group.add(this.flare);

    /* ---- the beams ---- */
    this.beamGeometry = createLanceGeometry({ lances: MAX_BEAMS, nodes: 32, sides: 12 });
    // The tube is the lance's; only the name of the index differs.
    this.beamGeometry.setAttribute('aBeam', this.beamGeometry.getAttribute('aLance'));
    this.beamGeometry.deleteAttribute('aLance');
    this.beamMaterial = createShardBeamMaterial();
    this.beams = new Mesh(this.beamGeometry, this.beamMaterial);
    this.beams.name = 'ShardBeams';
    this.beams.layers.set(LAYER.VFX);
    this.beams.renderOrder = 18;
    this.beams.frustumCulled = false;
    this.beams.matrixAutoUpdate = false;
    this.beams.visible = false;
    this.group.add(this.beams);

    /**
     * One slot per shot in flight. `from` / `to` / `state` are *the material's
     * own uniform values*, written in place — a volley never allocates.
     */
    this._beamSlots = [];
    for (let i = 0; i < MAX_BEAMS; i++) {
      this._beamSlots.push({
        age: 0,
        life: 1,
        /** The body this shot is on its way to, until its head arrives. */
        pending: null,
        dirX: 0,
        dirZ: 1,
        from: this.beamMaterial.uniforms.uOrigin.value[i],
        to: this.beamMaterial.uniforms.uTarget.value[i],
        state: this.beamMaterial.uniforms.uState.value[i]
      });
    }

    /** Bodies the light is still burning out. */
    this._burning = [];
    for (let i = 0; i < MAX_BURNING; i++) {
      this._burning.push({ dummy: null, time: 0, eaten: 0 });
    }

    /* ---- per-cast state ---- */
    this._seed = 0;
    /** Seconds since the seed landed. Drives the whole sequence. */
    this._time = 0;
    this._pulsePhase = 0;
    this._pulse = 0;
    /** 0..1 how wound up the beam is. */
    this._charge = 0;
    this._fireTimer = 0;
    this._chargeTimer = 0;
    this._mark = null;
    this._targets = [];
    /** One-shots. */
    this._ignited = false;
    this._shattered = false;
    /** Where the flash is — the point every beam leaves from. */
    this._flareAt = new Vector3();

    this._runeState = {
      radius: 1,
      quadSize: 1,
      grown: 0,
      front: 0,
      pulse: 0,
      charge: 0,
      fade: 1,
      seed: 0
    };
    this._splashState = { radius: 1, rise: 0, fall: 0, fade: 1, seed: 0 };
    this._flareState = { lit: 0, charge: 0, pulse: 0, fade: 1, seed: 0 };
  }

  /** One crystal shape. The variant index only perturbs the seed. */
  _buildGeometry(variant) {
    const c = settings.shard;
    return createCrystalGeometry({
      seed: 7.3 + variant * 13.7,
      sides: c.crystalFacets,
      taper: c.crystalTaper,
      roughness: c.crystalRough,
      bend: c.crystalBend
    });
  }

  /**
   * Regenerate the crystal meshes when a *shape* control moves. Facets, taper,
   * roughness and bend cannot be a per-instance transform, so they are baked —
   * and a six-sided prism is cheap enough to rebuild outright.
   */
  _syncGeometry() {
    const c = settings.shard;
    const key = `${Math.round(c.crystalFacets)}|${c.crystalTaper.toFixed(3)}|${c.crystalRough.toFixed(3)}|${c.crystalBend.toFixed(3)}`;
    if (key === this._shapeKey) return;
    this._shapeKey = key;

    for (let v = 0; v < VARIANTS; v++) {
      const mesh = this.crystalMeshes[v];
      const previous = mesh.geometry;
      const geometry = this._buildGeometry(v);
      for (const name of ['aSeed', 'aBirth', 'aFlow']) {
        geometry.setAttribute(name, previous.getAttribute(name));
      }
      mesh.geometry = geometry;
      previous.dispose();
    }
  }

  createParticles() {
    const particles = this.ctx.particles;

    /* ---- layer 4: the mist ---- */
    // Non-additive: the sheet's tendrils *occlude* what is behind them, and an
    // additive version is a violet haze the cluster loses its depth in. Swirl,
    // so a puff born beside the cluster coils round it as it climbs.
    this.mist = particles.get('shard.mist', {
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

    /* ---- layer 6: the beads ---- */
    // Beads of corruption: dark, full through the middle, wet at the edge. Not
    // additive — a bead is *matter*, and additive matter is a spark. They hang
    // and drift round the cluster rather than falling.
    this.beads = particles.get('shard.beads', {
      capacity: 2400,
      shape: ParticleShape.DROPLET,
      additive: false,
      lit: true,
      swirl: true,
      softFade: 0.2
    });
    this.beads.uniforms.uDrag.value = 1.8;
    this.beads.uniforms.uEndSize.value = 0.85;
    this.beads.uniforms.uSizeIn.value = 0.06;
    this.beads.uniforms.uFadeIn.value = 0.04;
    this.beads.uniforms.uFadeOut.value = 0.8;

    // ... and the pinpoints of light among them.
    this.glints = particles.get('shard.glints', {
      capacity: 2000,
      shape: ParticleShape.GLINT,
      additive: true,
      curl: true,
      softFade: 0.3
    });
    this.glints.uniforms.uDrag.value = 1.4;
    this.glints.uniforms.uEndSize.value = 0.3;
    this.glints.uniforms.uSizeIn.value = 0.05;
    this.glints.uniforms.uFadeIn.value = 0.05;
    this.glints.uniforms.uFadeOut.value = 0.4;

    /* ---- layer 3: the water thrown off the crown ---- */
    // Real droplets under real gravity, unlike the beads.
    this.drops = particles.get('shard.drops', {
      capacity: 2200,
      shape: ParticleShape.DROPLET,
      additive: false,
      lit: true,
      softFade: 0.2
    });
    this.drops.uniforms.uDrag.value = 0.15;
    this.drops.uniforms.uEndSize.value = 0.8;
    this.drops.uniforms.uSizeIn.value = 0.03;
    this.drops.uniforms.uFadeIn.value = 0.02;
    this.drops.uniforms.uFadeOut.value = 0.85;

    /* ---- what the crystals leave as they go ---- */
    this.chips = particles.get('shard.chips', {
      capacity: 1200,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.25
    });
    this.chips.uniforms.uDrag.value = 0.6;
    this.chips.uniforms.uEndSize.value = 0.7;
    this.chips.uniforms.uSizeIn.value = 0.02;
    this.chips.uniforms.uFadeIn.value = 0.02;
    this.chips.uniforms.uFadeOut.value = 0.7;

    this.mistEmitter = new RateEmitter();
    this.beadEmitter = new RateEmitter();
    this.glintEmitter = new RateEmitter();
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get impactDuration() {
    return Math.max(0.05, settings.shard.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.shard.fadeTime);
  }

  /** The light pulses with everything else, and flares as a beam winds up. */
  lightShimmer() {
    const c = settings.shard;
    return 1 - c.lightPulse * 0.5 + c.lightPulse * this._pulse + this._charge * 0.45;
  }

  /** Live crystal count, for the HUD readout. */
  get instanceCount() {
    let count = 0;
    for (const mesh of this.crystalMeshes) count += mesh.count;
    return count;
  }

  /* ------------------------------------------------------------------ */
  /* Geometry — every metre resolved from live settings                   */
  /* ------------------------------------------------------------------ */

  /** The live footprint, metres. What the indicator measured out. */
  get radius() {
    return Math.max(0.05, settings.shard.zoneRadius);
  }

  /** Where the seed leaves the caster, in world space. */
  _handPoint(out) {
    const c = settings.shard;
    out
      .copy(this.origin)
      .addScaledVector(this.direction, c.handForward)
      .addScaledVector(this.side, c.handSide);
    out.y = c.handHeight;
    return out;
  }

  /** The centre of the spawn — the far end of the aimed line. */
  _centrePoint(out) {
    return this.pointAt(1, out).setY(0);
  }

  /** The seed's travelling head. Pinned to the centre once it has arrived. */
  _frontPoint(out) {
    const u = this.phase === AbilityPhase.TRAVEL ? this.u : 1;
    return this.pointAt(u, out).setY(0.12);
  }

  /** Where the flash stands: in the heart of the cluster. */
  _flarePoint(out) {
    this._centrePoint(out);
    out.y = settings.shard.flareHeight;
    return out;
  }

  /** How lit the flash is, 0..1. */
  _flareLit() {
    const c = settings.shard;
    return Easing.outCubic(saturate((this._time - c.flareDelay) / Math.max(0.01, c.flareTime)));
  }

  /** The pop as the flash ignites — a spike over the first quarter second. */
  _ignitePop() {
    const c = settings.shard;
    const since = this._time - c.flareDelay;
    if (since < 0) return 0;
    return c.flareIgnite * Math.exp(-since * 7) * saturate(since / 0.05);
  }

  /** Whether there is a light to fire from yet. */
  get _armed() {
    const c = settings.shard;
    if (!c.laserEnabled) return false;
    return this._time >= c.flareDelay + c.flareTime + c.fireDelay;
  }

  /** Where up a body a beam lands. */
  _aimPoint(out, dummy) {
    return out.set(
      dummy.position.x,
      settings.dummies.height * saturate(settings.shard.laserAim),
      dummy.position.z
    );
  }

  /* ------------------------------------------------------------------ */
  /* The crystals                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Deal the dice for a cast.
   *
   * Every record is rolled, whatever the live count: the count is read per
   * frame and the surplus simply is not drawn, so raising the slider while a
   * spawn stands brings more crystals up out of the floor. Bearings come off
   * the golden angle *per tier*, which spreads any number of them evenly round
   * their ring — a fixed division would bunch as the count moved.
   */
  _deal() {
    let blades = 0;
    let shards = 0;
    const spinA = Math.random() * TAU;
    const spinB = Math.random() * TAU;

    for (let i = 0; i < MAX_CRYSTALS; i++) {
      const record = this.records[i];
      if (i === 0) {
        record.tier = Tier.SPIRE;
        record.angle = Math.random() * TAU;
        record.stagger = 0;
      } else if (i % 3 === 0) {
        record.tier = Tier.SHARD;
        record.angle = spinB + shards++ * GOLDEN;
        record.stagger = 0.5 + Math.random() * 0.5;
      } else {
        record.tier = Tier.BLADE;
        record.angle = spinA + blades++ * GOLDEN;
        record.stagger = 0.12 + Math.random() * 0.5;
      }
      record.angle += (Math.random() - 0.5) * 0.25;
      record.seatJitter = Math.random() * 2 - 1;
      record.heightJitter = Math.random() * 2 - 1;
      record.radiusJitter = Math.random() * 2 - 1;
      record.leanJitter = Math.random() * 2 - 1;
      record.yaw = Math.random() * TAU;
      record.eruptTime = -1;
      record.breached = false;
    }
  }

  /** How many crystals are live, from the slider. */
  get _crystalCount() {
    return Math.min(MAX_CRYSTALS, Math.max(1, Math.round(settings.shard.crystals)));
  }

  _crystalHeight(record, c, g) {
    let h = c.bladeHeight;
    if (record.tier === Tier.SPIRE) h = c.spireHeight;
    else if (record.tier === Tier.SHARD) h = c.shardHeight;
    return Math.max(0.05, h * (1 + record.heightJitter * c.crystalHeightJitter * g.randomness));
  }

  /** Base radius, metres. A spire is broader than a blade; a shard is squat. */
  _crystalRadius(record, c, g) {
    let r = c.crystalRadius;
    if (record.tier === Tier.SPIRE) r *= 1.3;
    else if (record.tier === Tier.SHARD) r *= 1.25;
    return Math.max(0.01, r * (1 + record.radiusJitter * c.crystalRadiusJitter * g.randomness));
  }

  /** Where the foot is planted, flat, written into `out`. */
  _crystalSeat(record, c, g, out) {
    this._centrePoint(out);
    let seat = 0;
    if (record.tier === Tier.BLADE) seat = this.radius * c.bladeSeat;
    else if (record.tier === Tier.SHARD) seat = this.radius * c.shardSeat;
    else seat = 0.08;
    seat *= 1 + record.seatJitter * c.crystalSeatJitter * g.randomness;
    out.x += Math.cos(record.angle) * seat;
    out.z += Math.sin(record.angle) * seat;
    return out;
  }

  /** Radians it leans away from the centre, and `_lean` set to that direction. */
  _crystalLean(record, c, g) {
    _lean.set(Math.cos(record.angle), 0, Math.sin(record.angle));
    let lean = c.bladeLean;
    if (record.tier === Tier.SPIRE) lean = 0.05;
    else if (record.tier === Tier.SHARD) lean = c.shardLean;
    return lean * (1 + record.leanJitter * c.crystalLeanJitter * g.randomness);
  }

  /**
   * How far out of the ground a crystal is, 0 → 1 by way of a single overshoot
   * past 1. Negative while it is still buried and waiting.
   */
  _emergence(record, c) {
    if (record.eruptTime < 0) return -1;
    const elapsed = this._time - record.eruptTime;
    if (elapsed < 0) return -1;

    const riseTime = Math.max(0.02, c.crystalTime);
    const peak = 1 + c.crystalOvershoot;
    if (elapsed <= riseTime) return Easing.outQuint(elapsed / riseTime) * peak;

    // Then it drops back onto its seat and stays there. Crystal does not
    // rebound; it lands once and the floor keeps it.
    const drop = saturate((elapsed - riseTime) / Math.max(0.05, c.crystalSettle));
    return peak - c.crystalOvershoot * Easing.inQuad(drop);
  }

  /**
   * Rebuild every instance matrix from the live settings.
   * @param {number} retract 0..1 — the whole cluster withdrawing into the floor.
   */
  _updateCrystals(retract) {
    const c = settings.shard;
    const g = settings.global;
    const count = this._crystalCount;
    const birthFade = Math.max(0.02, c.gemBirthFade);
    const used = [0, 0, 0];
    let shown = false;

    for (let i = 0; i < count; i++) {
      const record = this.records[i];
      const variant = i % VARIANTS;
      const slot = (i / VARIANTS) | 0;
      const emerge = this._emergence(record, c);

      if (emerge < 0) {
        _dummy.position.set(0, -999, 0);
        _dummy.quaternion.identity();
        _dummy.scale.setScalar(0.0001);
        _dummy.updateMatrix();
        this.crystalMeshes[variant].setMatrixAt(slot, _dummy.matrix);
        this.birthAttributes[variant].array[slot] = 0;
        used[variant] = Math.max(used[variant], slot + 1);
        continue;
      }

      shown = true;
      const height = this._crystalHeight(record, c, g);
      const radius = this._crystalRadius(record, c, g);
      const leanAngle = this._crystalLean(record, c, g);

      /* --- the spray thrown as it breaks the surface --- */
      if (!record.breached && emerge > 0.2) {
        record.breached = true;
        this._breachFx(record, c, g, radius, height);
      }

      // Rotating about (up × lean) tips the crystal's own +Y toward `lean`.
      _axis.crossVectors(_up, _lean);
      if (_axis.lengthSq() < 1e-8) _axis.set(1, 0, 0);
      _axis.normalize();
      _tilt.setFromAxisAngle(_axis, leanAngle);
      _spin.setFromAxisAngle(_up, record.yaw * c.crystalTwist);
      _tilt.multiply(_spin);

      /* --- slide it up out of the floor --- */
      const settled = Math.min(1, emerge);
      this._crystalSeat(record, c, g, _dummy.position);
      _dummy.position.y = (emerge - 1) * height * 0.85;
      if (retract > 0) {
        _dummy.position.y -= Easing.inCubic(retract) * (height + radius + 0.5);
      }

      _dummy.quaternion.copy(_tilt);
      // The unit crystal's base ring has a circumradius of 0.5, so the true
      // base radius is half the scale.
      _dummy.scale.set(radius * 2, height, radius * 2).multiplyScalar(lerp(0.84, 1, settled));
      _dummy.updateMatrix();

      this.crystalMeshes[variant].setMatrixAt(slot, _dummy.matrix);
      this.birthAttributes[variant].array[slot] = saturate(
        1 - (this._time - record.eruptTime) / birthFade
      );
      used[variant] = Math.max(used[variant], slot + 1);
    }

    for (let v = 0; v < VARIANTS; v++) {
      const mesh = this.crystalMeshes[v];
      // Nothing above the floor yet: no draw, rather than a rack of degenerate
      // matrices parked under it.
      mesh.count = shown ? used[v] : 0;
      mesh.visible = shown && used[v] > 0;
      mesh.instanceMatrix.needsUpdate = true;
      this.birthAttributes[v].needsUpdate = true;
    }
  }

  /** Where the tip of a crystal currently is. Good enough to spawn from. */
  _crystalTip(record, c, g, out) {
    const height = this._crystalHeight(record, c, g);
    this._crystalSeat(record, c, g, out);
    const leanAngle = this._crystalLean(record, c, g);
    out.y += Math.cos(leanAngle) * height;
    out.addScaledVector(_lean, Math.sin(leanAngle) * height);
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.mistEmitter.reset();
    this.beadEmitter.reset();
    this.glintEmitter.reset();

    this._time = 0;
    this._charge = 0;
    // Primed, so the first beam leaves the moment the flash is armed.
    this._fireTimer = Math.max(0, settings.shard.laserInterval);
    this._chargeTimer = 0;
    this._mark = null;
    this._targets.length = 0;
    this._ignited = false;
    this._shattered = false;
    this.beams.visible = false;
    this._pulsePhase = Math.random() * 40;
    this._pulse = 0;
    this._seed = Math.random() * 100;

    this._deal();
    for (const slot of this._beamSlots) this._retireBeam(slot);
    for (const slot of this._burning) slot.dummy = null;

    this._sync(1, 0);
    this._muzzleFx();
  }

  /* ------------------------------------------------------------------ */
  /* Per-frame sync                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the current cast state into every material and
   * particle system.
   *
   * @param {number} fade      1 while the spawn stands, ramping to 0 as it goes
   * @param {number} collapse  0..1 through the fade
   */
  _sync(fade, collapse) {
    const c = settings.shard;
    const g = settings.global;
    const travelling = this.phase === AbilityPhase.TRAVEL;

    this._centrePoint(_centre);
    const radius = this.radius;
    const t = travelling ? 0 : this._time;
    const pulse = this._pulse * saturate(fade);

    /* ---- layer 1: the rune ---- */
    const rune = this._runeState;
    rune.radius = radius;
    rune.quadSize = (radius + 1.2) * 2;
    rune.grown = travelling ? 0 : radius * Easing.outQuint(saturate(t / Math.max(0.01, c.runeTime)));
    rune.front = travelling ? 0 : 1 - saturate(t / Math.max(0.01, c.runeTime));
    rune.pulse = pulse;
    rune.charge = this._charge;
    rune.fade = travelling ? 0 : fade;
    rune.seed = this._seed;
    this.runeMaterial.userData.sync(rune);

    this.rune.visible = !travelling;
    this.rune.position.set(_centre.x, c.runeHeight, _centre.z);
    this.rune.scale.set(rune.quadSize, 1, rune.quadSize);

    /* ---- layer 5: the flare, before the crystals read it ---- */
    const lit = travelling ? 0 : this._flareLit();
    this._flarePoint(this._flareAt);
    const flare = this._flareState;
    flare.lit = lit * (1 + this._ignitePop()) * lerp(1, 0.15, Easing.inQuad(saturate(collapse)));
    flare.charge = this._charge;
    flare.pulse = pulse;
    flare.fade = fade;
    flare.seed = this._seed;
    this.flareMaterial.userData.sync(flare);
    this.flare.visible = !travelling && lit > 0.001 && fade > 0.001;
    this.flare.position.copy(this._flareAt);

    /* ---- layer 2: the crystals ---- */
    this._syncGeometry();
    this.crystalMaterial.userData.sync(this._flareAt, lit * fade, this._charge);
    const retract = collapse > 0 ? saturate(this.fadeTime / Math.max(0.05, c.crystalSinkTime)) : 0;
    this._updateCrystals(retract);

    /* ---- layer 3: the splash ---- */
    const splashEnd = c.splashRise + c.splashHold + c.splashFall;
    const splash = this._splashState;
    splash.radius = radius * c.splashRadius;
    splash.rise = travelling ? 0 : Easing.outQuint(saturate(t / Math.max(0.01, c.splashRise)));
    splash.fall = travelling
      ? 0
      : Easing.inQuad(saturate((t - c.splashRise - c.splashHold) / Math.max(0.01, c.splashFall)));
    splash.fade = fade;
    splash.seed = this._seed;
    this.splashMaterial.userData.sync(splash);
    this.splash.visible = !travelling && t < splashEnd && splash.rise > 0.001;
    this.splash.position.set(_centre.x, 0.02, _centre.z);

    /* ---- the beams ---- */
    this.beamMaterial.userData.sync();

    /* ---- layers 4 and 6: the particle systems ---- */
    this.mist.setGradient(
      getColor(c.colorMistA),
      getColor(c.colorMistB),
      getColor(c.colorMistC),
      getColor(c.colorMistD)
    );
    this.mist.uniforms.uGravity.value.set(0, c.mistRise, 0);
    this.mist.uniforms.uSizeScale.value = c.mistSize * g.particleSize;
    this.mist.uniforms.uLifeScale.value = c.mistLifetime * 0.5 * g.particleLifetime;
    this.mist.uniforms.uSpeedScale.value = c.mistSpeed * g.particleSpeed;
    this.mist.uniforms.uOpacity.value = c.mistOpacity * g.opacity;
    this.mist.uniforms.uTurbulence.value = c.mistTurbulence * 0.5 * g.turbulence;
    this.mist.uniforms.uSwirl.value = c.mistSwirl;
    this.mist.uniforms.uSwirlExpand.value = c.mistSwirlExpand;

    this.beads.setGradient(
      getColor(c.colorBeadA),
      getColor(c.colorBeadB),
      getColor(c.colorBeadC),
      getColor(c.colorBeadD)
    );
    this.beads.uniforms.uGravity.value.set(0, c.beadRise, 0);
    this.beads.uniforms.uSizeScale.value = c.beadSize * g.particleSize * 7;
    this.beads.uniforms.uLifeScale.value = c.beadLifetime * 0.5 * g.particleLifetime;
    this.beads.uniforms.uSpeedScale.value = g.particleSpeed;
    this.beads.uniforms.uOpacity.value = g.opacity;
    this.beads.uniforms.uSwirl.value = c.beadSwirl;
    this.beads.uniforms.uSwirlExpand.value = 0.35;

    this.glints.setGradient(
      getColor(c.colorGlintA),
      getColor(c.colorGlintB),
      getColor(c.colorGlintC),
      getColor(c.colorGlintD)
    );
    this.glints.uniforms.uGravity.value.set(0, c.beadRise * 0.6, 0);
    this.glints.uniforms.uSizeScale.value = c.glintSize * g.particleSize * 7;
    this.glints.uniforms.uLifeScale.value = c.glintLifetime * 0.5 * g.particleLifetime;
    this.glints.uniforms.uSpeedScale.value = g.particleSpeed;
    this.glints.uniforms.uOpacity.value = g.opacity;
    this.glints.uniforms.uGlow.value = 1.6 * g.glow;
    this.glints.uniforms.uTurbulence.value = 0.5 * g.turbulence;

    this.drops.setGradient(
      getColor(c.colorDropA),
      getColor(c.colorDropB),
      getColor(c.colorDropC),
      getColor(c.colorDropD)
    );
    this.drops.uniforms.uGravity.value.set(0, -9.0, 0);
    this.drops.uniforms.uSizeScale.value = c.splashDropSize * g.particleSize * 7;
    this.drops.uniforms.uLifeScale.value = c.splashDropLife * 0.5 * g.particleLifetime;
    this.drops.uniforms.uSpeedScale.value = g.particleSpeed;
    this.drops.uniforms.uOpacity.value = g.opacity;

    this.chips.setGradient(
      getColor(c.colorGemRim),
      getColor(c.colorGem),
      getColor(c.colorGemDeep),
      getColor(c.colorGemBase)
    );
    this.chips.uniforms.uGravity.value.set(0, -9.5, 0);
    this.chips.uniforms.uSizeScale.value = g.particleSize;
    this.chips.uniforms.uLifeScale.value = 0.6 * g.particleLifetime;
    this.chips.uniforms.uSpeedScale.value = g.particleSpeed;
    this.chips.uniforms.uOpacity.value = g.opacity;
  }

  /* ------------------------------------------------------------------ */
  /* The beams                                                           */
  /* ------------------------------------------------------------------ */

  /** Put a slot back in the rack. */
  _retireBeam(slot) {
    slot.age = 0;
    slot.pending = null;
    slot.state.set(0, slot.state.y, 1, 0);
  }

  /** The first slot not currently carrying a shot, or null. */
  _freeBeam() {
    for (const slot of this._beamSlots) {
      if (slot.state.w < 0.5) return slot;
    }
    return null;
  }

  /**
   * Choose, charge, fire.
   *
   * The flash *marks* a body, spends `laserWarmup` visibly gathering itself on
   * it — the flare swells, the veins in every crystal run hot, the hub of the
   * rune fills — and only then lets a beam go. A light that fires the instant
   * a target walks into range is a turret; one that takes a breath first is a
   * thing deciding.
   */
  _aim(dt, fade) {
    const c = settings.shard;

    if (!this._armed || fade < 0.5) {
      this._mark = null;
      this._chargeTimer = 0;
      this._charge = Math.max(0, this._charge - dt * 3.2);
      return;
    }

    this._fireTimer += dt;

    // Whoever it was aiming at may have been felled by the last shot.
    if (this._mark && !this._mark.alive) {
      this._mark = null;
      this._chargeTimer = 0;
    }

    if (!this._mark) {
      if (this._fireTimer < Math.max(0.02, c.laserInterval)) {
        this._charge = Math.max(0, this._charge - dt * 2.4);
        return;
      }
      this._centrePoint(_centre);
      const found = this.ctx.dummies?.findTargets?.(_centre.x, _centre.z, c.laserRange, this._targets);
      this._mark = found && found.length ? found[0] : null;
      this._chargeTimer = 0;
      if (!this._mark) {
        this._charge = Math.max(0, this._charge - dt * 2.4);
        return;
      }
    }

    this._chargeTimer += dt;
    const warmup = Math.max(0.01, c.laserWarmup);
    this._charge = saturate(this._chargeTimer / warmup);
    if (this._chargeTimer < warmup) return;

    /* ---- fire ---- */
    const volley = Math.max(1, Math.round(c.laserVolley));
    this._fireBeam(this._mark);
    if (volley > 1) {
      for (let i = 1; i < volley && i < this._targets.length; i++) {
        const other = this._targets[i];
        if (other !== this._mark && other.alive) this._fireBeam(other);
      }
    }

    this._mark = null;
    this._chargeTimer = 0;
    this._fireTimer = 0;
  }

  /** Send one beam at one body. */
  _fireBeam(dummy) {
    const c = settings.shard;
    const g = settings.global;
    const slot = this._freeBeam();
    if (!slot) return;

    slot.from.copy(this._flareAt);
    this._aimPoint(slot.to, dummy);

    const dx = slot.to.x - slot.from.x;
    const dz = slot.to.z - slot.from.z;
    const flat = Math.hypot(dx, dz);
    slot.dirX = flat > 1e-4 ? dx / flat : this.direction.x;
    slot.dirZ = flat > 1e-4 ? dz / flat : this.direction.z;

    slot.age = 0;
    slot.life = Math.max(0.05, c.laserLife);
    slot.pending = dummy;
    slot.state.set(0, Math.random() * 10, Math.max(0.01, c.laserWidth), 1);

    this._charge = 1;
    this.lightBoost = Math.max(this.lightBoost, c.lightIntensity * 0.4 * g.explosionIntensity);
    this.ctx.shake.add(c.laserShake * g.explosionIntensity * g.cameraShake, 4.0, 26);
    this.ctx.flash.trigger(getColor(c.colorFlash), c.laserFlash * g.explosionIntensity);

    this._muzzleGlints(slot.dirX, slot.dirZ);
  }

  /**
   * Advance every shot, and hit whatever each one is going through.
   *
   * The hit lands on the frame the beam's **head** reaches the body rather than
   * on the frame it was fired — forty milliseconds at the shipped numbers, and
   * the difference between a light that is doing something and a light that
   * is playing an animation.
   */
  _stepBeams(dt) {
    const c = settings.shard;
    let any = false;

    for (const slot of this._beamSlots) {
      if (slot.state.w < 0.5) continue;
      any = true;

      slot.age += dt;
      const life = saturate(slot.age / slot.life);
      slot.state.x = life;

      if (slot.pending && life >= c.beamStrike) {
        const dummy = slot.pending;
        slot.pending = null;
        if (dummy.alive && dummy.kill(slot.dirX, slot.dirZ, c.laserHit, false)) {
          this._impactFx(slot.to, slot.dirX, slot.dirZ, dummy);
          this._ignite(dummy);
        }
      }

      if (life >= 1) this._retireBeam(slot);
    }

    this.beams.visible = any;
  }

  /** Start burning a body the beam has gone through. */
  _ignite(dummy) {
    if (!settings.shard.burn.enabled) return;
    for (const slot of this._burning) {
      if (slot.dummy) continue;
      slot.dummy = dummy;
      slot.time = 0;
      slot.eaten = 0;
      return;
    }
  }

  /**
   * Burn out every body the light has gone through.
   *
   * The violet leads: the body is stained over `burn.stain` seconds while it is
   * still falling, and only after `burn.onset` does it start to go — so it
   * reads as lit from the inside first and eaten second, which is the order a
   * beam of light does things in.
   */
  _burn(dt) {
    const b = settings.shard.burn;
    for (const slot of this._burning) {
      const dummy = slot.dummy;
      if (!dummy) continue;
      if (dummy.state === 'gone' || dummy.alive) {
        slot.dummy = null;
        continue;
      }

      slot.time += dt;
      dummy.corrode(saturate(slot.time * Math.max(0, b.stain)), b.look);

      if (slot.time < b.onset) continue;
      slot.eaten = Math.min(1, slot.eaten + Math.max(0, b.rate) * dt);
      dummy.consume(slot.eaten);
      if (slot.eaten >= 1) slot.dummy = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /** Fill the scratch emit record with the defaults every batch shares. */
  _emitDefaults(time) {
    _emit.inherit = null;
    _emit.anchor = null;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    _emit.sizeVariance = 0.6;
    _emit.lifeVariance = 0.45;
    _emit.speedVariance = 0.7;
  }

  /** The flash at the caster's hand as the seed leaves it. */
  _muzzleFx() {
    const c = settings.shard;
    const g = settings.global;

    this._handPoint(_pos);

    this.ctx.bursts.spawn(BurstMode.AIR, _pos, {
      radius: c.muzzleSize * 0.25,
      endRadius: c.muzzleSize * g.explosionIntensity,
      life: 0.3,
      intensity: c.muzzleIntensity,
      opacity: 0.6,
      fresnel: 2.0,
      displace: 0.4,
      colorA: getColor(c.colorBurstA),
      colorB: getColor(c.colorBurstB),
      colorC: getColor(c.colorBurstC)
    });

    this._emitDefaults(frame.uTime.value);
    _emit.position = _pos;
    _emit.radius = 0.16;
    _emit.direction = _dir.copy(this.direction);
    _emit.speed = 3.2;
    _emit.spread = 0.6;
    _emit.size = 0.09;
    _emit.life = c.beadLifetime * 0.4;
    this.beads.emit(Math.round(c.seedBeads * g.particleCount), _emit);

    _emit.size = 0.08;
    _emit.life = c.glintLifetime * 0.5;
    this.glints.emit(Math.round(c.seedBeads * 0.6 * g.particleCount), _emit);

    this.ctx.flash.trigger(getColor(c.colorCastFlash), c.castFlash * g.explosionIntensity);
    this.lightBoost = c.lightIntensity * 0.4 * g.explosionIntensity;
  }

  /** The seed running across the floor: beads skipping off it. */
  _creepFx(dt) {
    const c = settings.shard;
    const g = settings.global;

    const count = Math.round(this.beadEmitter.tick(dt, c.creepRate) * g.particleCount);
    if (count <= 0) return;

    this._emitDefaults(frame.uTime.value);
    _emit.direction = _dir.copy(this.direction).multiplyScalar(0.3).setY(1).normalize();
    _emit.speed = 1.6;
    _emit.spread = 0.9;
    _emit.size = 0.07;
    _emit.life = c.beadLifetime * 0.35;

    let remaining = count;
    const per = Math.ceil(count / Math.min(count, BATCHES));
    while (remaining > 0) {
      this.pointAt(randRange(0.15, 1) * this.u, _pos).setY(0.08);
      _emit.position = _pos;
      _emit.radius = 0.22;
      const n = Math.min(per, remaining);
      this.beads.emit(n, _emit);
      this.glints.emit(Math.max(1, n >> 1), _emit);
      remaining -= per;
    }
  }

  /** The spray a crystal throws as it breaks the surface. */
  _breachFx(record, c, g, radius, height) {
    const time = frame.uTime.value;
    this._crystalSeat(record, c, g, _pos);
    _pos.y = 0.05;

    this._emitDefaults(time);
    _emit.position = _pos;
    _emit.radius = radius * 0.8;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = 2.8 + height * 0.6;
    _emit.spread = 0.8;
    _emit.size = 0.08;
    _emit.life = c.splashDropLife * 0.7;
    this.drops.emit(Math.round(14 * g.particleCount), _emit);

    _emit.size = 0.9;
    _emit.speed = 1.2;
    _emit.spread = 0.6;
    _emit.life = c.mistLifetime * 0.6;
    _emit.anchor = _centre;
    this.mist.emit(Math.round(4 * g.particleCount), _emit);
    _emit.anchor = null;

    _emit.size = 0.07;
    _emit.speed = 2.0;
    _emit.spread = 1.0;
    _emit.life = c.glintLifetime * 0.6;
    this.glints.emit(Math.round(8 * g.particleCount), _emit);
  }

  /** The glints thrown off the flash as a beam leaves it. */
  _muzzleGlints(dirX, dirZ) {
    const c = settings.shard;
    const g = settings.global;

    this._centrePoint(_centre);
    this._emitDefaults(frame.uTime.value);
    _emit.position = this._flareAt;
    _emit.radius = 0.2;
    _emit.direction = _dir.set(dirX, 0.35, dirZ).normalize();
    _emit.speed = 3.0;
    _emit.spread = 0.9;
    _emit.size = 0.08;
    _emit.life = c.glintLifetime * 0.6;
    this.glints.emit(Math.round(30 * g.particleCount), _emit);

    _emit.size = 0.08;
    _emit.speed = 2.0;
    _emit.life = c.beadLifetime * 0.5;
    _emit.anchor = _centre;
    this.beads.emit(Math.round(14 * g.particleCount), _emit);
  }

  /**
   * What comes out of a body the beam has just gone through.
   *
   * @param {THREE.Vector3} point where the beam landed
   * @param {number} dirX the shot's heading, flat — the spray follows it
   * @param {number} dirZ
   */
  _impactFx(point, dirX, dirZ, dummy) {
    const c = settings.shard;
    const g = settings.global;
    const time = frame.uTime.value;

    _pos.copy(point);
    // Out along the beam and a little upward.
    _dir.set(dirX, 0.45, dirZ).normalize();

    this._emitDefaults(time);
    _emit.position = _pos;
    _emit.radius = 0.2;
    _emit.direction = _dir;
    _emit.speed = 4.2;
    _emit.speedVariance = 0.85;
    _emit.spread = 0.8;
    _emit.size = 0.09;
    _emit.life = c.beadLifetime * 0.6;
    this.beads.emit(Math.round(c.impactBeads * g.particleCount), _emit);

    _emit.size = 0.08;
    _emit.speed = 5.0;
    _emit.life = c.glintLifetime * 0.7;
    this.glints.emit(Math.round(c.impactGlints * g.particleCount), _emit);

    _emit.size = 0.8;
    _emit.speed = 1.6;
    _emit.spread = 0.9;
    _emit.life = c.mistLifetime * 0.5;
    _emit.anchor = _pos;
    this.mist.emit(Math.round(8 * g.particleCount), _emit);
    _emit.anchor = null;

    // No shell over the wound: at any size the eye can measure it reads as a
    // bubble the body is standing in. The beads coming out of it are the hit.

    _pos.set(dummy.position.x, 0, dummy.position.z);
    this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
      radius: c.impactScorch,
      life: c.stainLife * 0.7,
      intensity: c.stainIntensity,
      colorA: getColor(c.colorScorch),
      colorB: getColor(c.colorScorchEdge),
      height: 0.02
    });
  }

  /**
   * Everything the standing spawn sheds: mist coiling up round the cluster,
   * beads drifting round it, glints among them.
   *
   * @param {number} scale 0..1 — thinned out as the spawn goes
   */
  _auraFx(dt, scale) {
    const c = settings.shard;
    const g = settings.global;
    const time = frame.uTime.value;

    this._centrePoint(_centre);
    const radius = this.radius;
    const surge = 1 + this._pulse * c.pulseDepth + this._charge * 0.6;
    const height = c.flareHeight;

    /* --- the mist --- */
    if (this._time >= c.mistDelay) {
      let mist = Math.round(this.mistEmitter.tick(dt, c.mistRate * scale * surge) * g.particleCount);
      if (mist > 0) {
        this._emitDefaults(time);
        _emit.anchor = _centre;
        _emit.speed = c.mistSpeed;
        _emit.spread = 0.5;
        _emit.size = 0.85;
        _emit.life = c.mistLifetime;
        _emit.spin = 0.3;

        const per = Math.ceil(mist / Math.min(mist, BATCHES));
        while (mist > 0) {
          const a = Math.random() * TAU;
          const r = radius * randRange(0.3, 0.7);
          _pos.set(_centre.x + Math.cos(a) * r, randRange(0.05, height * 0.6), _centre.z + Math.sin(a) * r);
          _emit.position = _pos;
          _emit.radius = 0.3;
          // Up, and leaning in toward the cluster: the tendrils climb *it*.
          _emit.direction = _dir.set(-Math.cos(a) * 0.4, 1, -Math.sin(a) * 0.4).normalize();
          this.mist.emit(Math.min(per, mist), _emit);
          mist -= per;
        }
      }
    }

    /* --- the beads --- */
    const beads = Math.round(this.beadEmitter.tick(dt, c.beadRate * scale * surge) * g.particleCount);
    if (beads > 0) {
      this._emitDefaults(time);
      const a = Math.random() * TAU;
      const r = radius * randRange(0.15, 0.6);
      _pos.set(_centre.x + Math.cos(a) * r, randRange(0.2, height * 1.5), _centre.z + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = 0.35;
      _emit.anchor = _centre;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = c.beadSpeed;
      _emit.spread = 1.0;
      _emit.size = 0.1;
      _emit.life = c.beadLifetime;
      this.beads.emit(beads, _emit);
    }

    /* --- the glints --- */
    const glints = Math.round(this.glintEmitter.tick(dt, c.glintRate * scale * surge) * g.particleCount);
    if (glints > 0) {
      this._emitDefaults(time);
      const a = Math.random() * TAU;
      const r = radius * randRange(0.1, 0.55);
      _pos.set(_centre.x + Math.cos(a) * r, randRange(0.3, height * 1.6), _centre.z + Math.sin(a) * r);
      _emit.position = _pos;
      _emit.radius = 0.4;
      _emit.direction = _dir.set(0, 1, 0);
      _emit.speed = 0.4;
      _emit.spread = 1.0;
      _emit.size = 0.07;
      _emit.life = c.glintLifetime;
      this.glints.emit(glints, _emit);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    this._sync(1, 0);

    // The light rides the seed, just off the floor.
    this._frontPoint(this.position);
    this.position.y += 0.35;

    this._creepFx(dt);
    this.ctx.shake.rumble(settings.shard.rumble * settings.global.cameraShake, dt);
  }

  onImpact() {
    const c = settings.shard;
    const g = settings.global;
    const time = frame.uTime.value;

    this._time = 0;
    const centre = this._centrePoint(_centre);

    /* every crystal is told when to leave */
    for (let i = 0; i < MAX_CRYSTALS; i++) {
      const record = this.records[i];
      record.eruptTime = c.crystalDelay + record.stagger * c.crystalStagger;
    }

    // No shell. The sheet has no dome on it, and a pressure sphere at any
    // opacity draws its own rim; the landing is the crown, the ring on the
    // floor, the gout of mist and the rune racing out — all of them below.

    /* the ring of water running out across the floor */
    this.ctx.decals.spawn(DecalType.RIPPLE, centre, {
      radius: this.radius * c.splashRipple * g.explosionIntensity,
      life: 1.0,
      width: 0.07,
      intensity: 0.4,
      colorA: getColor(c.colorWater),
      colorB: getColor(c.colorWaterRim)
    });

    /* the mark the spawn stands on, and leaves behind */
    this.ctx.decals.spawn(DecalType.SCORCH, centre, {
      radius: this.radius * 0.9,
      life: c.stainLife,
      intensity: c.stainIntensity,
      colorA: getColor(c.colorScorch),
      colorB: getColor(c.colorScorchEdge),
      height: 0.012
    });

    /* the water flung off the crown, radially */
    const drops = Math.round(c.splashDrops * g.particleCount);
    if (drops > 0) {
      this._emitDefaults(time);
      _emit.size = 0.1;
      _emit.life = c.splashDropLife;
      _emit.speedVariance = 0.6;
      const crown = this.radius * c.splashRadius;
      const per = Math.ceil(drops / 8);
      let remaining = drops;
      while (remaining > 0) {
        const a = Math.random() * TAU;
        _pos.set(centre.x + Math.cos(a) * crown, 0.15, centre.z + Math.sin(a) * crown);
        _emit.position = _pos;
        _emit.radius = 0.2;
        _emit.direction = _dir.set(Math.cos(a) * 0.55, 1, Math.sin(a) * 0.55).normalize();
        _emit.speed = c.splashDropSpeed;
        _emit.spread = 0.35;
        this.drops.emit(Math.min(per, remaining), _emit);
        remaining -= per;
      }
    }

    /* the gout of mist as the floor gives */
    this._emitDefaults(time);
    _emit.position = centre;
    _emit.radius = this.radius * 0.5;
    _emit.anchor = centre;
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = c.mistSpeed * 2.6;
    _emit.spread = 0.9;
    _emit.size = 1.2;
    _emit.life = c.mistLifetime * 0.9;
    _emit.spin = 0.35;
    this.mist.emit(Math.round(c.mistBurst * g.particleCount), _emit);

    this.ctx.shake.add(
      c.igniteShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      18
    );
    this.lightBoost = c.lightIntensity * 0.9 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.shard;
    const g = settings.global;
    const previous = this._time;
    this._time += dt;

    // `t` runs 0..1 while the spawn stands, then 1..2 while it goes.
    const collapse = t <= 1 ? 0 : saturate(t - 1);
    const fade = 1 - Easing.inQuad(collapse);

    /* ---- the pulse, before anything reads it ---- */
    this._pulsePhase += dt * Math.max(0, c.pulseRate);
    this._pulse = pulseEnvelope(this._pulsePhase) * (1 - collapse * 0.6);

    /* ---- the one-shot as the flash ignites ---- */
    if (!this._ignited && previous < c.flareDelay && this._time >= c.flareDelay && dt > 0) {
      this._ignited = true;
      this._igniteFx();
    }

    this._aim(dt, fade);
    this._stepBeams(dt);
    this._burn(dt);
    this._sync(fade, collapse);

    // The light sits in the flash once there is one, and low in the rune before.
    this._centrePoint(this.position);
    this.position.y = lerp(0.4, c.flareHeight, saturate(c.lightHeight) * this._flareLit());

    this._auraFx(dt, fade * (t <= 1 ? 1 : 0.3));
    this.ctx.shake.rumble(c.holdShake * fade * g.cameraShake, dt);

    // The cluster comes apart as it goes, once and heavily rather than as a
    // trickle: a spawn that dissolves quietly leaves the eye with nothing.
    if (collapse > 0 && !this._shattered && dt > 0) {
      this._shattered = true;
      this._shatterFx();
    }
  }

  /** What the flash throws as it lights. */
  _igniteFx() {
    const c = settings.shard;
    const g = settings.global;
    const time = frame.uTime.value;

    this._flarePoint(_pos);

    // No shell here either: the ignition is the star itself popping to two
    // and a half times its brightness, the screen flash, and the cloud of
    // beads thrown out of it. A sphere around a lens flare is a soap bubble.
    this._centrePoint(_centre);
    this._emitDefaults(time);
    _emit.position = _pos;
    _emit.radius = 0.5;
    _emit.anchor = _centre;
    // A sphere, slow: they are thrown *out* of the light and hang there, as
    // the sheet scatters them, rather than fountaining off it.
    _emit.direction = _dir.set(0, 0.15, 0).normalize();
    _emit.speed = c.beadSpeed * 2.2;
    _emit.spread = 1.0;
    _emit.size = 0.1;
    _emit.life = c.beadLifetime * 1.2;
    this.beads.emit(Math.round(c.beadBurst * g.particleCount), _emit);

    _emit.anchor = null;
    _emit.size = 0.09;
    _emit.speed = 3.0;
    _emit.life = c.glintLifetime;
    this.glints.emit(Math.round(c.beadBurst * 0.5 * g.particleCount), _emit);

    this.ctx.shake.add(0.2 * g.explosionIntensity * g.cameraShake, 2.6, 22);
    this.ctx.flash.trigger(getColor(c.colorFlash), c.igniteFlash * g.explosionIntensity);
    this.lightBoost = Math.max(this.lightBoost, c.lightIntensity * 1.1 * g.explosionIntensity);
  }

  /** The cluster shedding itself as it goes. */
  _shatterFx() {
    const c = settings.shard;
    const g = settings.global;
    const time = frame.uTime.value;
    const count = this._crystalCount;
    const chips = Math.round(c.shatterChips * g.particleCount);
    if (chips <= 0) return;

    this._emitDefaults(time);
    _emit.direction = _dir.set(0, 1, 0);
    _emit.speed = 3.2;
    _emit.spread = 0.9;
    _emit.size = 0.12;
    _emit.sizeVariance = 0.7;
    _emit.life = 1.1;
    _emit.spin = 6.0;

    const per = Math.max(1, Math.round(chips / count));
    for (let i = 0; i < count; i++) {
      const record = this.records[i];
      if (record.eruptTime < 0) continue;
      this._crystalTip(record, c, g, _pos);
      _pos.y *= randRange(0.3, 0.9);
      _emit.position = _pos;
      _emit.radius = 0.25;
      this.chips.emit(per, _emit);
      this.glints.emit(Math.max(1, per >> 2), _emit);
    }
  }

  onDestroy() {
    for (const slot of this._beamSlots) this._retireBeam(slot);
    for (const slot of this._burning) slot.dummy = null;
    this._mark = null;
    this._targets.length = 0;

    this.rune.visible = false;
    this.splash.visible = false;
    this.flare.visible = false;
    this.beams.visible = false;
    for (const mesh of this.crystalMeshes) {
      mesh.count = 0;
      mesh.visible = false;
    }
    this.runeMaterial.uniforms.uFade.value = 0;
    this.flareMaterial.uniforms.uLit.value = 0;
    this.splashMaterial.uniforms.uRise.value = 0;
  }

  dispose() {
    this.runeGeometry.dispose();
    for (const mesh of this.crystalMeshes) mesh.geometry.dispose();
    this.splashGeometry.dispose();
    this.flareGeometry.dispose();
    this.beamGeometry.dispose();

    this.runeMaterial.dispose();
    this.crystalMaterial.dispose();
    this.splashMaterial.dispose();
    this.flareMaterial.dispose();
    this.beamMaterial.dispose();

    super.dispose();
  }
}
