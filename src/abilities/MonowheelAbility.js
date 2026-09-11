import { Group, MathUtils, Mesh, PlaneGeometry, Vector2, Vector3 } from 'three';
import { Ability, AbilityPhase } from './Ability.js';
import { DroneState } from './DroneAbility.js';
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
  patchDroneBody
} from '../materials/DroneMaterials.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { Easing, damp, saturate } from '../utils/math.js';

const TAU = Math.PI * 2;
/** Rounds whose flight is still in the air, at most. */
const MAX_PENDING = 16;

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
 * THE MONOWHEEL BOT — the drone's principle, on the ground.
 *
 * A second summon. Press the slot and an armoured one-wheeled sentry prints
 * itself in on the floor in front of the caster, balances up and waits. It
 * stays until it is recalled, and while it is out the other slots are locked
 * — the caster is driving it. Every control the drone answers, this answers,
 * so `App` flies both through one deck; the difference is what the control
 * *means* to a machine that cannot leave the floor:
 *
 *   1. **The drive.** The stick is still a screen-relative demand, but a
 *      wheel cannot strafe. Free, the bot **turns to face the stick** and
 *      drives along its heading — throttle scaled by how squarely it is
 *      facing the demand, so a push behind it is a pivot first and a run
 *      second. Locked onto a target it faces the target instead, and the
 *      stick becomes a tank's: forward closes, back backs off.
 *   2. **The wheel.** `Tire` rolls by exactly the distance travelled — the
 *      angle is the arc length over the radius the rig measured — so the
 *      tread never slides, at any size or speed the editor sets.
 *   3. **The balance.** It is a self-balancing machine, and that is what
 *      sells it: the hull leans forward to accelerate, leans into every turn,
 *      rocks back on each round it fires, and never quite holds still.
 *   4. **The guns.** Two sockets on the nose, one each side. A burst
 *      alternates them, each round with its own muzzle flash — a hot core, a
 *      flame of streaks out of the barrel, a punch of light — and a casing
 *      thrown out of its own side.
 *   5. **The show.** The range ring and the reticle the drone draws; a
 *      headlamp cone off the nose in place of the searchlight, which swings
 *      onto whatever it is about to shoot; dust off the tread.
 *
 * It answers `handlesOwnHits` for the same reason the drone does: there is
 * no front, and it has to be the thing that says which body, and when.
 *
 * Nothing about the model is known here: `MonowheelRig` hands over a
 * normalised chassis, the tire node and the two muzzle points, and that is
 * the whole contract. The state machine is the drone's (`DroneState`), so
 * everything in `App` that reads one reads the other.
 */
export class MonowheelAbility extends Ability {
  constructor(context) {
    super('monowheel', context);
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
    return this.rig ? this.config.size / Math.max(0.01, this.rig.height) : 1;
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
    const rig = this.ctx.models?.monowheel ?? null;
    this.rig = rig;

    // root: the contact patch, and which way it faces. tilt: the lean, about
    // the axle. frame: the chassis itself, in rig metres.
    this.root = new Group();
    this.root.name = 'MonowheelRoot';
    this.tilt = new Group();
    this.tilt.name = 'MonowheelTilt';
    this.frame = new Group();
    this.frame.name = 'MonowheelFrame';
    this.root.add(this.tilt);
    this.tilt.add(this.frame);
    this.group.add(this.root);

    this.bodyMaterial = null;
    this.bodyMeshes = [];
    this.wheelNode = null;
    this.wheelBase = 0;
    this.height = 1.7;
    this.length = 1.9;
    this.width = 1.1;
    this.sockets = [new Vector3(0, 0.8, 0.9)];
    this.axle = new Vector3(0, 0.6, 0);
    this.wheelRadius = 0.6;

    if (rig) {
      this.height = rig.height;
      this.length = rig.length;
      this.width = rig.width;
      this.sockets = rig.sockets;
      if (rig.wheel) {
        this.axle.copy(rig.wheel.axle);
        this.wheelRadius = rig.wheel.radius;
      }

      const clone = rig.source.clone(true);
      clone.traverse((node) => {
        if (!node.isMesh) return;
        // One material per bot, so the reveal of one can never print out
        // another. The export's meshes share a material, so this is one
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

      if (rig.wheel) {
        this.wheelNode = clone.getObjectByName(rig.wheel.name) ?? null;
        this.wheelBase = this.wheelNode?.rotation.x ?? 0;
      }
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

    /* ---- the headlamp, and its pool on the floor ---- */
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
    /** Commanded position, on the floor. */
    this.pos = new Vector3();
    /** Metres/second along the heading. Signed: it can back up. */
    this.speed = 0;
    this.yaw = 0;
    this.yawRate = 0;
    this.pitch = 0;
    this.roll = 0;
    /** The recoil rock: a spring, kicked by every round. */
    this.kick = 0;
    this.kickVel = 0;
    /** Radians the tire has rolled. */
    this.wheelAngle = 0;
    /** 0 nothing printed → 1 whole chassis. */
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
    /** Which socket fires next. */
    this.socketIndex = 0;
    this.aimPoint = new Vector3();
    this.beamTarget = new Vector3();
    this.beamAt = new Vector3();
    this.lightAt = new Vector3();
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

    this._treadDust = new RateEmitter(20);
    this._printSparks = new RateEmitter(30);
  }

  createParticles() {
    const P = this.ctx.particles;
    this.tracers = P.get('botTracer', {
      capacity: 256,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.05
    });
    this.sparks = P.get('botSpark', {
      capacity: 512,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.1
    });
    this.flashes = P.get('botFlash', { capacity: 64, shape: ParticleShape.GLINT, additive: true });
    // The flame out of the barrel: short, fat streaks that stop almost at
    // once. Its own system because it wants drag and stretch the sparks and
    // the tracers do not.
    this.muzzle = P.get('botMuzzle', {
      capacity: 128,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.05
    });
    this.smoke = P.get('botSmoke', {
      capacity: 256,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 0.5
    });
    this.casings = P.get('botCasing', {
      capacity: 128,
      shape: ParticleShape.CHIP,
      additive: false,
      lit: true,
      softFade: 0.05
    });
    this.dust = P.get('botDust', {
      capacity: 400,
      shape: ParticleShape.SMOKE,
      additive: false,
      curl: true,
      softFade: 0.9
    });
  }

  /* ------------------------------------------------------------------ */
  /* control surface — the drone's, verbatim, so one deck drives both    */
  /* ------------------------------------------------------------------ */

  /** Whether it is on station and answering the stick. */
  get isOnStation() {
    return this.isActive && this.state === DroneState.STATION;
  }

  /**
   * Who is standing in the ring this frame, nearest first — the list the hunt
   * reads. The HUD draws a box on each; `mark` is the one it has chosen.
   */
  get targets() {
    return this._targets;
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

  /** The on-screen stick: a dead zone at the centre and an expo curve. */
  steerFromStick(x, y) {
    const c = this.config;
    const r = Math.hypot(x, y);
    if (r < 1e-4) return this.setSteer(0, 0);
    const dead = MathUtils.clamp(c.stickDeadZone, 0, 0.9);
    const t = saturate((r - dead) / (1 - dead));
    const k = Math.pow(t, Math.max(0.2, c.stickExpo));
    this.setSteer((x / r) * k, (y / r) * k);
  }

  /** The hand, in NDC: holds within `handDeadZone`, full stick by `handFullRange`. */
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

  /** Stand it down. It brakes and prints out where it is, gone in `recallTime`. */
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
    // On the floor, a little way out along the caster's facing — it is a
    // vehicle, and it arrives in front of its operator.
    this.pos.copy(this.origin).addScaledVector(this.direction, Math.max(0, c.deployDistance));
    this.pos.y = 0;
    this.speed = 0;
    this.yaw = Math.atan2(this.direction.x, this.direction.z);
    this.yawRate = 0;
    this.pitch = 0;
    this.roll = 0;
    this.kick = 0;
    this.kickVel = 0;
    this.wheelAngle = 0;
    this.reveal = 0;
    this.ringReveal = 0;
    this.hot = 0;
    this.steer.set(0, 0);
    this.firing = false;
    this.mark = null;
    this.lock = 0;
    this.retargetTimer = 0;
    this.burst = null;
    this.socketIndex = 0;
    this.targetsInRange = 0;
    for (const slot of this._pending) slot.live = false;
    this._treadDust.reset();
    this._printSparks.reset();

    this.beamTarget.copy(this.pos).addScaledVector(this.direction, c.headlightReach);
    this.beamAt.copy(this.beamTarget);
    this.spotLight = this.ctx.lights.acquire();
    this._castShadows(false);

    this.root.position.copy(this.pos);
    this.root.rotation.set(0, this.yaw, 0);
    this.tilt.rotation.set(0, 0, 0);
    this.reticle.visible = false;
    this.position.copy(this.pos);
    this._placeFrame();

    // The arrival: the floor takes a ring of dust before the hull is there.
    const g = settings.global;
    const span = this.length * this.scaleK;
    this.ctx.decals.spawn(DecalType.DUSTRING, this.pos, {
      radius: span * 1.1,
      life: 1.6,
      intensity: 0.6,
      growth: 0.6,
      colorA: getColor('#8a919c'),
      colorB: getColor('#454b55')
    });
    this._puff(this.pos, 30, span * 0.45, 2.8, 1.8, c.treadDustSize * 1.3);
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
        this._drive(dt, c);
        break;
      case DroneState.RECALL:
        this._recall(dt, c);
        break;
      default:
        break;
    }

    // The hull is placed before the hunt reads a muzzle off it, so a round
    // leaves from where the nose is this frame and not where it was last.
    this._animate(dt, c);
    if (this.state === DroneState.STATION) this._hunt(dt, c);
    this._landRounds(c);
    this._aimBeam(dt, c);
    this._dress(c);
    this._emitters(dt, c);
    this._bodyLight(dt, c);
    this._spotLightFrame(dt, c);
  }

  /** Print in, on the spot. */
  _deploy(dt, c) {
    this.stateTime += dt;
    const t = saturate(this.stateTime / Math.max(0.05, c.deployTime));

    this.reveal = t;
    // The ring snaps out once the hull is mostly there.
    this.ringReveal = Easing.outBack(saturate((t - 0.45) / 0.55));

    if (t >= 1) {
      this.state = DroneState.STATION;
      this.stateTime = 0;
      this.reveal = 1;
      this.ringReveal = 1;
      this._castShadows(true);
    }
  }

  /** Brake, and print out where it stands. */
  _recall(dt, c) {
    this.stateTime += dt;
    const t = saturate(this.stateTime / Math.max(0.05, c.recallTime));

    this.speed = damp(this.speed, 0, 0.01, dt);
    this._roll(this.speed * dt);
    this.pos.x += Math.sin(this.yaw) * this.speed * dt;
    this.pos.z += Math.cos(this.yaw) * this.speed * dt;
    this.yawRate = damp(this.yawRate, 0, 0.01, dt);

    this.reveal = 1 - t;
    this.ringReveal = 1 - Easing.inQuad(saturate(t / 0.5));
    this.hot = damp(this.hot, 0, 0.02, dt);

    if (t >= 1) {
      this.phase = AbilityPhase.DONE;
      this.reveal = 0;
    }
  }

  /**
   * The stick becomes a heading and a throttle, the throttle a speed along
   * the heading, and the speed a position — and a roll of the tire.
   */
  _drive(dt, c) {
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
    const demand = Math.min(1, _push.length());

    const fwdX = Math.sin(this.yaw);
    const fwdZ = Math.cos(this.yaw);

    let yawTarget = this.yaw;
    let throttle = 0;
    let rate = c.turnRate;
    if (this.mark) {
      // Facing the target, whatever the stick says. The stick is a tank's:
      // the part of it along the heading is the throttle, forward or back.
      yawTarget = Math.atan2(this.aimPoint.x - this.pos.x, this.aimPoint.z - this.pos.z);
      rate = c.aimTurnRate;
      throttle = demand > 1e-3 ? (_push.x * fwdX + _push.z * fwdZ) : 0;
    } else if (demand > 0.02) {
      // Turn to face the stick, and only drive as squarely as it is facing:
      // a push behind it is a pivot first and a run second, not a slide.
      yawTarget = Math.atan2(_push.x, _push.z);
      const error = turnTo(this.yaw, yawTarget);
      throttle = demand * Math.max(0, Math.cos(error));
    }

    const before = this.yaw;
    this.yaw += turnTo(this.yaw, yawTarget) * (1 - Math.pow(rate, dt));
    // The lean into a turn reads this, so it is smoothed rather than raw.
    const rawRate = dt > 1e-5 ? turnTo(before, this.yaw) / dt : 0;
    this.yawRate = damp(this.yawRate, MathUtils.clamp(rawRate, -8, 8), 0.02, dt);

    this.speed = damp(this.speed, throttle * c.maxSpeed, c.acceleration, dt);

    const headX = Math.sin(this.yaw);
    const headZ = Math.cos(this.yaw);
    const step = this.speed * dt;
    this.pos.x += headX * step;
    this.pos.z += headZ * step;

    // The leash. Soft: it stops against the fence rather than bouncing off
    // it, and a heading that is only partly outward still slides along.
    _pos.set(this.pos.x - this.origin.x, 0, this.pos.z - this.origin.z);
    const leash = Math.max(1, c.leash);
    const d = _pos.length();
    if (d > leash) {
      _pos.multiplyScalar(1 / d);
      this.pos.x = this.origin.x + _pos.x * leash;
      this.pos.z = this.origin.z + _pos.z * leash;
      const facing = headX * _pos.x + headZ * _pos.z;
      if (facing * this.speed > 0) this.speed *= 1 - Math.abs(facing);
    }

    this._roll(step);
  }

  /** Roll the tire by a distance along the floor. */
  _roll(distance) {
    const radius = Math.max(0.01, this.wheelRadius * this.scaleK);
    this.wheelAngle += distance / radius;
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
      // Nearest first — the field sorts — and only one at a time.
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

  /**
   * One round, from the next socket along: a tracer, the muzzle flash, a
   * casing out of that side, a kick to the hull, and a hit booked for the
   * round's arrival.
   */
  _fireRound(dummy, c) {
    const g = settings.global;
    const time = frame.uTime.value;
    const which = this.socketIndex;
    this.socketIndex = (this.socketIndex + 1) % this.sockets.length;
    this._muzzle(_muzzle, which);

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

    // The round is done at the body's *skin*, not its centre: a burst that
    // lands inside the mesh throws its sparks out of the far side.
    const reach = Math.max(0.1, dist - settings.dummies.bodyRadius);
    const speed = Math.max(5, c.tracerSpeed);
    const flight = reach / (speed * g.particleSpeed);

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

    /* the flash: a hot core on the muzzle... */
    _emit.speed = 0;
    _emit.size = c.muzzleSize;
    _emit.sizeVariance = 0.25;
    _emit.life = 0.07;
    _emit.lifeVariance = 0.3;
    _emit.spin = 6;
    this.flashes.emit(1, _emit);

    /* ...and a flame out of the barrel, a fan of streaks along the shot */
    _emit.direction.copy(_dir);
    _emit.radius = 0.02;
    _emit.speed = c.muzzleLength / 0.06;
    _emit.speedVariance = 0.35;
    _emit.spread = 0.22;
    _emit.size = c.muzzleSize * 0.28;
    _emit.sizeVariance = 0.4;
    _emit.life = 0.08;
    _emit.lifeVariance = 0.35;
    _emit.spin = 0;
    this.muzzle.emit(Math.max(0, Math.round(c.muzzleStreaks)), _emit);

    /* a breath of smoke off the muzzle */
    _emit.radius = 0;
    _emit.speed = 1.6;
    _emit.speedVariance = 0.4;
    _emit.spread = 0.35;
    _emit.size = 0.22;
    _emit.sizeVariance = 0.4;
    _emit.life = 0.7;
    _emit.lifeVariance = 0.3;
    _emit.spin = 1.5;
    this.smoke.emit(2, _emit);

    /* the casing, out of the side that fired */
    if (c.casings) {
      // Left socket throws left, right throws right; in the hull's own frame,
      // and +X is the left side of a nose that points down +Z.
      const side = this.sockets[which].x >= 0 ? 1 : -1;
      _eject.set(Math.cos(this.yaw) * side, 0.9, -Math.sin(this.yaw) * side).normalize();
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
    slot.point.copy(_muzzle).addScaledVector(_dir, reach);

    /* the hull rocks back on its wheel */
    this.kickVel -= c.recoil * 30;

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

  /** Where rounds leave from: socket `which`, in the world, wherever the nose is. */
  _muzzle(out, which = 0) {
    out.copy(this.sockets[which % this.sockets.length]);
    return this.frame.localToWorld(out);
  }

  /** The point between the sockets: where the headlamp and the body light sit. */
  _nose(out) {
    out.set(0, 0, 0);
    for (const socket of this.sockets) out.add(socket);
    out.multiplyScalar(1 / this.sockets.length);
    return this.frame.localToWorld(out);
  }

  /* ------------------------------------------------------------------ */
  /* the body                                                            */
  /* ------------------------------------------------------------------ */

  /** The lean, the balance, the recoil, the wheel — and place the chassis. */
  _animate(dt, c) {
    const t = this.age;
    const maxSpeed = Math.max(0.1, c.maxSpeed);
    const vf = this.speed / maxSpeed;

    // Lean forward to go forward, the way a self-balancing machine has to,
    // and lean into every turn the faster it is taking it.
    const pitchTarget = vf * c.lean;
    const rollTarget = -this.yawRate * vf * c.bankIntoTurns;
    this.pitch = damp(this.pitch, pitchTarget, c.leanRate, dt);
    this.roll = damp(this.roll, rollTarget, c.leanRate, dt);

    // The recoil spring: kicked by every round, rocking back on the wheel and
    // settling in a couple of bounces.
    this.kickVel += (-this.kick * 220 - this.kickVel * 16) * dt;
    this.kick += this.kickVel * dt;

    // The balance: it never quite holds still.
    const wobble = c.wobble * this.reveal;
    const wobbleX = (Math.sin(t * c.wobbleSpeed * 1.31 + 1.7) + 0.5 * Math.sin(t * c.wobbleSpeed * 2.9)) * wobble;
    const wobbleZ = (Math.sin(t * c.wobbleSpeed * 0.93) + 0.5 * Math.sin(t * c.wobbleSpeed * 2.3 + 0.8)) * wobble;

    this.root.position.copy(this.pos);
    this.root.rotation.set(0, this.yaw, 0);
    this.tilt.rotation.set(this.pitch + this.kick + wobbleX, 0, this.roll + wobbleZ);
    this._placeFrame();
    this.position.copy(this.root.position);

    // The tire, rolled by the distance the drive has covered. Distance, not
    // time — so it is untouched by the animation speed, and the tread never
    // slides on the floor at any size the editor sets.
    if (this.wheelNode) {
      this.wheelNode.rotation.x = this.wheelBase + this.wheelAngle;
    }

    // The muzzles and the headlamp are read off this transform this frame,
    // so it has to be current before they are.
    this.root.updateMatrixWorld(true);
  }

  /**
   * The lean pivots about the axle: the tilt group sits at hub height and the
   * chassis is offset back down under it, both at the live size.
   */
  _placeFrame() {
    const k = this.scaleK;
    this.tilt.position.set(0, this.axle.y * k, 0);
    this.frame.position.set(0, -this.axle.y, 0);
    this.frame.scale.setScalar(k);
  }

  /** Where the headlamp is looking, and the cone that shows it. */
  _aimBeam(dt, c) {
    // Onto the mark while hunting; down the road otherwise, so it sweeps as
    // the bot turns.
    if (this.mark) {
      this.beamTarget.set(this.mark.position.x, 0, this.mark.position.z);
    } else {
      const reach = Math.max(0.5, c.headlightReach);
      this.beamTarget.set(this.pos.x + Math.sin(this.yaw) * reach, 0, this.pos.z + Math.cos(this.yaw) * reach);
    }
    const swing = this.mark ? c.beamSwing : c.beamSwing * 8;
    this.beamAt.x = damp(this.beamAt.x, this.beamTarget.x, swing, dt);
    this.beamAt.z = damp(this.beamAt.z, this.beamTarget.z, swing, dt);
    this.beamAt.y = 0;

    // The cone: apex on the nose, rim on the floor at the target.
    this._nose(_pos);
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

    /* the hull */
    if (this.bodyMaterial) {
      const u = this.bodyMaterial.userData.droneUniforms;
      // The plane climbs from the floor to just over the hull.
      const height = this.height * this.scaleK;
      u.uRevealY.value = -0.05 + (height + 0.3) * this.reveal;
      u.uRevealWidth.value = Math.max(0.005, c.revealWidth);
      u.uRevealColor.value.copy(getColor(c.revealColor));
      u.uRevealGlow.value = c.revealGlow * g.glow;
      u.uRimColor.value.copy(getColor(c.rimColor));
      u.uRimStrength.value = c.rimStrength * g.fresnel;
      u.uRimPower.value = c.rimPower;
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

    /* the headlamp */
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
      this.beam.visible = this.reveal > 0.05 && c.beamIntensity > 0;

      const s = this.spotMaterial.uniforms;
      s.uIntensity.value = c.spotIntensity * this.reveal * g.shaderIntensity;
      s.uHot.value = this.hot;
      s.uOpacity.value = opacity;
      s.uColor.value.copy(getColor(c.colorBeam));
      s.uColorHot.value.copy(getColor(c.colorBeamHot));
      this.spot.visible = this.reveal > 0.05 && c.spotIntensity > 0;
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
      // The flame: white at the barrel, the flash colour by its tip, and it
      // stops dead — a muzzle flash is a shape, not a spray.
      const u = this.muzzle.uniforms;
      this.muzzle.setGradient(getColor('#ffffff'), getColor(c.colorFlash), getColor(c.colorTracerTail), getColor('#5a2408'));
      u.uGravity.value.set(0, 0, 0);
      u.uDrag.value = 9;
      u.uTurbulence.value = 0;
      u.uStretch.value = 0.06;
      u.uEndSize.value = 1.8;
      u.uSizeIn.value = 0.001;
      u.uFadeIn.value = 0;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = 2.6 * g.glow;
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

  /** Dust off the tread, and sparks off the print plane. */
  _emitters(dt, c) {
    const g = settings.global;
    const time = frame.uTime.value;

    /* the tread */
    // Thrown back off the contact patch, more the faster it rolls; a pivot
    // scrubs a little up too, so a turn on the spot is not silent.
    const maxSpeed = Math.max(0.1, c.maxSpeed);
    const rolling = Math.abs(this.speed) / maxSpeed;
    const scrub = Math.min(1, Math.abs(this.yawRate) * 0.25);
    const rate = c.treadDust * (rolling + scrub * 0.5) * this.reveal;
    const count = this._treadDust.tick(dt, rate * g.particleCount);
    const back = this.speed >= 0 ? -1 : 1;
    const headX = Math.sin(this.yaw);
    const headZ = Math.cos(this.yaw);
    const width = this.width * this.scaleK * 0.2;
    for (let i = 0; i < count; i++) {
      const side = (Math.random() - 0.5) * 2 * width;
      _emit.position.set(
        this.pos.x + headX * back * 0.2 + Math.cos(this.yaw) * side,
        0.05,
        this.pos.z + headZ * back * 0.2 - Math.sin(this.yaw) * side
      );
      _emit.direction.set(headX * back, 0.35, headZ * back);
      _emit.radius = 0.08;
      _emit.speed = 1.2 + rolling * 1.8;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.4;
      _emit.size = c.treadDustSize;
      _emit.sizeVariance = 0.5;
      _emit.life = 1.4;
      _emit.lifeVariance = 0.4;
      _emit.spin = 0.6;
      _emit.time = time;
      this.dust.emit(1, _emit);
    }

    /* the print plane */
    if (this.reveal > 0.02 && this.reveal < 0.98) {
      const y = this.bodyMaterial?.userData.droneUniforms.uRevealY.value ?? this.root.position.y;
      const n = this._printSparks.tick(dt, 40 * g.particleCount);
      const span = this.length * this.scaleK;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * TAU;
        const r = Math.sqrt(Math.random()) * span * 0.4;
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

  /**
   * The body light, on the nose rather than at the root: the muzzle punch it
   * carries is what throws the flash onto the floor in front of the guns.
   * Otherwise the base class's light, verbatim.
   */
  _bodyLight(dt, c) {
    if (!this.light) return;
    this._nose(this.lightAt);
    this.lightColor.copy(getColor(c.lightColor));
    this.ctx.lights.set(
      this.light,
      this.lightAt,
      this.lightColor,
      c.lightIntensity * this.reveal * this.lightShimmer() + this.lightBoost,
      c.lightRadius * (1 + this.lightBoost * 0.02),
      dt
    );
    this.lightBoost = Math.max(0, this.lightBoost - this.lightBoost * 4.5 * dt - 0.5 * dt);
  }

  /** The light in the headlamp's pool on the floor. */
  _spotLightFrame(dt, c) {
    if (!this.spotLight) return;
    _pos.set(this.beamAt.x, 0.7, this.beamAt.z);
    this.lightColor.copy(getColor(c.colorBeam)).lerp(getColor(c.colorBeamHot), this.hot);
    this.ctx.lights.set(this.spotLight, _pos, this.lightColor, c.spotLight * this.reveal, c.spotLightRadius, dt);
  }

  /** A slow breath rather than a flicker: it is a machine, not a torch. */
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
  }
}
