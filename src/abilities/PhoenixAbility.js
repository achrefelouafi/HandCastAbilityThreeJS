import { Group, MathUtils, Mesh, PlaneGeometry, SkinnedMesh, Vector3 } from 'three';
import { Ability } from './Ability.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import { instancePhoenix } from '../assets/PhoenixRig.js';
import {
  PHOENIX_FIREBALL_NODES,
  PHOENIX_MAX_FIREBALLS,
  createFireballGeometry,
  createFireballHistory,
  createFireballMaterial,
  fireballHull,
  createPhoenixAuraMaterial,
  createPhoenixBodyMaterial,
  createPhoenixGroundMaterial,
  createSerpentGeometry,
  createSerpentMaterial,
  createSkirtGeometry,
  createSkirtMaterial
} from '../materials/PhoenixMaterials.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { Easing, damp, saturate } from '../utils/math.js';

/** Where the bird is in its life, once the seed has landed. */
export const PhoenixState = Object.freeze({
  RISE: 'rise',
  HUNT: 'hunt',
  SWOOP: 'swoop',
  BURNOUT: 'burnout'
});

const TAU = Math.PI * 2;
/** Above the floor, where the reveal plane sits while the bird climbs through it. */
const FLOOR = 0.04;
/** Where the reveal plane goes once the bird is clear of the floor: far under it. */
const REVEALED = -1e3;
/**
 * Raw flight samples kept per round, one per frame. The wake is resampled out
 * of these by arc length; at 60 fps a 3 m wake behind a 19 m/s round is ten
 * of them, and slow motion stretches that to thirty.
 */
const RAW_SAMPLES = 64;

const _centre = new Vector3();
const _muzzle = new Vector3();
const _aim = new Vector3();
const _dir = new Vector3();
const _pos = new Vector3();
const _vel = new Vector3();
const _up = new Vector3(0, 1, 0);
const _emit = {
  position: new Vector3(),
  direction: new Vector3(),
  inherit: null,
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

/** Signed shortest turn from `from` to `to`, radians. */
const turnTo = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));

/**
 * THE SERPENT TIDE FIELD — a phoenix, summoned onto a point, that hunts.
 *
 * A far cast. The seed flies out as an ember and where it lands the ground
 * splits, a pyre erupts, and the bird climbs out of it: wings spread, body a
 * fresnel of fire, flames licking off its silhouette. It hovers over the field
 * for `lifetime` seconds and works through whoever is standing in range **one
 * at a time** — the nearest first — and it has two answers for them:
 *
 *   - **the volley.** A body out past `kickRange` gets turned onto, and the
 *     beak spits a quick burst of fireballs at it. Each is a homing comet with
 *     a torn tail, and the first to arrive kicks the body off its feet along
 *     the shot.
 *   - **the kick.** A body close in gets the talons: the bird dives off its
 *     hover, stamps the target and climbs back, and the body leaves along the
 *     dive with a gout of fire under it.
 *
 * Around it, the sheet's layers: serpents of fire winding round the pyre
 * on S-curves (placed entirely in a vertex shader — the CPU only samples the
 * same curve to throw embers off their heads), a skirt of wispy flame torn into
 * tongues, the scorched and cracked crust lit from underneath, and embers
 * everywhere. When the field burns out the bird flares and
 * goes to embers from its coolest feathers first.
 *
 * It answers `handlesOwnHits` because it has to be the thing that says which
 * body, and when — the field's disc reading of a far cast would fell everyone
 * in it on the frame the seed landed.
 *
 * Nothing about the model is known here: `PhoenixRig` hands over a normalised
 * bird, its flap cycle and the names of the beak and the feet, and that is the
 * whole contract.
 */
export class PhoenixAbility extends Ability {
  constructor(context) {
    super('phoenix', context);
  }

  get handlesOwnHits() {
    return true;
  }

  /** Followed hard once it is up: the hunt is the show. */
  get cameraWeight() {
    return this.u < 1 ? saturate(1 - this.u * 0.4) : 0.85;
  }

  get impactDuration() {
    return Math.max(0.05, settings.phoenix.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.phoenix.fadeTime);
  }

  get instanceCount() {
    let n = 0;
    for (const ball of this._fireballs) if (ball.live) n++;
    return n;
  }

  /** The editor's wingspan over the span the rig was normalised to. Live. */
  get scaleK() {
    return this.rig ? this.config.wingspan / Math.max(0.01, this.rig.wingspan) : 1;
  }

  /* ------------------------------------------------------------------ */
  /* construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const rig = this.ctx.models?.phoenix ?? null;
    this.rig = rig;

    // root: where it is and which way it faces. tilt: the bank and the dive.
    // frame: the bird itself, in rig metres.
    this.root = new Group();
    this.root.name = 'PhoenixRoot';
    this.tilt = new Group();
    this.tilt.name = 'PhoenixTilt';
    this.frame = new Group();
    this.frame.name = 'PhoenixFrame';
    this.root.add(this.tilt);
    this.tilt.add(this.frame);
    this.group.add(this.root);

    this.bird = null;
    /** Every material on the bird, so the reveal and the burn drive all of them. */
    this.birdMaterials = [];
    this.bodyMaterials = [];
    this.auraMaterials = [];

    if (rig) {
      const bird = instancePhoenix(rig);
      this.bird = bird;
      for (const mesh of bird.meshes) {
        const source = mesh.material;
        const map = source?.map ?? null;
        const emissive = source?.emissiveMap ?? null;

        const body = createPhoenixBodyMaterial(map, emissive);
        mesh.material = body;
        mesh.layers.set(LAYER.WORLD);
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.frustumCulled = false;
        this.bodyMaterials.push(body);
        this.birdMaterials.push(body);

        // The fire shells: the same geometry on the same skeleton, stood off
        // the body, so every tongue rides the wing it leaves.
        for (let i = 0; i < 2; i++) {
          const aura = createPhoenixAuraMaterial(map, emissive);
          aura.userData.shell = i;
          const shell = new SkinnedMesh(mesh.geometry, aura);
          shell.bind(mesh.skeleton, mesh.bindMatrix);
          shell.bindMode = mesh.bindMode;
          shell.layers.set(LAYER.VFX);
          shell.renderOrder = 11 + i;
          shell.frustumCulled = false;
          shell.castShadow = false;
          shell.receiveShadow = false;
          mesh.add(shell);
          this.auraMaterials.push(aura);
          this.birdMaterials.push(aura);
        }
      }
      this.frame.add(bird.root);
    }

    /* ---- the ground ---- */
    const flat = new PlaneGeometry(1, 1);
    flat.rotateX(-Math.PI / 2);
    this.groundMaterial = createPhoenixGroundMaterial();
    this.ground = new Mesh(flat, this.groundMaterial);
    this.ground.layers.set(LAYER.VFX);
    this.ground.renderOrder = 5;
    this.ground.frustumCulled = false;
    this.group.add(this.ground);

    /* ---- the wispy flame waves ---- */
    this.skirtMaterial = createSkirtMaterial();
    this.skirt = new Mesh(createSkirtGeometry(), this.skirtMaterial);
    this.skirt.layers.set(LAYER.VFX);
    this.skirt.renderOrder = 9;
    this.skirt.frustumCulled = false;
    this.group.add(this.skirt);

    /* ---- the serpentine fire trails ---- */
    this.serpentMaterial = createSerpentMaterial();
    this.serpents = new Mesh(createSerpentGeometry(160), this.serpentMaterial);
    this.serpents.layers.set(LAYER.VFX);
    this.serpents.renderOrder = 10;
    this.serpents.frustumCulled = false;
    this.group.add(this.serpents);

    /* ---- the fireballs ---- */
    // The wake of every round is resampled into the history texture each frame.
    this.fireballHistory = createFireballHistory(PHOENIX_MAX_FIREBALLS);
    const hull = createFireballGeometry(PHOENIX_MAX_FIREBALLS);
    this.fireballMaterial = createFireballMaterial();
    this.fireballMaterial.uniforms.uHistory.value = this.fireballHistory;
    this.fireballMesh = new Mesh(hull, this.fireballMaterial);
    this.fireballMesh.layers.set(LAYER.VFX);
    // After the smoke (10), before the aura shells (11) and the additive
    // particles (12): the soot in the volume must not dim an ember that is in
    // front of it.
    this.fireballMesh.renderOrder = 10.5;
    this.fireballMesh.frustumCulled = false;
    this.fireballMesh.matrixAutoUpdate = false;
    this.group.add(this.fireballMesh);

    this._fireballs = [];
    for (let i = 0; i < PHOENIX_MAX_FIREBALLS; i++) {
      this._fireballs.push({
        live: false,
        pos: new Vector3(),
        vel: new Vector3(),
        aim: new Vector3(),
        age: 0,
        life: 1,
        size: 0.4,
        seed: Math.random(),
        dummy: null,
        /** Where it has been: x, y, z, metres flown — a ring, newest at rawHead. */
        raw: new Float32Array(RAW_SAMPLES * 4),
        rawHead: 0,
        rawCount: 0,
        /** The wake's length this frame, metres: never more than it has flown. */
        wake: 0
      });
    }

    /* ---- state ---- */
    this.state = PhoenixState.RISE;
    this.fieldAge = 0;
    this.burn = 0;
    this.centre = new Vector3();
    this.pos = new Vector3();
    this.hover = new Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    this.reveal = 0;
    this.spin = 0;
    this.seedHeight = 0;

    this.mark = null;
    this.aimPoint = new Vector3();
    this.lock = 0;
    this.retargetTimer = 0;
    this.volley = null;
    this.swoopT = 0;
    this.swoopFrom = new Vector3();
    this.swoopTo = new Vector3();
    this.kicked = false;
    this.flare = 0;

    this.fieldLight = null;
    this.hitLight = null;
    this.hitPoint = new Vector3();
    this.hitHeat = 0;

    /** Reused by `DummyField#findTargets`, so polling allocates nothing. */
    this._targets = [];
    this.targetsInRange = 0;

    this._seedTrail = new RateEmitter(120);
    this._embers = new RateEmitter(90);
    this._bodyEmbers = new RateEmitter(40);
    this._serpentEmbers = new RateEmitter(30);
    this._smoke = new RateEmitter(10);
    this._trail = new RateEmitter(60);
  }

  createParticles() {
    const P = this.ctx.particles;
    this.embers = P.get('phoenixEmber', {
      capacity: 1500,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.3
    });
    this.sparks = P.get('phoenixSpark', {
      capacity: 800,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.1
    });
    this.flashes = P.get('phoenixFlash', { capacity: 64, shape: ParticleShape.GLINT, additive: true });
    this.smoke = P.get('phoenixSmoke', {
      capacity: 300,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 0.6
    });
    this.trail = P.get('phoenixTrail', {
      capacity: 600,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      softFade: 0.15
    });
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = this.config;

    this.state = PhoenixState.RISE;
    this.fieldAge = 0;
    this.burn = 0;
    this.reveal = 0;
    this.spin = Math.random() * TAU;
    this.pointAt(1, this.centre);
    this.hover.set(this.centre.x, c.altitude, this.centre.z);
    this.pos.set(this.centre.x, c.riseFrom, this.centre.z);
    this.yaw = Math.atan2(this.direction.x, this.direction.z);
    this.pitch = 0;
    this.roll = 0;
    this.mark = null;
    this.lock = 0;
    this.retargetTimer = 0;
    this.volley = null;
    this.swoopT = 0;
    this.kicked = false;
    this.flare = 0;
    this.targetsInRange = 0;
    this.hitHeat = 0;
    for (const ball of this._fireballs) ball.live = false;
    this._seedTrail.reset();
    this._embers.reset();
    this._bodyEmbers.reset();
    this._serpentEmbers.reset();
    this._smoke.reset();
    this._trail.reset();

    this.fieldLight = this.ctx.lights.acquire();
    this.hitLight = this.ctx.lights.acquire();

    // The seed's flight: an ember lobbed at the point.
    this.seedHeight = 0;
    this.position.copy(this.origin);
    this.position.y = c.seedHeight;

    // Nothing on the floor yet; the bird is under it.
    this.root.visible = false;
    this.ground.visible = false;
    this.skirt.visible = false;
    this.serpents.visible = false;
    this.fireballMesh.visible = false;

    if (this.bird?.action) {
      this.bird.action.reset().play();
      this.bird.mixer.setTime(Math.random() * 3);
    }
    this._placeBird();
    this._syncFireballs();
  }

  onDestroy() {
    this.ctx.lights.release(this.fieldLight);
    this.ctx.lights.release(this.hitLight);
    this.fieldLight = null;
    this.hitLight = null;
    this.mark = null;
    this.volley = null;
    for (const ball of this._fireballs) ball.live = false;
    this._syncFireballs();
    this.root.visible = false;
  }

  /* ------------------------------------------------------------------ */
  /* the seed                                                            */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = this.config;
    const g = settings.global;
    const time = frame.uTime.value;

    // A lob: up out of the caster's hand and down onto the point.
    const arc = Math.sin(this.u * Math.PI);
    this.position.y = c.seedHeight * (1 - this.u) + arc * c.seedArc;

    // The seed is a comet: the first fireball slot, flown by hand. Its heading
    // is the lob's tangent, so the tail trails the arc rather than the line.
    const seed = this._fireballs[0];
    const speed = c.speed * g.speed;
    const climb = (Math.cos(this.u * Math.PI) * Math.PI * c.seedArc - c.seedHeight) * (speed / Math.max(0.1, this.length));
    if (!seed.live) this._ignite(seed);
    seed.live = true;
    seed.pos.copy(this.position);
    seed.vel.copy(this.direction).multiplyScalar(speed).setY(climb);
    seed.aim.copy(this.centre);
    seed.age = this.age;
    seed.life = 1;
    seed.size = c.seedSize;
    seed.dummy = null;
    this.fireballMesh.visible = true;
    this._syncFireballs();

    const n = this._seedTrail.tick(dt, c.seedTrail * g.particleCount);
    for (let i = 0; i < n; i++) {
      _emit.position.copy(this.position);
      _emit.direction.copy(this.direction).negate();
      _emit.radius = 0.08;
      _emit.speed = 1.2;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.5;
      _emit.size = 0.12;
      _emit.sizeVariance = 0.5;
      _emit.life = 0.5;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.embers.emit(1, _emit);
    }
    this._dress(c);
  }

  /* ------------------------------------------------------------------ */
  /* the eruption                                                        */
  /* ------------------------------------------------------------------ */

  onImpact() {
    const c = this.config;
    const g = settings.global;
    const time = frame.uTime.value;
    const R = c.zoneRadius;

    this.pointAt(1, this.centre);
    this.hover.set(this.centre.x, c.altitude, this.centre.z);
    this.pos.set(this.centre.x, c.riseFrom, this.centre.z);
    this.position.copy(this.centre);
    this.fieldAge = 0;
    this.state = PhoenixState.RISE;
    // The seed has landed; the slot goes back to the volley.
    this._fireballs[0].live = false;

    this.root.visible = !!this.bird;
    this.ground.visible = true;
    this.skirt.visible = true;
    this.serpents.visible = true;
    this.fireballMesh.visible = true;

    /* the pyre erupts */
    _pos.set(this.centre.x, 0.3, this.centre.z);
    this.ctx.bursts.spawn(BurstMode.FIRE, _pos, {
      radius: 0.5,
      endRadius: R * 0.9,
      life: 0.75,
      intensity: 1.6 * g.explosionIntensity,
      opacity: 0.9,
      displace: 0.5,
      squash: 0.6,
      colorA: getColor(c.colorCore),
      colorB: getColor(c.colorMid),
      colorC: getColor(c.colorEdge)
    });
    this.ctx.decals.spawn(DecalType.SHOCKWAVE, this.centre, {
      radius: R * 1.4,
      life: 0.7,
      intensity: 0.7,
      width: 0.06,
      colorA: getColor(c.colorMid),
      colorB: getColor(c.colorEdge)
    });
    this.ctx.decals.spawn(DecalType.DUSTRING, this.centre, {
      radius: R * 1.1,
      life: 1.8,
      intensity: 0.6,
      growth: 0.5,
      colorA: getColor('#5a4034'),
      colorB: getColor('#2a1d16')
    });

    /* embers thrown up out of the ground */
    const embers = Math.round(c.eruptionEmbers * g.particleCount);
    for (let i = 0; i < embers; i++) {
      const a = Math.random() * TAU;
      const r = Math.sqrt(Math.random()) * R * 0.6;
      _emit.position.set(this.centre.x + Math.cos(a) * r, 0.1, this.centre.z + Math.sin(a) * r);
      _emit.direction.set(Math.cos(a) * 0.5, 1.4, Math.sin(a) * 0.5).normalize();
      _emit.radius = 0.1;
      _emit.speed = 5.5;
      _emit.speedVariance = 0.6;
      _emit.spread = 0.5;
      _emit.size = c.emberSize * 1.4;
      _emit.sizeVariance = 0.6;
      _emit.life = c.emberLife;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.embers.emit(1, _emit);
    }
    const sparks = Math.round(c.eruptionEmbers * 0.6 * g.particleCount);
    for (let i = 0; i < sparks; i++) {
      const a = Math.random() * TAU;
      _emit.position.set(this.centre.x, 0.2, this.centre.z);
      _emit.direction.set(Math.cos(a), 1.6, Math.sin(a)).normalize();
      _emit.radius = 0.2;
      _emit.speed = 9;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.35;
      _emit.size = 0.06;
      _emit.sizeVariance = 0.5;
      _emit.life = 0.9;
      _emit.lifeVariance = 0.5;
      _emit.time = time;
      this.sparks.emit(1, _emit);
    }
    _emit.position.set(this.centre.x, 0.6, this.centre.z);
    _emit.speed = 0;
    _emit.size = 3.0;
    _emit.life = 0.16;
    _emit.spin = 2;
    this.flashes.emit(1, _emit);

    this.lightBoost = c.eruptionLight * g.explosionIntensity;
    this.ctx.shake.add(c.eruptionShake * g.explosionIntensity * g.cameraShake, 2.4, 20);
    if (c.eruptionFlash > 0) this.ctx.flash.trigger(getColor(c.colorMid), c.eruptionFlash * g.explosionIntensity);

    this._placeBird();
  }

  /* ------------------------------------------------------------------ */
  /* the field                                                           */
  /* ------------------------------------------------------------------ */

  /** @param {number} t 0..1 hunting, 1..2 burning out */
  onFade(dt, t) {
    const c = this.config;
    this.fieldAge += dt;
    this.burn = t > 1 ? saturate(t - 1) : 0;

    if (t >= 1 && this.state !== PhoenixState.BURNOUT) this._burnOut();

    switch (this.state) {
      case PhoenixState.RISE:
        this._rise(dt, c);
        break;
      case PhoenixState.HUNT:
        this._hunt(dt, c);
        break;
      case PhoenixState.SWOOP:
        this._swoop(dt, c);
        break;
      case PhoenixState.BURNOUT:
        this._burning(dt, c);
        break;
      default:
        break;
    }

    // The body is placed before the volley reads the beak off it, so a round
    // leaves from where the beak is this frame.
    this._animateBird(dt, c);
    if (this.state === PhoenixState.HUNT) this._volleyFrame(dt, c);
    this._flyFireballs(dt, c);
    this._dress(c);
    this._emitters(dt, c);
    this._fieldLights(dt, c);
  }

  /** Out of the pyre and up to station. */
  _rise(dt, c) {
    const t = saturate(this.fieldAge / Math.max(0.05, c.riseTime));
    this.reveal = t;
    this.pos.y = MathUtils.lerp(c.riseFrom, c.altitude, Easing.outCubic(t));
    this.pos.x = this.centre.x;
    this.pos.z = this.centre.z;
    if (t >= 1) {
      this.state = PhoenixState.HUNT;
      this.reveal = 1;
      this.retargetTimer = c.retarget;
    }
  }

  /** Hold station and pick. */
  _hunt(dt, c) {
    // Ease back onto the hover point after a swoop.
    this.pos.x = damp(this.pos.x, this.hover.x, 0.02, dt);
    this.pos.y = damp(this.pos.y, this.hover.y, 0.02, dt);
    this.pos.z = damp(this.pos.z, this.hover.z, 0.02, dt);

    const dummies = this.ctx.dummies;
    const found =
      dummies?.findTargets?.(this.centre.x, this.centre.z, c.fireRange, this._targets) ?? this._targets;
    this.targetsInRange = found.length;

    // Whoever it was on may have gone down to someone else, or burned away.
    if (this.mark && !this.mark.alive) {
      this.mark = null;
      this.volley = null;
      this.lock = 0;
    }

    if (!this.mark) {
      this.lock = Math.max(0, this.lock - dt * 4);
      this.retargetTimer += dt;
      if (this.retargetTimer < c.retarget) return;
      // Nearest first — the field sorts — and only one at a time, which is
      // what makes it read as *choosing*.
      this.mark = found.length ? found[0] : null;
      this.lock = 0;
      if (!this.mark) return;

      // Close in, it does not bother spitting: it goes for the talons.
      const dx = this.mark.position.x - this.centre.x;
      const dz = this.mark.position.z - this.centre.z;
      if (Math.hypot(dx, dz) <= c.kickRange) {
        this._beginSwoop(c);
        return;
      }
    }

    this._aimAt(this.aimPoint, this.mark, c);

    // The lock builds only while the beak is on it, and drains when it slips.
    const target = Math.atan2(this.aimPoint.x - this.pos.x, this.aimPoint.z - this.pos.z);
    const error = Math.abs(turnTo(this.yaw, target));
    if (error < c.lockCone) this.lock = Math.min(1, this.lock + dt / Math.max(0.02, c.aimTime));
    else this.lock = Math.max(0, this.lock - dt * 2);
  }

  /** The beak has to be on the body before a round leaves it. */
  _volleyFrame(dt, c) {
    if (!this.mark || this.lock < 1) return;

    if (!this.volley) this.volley = { fired: 0, timer: 0 };
    const volley = this.volley;
    volley.timer += dt;
    const rounds = Math.max(1, Math.round(c.volleyRounds));
    const interval = Math.max(0.02, c.volleyInterval);
    while (volley.fired < rounds && volley.timer >= volley.fired * interval) {
      this._spit(this.mark, c);
      volley.fired += 1;
    }

    if (volley.fired >= rounds && volley.timer >= rounds * interval) {
      // Done with this one. The kill lands on its own when the round does.
      this.volley = null;
      this.mark = null;
      this.lock = 0;
      this.retargetTimer = 0;
    }
  }

  /** Where the shot is aimed: partway up the body, at the chest. */
  _aimAt(out, dummy, c) {
    return out.set(dummy.position.x, settings.dummies.height * saturate(c.aimHeight), dummy.position.z);
  }

  /* ---- the kick ---- */

  _beginSwoop(c) {
    this.state = PhoenixState.SWOOP;
    this.swoopT = 0;
    this.kicked = false;
    this.swoopFrom.copy(this.pos);
    this._aimAt(this.aimPoint, this.mark, c);
    // The talons land on the chest, from the bird's own side of the body.
    _dir.set(this.aimPoint.x - this.pos.x, 0, this.aimPoint.z - this.pos.z);
    const d = _dir.length();
    if (d > 1e-3) _dir.multiplyScalar(1 / d);
    else _dir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.swoopTo.copy(this.aimPoint).addScaledVector(_dir, -0.35);
    this.swoopTo.y = Math.max(0.5, this.aimPoint.y + c.kickHeight);
  }

  /** Dive, stamp, climb. */
  _swoop(dt, c) {
    this.swoopT += dt / Math.max(0.1, c.kickTime);
    const t = Math.min(1, this.swoopT);
    // Down fast, a beat on the body, and a slower climb out.
    const w = Math.sin(Math.PI * Math.pow(t, 0.85));
    this.pos.lerpVectors(this.swoopFrom, this.swoopTo, w);

    if (this.mark && !this.mark.alive && !this.kicked) {
      // Someone else got there first. Pull out.
      this.kicked = true;
    }

    if (!this.kicked && t >= 0.5) {
      this.kicked = true;
      this._kick(c);
    }

    if (t >= 1) {
      this.state = PhoenixState.HUNT;
      this.mark = null;
      this.lock = 0;
      this.retargetTimer = c.retarget * 0.5;
    }
  }

  _kick(c) {
    const g = settings.global;
    const time = frame.uTime.value;
    const dummy = this.mark;
    if (!dummy) return;

    _dir.set(this.swoopTo.x - this.swoopFrom.x, 0, this.swoopTo.z - this.swoopFrom.z);
    const d = _dir.length();
    if (d > 1e-3) _dir.multiplyScalar(1 / d);
    else _dir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));

    _pos.set(this.aimPoint.x, this.aimPoint.y * 0.7, this.aimPoint.z);
    this._impactFx(_pos, _dir, c.kickBurst, 1.6, c);
    this.hitPoint.copy(_pos);
    this.hitHeat = 1;
    this.flare = Math.max(this.flare, 1);

    if (dummy.alive) dummy.kill(_dir.x, _dir.z, c.kickHit);

    if (c.impactScorch) {
      _pos.set(dummy.position.x, 0, dummy.position.z);
      this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
        radius: 1.1,
        life: 4.0,
        intensity: 0.7,
        colorA: getColor(c.colorMid)
      });
    }
    this.lightBoost = Math.max(this.lightBoost, c.fireballLight * 1.5 * g.explosionIntensity);
    this.ctx.shake.add(c.kickShake * g.explosionIntensity * g.cameraShake, 3.0, 22);
    if (c.hitFlash > 0) this.ctx.flash.trigger(getColor(c.colorMid), c.hitFlash * 1.5 * g.explosionIntensity);

    /* the talons throw a spray of embers forward */
    _emit.position.copy(_pos);
    _emit.direction.set(_dir.x, 0.8, _dir.z).normalize();
    _emit.radius = 0.2;
    _emit.speed = 7;
    _emit.speedVariance = 0.5;
    _emit.spread = 0.6;
    _emit.size = 0.07;
    _emit.sizeVariance = 0.5;
    _emit.life = 0.8;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.impactSparks * 1.5 * g.particleCount), _emit);
  }

  /* ---- the volley ---- */

  /** One round off the beak: a comet, a flash, sparks, and a hit booked for its arrival. */
  _spit(dummy, c) {
    const g = settings.global;
    const time = frame.uTime.value;
    this._muzzle(_muzzle);

    // Aim with a little dispersion, so a volley is a group and not one line.
    this._aimAt(_aim, dummy, c);
    _dir.copy(_aim).sub(_muzzle);
    const dist = Math.max(0.3, _dir.length());
    _dir.multiplyScalar(1 / dist);
    const spread = c.spread * g.randomness;
    _dir.x += (Math.random() - 0.5) * 2 * spread;
    _dir.y += (Math.random() - 0.5) * 2 * spread;
    _dir.z += (Math.random() - 0.5) * 2 * spread;
    _dir.normalize();

    const speed = Math.max(3, c.fireballSpeed) * g.particleSpeed;
    const ball = this._fireballs.find((b) => !b.live) ?? this._fireballs[0];
    ball.live = true;
    ball.pos.copy(_muzzle);
    // Lobbed: it leaves with some lift and homes back down onto the chest.
    ball.vel.copy(_dir).multiplyScalar(speed).addScaledVector(_up, speed * c.fireballArc);
    ball.aim.copy(_aim);
    ball.age = 0;
    ball.life = dist / speed;
    ball.size = c.fireballSize * (1 + (Math.random() - 0.5) * 0.3);
    ball.seed = Math.random();
    ball.dummy = dummy;
    // The wake starts at the beak, so it grows out of the mouth.
    this._ignite(ball);
    this._record(ball);

    /* the flash off the beak */
    _emit.position.copy(_muzzle);
    _emit.direction.copy(_dir);
    _emit.radius = 0;
    _emit.speed = 0;
    _emit.speedVariance = 0;
    _emit.spread = 0;
    _emit.size = c.spitFlash;
    _emit.sizeVariance = 0.25;
    _emit.life = 0.08;
    _emit.lifeVariance = 0.3;
    _emit.spin = 6;
    _emit.tint = null;
    _emit.time = time;
    this.flashes.emit(1, _emit);

    /* sparks spat with it */
    _emit.radius = 0.06;
    _emit.speed = speed * 0.45;
    _emit.speedVariance = 0.5;
    _emit.spread = 0.3;
    _emit.size = 0.05;
    _emit.sizeVariance = 0.5;
    _emit.life = 0.35;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    this.sparks.emit(Math.round(8 * g.particleCount), _emit);

    this.flare = Math.max(this.flare, 0.6);
    this.lightBoost = Math.max(this.lightBoost, c.spitLight * g.explosionIntensity);
    this.ctx.shake.add(c.spitShake * g.explosionIntensity * g.cameraShake, 5.0, 30);
  }

  /** Where rounds leave from: the beak, in the world, wherever the head is. */
  _muzzle(out) {
    if (this.bird?.jaw) return this.bird.jaw.getWorldPosition(out);
    if (this.rig) out.copy(this.rig.beak);
    else out.set(0, 0.4, 0.9);
    return this.frame.localToWorld(out);
  }

  /** Fly every round, home it, land it. */
  _flyFireballs(dt, c) {
    const g = settings.global;
    const speed = Math.max(3, c.fireballSpeed) * g.particleSpeed;

    for (const ball of this._fireballs) {
      if (!ball.live) continue;
      ball.age += dt;

      // A live target is chased; a fallen one is hit where it was aimed.
      if (ball.dummy?.alive) this._aimAt(ball.aim, ball.dummy, c);

      _dir.copy(ball.aim).sub(ball.pos);
      const dist = _dir.length();
      // The round is done when it reaches the body's *skin*, not the chest
      // centre — landing inside the cylinder buries the burst in the mesh
      // and throws the sparks out of the far side, which reads as a hit on
      // the back.
      const skin = ball.dummy ? settings.dummies.bodyRadius : 0;
      if (dist < skin + Math.max(0.15, speed * dt * 1.2) || ball.age > ball.life * 2.5 + 0.5) {
        this._land(ball, c);
        continue;
      }
      _dir.multiplyScalar(speed / dist);
      // Homing: the velocity is damped onto the line to the chest, so the lob
      // it left with bends back down onto the body.
      ball.vel.x = damp(ball.vel.x, _dir.x, c.fireballHoming, dt);
      ball.vel.y = damp(ball.vel.y, _dir.y, c.fireballHoming, dt);
      ball.vel.z = damp(ball.vel.z, _dir.z, c.fireballHoming, dt);
      ball.pos.addScaledVector(ball.vel, dt);
    }

    this._syncFireballs();
  }

  /** A round arrives: fire, sparks, scorch — and the body is kicked along it. */
  _land(ball, c) {
    const g = settings.global;
    ball.live = false;
    const dummy = ball.dummy;
    ball.dummy = null;

    _vel.copy(ball.vel);
    const flat = Math.hypot(_vel.x, _vel.z);
    if (flat > 1e-4) _dir.set(_vel.x / flat, 0, _vel.z / flat);
    else _dir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));

    // Put the hit on the face of the body the round came at, at the height
    // it was aimed, so the burst sits on the chest and not inside it.
    if (dummy) {
      ball.pos.copy(ball.aim).addScaledVector(_dir, -settings.dummies.bodyRadius);
    }

    // The sparks splash back at the shooter and up; the body still leaves
    // along the shot.
    _pos.set(-_dir.x, 0, -_dir.z);
    this._impactFx(ball.pos, _pos, c.impactRadius, 1, c);
    this.hitPoint.copy(ball.pos);
    this.hitHeat = 1;

    if (dummy?.alive) {
      dummy.kill(_dir.x, _dir.z, c.hit);
      if (c.impactScorch) {
        _pos.set(dummy.position.x, 0, dummy.position.z);
        this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
          radius: 0.8,
          life: 3.5,
          intensity: 0.6,
          colorA: getColor(c.colorMid)
        });
      }
    }
    this.lightBoost = Math.max(this.lightBoost, c.fireballLight * g.explosionIntensity);
    this.ctx.shake.add(c.hitShake * g.explosionIntensity * g.cameraShake, 3.0, 24);
    if (c.hitFlash > 0) this.ctx.flash.trigger(getColor(c.colorMid), c.hitFlash * g.explosionIntensity);
  }

  /** The gout of fire an arrival makes, at any size. */
  _impactFx(at, dir, radius, scale, c) {
    const g = settings.global;
    const time = frame.uTime.value;

    this.ctx.bursts.spawn(BurstMode.FIRE, at, {
      radius: 0.12 * scale,
      endRadius: radius,
      life: 0.32,
      intensity: 1.4 * g.explosionIntensity,
      opacity: 0.7,
      displace: 0.55,
      colorA: getColor(c.colorCore),
      colorB: getColor(c.colorMid),
      colorC: getColor(c.colorEdge)
    });

    /* sparks thrown on along the shot and up */
    _emit.position.copy(at);
    _emit.direction.set(dir.x * 0.6, 1.0, dir.z * 0.6).normalize();
    _emit.radius = 0.1;
    _emit.speed = 6 * scale;
    _emit.speedVariance = 0.5;
    _emit.spread = 0.8;
    _emit.size = 0.06;
    _emit.sizeVariance = 0.5;
    _emit.life = 0.6;
    _emit.lifeVariance = 0.5;
    _emit.spin = 0;
    _emit.tint = null;
    _emit.time = time;
    this.sparks.emit(Math.round(c.impactSparks * g.particleCount), _emit);

    /* embers that hang in the air after it */
    _emit.direction.set(0, 1, 0);
    _emit.radius = radius * 0.3;
    _emit.speed = 1.6;
    _emit.spread = 0.8;
    _emit.size = c.emberSize * 1.2;
    _emit.life = c.emberLife * 0.7;
    this.embers.emit(Math.round(c.impactSparks * 0.5 * g.particleCount), _emit);

    _emit.radius = 0;
    _emit.speed = 0;
    _emit.size = radius * 1.4;
    _emit.sizeVariance = 0.2;
    _emit.life = 0.1;
    _emit.spin = 3;
    this.flashes.emit(1, _emit);

    _emit.direction.set(0, 1, 0);
    _emit.radius = radius * 0.2;
    _emit.speed = 1.2;
    _emit.spread = 0.7;
    _emit.size = 0.5 * scale;
    _emit.sizeVariance = 0.4;
    _emit.life = 1.2;
    _emit.lifeVariance = 0.3;
    _emit.spin = 1.5;
    this.smoke.emit(Math.round(4 * scale * g.particleCount), _emit);
  }

  /** A round's flight starts here: nothing behind it yet. */
  _ignite(ball) {
    ball.rawHead = 0;
    ball.rawCount = 0;
    ball.wake = 0;
  }

  /** Push where the round is now onto its flight history. */
  _record(ball) {
    const raw = ball.raw;
    const p = ball.pos;
    if (ball.rawCount === 0) {
      raw[0] = p.x;
      raw[1] = p.y;
      raw[2] = p.z;
      raw[3] = 0;
      ball.rawHead = 0;
      ball.rawCount = 1;
      return;
    }
    const h = ball.rawHead * 4;
    const step = Math.hypot(p.x - raw[h], p.y - raw[h + 1], p.z - raw[h + 2]);
    if (step < 1e-4) return;
    const next = (ball.rawHead + 1) % RAW_SAMPLES;
    const n = next * 4;
    raw[n] = p.x;
    raw[n + 1] = p.y;
    raw[n + 2] = p.z;
    raw[n + 3] = raw[h + 3] + step;
    ball.rawHead = next;
    ball.rawCount = Math.min(ball.rawCount + 1, RAW_SAMPLES);
  }

  /**
   * Resample one round's flight into its row of the history texture: NODES
   * points evenly spaced by arc length from the head back to `wake` metres
   * behind it. The wake never reaches further back than the round has flown
   * (plus its own radius), so it grows out of the beak rather than being
   * extrapolated back through the bird's head; past the oldest sample it
   * runs straight on, which is never visible.
   */
  _resample(ball, row) {
    const raw = ball.raw;
    const count = ball.rawCount;
    const head = ball.rawHead;
    const data = this.fireballHistory.image.data;
    const N = PHOENIX_FIREBALL_NODES;
    const base = row * N * 4;

    const at = (k) => ((head - k + RAW_SAMPLES) % RAW_SAMPLES) * 4;
    const flownAt = (k) => raw[at(0) + 3] - raw[at(k) + 3];
    const flown = count > 0 ? flownAt(count - 1) : 0;
    const L = Math.max(ball.size * 0.5, Math.min(ball.wake, flown + ball.size * 0.5));
    ball.wake = L;
    const spacing = L / (N - 1);

    // Direction to run on past the oldest sample: the oldest segment, or,
    // with only one sample, straight back along the velocity.
    let ex, ey, ez;
    if (count >= 2) {
      const o = at(count - 1);
      const q = at(count - 2);
      ex = raw[o] - raw[q];
      ey = raw[o + 1] - raw[q + 1];
      ez = raw[o + 2] - raw[q + 2];
    } else {
      ex = -ball.vel.x;
      ey = -ball.vel.y;
      ez = -ball.vel.z;
    }
    const el = Math.hypot(ex, ey, ez) || 1;
    ex /= el;
    ey /= el;
    ez /= el;

    let k = 0;
    for (let n = 0; n < N; n++) {
      const target = n * spacing;
      while (k + 1 < count && flownAt(k + 1) < target) k++;
      const o = base + n * 4;
      if (k + 1 < count) {
        const a = at(k);
        const b = at(k + 1);
        const da = flownAt(k);
        const db = flownAt(k + 1);
        const t = (target - da) / Math.max(db - da, 1e-6);
        data[o] = raw[a] + (raw[b] - raw[a]) * t;
        data[o + 1] = raw[a + 1] + (raw[b + 1] - raw[a + 1]) * t;
        data[o + 2] = raw[a + 2] + (raw[b + 2] - raw[a + 2]) * t;
      } else {
        const a = at(Math.max(count - 1, 0));
        const extra = target - (count > 0 ? flownAt(count - 1) : 0);
        data[o] = raw[a] + ex * extra;
        data[o + 1] = raw[a + 1] + ey * extra;
        data[o + 2] = raw[a + 2] + ez * extra;
      }
      data[o + 3] = target;
    }
  }

  /** Push every round's state into the instance buffers and the history. */
  _syncFireballs() {
    const geometry = this.fireballMesh.geometry;
    const vel = geometry.getAttribute('aVel');
    const data = geometry.getAttribute('aData');
    const c = this.config;
    let any = false;
    for (let i = 0; i < this._fireballs.length; i++) {
      const ball = this._fireballs[i];
      if (!ball.live) {
        data.setZ(i, -1);
        continue;
      }
      any = true;
      this._record(ball);
      ball.wake = c.fireballTail;
      this._resample(ball, i);
      vel.setXYZ(i, ball.vel.x, ball.vel.y, ball.vel.z);
      data.setXYZW(i, ball.size, ball.wake, ball.age, ball.seed);
    }
    vel.needsUpdate = true;
    data.needsUpdate = true;
    if (any) this.fireballHistory.needsUpdate = true;
  }

  /* ---- the burn-out ---- */

  _burnOut() {
    this.state = PhoenixState.BURNOUT;
    this.mark = null;
    this.volley = null;
    this.lock = 0;
    this.flare = Math.max(this.flare, 1.2);
  }

  /** Flare, climb a little, and come apart into embers. */
  _burning(dt, c) {
    this.pos.y += c.burnClimb * dt;
    this.pos.x = damp(this.pos.x, this.hover.x, 0.02, dt);
    this.pos.z = damp(this.pos.z, this.hover.z, 0.02, dt);
  }

  /* ------------------------------------------------------------------ */
  /* the body                                                            */
  /* ------------------------------------------------------------------ */

  /** Hover, bank, flap — and place the bird. */
  _animateBird(dt, c) {
    const t = this.fieldAge;
    const g = settings.global;

    // Heading: onto the target while it has one, else drifting back to the cast line.
    let target = this.yaw;
    if (this.mark) target = Math.atan2(this.aimPoint.x - this.pos.x, this.aimPoint.z - this.pos.z);
    const rate = this.state === PhoenixState.SWOOP ? c.turnRate * 0.05 : c.turnRate;
    const turn = turnTo(this.yaw, target);
    this.yaw += turn * (1 - Math.pow(rate, dt));

    // The nose comes down to look at what it is about to hit, and all the way
    // down into a dive.
    let pitchTarget = 0;
    if (this.mark) {
      const dx = this.aimPoint.x - this.pos.x;
      const dz = this.aimPoint.z - this.pos.z;
      const dy = this.pos.y - this.aimPoint.y;
      const down = Math.atan2(dy, Math.max(0.5, Math.hypot(dx, dz)));
      pitchTarget = Math.min(down, 1.2) * c.aimPitch * this.lock;
    }
    if (this.state === PhoenixState.SWOOP) {
      const w = Math.sin(Math.PI * Math.min(1, this.swoopT));
      pitchTarget = c.divePitch * w * (this.swoopT < 0.5 ? 1 : 0.35);
    }
    const rollTarget = -turn * c.bank;
    this.pitch = damp(this.pitch, pitchTarget, c.bankRate, dt);
    this.roll = damp(this.roll, rollTarget, c.bankRate, dt);

    // The hover: a slow bob and a wobble that never quite repeats. Stilled
    // while it rises and while it dives.
    const hovering = this.state === PhoenixState.HUNT ? 1 : 0.25;
    const bob = Math.sin(t * c.hoverFrequency * TAU) * c.hoverAmplitude * this.reveal * hovering;
    const swayX = (Math.sin(t * c.swaySpeed * 1.31 + 1.7) + 0.5 * Math.sin(t * c.swaySpeed * 2.9)) * c.sway;
    const swayZ = (Math.sin(t * c.swaySpeed * 0.93) + 0.5 * Math.sin(t * c.swaySpeed * 2.3 + 0.8)) * c.sway;

    this.root.position.set(this.pos.x, this.pos.y + bob, this.pos.z);
    this.root.rotation.set(0, this.yaw, 0);
    this.tilt.rotation.set(this.pitch + swayX, 0, this.roll + swayZ);
    this.frame.scale.setScalar(this.scaleK);
    this.position.copy(this.root.position);

    // The wings. Faster in the dive and the burn-out, because a bird that is
    // doing something beats harder.
    if (this.bird) {
      let flap = c.flapSpeed;
      if (this.state === PhoenixState.SWOOP) flap *= 1.6;
      if (this.state === PhoenixState.BURNOUT) flap *= 1.3;
      this.bird.mixer.update(dt * flap * g.animationSpeed);
    }

    this.flare = Math.max(0, this.flare - dt * 2.2);
    this._placeBird();
  }

  /** Bring the transform chain up to date so the beak can be read this frame. */
  _placeBird() {
    this.root.updateMatrixWorld(true);
  }

  /** Metres per unit of the skinned mesh's local space. */
  _birdUnit() {
    const mesh = this.bird?.meshes[0];
    if (!mesh) return 1;
    const e = mesh.matrixWorld.elements;
    return Math.max(1e-6, Math.hypot(e[0], e[1], e[2]));
  }

  /* ------------------------------------------------------------------ */
  /* dressing                                                            */
  /* ------------------------------------------------------------------ */

  /** Push the settings into every uniform, every frame. */
  _dress(c) {
    const g = settings.global;
    const opacity = g.opacity;
    const R = c.zoneRadius;
    const fade = 1 - Easing.inQuad(this.burn);
    const flare = 1 + this.flare * c.flareStrength;

    const fire = (u) => {
      u.uTempCore.value = c.tempCore;
      u.uTempEdge.value = c.tempEdge;
      u.uEmissionCurve.value = c.emissionCurve;
      u.uPalette.value = c.palette;
      u.uColorCore.value.copy(getColor(c.colorCore));
      u.uColorMid.value.copy(getColor(c.colorMid));
      u.uColorEdge.value.copy(getColor(c.colorEdge));
      u.uColorEmber.value.copy(getColor(c.colorEmber));
    };

    /* the bird */
    const revealY = this.state === PhoenixState.RISE ? FLOOR : REVEALED;
    for (const material of this.birdMaterials) {
      const u = material.uniforms;
      fire(u);
      u.uFlameScale.value = c.flameScale * g.noiseFrequency;
      u.uFlameRise.value = c.flameRise * g.noiseSpeed;
      u.uLick.value = c.lick;
      u.uFeatherBurn.value = c.featherBurn;
      u.uRevealY.value = revealY;
      u.uRevealWidth.value = c.revealWidth;
      u.uDissolve.value = this.burn;
      u.uRevealColor.value.copy(getColor(c.colorCore));
      u.uRevealGlow.value = c.revealGlow * g.glow;
      u.uRimPower.value = c.rimPower;
    }
    for (const material of this.bodyMaterials) {
      const u = material.uniforms;
      u.uBodyHeat.value = c.bodyHeat * flare;
      u.uRimStrength.value = c.rimStrength * g.fresnel;
      u.uFlameStrength.value = c.flameStrength * g.noiseStrength;
      u.uEmission.value = c.emission * g.glow * g.shaderIntensity * flare;
      u.uPaintShow.value = c.paintShow;
    }
    // The shells stand off the body in metres, but the vertex stage works in
    // the mesh's own units — centimetres, for this export — so the stand-off
    // is divided by the mesh's world scale.
    const unit = this._birdUnit();
    for (const material of this.auraMaterials) {
      const u = material.uniforms;
      const outer = material.userData.shell === 1;
      u.uInflate.value = (outer ? c.auraSize * 2.6 : c.auraSize) / unit;
      u.uAuraStrength.value = (outer ? c.auraStrength * 0.55 : c.auraStrength) * g.fresnel * flare;
      u.uAuraThreshold.value = outer ? c.auraThreshold + 0.12 : c.auraThreshold;
      u.uLick.value = c.lick * (outer ? 2.2 : 1);
      u.uEmission.value = c.emission * g.glow * g.shaderIntensity;
      u.uOpacity.value = opacity;
    }

    /* the ground */
    {
      const u = this.groundMaterial.uniforms;
      const spread = Easing.outCubic(saturate(this.fieldAge / Math.max(0.05, c.spreadTime)));
      const size = R * 2.8;
      u.uSize.value = size;
      u.uRadius.value = R * c.scorchRadius;
      u.uSpread.value = spread;
      u.uFade.value = fade * opacity;
      u.uScorch.value = c.scorchDark;
      u.uCrackScale.value = c.crackScale;
      u.uCrackWidth.value = c.crackWidth;
      u.uCrackGlow.value = c.crackGlow * g.glow * flare;
      u.uCrackReach.value = c.crackReach;
      u.uPulse.value = c.glowPulse;
      u.uPulseSpeed.value = c.glowPulseSpeed;
      u.uGlowRadius.value = R * c.glowRadius;
      u.uGlowIntensity.value = c.glowIntensity * g.glow * flare;
      u.uEmberGlow.value = c.groundEmbers * g.glow;
      u.uFlash.value = this.lightBoost * 0.01;
      u.uColorGlow.value.copy(getColor(c.colorGlow));
      u.uColorCrack.value.copy(getColor(c.colorMid));
      u.uColorScorch.value.copy(getColor(c.colorScorch));
      this.ground.position.set(this.centre.x, 0.02, this.centre.z);
      this.ground.scale.setScalar(size);
    }

    /* the wispy flame waves */
    {
      const u = this.skirtMaterial.uniforms;
      fire(u);
      const reveal = Easing.outBack(saturate((this.fieldAge - 0.1) / Math.max(0.05, c.skirtRiseTime)));
      u.uRadius.value = R * c.skirtRadius;
      u.uHeight.value = c.skirtHeight;
      u.uFlare.value = c.skirtFlare;
      u.uBreathe.value = c.skirtBreathe;
      u.uReveal.value = Math.max(0, reveal) * (1 - Easing.inQuad(this.burn) * 0.6);
      u.uNoiseScale.value = c.skirtNoiseScale * g.noiseFrequency;
      u.uRise.value = c.skirtRise * g.noiseSpeed;
      u.uShred.value = c.skirtShred * g.noiseStrength;
      u.uWisp.value = c.skirtWisp;
      u.uWaveSpeed.value = c.skirtWaveSpeed;
      u.uWaveDepth.value = c.skirtWaveDepth;
      u.uHeat.value = c.skirtHeat * flare;
      u.uIntensity.value = c.skirtIntensity * g.glow * g.shaderIntensity;
      u.uOpacity.value = c.skirtOpacity * opacity;
      u.uFade.value = fade;
      this.skirt.position.set(this.centre.x, 0, this.centre.z);
      this.skirt.visible = this.ground.visible && reveal > 0.001;
    }

    /* the serpents */
    {
      const u = this.serpentMaterial.uniforms;
      fire(u);
      const reveal = saturate((this.fieldAge - 0.25) / Math.max(0.05, c.serpentGrowTime));
      u.uCount.value = MathUtils.clamp(Math.round(c.serpents), 0, 6);
      u.uRadius.value = R * c.serpentRadius;
      u.uWeave.value = c.serpentWeave;
      u.uWaves.value = Math.max(1, Math.round(c.serpentWaves));
      u.uHeight.value = c.serpentHeight;
      u.uLift.value = c.serpentLift;
      u.uLength.value = c.serpentLength;
      u.uSpeed.value = c.serpentSpeed;
      u.uWidth.value = c.serpentWidth;
      u.uFloorWidth.value = c.serpentFloorWidth;
      u.uReveal.value = Easing.outCubic(reveal) * (1 - Easing.inCubic(this.burn));
      u.uSpin.value = this.spin;
      u.uNoiseScale.value = c.serpentNoiseScale * g.noiseFrequency;
      u.uFlow.value = c.serpentFlow * g.noiseSpeed;
      u.uRise.value = c.serpentRise * g.noiseSpeed;
      u.uShred.value = c.serpentShred * g.noiseStrength;
      u.uHeadGlow.value = c.serpentHeadGlow;
      u.uIntensity.value = c.serpentIntensity * g.glow * g.shaderIntensity;
      u.uFloorGlow.value = c.serpentFloorGlow;
      u.uOpacity.value = opacity;
      u.uFade.value = fade;
      this.serpents.position.set(this.centre.x, 0, this.centre.z);
      this.serpents.visible = this.ground.visible && reveal > 0.001;
    }

    /* the fireballs */
    {
      const hull = fireballHull(c.fireballBulge, c.fireballPlume, c.fireballHalo);
      const u = this.fireballMaterial.uniforms;
      fire(u);
      u.uHull.value = hull;
      u.uWakeWidth.value = c.fireballWakeWidth;
      u.uWakeSpread.value = c.fireballWakeSpread;
      u.uPlume.value = c.fireballPlume;
      u.uIntensity.value = c.fireballIntensity * g.glow;
      u.uBulge.value = c.fireballBulge;
      u.uShred.value = c.fireballShred * g.noiseStrength;
      u.uNoiseScale.value = c.fireballNoiseScale * g.noiseFrequency;
      u.uFlow.value = c.fireballFlow;
      u.uBuoyancy.value = c.fireballBuoyancy * g.noiseSpeed;
      u.uVortex.value = c.fireballVortex;
      u.uDetach.value = c.fireballDetach;
      u.uSoftness.value = c.fireballSoftness;
      u.uTailHeat.value = c.fireballTailHeat;
      u.uDensity.value = c.fireballDensity;
      u.uSoot.value = c.fireballSoot;
      u.uSteps.value = c.fireballSteps;
      u.uHalo.value = c.fireballHalo;
      u.uOpacity.value = opacity;
    }

    /* the particle systems — shared, so re-dressed every frame */
    {
      const u = this.embers.uniforms;
      this.embers.setGradient(getColor(c.colorCore), getColor(c.colorMid), getColor(c.colorEdge), getColor(c.colorEmber));
      u.uGravity.value.set(0, c.emberRise, 0);
      u.uDrag.value = 1.1;
      u.uTurbulence.value = 0.9 * g.turbulence;
      u.uTurbFrequency.value = 0.7;
      u.uTurbSpeed.value = 0.5;
      u.uEndSize.value = 0.35;
      u.uSizeIn.value = 0.05;
      u.uFadeIn.value = 0.05;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = c.emberGlow * g.glow;
      u.uOpacity.value = opacity;
    }
    {
      const u = this.sparks.uniforms;
      this.sparks.setGradient(getColor('#ffffff'), getColor(c.colorCore), getColor(c.colorMid), getColor(c.colorEdge));
      u.uGravity.value.set(0, -9, 0);
      u.uDrag.value = 1.6;
      u.uTurbulence.value = 0.2;
      u.uStretch.value = 0.08;
      u.uEndSize.value = 0.3;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = 2.2 * g.glow;
      u.uOpacity.value = opacity;
    }
    {
      const u = this.flashes.uniforms;
      this.flashes.setGradient(getColor('#ffffff'), getColor(c.colorCore), getColor(c.colorMid), getColor(c.colorMid));
      u.uGravity.value.set(0, 0, 0);
      u.uDrag.value = 1;
      u.uTurbulence.value = 0;
      u.uEndSize.value = 1.6;
      u.uSizeIn.value = 0.001;
      u.uFadeIn.value = 0;
      u.uFadeOut.value = 0.3;
      u.uGlow.value = 2.4 * g.glow;
      u.uOpacity.value = opacity;
    }
    {
      const u = this.smoke.uniforms;
      this.smoke.setGradient(getColor('#4a3a30'), getColor('#2c2420'), getColor('#1c1815'), getColor('#121010'));
      u.uGravity.value.set(0, 0.9, 0);
      u.uDrag.value = 1.8;
      u.uTurbulence.value = 0.5 * g.turbulence;
      u.uTurbFrequency.value = 0.9;
      u.uEndSize.value = 2.8;
      u.uFadeIn.value = 0.15;
      u.uFadeOut.value = 0.4;
      u.uGlow.value = 0.25;
      u.uOpacity.value = c.smokeOpacity * opacity;
    }
    {
      // Embers shaken out of the wake: small, bright, buoyant, and quick to
      // go. The gas itself is the volume; these are what comes off it.
      const u = this.trail.uniforms;
      this.trail.setGradient(getColor('#ffffff'), getColor(c.colorCore), getColor(c.colorMid), getColor(c.colorEdge));
      u.uGravity.value.set(0, 1.2, 0);
      u.uDrag.value = 2.2;
      u.uTurbulence.value = 1.1 * g.turbulence;
      u.uTurbFrequency.value = 1.6;
      u.uTurbSpeed.value = 0.8;
      u.uEndSize.value = 0.3;
      u.uSizeIn.value = 0.05;
      u.uFadeIn.value = 0.05;
      u.uFadeOut.value = 0.55;
      u.uGlow.value = 2.4 * g.glow;
      u.uOpacity.value = opacity;
    }
  }

  /* ------------------------------------------------------------------ */
  /* emitters                                                            */
  /* ------------------------------------------------------------------ */

  /** Embers off the floor, off the bird, off the serpents; the comets' trails. */
  _emitters(dt, c) {
    const g = settings.global;
    const time = frame.uTime.value;
    const R = c.zoneRadius;
    const alive = 1 - this.burn;

    /* floating fire embers, everywhere the field is */
    {
      const n = this._embers.tick(dt, c.emberRate * g.particleCount * this.reveal * alive);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU;
        const r = Math.sqrt(Math.random()) * R * 0.85;
        _emit.position.set(this.centre.x + Math.cos(a) * r, 0.05 + Math.random() * 0.3, this.centre.z + Math.sin(a) * r);
        _emit.direction.set(0, 1, 0);
        _emit.radius = 0.05;
        _emit.speed = 0.9;
        _emit.speedVariance = 0.6;
        _emit.spread = 0.5;
        _emit.size = c.emberSize;
        _emit.sizeVariance = 0.6;
        _emit.life = c.emberLife;
        _emit.lifeVariance = 0.5;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = time;
        this.embers.emit(1, _emit);
      }
    }

    /* embers shed by the bird: more as it burns out, and they are what is left of it */
    if (this.bird) {
      const shed = c.bodyEmbers * (1 + this.burn * 8) * (this.state === PhoenixState.RISE ? this.reveal : 1);
      const n = this._bodyEmbers.tick(dt, shed * g.particleCount);
      const span = c.wingspan * 0.5;
      for (let i = 0; i < n; i++) {
        _emit.position.set(
          this.root.position.x + (Math.random() - 0.5) * 2 * span,
          this.root.position.y + (Math.random() - 0.5) * span * 0.5,
          this.root.position.z + (Math.random() - 0.5) * span * 0.9
        );
        // Off the floor-line while it rises, nothing below it.
        if (this.state === PhoenixState.RISE) _emit.position.y = Math.max(0.05, _emit.position.y);
        _emit.direction.set(0, 1, 0);
        _emit.radius = 0.05;
        _emit.speed = 1.2 + this.burn * 1.5;
        _emit.speedVariance = 0.5;
        _emit.spread = 0.6;
        _emit.size = c.emberSize * 1.1;
        _emit.sizeVariance = 0.6;
        _emit.life = c.emberLife * 0.8;
        _emit.lifeVariance = 0.5;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = time;
        this.embers.emit(1, _emit);
      }
    }

    /* the serpents' heads throw embers as they go */
    {
      const count = MathUtils.clamp(Math.round(c.serpents), 0, 6);
      const grown = this.serpentMaterial.uniforms.uReveal.value;
      const n = this._serpentEmbers.tick(dt, c.serpentEmbers * count * g.particleCount * grown * alive);
      for (let i = 0; i < n; i++) {
        const k = Math.floor(Math.random() * count);
        const theta = time * c.serpentSpeed * TAU + k * (TAU / Math.max(count, 1)) + this.spin - Math.random() * 0.4;
        this._serpentPoint(theta, k, time, _pos, c);
        _emit.position.copy(_pos);
        _emit.direction.set(0, 1, 0);
        _emit.radius = c.serpentWidth * 0.3;
        _emit.speed = 1.0;
        _emit.speedVariance = 0.5;
        _emit.spread = 0.7;
        _emit.size = c.emberSize * 0.9;
        _emit.sizeVariance = 0.5;
        _emit.life = c.emberLife * 0.6;
        _emit.lifeVariance = 0.5;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = time;
        this.embers.emit(1, _emit);
      }
    }

    /* smoke off the skirt */
    {
      const n = this._smoke.tick(dt, c.smokeRate * g.particleCount * this.reveal * alive);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU;
        const r = R * c.skirtRadius * (0.9 + Math.random() * 0.3);
        _emit.position.set(this.centre.x + Math.cos(a) * r, c.skirtHeight * 0.7, this.centre.z + Math.sin(a) * r);
        _emit.direction.set(Math.cos(a) * 0.3, 1, Math.sin(a) * 0.3).normalize();
        _emit.radius = 0.3;
        _emit.speed = 1.0;
        _emit.speedVariance = 0.5;
        _emit.spread = 0.4;
        _emit.size = 0.9;
        _emit.sizeVariance = 0.4;
        _emit.life = 2.4;
        _emit.lifeVariance = 0.4;
        _emit.spin = 0.6;
        _emit.tint = null;
        _emit.time = time;
        this.smoke.emit(1, _emit);
      }
    }

    /* what comes off the comets: embers out of the wake, sparks out of the
       underside of the head, and the odd puff of smoke where the wake ends */
    {
      let live = 0;
      for (const ball of this._fireballs) if (ball.live) live++;
      if (live > 0) {
        const history = this.fireballHistory.image.data;
        const N = PHOENIX_FIREBALL_NODES;
        const n = this._trail.tick(dt, c.trailRate * live * g.particleCount);
        for (let i = 0; i < n; i++) {
          // Spread them over the live rounds.
          let k = Math.floor(Math.random() * live);
          let ball = null;
          let row = 0;
          for (let b = 0; b < this._fireballs.length; b++) {
            if (!this._fireballs[b].live) continue;
            if (k-- === 0) {
              ball = this._fireballs[b];
              row = b;
              break;
            }
          }
          if (!ball) continue;
          const roll = Math.random();
          if (roll < 0.72) {
            // An ember, off a point along the wake — mostly the hot half.
            const node = Math.min(N - 1, Math.floor(Math.pow(Math.random(), 1.6) * N));
            const o = (row * N + node) * 4;
            const a = node / (N - 1);
            _emit.position.set(history[o], history[o + 1], history[o + 2]);
            _emit.direction.set(0, 1, 0);
            _emit.radius = ball.size * (0.5 + a * 0.4);
            _emit.speed = 0.9;
            _emit.speedVariance = 0.6;
            _emit.spread = 0.9;
            _emit.size = 0.05 + ball.size * 0.08;
            _emit.sizeVariance = 0.6;
            _emit.life = 0.5 + a * 0.4;
            _emit.lifeVariance = 0.5;
            _emit.spin = 0;
            _emit.tint = null;
            _emit.time = time;
            this.trail.emit(1, _emit);
          } else if (roll < 0.92) {
            // A spark, thrown out of the underside of the head and left behind.
            _emit.position.copy(ball.pos).addScaledVector(ball.vel, -0.02);
            _emit.direction.copy(ball.vel).negate().normalize();
            _emit.direction.y -= 0.6;
            _emit.direction.normalize();
            _emit.radius = ball.size * 0.5;
            _emit.speed = 2.5;
            _emit.speedVariance = 0.6;
            _emit.spread = 0.5;
            _emit.size = 0.04;
            _emit.sizeVariance = 0.5;
            _emit.life = 0.45;
            _emit.lifeVariance = 0.5;
            _emit.spin = 0;
            _emit.tint = null;
            _emit.time = time;
            this.sparks.emit(1, _emit);
          } else if (ball.wake > ball.size * 2) {
            // Smoke, where the wake has gone out.
            const o = (row * N + N - 2) * 4;
            _emit.position.set(history[o], history[o + 1], history[o + 2]);
            _emit.direction.set(0, 1, 0);
            _emit.radius = ball.size * 0.5;
            _emit.speed = 0.5;
            _emit.speedVariance = 0.5;
            _emit.spread = 0.7;
            _emit.size = ball.size * 1.1;
            _emit.sizeVariance = 0.4;
            _emit.life = 1.1;
            _emit.lifeVariance = 0.4;
            _emit.spin = 1.2;
            _emit.tint = null;
            _emit.time = time;
            this.smoke.emit(1, _emit);
          }
        }
      }
    }
  }

  /** The serpents' curve, mirrored from the vertex shader, for the embers. */
  _serpentPoint(theta, seed, t, out, c) {
    const R = c.zoneRadius * c.serpentRadius;
    const bend = Math.sin(theta * c.serpentWaves + seed * 2.39 + t * 0.55);
    const r = R * (1 + c.serpentWeave * bend);
    const y = c.serpentLift + c.serpentHeight * (0.5 + 0.5 * Math.sin(theta * c.serpentWaves * 1.5 + seed * 4.1 - t * 1.3));
    return out.set(this.centre.x + Math.cos(theta) * r, y, this.centre.z + Math.sin(theta) * r);
  }

  /* ------------------------------------------------------------------ */
  /* lights                                                              */
  /* ------------------------------------------------------------------ */

  /** The pyre's light under the bird, and the light of the last hit. */
  _fieldLights(dt, c) {
    const g = settings.global;
    const fade = 1 - this.burn;

    if (this.fieldLight) {
      _pos.set(this.centre.x, 0.9, this.centre.z);
      const breath = 1 - c.glowPulse * 0.3 + c.glowPulse * 0.3 * Math.sin(this.fieldAge * c.glowPulseSpeed * 0.7);
      this.lightColor.copy(getColor(c.colorGlow));
      this.ctx.lights.set(
        this.fieldLight,
        _pos,
        this.lightColor,
        c.fieldLight * breath * this.reveal * fade * (1 + this.flare * 0.5),
        c.fieldLightRadius,
        dt
      );
    }

    if (this.hitLight) {
      this.hitHeat = Math.max(0, this.hitHeat - dt * 3);
      this.lightColor.copy(getColor(c.colorMid));
      this.ctx.lights.set(
        this.hitLight,
        this.hitPoint,
        this.lightColor,
        c.fireballLight * this.hitHeat * g.explosionIntensity,
        c.lightRadius * 0.8,
        dt
      );
    }
  }

  /** A gutter, not a shimmer: it is a fire. */
  lightShimmer() {
    const c = this.config;
    const t = this.age;
    const gutter = Math.sin(t * c.lightGutterSpeed) * Math.sin(t * c.lightGutterSpeed * 0.37 + 1.3);
    return 1 - c.lightGutter * 0.5 + c.lightGutter * 0.5 * gutter + this.flare * 0.4;
  }

  dispose() {
    super.dispose();
    for (const material of this.birdMaterials) material.dispose();
    this.groundMaterial.dispose();
    this.skirtMaterial.dispose();
    this.serpentMaterial.dispose();
    this.fireballMaterial.dispose();
    this.fireballHistory.dispose();
    this.fireballMesh.geometry.dispose();
    this.serpents.geometry.dispose();
    this.skirt.geometry.dispose();
  }
}
