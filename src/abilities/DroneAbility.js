import {
  BufferAttribute,
  BufferGeometry,
  CircleGeometry,
  Group,
  MathUtils,
  Mesh,
  PlaneGeometry,
  Points,
  Vector2,
  Vector3
} from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { DecalType } from '../effects/GroundDecals.js';
import { BurstMode } from '../effects/BurstSphere.js';
import {
  DRONE_FORWARD,
  createBeamGeometry,
  createDroneBeamMaterial,
  createDroneReticleMaterial,
  createDroneRingMaterial,
  createDroneSpotMaterial,
  createNavLightsMaterial,
  createRotorBlurMaterial,
  patchDroneBody
} from '../materials/DroneMaterials.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { Easing, damp, saturate } from '../utils/math.js';

/**
 * Where the drone is in its life. `Ability#phase` is kept to the two values the
 * manager reads — active or done — and this is the real machine.
 */
export const DroneState = Object.freeze({
  DEPLOY: 'deploy',
  STATION: 'station',
  RECALL: 'recall'
});

const TAU = Math.PI * 2;
/** Rounds whose flight is still in the air, at most. */
const MAX_PENDING = 16;
/** Metres the beam's apex sits under the body's centre, as a fraction of its height. */
const BEAM_APEX = 0.3;

const _right = new Vector3();
const _push = new Vector3();
const _muzzle = new Vector3();
const _aim = new Vector3();
const _dir = new Vector3();
const _pos = new Vector3();
const _eject = new Vector3();
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
 * THE SENTINEL DRONE — a summon, not a cast.
 *
 * Everything else on the bar is fired and forgotten. This one is *deployed*:
 * press the slot and the airframe prints itself in over the caster's head,
 * spins up, climbs to station and waits. It stays until it is recalled, and
 * while it is up the other slots are locked — the caster is flying it.
 *
 * ## What it is doing, frame by frame
 *
 *   1. **Flight.** `steer` is a velocity demand from whichever control is
 *      driving — the on-screen stick, the keys, or the open hand pushed off the
 *      middle of the frame (`steerFromPointer` turns the hand's NDC into a
 *      stick with a dead zone: a hand near the centre holds, and that dead
 *      zone is the whole reason a shaky palm does not drag the drone around).
 *      The demand is camera-relative, damped into a velocity, leashed to the
 *      caster, and the body banks into it the way a real multirotor does —
 *      nose down to go forward, a shoulder down to go sideways.
 *   2. **The hunt.** Firing (fist shut, or fire held) puts it to work: it asks
 *      the field who is standing in its ring, turns onto the nearest, and the
 *      reticle closes on them over `lockTime`. Once the heading is inside
 *      `lockCone` with the lock complete, it empties a burst — tracers from the
 *      socket, a flash, casings off the side — and the first round to arrive
 *      knocks the body down along the shot. Then the next one, for as long as
 *      the fist stays shut.
 *   3. **The show.** A range ring on the floor with a radar sweep that runs
 *      hot while it hunts; a searchlight standing under it that swings onto
 *      whatever it is about to shoot; rotor blur; nav lights; the downwash
 *      lifting dust off the stone under it.
 *
 * It answers `handlesOwnHits` because the field's line-and-disc reading of a
 * cast is meaningless here — there is no front — and because it has to be the
 * thing that says which body, and when.
 *
 * Nothing about the model is known here: `DroneRig` hands over a normalised
 * airframe, the blade nodes and the muzzle point, and that is the whole
 * contract.
 */
export class DroneAbility extends Ability {
  constructor(context) {
    super('drone', context);
  }

  get handlesOwnHits() {
    return true;
  }

  /** How hard the camera should follow it. It roams, so harder than a cast. */
  get cameraWeight() {
    return 1;
  }

  /** The editor's size over the size the rig was normalised to. Live. */
  get scaleK() {
    return this.rig ? this.config.size / Math.max(0.01, this.rig.span) : 1;
  }

  get impactDuration() {
    return 0.01;
  }

  get fadeDuration() {
    return 0.01;
  }

  /* ------------------------------------------------------------------ */
  /* construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const rig = this.ctx.models?.drone ?? null;
    this.rig = rig;

    // root: where it is and which way it faces. tilt: the bank. frame: the
    // airframe itself, in rig metres.
    this.root = new Group();
    this.root.name = 'DroneRoot';
    this.tilt = new Group();
    this.tilt.name = 'DroneTilt';
    this.frame = new Group();
    this.frame.name = 'DroneFrame';
    this.root.add(this.tilt);
    this.tilt.add(this.frame);
    this.group.add(this.root);

    this.bodyMaterial = null;
    this.bodyMeshes = [];
    this.blades = [];
    this.rotors = [];
    this.height = 0.6;
    this.span = 2;

    if (rig) {
      this.height = rig.height;
      this.span = rig.span;

      const clone = rig.source.clone(true);
      clone.traverse((node) => {
        if (!node.isMesh) return;
        // One material per drone, so the reveal of one can never print out
        // another. All the export's meshes share a material, so this is one
        // clone and one program.
        if (!this.bodyMaterial) {
          this.bodyMaterial = patchDroneBody(node.material.clone());
        }
        node.material = this.bodyMaterial;
        node.layers.set(LAYER.WORLD);
        node.castShadow = false;
        node.receiveShadow = false;
        node.frustumCulled = false;
        this.bodyMeshes.push(node);
      });
      this.frame.add(clone);

      const blurGeometry = new CircleGeometry(1, 40);
      blurGeometry.rotateX(-Math.PI / 2);

      rig.blades.forEach((info, i) => {
        const node = clone.getObjectByName(info.name);
        if (!node) return;
        this.blades.push({
          node,
          // Adjacent rotors turn against each other, or the airframe would spin.
          sign: i % 2 === 0 ? 1 : -1,
          phase: (i / rig.blades.length) * TAU
        });

        const blur = new Mesh(blurGeometry, createRotorBlurMaterial());
        blur.position.copy(info.position);
        blur.position.y += 0.012;
        blur.scale.setScalar(rig.bladeRadius);
        blur.layers.set(LAYER.VFX);
        blur.renderOrder = 8;
        blur.frustumCulled = false;
        this.frame.add(blur);
        this.rotors.push(blur);
      });

      this._buildNavLights(rig);
    }

    /* ---- the range ring ---- */
    const flat = new PlaneGeometry(1, 1);
    flat.rotateX(-Math.PI / 2);

    this.ringMaterial = createDroneRingMaterial();
    this.ring = new Mesh(flat, this.ringMaterial);
    this.ring.layers.set(LAYER.VFX);
    this.ring.renderOrder = 6;
    this.ring.frustumCulled = false;
    this.group.add(this.ring);

    /* ---- the searchlight, and its pool on the floor ---- */
    this.beamMaterial = createDroneBeamMaterial();
    this.beam = new Mesh(createBeamGeometry(48), this.beamMaterial);
    this.beam.layers.set(LAYER.VFX);
    this.beam.renderOrder = 9;
    this.beam.frustumCulled = false;
    this.group.add(this.beam);

    this.spotMaterial = createDroneSpotMaterial();
    this.spot = new Mesh(flat, this.spotMaterial);
    this.spot.layers.set(LAYER.VFX);
    this.spot.renderOrder = 7;
    this.spot.frustumCulled = false;
    this.group.add(this.spot);

    /* ---- the lock reticle ---- */
    this.reticleMaterial = createDroneReticleMaterial();
    this.reticle = new Mesh(new PlaneGeometry(1, 1), this.reticleMaterial);
    this.reticle.layers.set(LAYER.VFX);
    this.reticle.renderOrder = 14;
    this.reticle.frustumCulled = false;
    this.reticle.visible = false;
    this.group.add(this.reticle);

    /* ---- state ---- */
    this.state = DroneState.DEPLOY;
    this.stateTime = 0;
    /** Commanded position: flat, plus the altitude it is holding. */
    this.pos = new Vector3();
    this.vel = new Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0;
    /** 0 still → 1 full spin. */
    this.spin = 0;
    this.bladeAngle = 0;
    /** 0 nothing printed → 1 whole airframe. */
    this.reveal = 0;
    this.ringReveal = 0;
    /** 0 watching → 1 hunting. Drives every colour that goes red. */
    this.hot = 0;

    this.steer = new Vector2();
    this.firing = false;
    this.mark = null;
    this.lock = 0;
    this.retargetTimer = 0;
    this.burst = null;
    this.aimPoint = new Vector3();
    this.beamTarget = new Vector3();
    this.beamAt = new Vector3();
    this.spotLight = null;
    this.shadowsOn = false;

    /** Reused by `DummyField#findTargets`, so polling allocates nothing. */
    this._targets = [];
    this.targetsInRange = 0;
    /** Rounds in the air, waiting to land. */
    this._pending = [];
    for (let i = 0; i < MAX_PENDING; i++) {
      this._pending.push({ live: false, at: 0, dummy: null, dirX: 0, dirZ: 1, point: new Vector3() });
    }

    this._downwash = new RateEmitter(20);
    this._printSparks = new RateEmitter(30);
    this._navFront = '';
    this._navBack = '';
  }

  /** Six small lamps under the rotors and two strobes fore and aft. */
  _buildNavLights(rig) {
    const count = rig.blades.length + 2;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const phases = new Float32Array(count);
    const strobes = new Float32Array(count);

    rig.blades.forEach((info, i) => {
      positions[i * 3 + 0] = info.position.x;
      positions[i * 3 + 1] = info.position.y - 0.07;
      positions[i * 3 + 2] = info.position.z;
      phases[i] = i / rig.blades.length;
      strobes[i] = 0;
    });
    // The strobes sit on the spine, one at the nose and one at the tail.
    const n = rig.blades.length;
    positions[n * 3 + 0] = 0;
    positions[n * 3 + 1] = this.height * 0.15;
    positions[n * 3 + 2] = this.span * 0.22;
    phases[n] = 0;
    strobes[n] = 1;
    positions[(n + 1) * 3 + 0] = 0;
    positions[(n + 1) * 3 + 1] = this.height * 0.15;
    positions[(n + 1) * 3 + 2] = -this.span * 0.22;
    phases[n + 1] = 0.5;
    strobes[n + 1] = 1;

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aColor', new BufferAttribute(colors, 3));
    geometry.setAttribute('aPhase', new BufferAttribute(phases, 1));
    geometry.setAttribute('aStrobe', new BufferAttribute(strobes, 1));
    geometry.computeBoundingSphere();

    this.navMaterial = createNavLightsMaterial();
    this.nav = new Points(geometry, this.navMaterial);
    this.nav.layers.set(LAYER.VFX);
    this.nav.renderOrder = 13;
    this.nav.frustumCulled = false;
    this.frame.add(this.nav);
  }

  /** Recolour the lamps from the settings, only when a colour string changes. */
  _syncNavColors(c) {
    if (!this.nav) return;
    if (c.navColorFront === this._navFront && c.navColorBack === this._navBack) return;
    this._navFront = c.navColorFront;
    this._navBack = c.navColorBack;

    const front = getColor(c.navColorFront);
    const back = getColor(c.navColorBack);
    const colors = this.nav.geometry.getAttribute('aColor');
    const positions = this.nav.geometry.getAttribute('position');
    const strobes = this.nav.geometry.getAttribute('aStrobe');
    for (let i = 0; i < colors.count; i++) {
      if (strobes.getX(i) > 0.5) {
        colors.setXYZ(i, 1, 1, 1);
      } else {
        const col = positions.getZ(i) >= 0 ? front : back;
        colors.setXYZ(i, col.r, col.g, col.b);
      }
    }
    colors.needsUpdate = true;
  }

  createParticles() {
    const P = this.ctx.particles;
    this.tracers = P.get('droneTracer', {
      capacity: 256,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.05
    });
    this.sparks = P.get('droneSpark', {
      capacity: 512,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.1
    });
    this.flashes = P.get('droneFlash', { capacity: 64, shape: ParticleShape.GLINT, additive: true });
    this.smoke = P.get('droneSmoke', {
      capacity: 256,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 0.5
    });
    this.casings = P.get('droneCasing', {
      capacity: 128,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.05
    });
    this.dust = P.get('droneDust', {
      capacity: 400,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 0.9
    });
  }

  /* ------------------------------------------------------------------ */
  /* control surface                                                     */
  /* ------------------------------------------------------------------ */

  /** Whether it is on station and answering the stick. */
  get isOnStation() {
    return this.isActive && this.state === DroneState.STATION;
  }

  /**
   * A velocity demand, -1..1 on each axis, screen-relative: +y is away from
   * the camera. Already shaped — the stick and the keys hand this straight in.
   */
  setSteer(x, y) {
    const len = Math.hypot(x, y);
    const k = len > 1 ? 1 / len : 1;
    this.steer.set(x * k, y * k);
  }

  /**
   * The on-screen stick: a dead zone at the centre and an expo curve, so the
   * first few pixels of throw are a creep and not a lunge.
   */
  steerFromStick(x, y) {
    const c = this.config;
    const r = Math.hypot(x, y);
    if (r < 1e-4) return this.setSteer(0, 0);
    const dead = MathUtils.clamp(c.stickDeadZone, 0, 0.9);
    const t = saturate((r - dead) / (1 - dead));
    const k = Math.pow(t, Math.max(0.2, c.stickExpo));
    this.setSteer((x / r) * k, (y / r) * k);
  }

  /**
   * The hand, in NDC. Within `handDeadZone` of the centre it holds — that is
   * the rule that makes an unsteady palm flyable — and it is full stick by
   * `handFullRange`.
   */
  steerFromPointer(pointer) {
    const c = this.config;
    const r = Math.hypot(pointer.x, pointer.y);
    if (r < 1e-4) return this.setSteer(0, 0);
    const dead = MathUtils.clamp(c.handDeadZone, 0, 0.95);
    const full = Math.max(dead + 0.02, c.handFullRange);
    const t = saturate((r - dead) / (full - dead));
    const k = Math.pow(t, Math.max(0.2, c.stickExpo));
    this.setSteer((pointer.x / r) * k, (pointer.y / r) * k);
  }

  /** Fist shut, fire held. */
  setFiring(on) {
    this.firing = !!on && this.state === DroneState.STATION;
  }

  /** Bring it home. It prints out on the way and is gone in `recallTime`. */
  recall() {
    if (!this.isActive || this.state === DroneState.RECALL) return;
    this.state = DroneState.RECALL;
    this.stateTime = 0;
    this.firing = false;
    this.mark = null;
    this.burst = null;
    this.lock = 0;
    this.steer.set(0, 0);
    this._castShadows(false);
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    const c = this.config;

    this.state = DroneState.DEPLOY;
    this.stateTime = 0;
    this.pos.set(this.origin.x, c.launchHeight, this.origin.z);
    this.vel.set(0, 0, 0);
    this.yaw = Math.atan2(this.direction.x, this.direction.z);
    this.pitch = 0;
    this.roll = 0;
    this.spin = 0;
    this.reveal = 0;
    this.ringReveal = 0;
    this.hot = 0;
    this.steer.set(0, 0);
    this.firing = false;
    this.mark = null;
    this.lock = 0;
    this.retargetTimer = 0;
    this.burst = null;
    this.targetsInRange = 0;
    for (const slot of this._pending) slot.live = false;
    this._downwash.reset();
    this._printSparks.reset();

    this.beamTarget.set(this.origin.x, 0, this.origin.z);
    this.beamAt.copy(this.beamTarget);
    this.spotLight = this.ctx.lights.acquire();
    this._castShadows(false);

    this.root.position.copy(this.pos);
    this.root.rotation.set(0, this.yaw, 0);
    this.tilt.rotation.set(0, 0, 0);
    this.reticle.visible = false;
    this.position.copy(this.pos);

    // The arrival: the floor under it takes the downwash before the airframe
    // is even there.
    const g = settings.global;
    const span = this.span * this.scaleK;
    this.frame.scale.setScalar(this.scaleK);
    this.ctx.decals.spawn(DecalType.DUSTRING, this.origin, {
      radius: span * 1.3,
      life: 1.6,
      intensity: 0.6,
      growth: 0.6,
      colorA: getColor('#8a919c'),
      colorB: getColor('#454b55')
    });
    this._puff(this.origin, 36, span * 0.5, 3.2, 1.8, c.downwashSize * 1.3);
    this.ctx.shake.add(c.deployShake * g.cameraShake, 2.2, 18);
  }

  onDestroy() {
    this.ctx.lights.release(this.spotLight);
    this.spotLight = null;
    this.reticle.visible = false;
    this.firing = false;
    this.mark = null;
    this.burst = null;
    this.steer.set(0, 0);
    for (const slot of this._pending) slot.live = false;
    this._castShadows(false);
  }

  _castShadows(on) {
    if (this.shadowsOn === on) return;
    this.shadowsOn = on;
    for (const mesh of this.bodyMeshes) mesh.castShadow = on;
  }

  /* ------------------------------------------------------------------ */
  /* the frame                                                           */
  /* ------------------------------------------------------------------ */

  update(dt) {
    if (!this.isActive) return;
    this.age += dt;
    const c = this.config;

    switch (this.state) {
      case DroneState.DEPLOY:
        this._deploy(dt, c);
        break;
      case DroneState.STATION:
        this._fly(dt, c);
        break;
      case DroneState.RECALL:
        this._recall(dt, c);
        break;
      default:
        break;
    }

    // The body is placed before the hunt reads the muzzle off it, so a round
    // leaves from where the nose is this frame and not where it was last.
    this._animate(dt, c);
    if (this.state === DroneState.STATION) this._hunt(dt, c);
    this._landRounds(c);
    this._aimBeam(dt, c);
    this._dress(c);
    this._emitters(dt, c);
    this._updateLight(dt, this.reveal);
    this._spotLightFrame(dt, c);
  }

  /** Rise, spin up, print in. */
  _deploy(dt, c) {
    this.stateTime += dt;
    const t = saturate(this.stateTime / Math.max(0.05, c.deployTime));

    this.pos.y = MathUtils.lerp(c.launchHeight, c.altitude, Easing.outCubic(t));
    this.reveal = t;
    // The ring snaps out once the airframe is mostly there.
    this.ringReveal = Easing.outBack(saturate((t - 0.45) / 0.55));
    this.spin = saturate(this.stateTime / Math.max(0.05, c.bladeSpinUp));

    if (t >= 1) {
      this.state = DroneState.STATION;
      this.stateTime = 0;
      this.reveal = 1;
      this.ringReveal = 1;
      this._castShadows(true);
    }
  }

  /** Fly home over the caster and print out. */
  _recall(dt, c) {
    this.stateTime += dt;
    const t = saturate(this.stateTime / Math.max(0.05, c.recallTime));

    // Home is over the caster's head. The pull is strong and the velocity is
    // what is damped, so it still banks into the turn back.
    _push.set(this.origin.x - this.pos.x, 0, this.origin.z - this.pos.z);
    const dist = _push.length();
    if (dist > 1e-3) _push.multiplyScalar(Math.min(c.maxSpeed * 1.4, dist * 4) / dist);
    this.vel.x = damp(this.vel.x, _push.x, 0.002, dt);
    this.vel.z = damp(this.vel.z, _push.z, 0.002, dt);
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.pos.y = MathUtils.lerp(c.altitude, c.launchHeight, Easing.inQuad(t));

    this.reveal = 1 - t;
    this.ringReveal = 1 - Easing.inQuad(saturate(t / 0.5));
    this.hot = damp(this.hot, 0, 0.02, dt);

    if (t >= 1) {
      this.phase = AbilityPhase.DONE;
      this.reveal = 0;
    }
  }

  /** The stick becomes a velocity, the velocity becomes a position. */
  _fly(dt, c) {
    // Screen-relative, flattened onto the floor — the same frame the camera's
    // edge pan uses, so "push the hand up" is "away from me" in both.
    const camera = this.ctx.camera;
    _right.setFromMatrixColumn(camera.matrix, 0);
    _right.y = 0;
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    _right.normalize();
    const sx = this.steer.x;
    const sy = this.steer.y;
    _push.set(_right.x * sx + _right.z * sy, 0, _right.z * sx - _right.x * sy);
    _push.multiplyScalar(c.maxSpeed);

    this.vel.x = damp(this.vel.x, _push.x, c.acceleration, dt);
    this.vel.z = damp(this.vel.z, _push.z, c.acceleration, dt);
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    this.pos.y = damp(this.pos.y, c.altitude, 0.05, dt);

    // The leash. Soft: the radial part of the velocity is taken away rather
    // than the whole thing, so it slides round the boundary instead of
    // slamming into it.
    _pos.set(this.pos.x - this.origin.x, 0, this.pos.z - this.origin.z);
    const leash = Math.max(1, c.leash);
    const d = _pos.length();
    if (d > leash) {
      _pos.multiplyScalar(1 / d);
      this.pos.x = this.origin.x + _pos.x * leash;
      this.pos.z = this.origin.z + _pos.z * leash;
      const radial = this.vel.x * _pos.x + this.vel.z * _pos.z;
      if (radial > 0) {
        this.vel.x -= _pos.x * radial;
        this.vel.z -= _pos.z * radial;
      }
    }

    // Heading: onto the target while hunting, else along the velocity.
    if (this.mark) {
      const target = Math.atan2(this.aimPoint.x - this.pos.x, this.aimPoint.z - this.pos.z);
      this.yaw += turnTo(this.yaw, target) * (1 - Math.pow(c.aimTurnRate, dt));
    } else if (this.vel.lengthSq() > 0.6) {
      const target = Math.atan2(this.vel.x, this.vel.z);
      this.yaw += turnTo(this.yaw, target) * (1 - Math.pow(c.turnRate, dt));
    }
  }

  /** Pick, turn, lock, fire. Only while the fist is shut. */
  _hunt(dt, c) {
    const dummies = this.ctx.dummies;
    // Polled every frame for the readout, and it is what the pick reads too.
    const found = dummies?.findTargets?.(this.pos.x, this.pos.z, c.range, this._targets) ?? this._targets;
    this.targetsInRange = found.length;

    this.hot = damp(this.hot, this.firing ? 1 : 0, 0.015, dt);

    if (!this.firing) {
      this.mark = null;
      this.burst = null;
      this.lock = Math.max(0, this.lock - dt * 4);
      this.retargetTimer = c.retarget;
      return;
    }

    // Whoever it was on may have gone down to someone else, or burned away.
    if (this.mark && !this.mark.alive) {
      this.mark = null;
      this.burst = null;
      this.lock = 0;
    }

    if (!this.mark) {
      this.retargetTimer += dt;
      if (this.retargetTimer < c.retarget) return;
      // Nearest first — the field sorts — and only one at a time, which is
      // what makes it read as *choosing*.
      this.mark = found.length ? found[0] : null;
      this.lock = 0;
      if (!this.mark) return;
    }

    this._aimAt(this.aimPoint, this.mark, c);

    // The lock builds only while the nose is on it, and drains when it slips.
    const target = Math.atan2(this.aimPoint.x - this.pos.x, this.aimPoint.z - this.pos.z);
    const error = Math.abs(turnTo(this.yaw, target));
    if (error < c.lockCone) this.lock = Math.min(1, this.lock + dt / Math.max(0.02, c.lockTime));
    else this.lock = Math.max(0, this.lock - dt * 2);

    if (this.lock < 1) return;

    if (!this.burst) this.burst = { fired: 0, timer: 0 };
    const burst = this.burst;
    burst.timer += dt;
    const rounds = Math.max(1, Math.round(c.rounds));
    const interval = Math.max(0.01, c.burstTime) / rounds;
    while (burst.fired < rounds && burst.timer >= burst.fired * interval) {
      this._fireRound(this.mark, c);
      burst.fired += 1;
    }

    if (burst.fired >= rounds && burst.timer >= c.burstTime) {
      // Done with this one. The kill lands on its own when the round does.
      this.burst = null;
      this.mark = null;
      this.lock = 0;
      this.retargetTimer = 0;
    }
  }

  /** Where the shot is aimed: partway up the body, at the chest. */
  _aimAt(out, dummy, c) {
    return out.set(dummy.position.x, settings.dummies.height * saturate(c.aimHeight), dummy.position.z);
  }

  /** One round: a tracer, a flash, a casing, and a hit booked for its arrival. */
  _fireRound(dummy, c) {
    const g = settings.global;
    const time = frame.uTime.value;
    this._muzzle(_muzzle);

    // Aim with a little dispersion, so a burst is a group and not one line.
    this._aimAt(_aim, dummy, c);
    _dir.copy(_aim).sub(_muzzle);
    const dist = Math.max(0.2, _dir.length());
    _dir.multiplyScalar(1 / dist);
    const spread = c.spread * g.randomness;
    _dir.x += (Math.random() - 0.5) * 2 * spread;
    _dir.y += (Math.random() - 0.5) * 2 * spread;
    _dir.z += (Math.random() - 0.5) * 2 * spread;
    _dir.normalize();

    const speed = Math.max(5, c.tracerSpeed);
    const flight = dist / (speed * g.particleSpeed);

    /* the tracer */
    _emit.position.copy(_muzzle);
    _emit.direction.copy(_dir);
    _emit.radius = 0;
    _emit.speed = speed;
    _emit.speedVariance = 0;
    _emit.spread = 0;
    _emit.size = c.tracerSize;
    _emit.sizeVariance = 0.1;
    _emit.life = flight;
    _emit.lifeVariance = 0;
    _emit.spin = 0;
    _emit.time = time;
    this.tracers.emit(1, _emit);

    /* the flash */
    _emit.speed = 0;
    _emit.size = c.muzzleSize;
    _emit.sizeVariance = 0.25;
    _emit.life = 0.07;
    _emit.lifeVariance = 0.3;
    _emit.spin = 6;
    this.flashes.emit(1, _emit);

    /* a breath of smoke off the muzzle */
    _emit.direction.copy(_dir);
    _emit.speed = 1.6;
    _emit.speedVariance = 0.4;
    _emit.spread = 0.35;
    _emit.size = 0.22;
    _emit.sizeVariance = 0.4;
    _emit.life = 0.7;
    _emit.lifeVariance = 0.3;
    _emit.spin = 1.5;
    this.smoke.emit(2, _emit);

    /* the casing, thrown off the right of the nose */
    if (c.casings) {
      _eject.set(Math.cos(this.yaw), 0.9, -Math.sin(this.yaw)).normalize();
      _emit.direction.copy(_eject);
      _emit.speed = 2.6;
      _emit.speedVariance = 0.35;
      _emit.spread = 0.3;
      _emit.size = 0.05;
      _emit.sizeVariance = 0.2;
      _emit.life = 1.6;
      _emit.lifeVariance = 0.2;
      _emit.spin = 14;
      this.casings.emit(1, _emit);
    }

    /* book the hit */
    const slot = this._pending.find((s) => !s.live) ?? this._pending[0];
    slot.live = true;
    slot.at = this.age + flight;
    slot.dummy = dummy;
    const flat = Math.hypot(_dir.x, _dir.z);
    slot.dirX = flat > 1e-4 ? _dir.x / flat : Math.sin(this.yaw);
    slot.dirZ = flat > 1e-4 ? _dir.z / flat : Math.cos(this.yaw);
    slot.point.copy(_muzzle).addScaledVector(_dir, dist);

    this.lightBoost = Math.max(this.lightBoost, c.muzzleLight * g.explosionIntensity);
    this.ctx.shake.add(c.fireShake * g.explosionIntensity * g.cameraShake, 5.0, 30);
    if (c.fireFlash > 0) this.ctx.flash.trigger(getColor(c.colorFlash), c.fireFlash * g.explosionIntensity);
  }

  /** Rounds arrive; the first one to land on a standing body fells it. */
  _landRounds(c) {
    const g = settings.global;
    const time = frame.uTime.value;

    for (const slot of this._pending) {
      if (!slot.live || this.age < slot.at) continue;
      slot.live = false;

      const dummy = slot.dummy;
      slot.dummy = null;
      const point = slot.point;

      /* sparks off the hit, thrown back along the shot and up */
      _emit.position.copy(point);
      _emit.direction.set(-slot.dirX, 1.1, -slot.dirZ).normalize();
      _emit.radius = 0.08;
      _emit.speed = 5.5;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.85;
      _emit.size = 0.05;
      _emit.sizeVariance = 0.5;
      _emit.life = 0.4;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.time = time;
      this.sparks.emit(Math.max(0, Math.round(c.impactSparks * g.particleCount)), _emit);

      _emit.speed = 0;
      _emit.size = 0.35;
      _emit.life = 0.08;
      this.flashes.emit(1, _emit);

      _emit.direction.set(0, 1, 0);
      _emit.speed = 0.8;
      _emit.spread = 0.9;
      _emit.size = 0.3;
      _emit.life = 0.9;
      this.smoke.emit(3, _emit);

      if (!dummy || !dummy.alive) continue;
      if (!dummy.kill(slot.dirX, slot.dirZ, c.hit)) continue;

      this.ctx.bursts.spawn(BurstMode.AIR, point, {
        radius: 0.12,
        endRadius: 1.1,
        life: 0.3,
        intensity: 1.2 * g.explosionIntensity,
        opacity: 0.6,
        displace: 0.2
      });
      if (c.scorch) {
        _pos.set(dummy.position.x, 0, dummy.position.z);
        this.ctx.decals.spawn(DecalType.SCORCH, _pos, {
          radius: 0.6,
          life: 3.0,
          intensity: 0.5,
          colorA: getColor(c.colorSpark)
        });
      }
      this.ctx.shake.add(c.fireShake * 1.5 * g.explosionIntensity * g.cameraShake, 3.0, 22);
    }
  }

  /** Where rounds leave from: the socket, in the world, wherever the nose is. */
  _muzzle(out) {
    if (this.rig) out.copy(this.rig.socket);
    else out.set(0, 0, 0.3);
    return this.frame.localToWorld(out);
  }

  /* ------------------------------------------------------------------ */
  /* the body                                                            */
  /* ------------------------------------------------------------------ */

  /** Hover, bank, spin — and place the airframe. */
  _animate(dt, c) {
    const t = this.age;

    // Bank into the velocity: forward speed dips the nose, sideways speed
    // drops a shoulder. In the body's own frame.
    const fwdX = Math.sin(this.yaw);
    const fwdZ = Math.cos(this.yaw);
    const rgtX = Math.cos(this.yaw);
    const rgtZ = -Math.sin(this.yaw);
    const maxSpeed = Math.max(0.1, c.maxSpeed);
    const vf = (this.vel.x * fwdX + this.vel.z * fwdZ) / maxSpeed;
    const vr = (this.vel.x * rgtX + this.vel.z * rgtZ) / maxSpeed;

    let pitchTarget = vf * c.bank;
    // And onto the target: the nose comes down to look at what it is shooting.
    if (this.mark) {
      const dx = this.aimPoint.x - this.pos.x;
      const dz = this.aimPoint.z - this.pos.z;
      const dy = this.pos.y - this.aimPoint.y;
      const down = Math.atan2(dy, Math.max(0.5, Math.hypot(dx, dz)));
      pitchTarget += Math.min(down, 1.2) * c.aimPitch * this.lock;
    }
    const rollTarget = -vr * c.bank;
    this.pitch = damp(this.pitch, pitchTarget, c.bankRate, dt);
    this.roll = damp(this.roll, rollTarget, c.bankRate, dt);

    // The hover: a slow bob and a wobble that never quite repeats.
    const bob = Math.sin(t * c.hoverFrequency * TAU) * c.hoverAmplitude * this.reveal;
    const swayX = (Math.sin(t * c.swaySpeed * 1.31 + 1.7) + 0.5 * Math.sin(t * c.swaySpeed * 2.9)) * c.sway;
    const swayZ = (Math.sin(t * c.swaySpeed * 0.93) + 0.5 * Math.sin(t * c.swaySpeed * 2.3 + 0.8)) * c.sway;

    this.root.position.set(this.pos.x, this.pos.y + bob, this.pos.z);
    this.root.rotation.set(0, this.yaw, 0);
    this.tilt.rotation.set(this.pitch + swayX, 0, this.roll + swayZ);
    this.frame.scale.setScalar(this.scaleK);
    this.position.copy(this.root.position);

    // The rotors.
    this.bladeAngle += c.bladeSpeed * this.spin * TAU * dt * settings.global.animationSpeed;
    const counter = c.counterRotate;
    for (const blade of this.blades) {
      blade.node.rotation.y = this.bladeAngle * (counter ? blade.sign : 1) + blade.phase;
    }
    const blur = c.bladeBlur * MathUtils.smoothstep(this.spin, 0.25, 0.85) * this.reveal;
    for (const rotor of this.rotors) {
      rotor.material.uniforms.uBlur.value = blur;
      rotor.material.uniforms.uSpin.value = c.bladeSpeed * this.spin;
      rotor.material.uniforms.uOpacity.value = settings.global.opacity;
    }

    // The muzzle and the beam apex are read off this transform this frame, so
    // it has to be current before they are.
    this.root.updateMatrixWorld(true);
  }

  /** Where the searchlight is looking, and the cone that shows it. */
  _aimBeam(dt, c) {
    const t = this.age;
    // Onto the mark while hunting; under the drone otherwise, with a slow
    // circling scan so it is never a static prop. Hunting with nothing in
    // range widens the scan — it is looking for something.
    if (this.mark) {
      this.beamTarget.set(this.mark.position.x, 0, this.mark.position.z);
    } else {
      const scan = this.firing ? 2.2 : 0.7;
      const rate = this.firing ? 1.6 : 0.5;
      this.beamTarget.set(
        this.pos.x + Math.sin(t * rate) * scan,
        0,
        this.pos.z + Math.cos(t * rate * 0.83) * scan
      );
    }
    const swing = this.mark ? c.beamSwing : c.beamSwing * 8;
    this.beamAt.x = damp(this.beamAt.x, this.beamTarget.x, swing, dt);
    this.beamAt.z = damp(this.beamAt.z, this.beamTarget.z, swing, dt);
    this.beamAt.y = 0;

    // The cone: apex under the body, rim on the floor at the target.
    _pos.copy(this.root.position);
    _pos.y -= this.height * this.scaleK * BEAM_APEX;
    _dir.copy(this.beamAt).sub(_pos);
    const length = Math.max(0.2, _dir.length());
    _dir.multiplyScalar(1 / length);
    const radius = Math.tan(MathUtils.degToRad(Math.max(1, c.beamAngle))) * length;

    this.beam.position.copy(_pos);
    this.beam.quaternion.setFromUnitVectors(DRONE_FORWARD, _dir);
    this.beam.scale.set(radius, radius, length);

    this.spot.position.set(this.beamAt.x, 0.025, this.beamAt.z);
    this.spot.scale.setScalar(radius * 2.4);
  }

  /** Push the settings into every uniform, every frame. */
  _dress(c) {
    const g = settings.global;
    const opacity = g.opacity;

    /* the body */
    if (this.bodyMaterial) {
      const u = this.bodyMaterial.userData.droneUniforms;
      // The plane climbs from just under the airframe to just over it, riding
      // with the body as it rises.
      const height = this.height * this.scaleK;
      const bottom = this.root.position.y - height * 0.5 - 0.05;
      u.uRevealY.value = bottom + (height + 0.3) * this.reveal;
      u.uRevealWidth.value = Math.max(0.005, c.revealWidth);
      u.uRevealColor.value.copy(getColor(c.revealColor));
      u.uRevealGlow.value = c.revealGlow * g.glow;
      u.uRimColor.value.copy(getColor(c.rimColor));
      u.uRimStrength.value = c.rimStrength * g.fresnel;
      u.uRimPower.value = c.rimPower;
    }

    /* the lamps */
    if (this.navMaterial) {
      this._syncNavColors(c);
      const u = this.navMaterial.uniforms;
      u.uSize.value = c.navSize;
      u.uStrobeRate.value = c.strobeRate;
      u.uIntensity.value = c.navLights * g.glow * MathUtils.smoothstep(this.reveal, 0.6, 1);
    }

    /* the ring */
    {
      const u = this.ringMaterial.uniforms;
      const quad = (c.range + c.ringTickLength + 1) * 2;
      u.uQuadSize.value = quad;
      u.uRadius.value = c.range;
      u.uWidth.value = c.ringWidth;
      u.uGlow.value = c.ringGlow;
      u.uSoftness.value = c.ringSoftness;
      u.uFill.value = c.ringFill;
      u.uTicks.value = Math.max(0, Math.round(c.ringTicks));
      u.uTickLength.value = c.ringTickLength;
      u.uTickWidth.value = c.ringTickWidth;
      u.uTickSpin.value = c.ringTickSpin;
      u.uSweep.value = c.ringSweep;
      u.uSweepSpeed.value = c.ringSweepSpeed;
      u.uPulse.value = c.ringPulse;
      u.uHot.value = this.hot;
      u.uReveal.value = this.ringReveal;
      u.uOpacity.value = c.ringOpacity * opacity;
      u.uColor.value.copy(getColor(c.colorRing));
      u.uColorHot.value.copy(getColor(c.colorRingHot));
      this.ring.position.set(this.pos.x, 0.03, this.pos.z);
      this.ring.scale.setScalar(quad);
      this.ring.visible = this.ringReveal > 0.001;
    }

    /* the searchlight */
    {
      const u = this.beamMaterial.uniforms;
      u.uIntensity.value = c.beamIntensity * this.reveal * g.shaderIntensity;
      u.uEdge.value = c.beamEdge;
      u.uFalloff.value = c.beamFalloff;
      u.uNoise.value = c.beamNoise;
      u.uNoiseScale.value = c.beamNoiseScale;
      u.uHot.value = this.hot;
      u.uOpacity.value = opacity;
      u.uColor.value.copy(getColor(c.colorBeam));
      u.uColorHot.value.copy(getColor(c.colorBeamHot));
      this.beam.visible = this.reveal > 0.05;

      const s = this.spotMaterial.uniforms;
      s.uIntensity.value = c.spotIntensity * this.reveal * g.shaderIntensity;
      s.uHot.value = this.hot;
      s.uOpacity.value = opacity;
      s.uColor.value.copy(getColor(c.colorBeam));
      s.uColorHot.value.copy(getColor(c.colorBeamHot));
      this.spot.visible = this.beam.visible;
    }

    /* the reticle */
    if (this.mark) {
      const u = this.reticleMaterial.uniforms;
      u.uLock.value = this.lock;
      u.uIntensity.value = c.reticleGlow * g.glow;
      u.uOpacity.value = opacity;
      u.uColor.value.copy(getColor(c.colorReticle));
      u.uColorLocked.value.copy(getColor(c.colorLocked));
      this.reticle.position.copy(this.aimPoint);
      this.reticle.quaternion.copy(this.ctx.camera.quaternion);
      this.reticle.scale.setScalar(c.reticleSize);
      this.reticle.visible = true;
    } else {
      this.reticle.visible = false;
    }

    /* the particle systems — shared, so re-dressed every frame */
    {
      const u = this.tracers.uniforms;
      this.tracers.setGradient(getColor(c.colorTracer), getColor(c.colorTracer), getColor(c.colorTracerTail), getColor(c.colorTracerTail));
      u.uGravity.value.set(0, 0, 0);
      u.uDrag.value = 0.001;
      u.uTurbulence.value = 0;
      u.uStretch.value = Math.max(0, (c.tracerLength / Math.max(0.01, c.tracerSize) - 1) / Math.max(5, c.tracerSpeed));
      u.uEndSize.value = 1;
      u.uSizeIn.value = 0.001;
      u.uFadeIn.value = 0.0;
      u.uFadeOut.value = 0.92;
      u.uGlow.value = 2.4 * g.glow;
      u.uOpacity.value = opacity;
    }
    {
      const u = this.sparks.uniforms;
      this.sparks.setGradient(getColor('#ffffff'), getColor(c.colorSpark), getColor(c.colorTracerTail), getColor('#3a1a08'));
      u.uGravity.value.set(0, -14, 0);
      u.uDrag.value = 1.8;
      u.uTurbulence.value = 0.15;
      u.uStretch.value = 0.09;
      u.uEndSize.value = 0.3;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = 1.8 * g.glow;
      u.uOpacity.value = opacity;
    }
    {
      const u = this.flashes.uniforms;
      this.flashes.setGradient(getColor('#ffffff'), getColor(c.colorFlash), getColor(c.colorTracerTail), getColor(c.colorTracerTail));
      u.uGravity.value.set(0, 0, 0);
      u.uDrag.value = 1;
      u.uTurbulence.value = 0;
      u.uEndSize.value = 1.6;
      u.uSizeIn.value = 0.001;
      u.uFadeIn.value = 0;
      u.uFadeOut.value = 0.3;
      u.uGlow.value = 2.2 * g.glow;
      u.uOpacity.value = opacity;
    }
    {
      const u = this.smoke.uniforms;
      this.smoke.setGradient(getColor('#8c8c8c'), getColor('#5a5f66'), getColor('#3a3e44'), getColor('#26292e'));
      u.uGravity.value.set(0, 0.6, 0);
      u.uDrag.value = 2.2;
      u.uTurbulence.value = 0.4;
      u.uTurbFrequency.value = 1.2;
      u.uEndSize.value = 2.6;
      u.uFadeIn.value = 0.1;
      u.uFadeOut.value = 0.4;
      u.uGlow.value = 0.3;
      u.uOpacity.value = 0.35 * opacity;
    }
    {
      const u = this.casings.uniforms;
      this.casings.setGradient(getColor('#e8b45a'), getColor('#c99a3f'), getColor('#a37a2c'), getColor('#6b4d18'));
      u.uGravity.value.set(0, -14, 0);
      u.uDrag.value = 0.3;
      u.uTurbulence.value = 0;
      u.uEndSize.value = 1;
      u.uFadeIn.value = 0;
      u.uFadeOut.value = 0.9;
      u.uGlow.value = 0.35;
      u.uOpacity.value = opacity;
    }
    {
      const u = this.dust.uniforms;
      this.dust.setGradient(getColor('#6f7580'), getColor('#575d67'), getColor('#3d434c'), getColor('#2a2f36'));
      u.uGravity.value.set(0, 0.25, 0);
      u.uDrag.value = 1.4;
      u.uTurbulence.value = 0.5;
      u.uTurbFrequency.value = 0.8;
      u.uEndSize.value = 2.8;
      u.uFadeIn.value = 0.12;
      u.uFadeOut.value = 0.35;
      u.uGlow.value = 0.25;
      u.uOpacity.value = 0.32 * opacity;
    }
  }

  /** Dust off the floor under it, and sparks off the print plane. */
  _emitters(dt, c) {
    const g = settings.global;
    const time = frame.uTime.value;

    /* downwash */
    // Stronger the lower it is; at station it is a steady stir.
    const height = this.root.position.y;
    const span = this.span * this.scaleK;
    const wash = c.downwash * (1 - saturate((height - 1.2) / 8)) * this.spin * this.reveal;
    const count = this._downwash.tick(dt, wash * g.particleCount);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      _emit.position.set(
        this.pos.x + Math.cos(a) * span * 0.35,
        0.06,
        this.pos.z + Math.sin(a) * span * 0.35
      );
      _emit.direction.set(Math.cos(a), 0.12, Math.sin(a));
      _emit.radius = 0.15;
      _emit.speed = 2.0;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.25;
      _emit.size = c.downwashSize;
      _emit.sizeVariance = 0.5;
      _emit.life = 1.6;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.6;
      _emit.time = time;
      this.dust.emit(1, _emit);
    }

    /* the print plane */
    if (this.reveal > 0.02 && this.reveal < 0.98) {
      const y = this.bodyMaterial?.userData.droneUniforms.uRevealY.value ?? this.root.position.y;
      const n = this._printSparks.tick(dt, 40 * g.particleCount);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU;
        const r = Math.sqrt(Math.random()) * span * 0.5;
        _emit.position.set(this.pos.x + Math.cos(a) * r, y, this.pos.z + Math.sin(a) * r);
        _emit.direction.set(0, 1, 0);
        _emit.radius = 0.02;
        _emit.speed = 0.4;
        _emit.speedVariance = 0.5;
        _emit.spread = 0.8;
        _emit.size = 0.09;
        _emit.sizeVariance = 0.5;
        _emit.life = 0.35;
        _emit.lifeVariance = 0.5;
        _emit.spin = 4;
        _emit.time = time;
        this.flashes.emit(1, _emit);
      }
    }
  }

  /** A gout of floor dust: the arrival, and anything else that stirs it. */
  _puff(at, count, radius, speed, life, size) {
    const time = frame.uTime.value;
    const n = Math.round(count * settings.global.particleCount);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * TAU;
      _emit.position.set(at.x + Math.cos(a) * radius * 0.4, 0.08, at.z + Math.sin(a) * radius * 0.4);
      _emit.direction.set(Math.cos(a), 0.2, Math.sin(a));
      _emit.radius = 0.1;
      _emit.speed = speed;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.3;
      _emit.size = size;
      _emit.sizeVariance = 0.5;
      _emit.life = life;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.8;
      _emit.time = time;
      this.dust.emit(1, _emit);
    }
  }

  /** The light in the searchlight's pool on the floor. */
  _spotLightFrame(dt, c) {
    if (!this.spotLight) return;
    _pos.set(this.beamAt.x, 0.7, this.beamAt.z);
    this.lightColor.copy(getColor(c.colorBeam)).lerp(getColor(c.colorBeamHot), this.hot);
    this.ctx.lights.set(
      this.spotLight,
      _pos,
      this.lightColor,
      c.spotLight * this.reveal,
      c.spotLightRadius,
      dt
    );
  }

  /** A slow breath rather than a flicker: it is an aircraft, not a torch. */
  lightShimmer() {
    return 0.94 + 0.06 * Math.sin(this.age * 2.1);
  }

  dispose() {
    super.dispose();
    this.bodyMaterial?.dispose();
    this.ringMaterial.dispose();
    this.beamMaterial.dispose();
    this.spotMaterial.dispose();
    this.reticleMaterial.dispose();
    this.navMaterial?.dispose();
    for (const rotor of this.rotors) rotor.material.dispose();
  }
}
