import {
  CircleGeometry,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  Object3D,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector3
} from 'three';
import { Ability } from './Ability.js';
import { ParticleShape } from '../particles/ParticleSystem.js';
import { RateEmitter } from '../particles/ParticleEngine.js';
import { createShatterPlateGeometry } from '../assets/ShatterGeometry.js';
import { createAsteroidGeometry } from '../assets/ProceduralGeometry.js';
import { createSkirtGeometry, createSkirtMaterial } from '../materials/PhoenixMaterials.js';
import {
  FIRESTORM_MAX_PUFFS,
  createCloudMaterial,
  createCoreMaterial,
  createLavaBedMaterial,
  createLavaBombMaterial,
  createMagmaCrustMaterial,
  createMagmaSeamMaterial,
  createRibbonGeometry,
  createRibbonMaterial,
  syncCloud
} from '../materials/FireStormMaterials.js';
import { LAYER } from '../core/Layers.js';
import { frame } from '../core/FrameUniforms.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { Easing, hash11, lerp, randRange, saturate } from '../utils/math.js';

const TAU = Math.PI * 2;
/** Three bomb silhouettes, one InstancedMesh each. */
const BOMB_VARIANTS = 3;
const BOMB_SLOTS = 28;

const _pos = new Vector3();
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
 * THE VOLCANIC FIRE STORM ERUPTION — a far cast, built to a five-panel sheet.
 *
 * The cast is the magma *arriving*: a fracture races across the floor from
 * the caster's feet to the point with the melt showing through it, and where
 * it stops the floor fails. Then, in the order the sheet stacks them:
 *
 *   1. the crust — the floor inside the circle is cut into slabs and lifted
 *      whole off a bed of live melt, every seam and every fresh wall lit from
 *      underneath, a finer fracture network running hot across the top faces.
 *   2. the phreatic blast — the first thing out of a vent is not fire but
 *      the groundwater it flashed: a ring of white steam thrown off the plate
 *      and a jet of it up the middle, raymarched and sunlit, gone in seconds.
 *   3. the bombs — basalt torn out of the vent, molten inside, thrown on real
 *      ballistics with sparks streaming off them, cooling from the outside in
 *      wherever they land; and the embers, spiralling up the column.
 *   4. the vortex — the storm itself, a fire whirl: broad ribbons of flame
 *      wound about one axis and climbing it, torn to tongues along their
 *      edges and burnt to soot laces by the top; a white-hot core they are
 *      wound round; and a skirt of tongues flaring over the plate at the
 *      foot. The whole column leans and dances at the top while its foot
 *      stays planted on the crust.
 *   5. the pyrocumulus — the smoke standing on the vortex, a column of puffs
 *      that never stops rising, lit from underneath by the fire it stands on.
 *
 * It stands for `lifetime` seconds and then dies the way a fire whirl does:
 * the foot lets go of the ground and the column lifts away and thins, the
 * melt skins over and goes dark, the bombs and the plate sink back into the
 * floor, and the smoke drifts off downwind.
 *
 * The bodies in the circle are thrown outward by the field on the frame the
 * front lands (`DummyField`), which is what an eruption under one's feet does.
 */
export class FireStormAbility extends Ability {
  constructor(context) {
    super('firestorm', context);
  }

  get impactDuration() {
    return Math.max(0.05, settings.firestorm.lifetime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.firestorm.fadeTime);
  }

  get instanceCount() {
    return this._liveBombs;
  }

  /** Followed hard once it is up: the storm is the show. */
  get cameraWeight() {
    return this.u < 1 ? saturate(1 - this.u * 0.4) : 0.8;
  }

  /* ------------------------------------------------------------------ */
  /* construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    const environment = this.ctx.environment;

    /* ---- 1a · the seam ---- */
    const flat = new PlaneGeometry(1, 1);
    flat.rotateX(-Math.PI / 2);
    this.seamMaterial = createMagmaSeamMaterial();
    this.seam = new Mesh(flat, this.seamMaterial);
    this.seam.layers.set(LAYER.VFX);
    this.seam.renderOrder = 4;
    this.seam.frustumCulled = false;
    this.group.add(this.seam);

    /* ---- 1b · the crust ---- */
    this.crustMaterial = createMagmaCrustMaterial(environment);
    this._plateKey = '';
    this.crust = new Mesh(this._buildPlate(), this.crustMaterial);
    // On WORLD so it takes the sun, the shadows of the bombs and the light of
    // the fire. Not a caster: three would throw the shadow of the flat disc.
    this.crust.layers.set(LAYER.WORLD);
    this.crust.castShadow = false;
    this.crust.receiveShadow = true;
    this.crust.frustumCulled = false;
    this.crust.renderOrder = 1;
    this.group.add(this.crust);

    /* ---- 1c · the melt under it ---- */
    const disc = new CircleGeometry(1, 64);
    disc.rotateX(-Math.PI / 2);
    this.lavaMaterial = createLavaBedMaterial();
    this.lava = new Mesh(disc, this.lavaMaterial);
    this.lava.layers.set(LAYER.WORLD);
    this.lava.frustumCulled = false;
    this.lava.renderOrder = 0;
    this.group.add(this.lava);

    /* ---- 2 + 5 · the clouds ---- */
    const hullSphere = new SphereGeometry(1, 16, 12);
    this.steamMaterial = createCloudMaterial();
    this.steam = new Mesh(hullSphere, this.steamMaterial);
    this.steam.layers.set(LAYER.VFX);
    this.steam.renderOrder = 9;
    this.steam.frustumCulled = false;
    this.group.add(this.steam);

    this.smokeMaterial = createCloudMaterial();
    this.smoke = new Mesh(hullSphere, this.smokeMaterial);
    this.smoke.layers.set(LAYER.VFX);
    this.smoke.renderOrder = 9.5;
    this.smoke.frustumCulled = false;
    this.group.add(this.smoke);

    this.steamPuffs = [];
    for (let i = 0; i < FIRESTORM_MAX_PUFFS; i++) {
      this.steamPuffs.push({
        p0: new Vector3(),
        v0: new Vector3(),
        r0: 0.5,
        r1: 2,
        born: 0,
        life: 1,
        seed: Math.random()
      });
    }
    this._boundCentre = new Vector3();

    /* ---- 3 · the bombs ---- */
    this.bombMaterial = createLavaBombMaterial(environment);
    this.bombMeshes = [];
    this.bombHeatAttributes = [];
    for (let v = 0; v < BOMB_VARIANTS; v++) {
      const geometry = createAsteroidGeometry({
        seed: 4.1 + v * 7.7,
        detail: 2,
        lumpiness: 0.3,
        noiseScale: 1.6,
        roughness: 0.12,
        cuts: 6,
        cutDepth: 0.3,
        craters: 3,
        craterDepth: 0.12,
        craterSize: 0.4
      });
      const seeds = new InstancedBufferAttribute(new Float32Array(BOMB_SLOTS), 1);
      for (let i = 0; i < BOMB_SLOTS; i++) seeds.array[i] = Math.random() * 40;
      geometry.setAttribute('aSeed', seeds);
      const heat = new InstancedBufferAttribute(new Float32Array(BOMB_SLOTS), 1).setUsage(DynamicDrawUsage);
      geometry.setAttribute('aHeat', heat);

      const mesh = new InstancedMesh(geometry, this.bombMaterial, BOMB_SLOTS);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.layers.set(LAYER.WORLD);
      this.group.add(mesh);
      this.bombMeshes.push(mesh);
      this.bombHeatAttributes.push(heat);
    }

    this.bombs = [];
    for (let i = 0; i < BOMB_VARIANTS * BOMB_SLOTS; i++) {
      this.bombs.push({
        live: false,
        resting: false,
        position: new Vector3(),
        velocity: new Vector3(),
        orientation: new Quaternion(),
        spinAxis: new Vector3(0, 1, 0),
        spinRate: 0,
        size: 1,
        age: 0,
        cool: 0,
        heat: 0
      });
    }
    this._flying = [];
    this._liveBombs = 0;

    /* ---- 4 · the whirl ---- */
    // The core first, the skirt over it, the ribbons over both: every one of
    // them is premultiplied-over, so the soot laces on the ribbons darken
    // the core behind them the way the sheet paints them.
    this.coreMaterial = createCoreMaterial();
    this.core = new Mesh(new PlaneGeometry(1, 1), this.coreMaterial);
    this.core.layers.set(LAYER.VFX);
    this.core.renderOrder = 7;
    this.core.frustumCulled = false;
    this.group.add(this.core);

    this.skirtMaterial = createSkirtMaterial();
    this.skirt = new Mesh(createSkirtGeometry(), this.skirtMaterial);
    this.skirt.layers.set(LAYER.VFX);
    this.skirt.renderOrder = 7.5;
    this.skirt.frustumCulled = false;
    this.group.add(this.skirt);

    this.ribbonMaterial = createRibbonMaterial();
    this.ribbons = new Mesh(createRibbonGeometry(), this.ribbonMaterial);
    this.ribbons.layers.set(LAYER.VFX);
    this.ribbons.renderOrder = 8;
    this.ribbons.frustumCulled = false;
    this.group.add(this.ribbons);

    /* ---- state ---- */
    this.centre = new Vector3();
    this.fieldAge = 0;
    this.burn = 0;
    this.reveal = 0;
    this.lift = 0;
    this.salvoTimer = 0;
    this.stormLight = null;
    this._crustState = { grown: 0, heat: 0, rumble: 0 };

    this._embers = new RateEmitter(160);
    this._trail = new RateEmitter(40);
    this._sparks = new RateEmitter(25);
  }

  createParticles() {
    const P = this.ctx.particles;
    this.embers = P.get('firestormEmber', {
      capacity: 1600,
      shape: ParticleShape.SOFT,
      additive: true,
      curl: true,
      swirl: true,
      softFade: 0.3
    });
    this.sparks = P.get('firestormSpark', {
      capacity: 1200,
      shape: ParticleShape.STREAK,
      additive: true,
      stretch: true,
      softFade: 0.1
    });
  }

  /** The plate is re-cut only when a shape control moves. */
  _buildPlate() {
    const c = settings.firestorm;
    this._plateKey = `${c.plateCells}|${c.plateDepth}|${c.plateRagged}|${c.plateBias}`;
    return createShatterPlateGeometry({
      seed: 11 + Math.random() * 40,
      cells: c.plateCells,
      depth: c.plateDepth,
      bias: c.plateBias,
      ragged: c.plateRagged
    });
  }

  _syncPlate() {
    const c = settings.firestorm;
    const key = `${c.plateCells}|${c.plateDepth}|${c.plateRagged}|${c.plateBias}`;
    if (key === this._plateKey) return;
    const old = this.crust.geometry;
    this.crust.geometry = this._buildPlate();
    old.dispose();
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this.pointAt(1, this.centre);
    this.fieldAge = 0;
    this.burn = 0;
    this.reveal = 0;
    this.lift = 0;
    this.salvoTimer = 0;
    this._liveBombs = 0;
    for (const bomb of this.bombs) bomb.live = false;
    for (const puff of this.steamPuffs) puff.life = 0;
    this._embers.reset();
    this._trail.reset();
    this._sparks.reset();
    this.stormLight = this.ctx.lights.acquire();

    // The seam lies along the line, from the feet to the point.
    this.seam.position.copy(this.origin).addScaledVector(this.direction, this.length * 0.5);
    this.seam.position.y = 0.02;
    this.seam.rotation.set(0, Math.atan2(-this.direction.z, this.direction.x), 0);
    this.seam.visible = true;

    this.crust.visible = false;
    this.lava.visible = false;
    this.steam.visible = false;
    this.smoke.visible = false;
    this._whirlVisible(false);
    for (const mesh of this.bombMeshes) mesh.count = 0;

    this._syncPlate();
    this._dressSeam();
  }

  onDestroy() {
    this.ctx.lights.release(this.stormLight);
    this.stormLight = null;
    for (const bomb of this.bombs) bomb.live = false;
    for (const mesh of this.bombMeshes) mesh.count = 0;
    this.seam.visible = false;
    this.crust.visible = false;
    this.lava.visible = false;
    this.steam.visible = false;
    this.smoke.visible = false;
    this._whirlVisible(false);
  }

  _whirlVisible(on) {
    this.core.visible = on;
    this.skirt.visible = on;
    this.ribbons.visible = on;
  }

  /* ------------------------------------------------------------------ */
  /* the magma arriving                                                  */
  /* ------------------------------------------------------------------ */

  onTravel() {
    this.position.y = 0;
    this._dressSeam();
  }

  _dressSeam() {
    const c = this.config;
    const g = settings.global;
    const u = this.seamMaterial.uniforms;
    const width = c.seamWidth;

    this.seam.scale.set(this.length, 1, width);
    u.uLength.value = this.length;
    u.uWidth.value = width;
    u.uFront.value = this.u < 1 ? this.front : this.length + 1;
    u.uWander.value = c.seamWander * g.noiseStrength;
    u.uCrackWidth.value = c.seamCrackWidth;
    u.uGlowWidth.value = c.seamGlowWidth;
    u.uBranch.value = c.seamBranch;
    u.uBranchScale.value = c.seamBranchScale * g.noiseFrequency;
    u.uScorch.value = c.seamScorch;
    u.uIntensity.value = c.seamIntensity * g.glow * g.shaderIntensity;
    u.uColorScorch.value.copy(getColor(c.colorScorch));
    this._fire(u);

    // Lit while the magma runs; once the storm is up it cools behind it, and
    // the scorch it leaves goes with the storm.
    let heat = 1;
    let fade = 1;
    if (this.u >= 1) {
      heat = 1 - Easing.inQuad(saturate(this.fieldAge / Math.max(0.05, c.seamCool)));
      heat = Math.max(heat, 0.25 * (1 - this.burn));
      fade = 1 - Easing.inQuad(this.burn);
    }
    u.uHeat.value = heat;
    u.uFade.value = fade * g.opacity;
  }

  _fire(u) {
    const c = this.config;
    u.uTempCore.value = c.tempCore;
    u.uTempEdge.value = c.tempEdge;
    u.uEmissionCurve.value = c.emissionCurve;
    u.uPalette.value = c.palette;
    u.uColorCore.value.copy(getColor(c.colorCore));
    u.uColorMid.value.copy(getColor(c.colorMid));
    u.uColorEdge.value.copy(getColor(c.colorEdge));
    u.uColorEmber.value.copy(getColor(c.colorEmber));
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
    this.position.copy(this.centre);
    this.fieldAge = 0;

    this.crust.visible = true;
    this.lava.visible = true;
    this.steam.visible = true;
    this.smoke.visible = true;
    this._whirlVisible(true);

    /* 2 · the phreatic blast: a ring off the plate and a jet up the middle */
    const puffs = Math.min(FIRESTORM_MAX_PUFFS, Math.max(0, Math.round(c.steamPuffs)));
    const ring = Math.round(puffs * 0.64);
    for (let i = 0; i < FIRESTORM_MAX_PUFFS; i++) {
      const puff = this.steamPuffs[i];
      if (i >= puffs) {
        puff.life = 0;
        continue;
      }
      puff.seed = Math.random();
      if (i < ring) {
        const a = (i / ring) * TAU + randRange(-0.3, 0.3);
        const r = R * randRange(0.55, 0.85);
        puff.p0.set(this.centre.x + Math.cos(a) * r, 0.35, this.centre.z + Math.sin(a) * r);
        puff.v0.set(Math.cos(a), 0, Math.sin(a)).multiplyScalar(c.steamSpeed * randRange(0.8, 1.2));
        puff.v0.y = c.steamClimb * randRange(0.7, 1.3);
        puff.born = c.steamDelay + randRange(0, 0.12);
      } else {
        const k = (i - ring) / Math.max(1, puffs - ring);
        puff.p0.set(this.centre.x + randRange(-0.3, 0.3), 0.4 + k * 0.5, this.centre.z + randRange(-0.3, 0.3));
        puff.v0.set(randRange(-1, 1), 0, randRange(-1, 1)).multiplyScalar(1.2);
        puff.v0.y = c.steamJet * randRange(0.75, 1.25);
        puff.born = c.steamDelay + k * 0.14;
      }
      puff.r0 = c.steamSize * randRange(0.8, 1.2);
      puff.r1 = puff.r0 + c.steamGrowth * randRange(0.8, 1.2);
      puff.life = c.steamLife * randRange(0.85, 1.15);
    }

    /* 3 · the vent throws its first salvo */
    this._launchBombs(Math.round(c.bombSalvo * g.particleCount), 1.3);
    this.salvoTimer = 0;

    /* embers out of the ground */
    const embers = Math.round(c.eruptionEmbers * g.particleCount);
    for (let i = 0; i < embers; i++) {
      const a = Math.random() * TAU;
      const r = Math.sqrt(Math.random()) * R * 0.6;
      _emit.position.set(this.centre.x + Math.cos(a) * r, 0.1, this.centre.z + Math.sin(a) * r);
      _emit.anchor = null;
      _emit.direction.set(Math.cos(a) * 0.5, 1.4, Math.sin(a) * 0.5).normalize();
      _emit.inherit = null;
      _emit.radius = 0.1;
      _emit.speed = 6;
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
    const sparks = Math.round(c.eruptionSparks * g.particleCount);
    for (let i = 0; i < sparks; i++) {
      const a = Math.random() * TAU;
      _emit.position.set(this.centre.x, 0.3, this.centre.z);
      _emit.direction.set(Math.cos(a), 1.8, Math.sin(a)).normalize();
      _emit.radius = 0.25;
      _emit.speed = 11;
      _emit.speedVariance = 0.5;
      _emit.spread = 0.35;
      _emit.size = 0.06;
      _emit.sizeVariance = 0.5;
      _emit.life = 1.1;
      _emit.lifeVariance = 0.5;
      _emit.time = time;
      this.sparks.emit(1, _emit);
    }

    this.lightBoost = c.eruptionLight * g.explosionIntensity;
    this.ctx.shake.add(c.eruptionShake * g.explosionIntensity * g.cameraShake, 2.6, 18);

    this._dress();
  }

  /* ------------------------------------------------------------------ */
  /* the storm                                                           */
  /* ------------------------------------------------------------------ */

  /** @param {number} t 0..1 standing, 1..2 dying */
  onFade(dt, t) {
    const c = this.config;
    const g = settings.global;
    this.fieldAge += dt;
    this.burn = t > 1 ? saturate(t - 1) : 0;

    // The vortex climbs out of the vent a beat after the steam.
    this.reveal = Easing.outCubic(saturate((this.fieldAge - c.vortexDelay) / Math.max(0.05, c.vortexRiseTime)));

    // Salvos out of the vent for as long as it stands.
    if (this.burn <= 0) {
      this.salvoTimer += dt;
      const interval = Math.max(0.08, c.bombInterval);
      if (this.salvoTimer >= interval) {
        this.salvoTimer -= interval * randRange(0.7, 1.3);
        this._launchBombs(Math.round(c.bombBurst * randRange(0.6, 1.4) * g.particleCount), 1);
        this.ctx.shake.add(c.eruptionShake * 0.18 * g.explosionIntensity * g.cameraShake, 1.2, 24);
      }
    }

    this._flyBombs(dt);
    this._dress();
    this._emitters(dt);
    this._lights(dt);
  }

  /* ---- 3 · the bombs ---- */

  _launchBombs(count, speedScale) {
    const c = this.config;
    const g = settings.global;
    const R = c.zoneRadius;
    let thrown = 0;

    for (let i = 0; i < this.bombs.length && thrown < count; i++) {
      const bomb = this.bombs[i];
      if (bomb.live && !bomb.resting) continue;
      // A cold one lying on the floor can be recycled; a hot one is left.
      if (bomb.live && bomb.heat > 0.3) continue;

      const bearing = Math.random() * TAU;
      const reach = R * 0.3 * Math.sqrt(Math.random());
      bomb.position.set(
        this.centre.x + Math.cos(bearing) * reach,
        this.lift + randRange(0.2, 0.7),
        this.centre.z + Math.sin(bearing) * reach
      );

      // Up and out, with the outward share rolled per bomb: a few go nearly
      // straight up and rain back through the column.
      const lift = lerp(c.bombLift, 2.4, Math.random() * Math.random());
      const speed = c.bombSpeed * speedScale * randRange(0.55, 1.35) * g.particleSpeed;
      bomb.velocity
        .set(Math.cos(bearing), 0, Math.sin(bearing))
        .multiplyScalar(randRange(0.3, 1.0) * c.bombSpread)
        .setY(lift)
        .normalize()
        .multiplyScalar(speed);

      bomb.orientation.setFromAxisAngle(
        _axis.set(randRange(-1, 1), randRange(-1, 1), randRange(-1, 1)).normalize(),
        Math.random() * TAU
      );
      bomb.spinAxis.set(randRange(-1, 1), randRange(-1, 1), randRange(-1, 1)).normalize();
      bomb.spinRate = randRange(-1, 1) * c.bombSpin;
      bomb.size = randRange(1 - c.bombSizeJitter, 1 + c.bombSizeJitter);
      bomb.age = 0;
      bomb.cool = 0;
      bomb.heat = 1;
      bomb.live = true;
      bomb.resting = false;
      thrown++;
    }
  }

  /**
   * Integrate the bombs and write their matrices and their heat.
   *
   * Semi-implicit Euler with a floor bounce; a bomb that has stopped moving
   * is parked and cools twice as fast, lying where it fell until the storm
   * dies and takes it back under the floor.
   */
  _flyBombs(dt) {
    const c = this.config;
    const g = settings.global;
    const used = [0, 0, 0];
    const retract = Easing.inCubic(this.burn);
    let live = 0;
    this._flying.length = 0;

    for (let i = 0; i < this.bombs.length; i++) {
      const bomb = this.bombs[i];
      const variant = i % BOMB_VARIANTS;
      const slot = (i / BOMB_VARIANTS) | 0;
      const heatAttr = this.bombHeatAttributes[variant];

      if (!bomb.live) {
        _dummy.position.set(0, -999, 0);
        _dummy.quaternion.identity();
        _dummy.scale.setScalar(0.0001);
        _dummy.updateMatrix();
        this.bombMeshes[variant].setMatrixAt(slot, _dummy.matrix);
        heatAttr.setX(slot, 0);
        used[variant] = Math.max(used[variant], slot + 1);
        continue;
      }

      bomb.age += dt;
      bomb.cool += bomb.resting ? dt * 2 : dt;
      bomb.heat = Math.pow(1 - saturate(bomb.cool / Math.max(0.1, c.bombCoolTime)), 1.6);
      live++;
      const radius = c.bombSize * bomb.size * g.particleSize;

      if (!bomb.resting && dt > 0) {
        bomb.velocity.y += c.bombGravity * dt;
        bomb.position.addScaledVector(bomb.velocity, dt);

        // The plate is higher than the floor around it.
        const dx = bomb.position.x - this.centre.x;
        const dz = bomb.position.z - this.centre.z;
        const onPlate = dx * dx + dz * dz < c.zoneRadius * c.zoneRadius * 0.6;
        const floor = (onPlate ? this.lift : 0) + radius * 0.55;

        if (bomb.position.y <= floor) {
          bomb.position.y = floor;
          if (bomb.velocity.y < 0) {
            const impact = -bomb.velocity.y;
            bomb.velocity.y = impact * c.bombBounce;
            bomb.velocity.x *= c.bombFriction;
            bomb.velocity.z *= c.bombFriction;
            bomb.spinRate *= 0.5;
            if (impact > 3) this._landingSparks(bomb, impact);
            if (bomb.velocity.lengthSq() < 0.6) {
              bomb.resting = true;
              bomb.velocity.set(0, 0, 0);
              bomb.spinRate = 0;
            }
          }
        } else {
          this._flying.push(bomb);
        }

        if (bomb.spinRate !== 0) {
          _turn.setFromAxisAngle(bomb.spinAxis, bomb.spinRate * dt);
          bomb.orientation.premultiply(_turn);
        }
      }

      _dummy.position.copy(bomb.position);
      if (retract > 0) _dummy.position.y -= retract * (radius * 3 + 0.5);
      _dummy.quaternion.copy(bomb.orientation);
      _dummy.scale.setScalar(radius);
      _dummy.updateMatrix();
      this.bombMeshes[variant].setMatrixAt(slot, _dummy.matrix);
      heatAttr.setX(slot, bomb.heat);
      used[variant] = Math.max(used[variant], slot + 1);
    }

    this._liveBombs = live;
    for (let v = 0; v < BOMB_VARIANTS; v++) {
      this.bombMeshes[v].count = used[v];
      this.bombMeshes[v].instanceMatrix.needsUpdate = true;
      this.bombHeatAttributes[v].needsUpdate = true;
    }
  }

  /** Sparks thrown up where a bomb hits the floor. */
  _landingSparks(bomb, impact) {
    const g = settings.global;
    const time = frame.uTime.value;
    const n = Math.round(Math.min(14, impact * 1.2) * g.particleCount * bomb.heat);
    if (n <= 0) return;
    _emit.position.copy(bomb.position);
    _emit.anchor = null;
    _emit.direction.set(0, 1, 0);
    _emit.inherit = null;
    _emit.radius = 0.05;
    _emit.speed = 2 + impact * 0.25;
    _emit.speedVariance = 0.5;
    _emit.spread = 0.8;
    _emit.size = 0.05;
    _emit.sizeVariance = 0.5;
    _emit.life = 0.6;
    _emit.lifeVariance = 0.4;
    _emit.time = time;
    this.sparks.emit(n, _emit);
  }

  /* ---- the puffs ---- */

  /** Write one puff into a cloud material's arrays. */
  _writePuff(material, i, x, y, z, r, strength, seed) {
    const p = material.uniforms.uPuffs.value;
    const d = material.uniforms.uPuffData.value;
    const k = i * 4;
    p[k] = x;
    p[k + 1] = y;
    p[k + 2] = z;
    p[k + 3] = r;
    d[k] = strength;
    d[k + 1] = seed;
    d[k + 2] = 0;
    d[k + 3] = 0;
  }

  /** Fit the hull round the live puffs. @returns {boolean} whether any are */
  _boundPuffs(material, mesh, count) {
    const p = material.uniforms.uPuffs.value;
    const d = material.uniforms.uPuffData.value;
    const centre = this._boundCentre.set(0, 0, 0);
    let n = 0;
    for (let i = 0; i < count; i++) {
      if (d[i * 4] <= 0.001) continue;
      centre.x += p[i * 4];
      centre.y += p[i * 4 + 1];
      centre.z += p[i * 4 + 2];
      n++;
    }
    if (n === 0) return false;
    centre.multiplyScalar(1 / n);
    let radius = 0;
    for (let i = 0; i < count; i++) {
      if (d[i * 4] <= 0.001) continue;
      const dx = p[i * 4] - centre.x;
      const dy = p[i * 4 + 1] - centre.y;
      const dz = p[i * 4 + 2] - centre.z;
      radius = Math.max(radius, Math.sqrt(dx * dx + dy * dy + dz * dz) + p[i * 4 + 3] * 1.1);
    }
    material.uniforms.uBoundCenter.value.copy(centre);
    material.uniforms.uBoundRadius.value = radius;
    mesh.position.copy(centre);
    mesh.scale.setScalar(radius);
    return true;
  }

  _steamFrame() {
    const c = this.config;
    const count = Math.min(FIRESTORM_MAX_PUFFS, Math.max(0, Math.round(c.steamPuffs)));
    const k = Math.max(0.1, c.steamDrag);
    for (let i = 0; i < FIRESTORM_MAX_PUFFS; i++) {
      const puff = this.steamPuffs[i];
      const age = this.fieldAge - puff.born;
      if (i >= count || puff.life <= 0 || age < 0 || age > puff.life) {
        this._writePuff(this.steamMaterial, i, 0, -100, 0, 0.001, 0, puff.seed);
        continue;
      }
      // Thrown, dragged to a stop, and lifted by its own heat.
      const travel = (1 - Math.exp(-k * age)) / k;
      const x = puff.p0.x + puff.v0.x * travel;
      const y = puff.p0.y + puff.v0.y * travel + 0.5 * c.steamBuoyancy * age * age;
      const z = puff.p0.z + puff.v0.z * travel;
      const r = puff.r0 + (puff.r1 - puff.r0) * (1 - Math.exp(-age / Math.max(0.05, c.steamGrowTime)));
      const strength =
        smooth(0, 0.1, age) * (1 - smooth(puff.life * 0.45, puff.life, age)) * (1 - this.burn);
      this._writePuff(this.steamMaterial, i, x, y, z, r, strength, puff.seed);
    }
    this.steamMaterial.uniforms.uCount.value = count;
    this.steam.visible = this._boundPuffs(this.steamMaterial, this.steam, count);
  }

  _smokeFrame() {
    const c = this.config;
    const count = Math.min(FIRESTORM_MAX_PUFFS, Math.max(0, Math.round(c.smokePuffs)));
    const period = Math.max(0.5, c.smokePeriod);
    const tau = this.fieldAge - c.smokeDelay;
    // The column stands on the vortex, and follows it up as it lifts away.
    const top = this.lift + c.vortexHeight * this.reveal * 0.82 + this.burn * 2.5;
    const H = c.smokeRise;

    for (let i = 0; i < FIRESTORM_MAX_PUFFS; i++) {
      const cycle = tau - (i / Math.max(1, count)) * period;
      if (i >= count || cycle < 0) {
        this._writePuff(this.smokeMaterial, i, 0, -100, 0, 0.001, 0, 0);
        continue;
      }
      const round = Math.floor(cycle / period);
      const phase = cycle / period - round;
      const seed = hash11(i * 3.1 + round * 17.3 + 0.7);
      const seed2 = hash11(i * 7.7 + round * 5.9 + 2.3);

      const y = top + H * Math.pow(phase, 0.75);
      const spread = c.smokeSpread * Math.pow(phase, 0.85) * (0.6 + 0.8 * seed2);
      const angle = seed * TAU + phase * c.smokeSwirl;
      const drift = c.smokeWind * phase * H;
      const x = this.centre.x + Math.cos(angle) * spread + this.direction.x * drift;
      const z = this.centre.z + Math.sin(angle) * spread + this.direction.z * drift;
      const r = (c.smokeSize + c.smokeGrowth * Math.pow(phase, 0.7)) * (0.8 + 0.4 * seed2);
      const strength = smooth(0, 0.12, phase) * (1 - smooth(0.55, 1, phase)) * this.reveal * (1 - this.burn * 0.85);
      this._writePuff(this.smokeMaterial, i, x, y, z, r, strength, seed);
    }
    this.smokeMaterial.uniforms.uCount.value = count;
    this.smoke.visible = this._boundPuffs(this.smokeMaterial, this.smoke, count);
  }

  /* ---- settings → uniforms, every frame ---- */

  _dress() {
    const c = this.config;
    const g = settings.global;
    const R = c.zoneRadius;
    const fade = 1 - Easing.inQuad(this.burn);
    const heat = 1 - Easing.inCubic(this.burn);

    this._syncPlate();

    /* 1 · the crust rises whole off the melt, then sinks back */
    {
      const rise = Easing.outBack(saturate(this.fieldAge / Math.max(0.05, c.plateLiftTime)));
      const sink = Easing.inCubic(this.burn);
      // Whole, a hair above the floor, so the two never fight for the depth
      // buffer; dying, it goes all the way under.
      this.lift = c.plateLift * rise * (1 - sink) - sink * (c.plateDepth * R + 0.4);
      if (this.burn <= 0) this.lift = Math.max(this.lift, 0.01);
      this.crust.position.set(this.centre.x, this.lift, this.centre.z);
      this.crust.scale.setScalar(R);

      const state = this._crustState;
      state.grown = Easing.outQuad(saturate(this.fieldAge / Math.max(0.05, c.plateBreakTime))) * 1.3;
      state.heat = heat;
      state.rumble = c.rumble * this.reveal * heat;
      this.crustMaterial.userData.sync(state);
    }

    /* 1 · the melt */
    {
      const u = this.lavaMaterial.uniforms;
      this._fire(u);
      const radius = R * c.lavaRadius;
      u.uRadius.value = radius;
      u.uHeat.value = heat;
      u.uFlow.value = c.lavaFlow * g.noiseSpeed;
      u.uScale.value = c.lavaScale * g.noiseFrequency;
      u.uSkin.value = c.lavaSkin;
      u.uIntensity.value = c.lavaIntensity * g.glow * g.shaderIntensity;
      u.uColorSkin.value.copy(getColor(c.colorSkin));
      this.lava.position.set(this.centre.x, this.lift - c.lavaDepth, this.centre.z);
      this.lava.scale.setScalar(radius);
    }

    this._dressSeam();

    /* 2 · the steam */
    {
      syncCloud(this.steamMaterial, c.steam, g, 1);
      const u = this.steamMaterial.uniforms;
      u.uFirePos.value.set(this.centre.x, this.lift + 0.3, this.centre.z);
      u.uFireColor.value.copy(getColor(c.colorMid));
      this._steamFrame();
    }

    /* 4 · the whirl */
    {
      const H = c.vortexHeight;
      const burn = Easing.inQuad(this.burn);
      const liftOff = burn * H * c.vortexLiftOff;
      const on = this.reveal > 0.001 && fade > 0.001;
      const ribbons = Math.max(1, Math.round(c.vortexRibbons));

      // The column both are wound round.
      const column = (u) => {
        this._fire(u);
        u.uBase.value.set(this.centre.x, this.lift + 0.02, this.centre.z);
        u.uHeight.value = H;
        u.uReveal.value = this.reveal;
        u.uLift.value = liftOff;
        u.uFoot.value = R * c.vortexFoot;
        u.uWaist.value = R * c.vortexWaist;
        u.uCrown.value = R * c.vortexCrown;
        u.uWaistAt.value = c.vortexWaistAt;
        u.uSway.value = c.vortexSway;
        u.uSwayRate.value = c.vortexSwayRate;
        u.uTurns.value = c.vortexTurns;
        u.uSpin.value = c.vortexSpin;
        u.uRibbons.value = ribbons;
        u.uNoiseScale.value = c.vortexNoiseScale * g.noiseFrequency;
        u.uFlow.value = c.vortexFlow * g.noiseSpeed;
        u.uTongue.value = c.vortexTongue;
        u.uCool.value = c.vortexCool;
        u.uSootFrom.value = c.vortexSootFrom;
        u.uSoot.value = c.vortexSoot;
        u.uFlicker.value = c.vortexFlicker;
        u.uBurn.value = burn;
        u.uFade.value = fade;
        u.uOpacity.value = g.opacity;
        u.uColorSmoke.value.copy(getColor(c.colorSmoke));
      };

      {
        const u = this.ribbonMaterial.uniforms;
        column(u);
        u.uWisps.value = Math.max(0, Math.round(c.vortexWisps));
        u.uWidth.value = c.vortexRibbonWidth;
        u.uFootWidth.value = c.vortexFootWidth;
        u.uWispWidth.value = c.vortexWispWidth;
        u.uWispRadius.value = c.vortexWispRadius;
        u.uWispSpin.value = c.vortexWispSpin;
        u.uWaver.value = c.vortexWaver;
        u.uShred.value = c.vortexShred * g.noiseStrength;
        u.uHeat.value = c.vortexHeat;
        u.uIntensity.value = c.vortexIntensity * g.glow;
        u.uWispIntensity.value = c.vortexWispIntensity;
        this.ribbons.visible = on;
      }
      {
        const u = this.coreMaterial.uniforms;
        column(u);
        u.uCoreWidth.value = c.vortexCoreWidth;
        u.uShred.value = c.vortexCoreShred * g.noiseStrength;
        u.uStripe.value = c.vortexStripe;
        u.uHeat.value = c.vortexCoreHeat;
        u.uIntensity.value = c.vortexCoreIntensity * g.glow;
        this.core.visible = on;
      }
      {
        // The foot: the phoenix's torn cylinder, flared over the plate. It
        // dies with the foot of the column, before the ribbons do.
        const u = this.skirtMaterial.uniforms;
        this._fire(u);
        u.uRadius.value = R * c.skirtRadius;
        u.uHeight.value = c.skirtHeight;
        u.uFlare.value = c.skirtFlare;
        u.uBreathe.value = c.skirtBreathe;
        u.uReveal.value = this.reveal * (1 - burn);
        u.uNoiseScale.value = c.skirtNoiseScale * g.noiseFrequency;
        u.uRise.value = c.skirtRise * g.noiseSpeed;
        u.uShred.value = c.skirtShred * g.noiseStrength;
        u.uWisp.value = c.skirtWisp;
        u.uWaveSpeed.value = c.skirtWaveSpeed;
        u.uWaveDepth.value = c.skirtWaveDepth;
        u.uHeat.value = c.skirtHeat * heat;
        u.uIntensity.value = c.skirtIntensity * g.glow;
        u.uOpacity.value = c.skirtOpacity * g.opacity;
        u.uFade.value = fade;
        u.uGlobalGlow.value = 1;
        this.skirt.position.set(this.centre.x, this.lift + 0.02, this.centre.z);
        this.skirt.visible = on && burn < 0.999;
      }
    }

    /* 5 · the pyrocumulus */
    {
      syncCloud(this.smokeMaterial, c.smoke, g, 1);
      const u = this.smokeMaterial.uniforms;
      u.uFirePos.value.set(this.centre.x, this.lift + c.vortexHeight * this.reveal * 0.7, this.centre.z);
      u.uFireColor.value.copy(getColor(c.colorMid));
      u.uFireGlow.value *= this.reveal * heat;
      this._smokeFrame();
    }

    /* 3 · the bombs */
    this.bombMaterial.userData.sync();

    /* the particle systems — shared, so re-dressed every frame */
    {
      const u = this.embers.uniforms;
      this.embers.setGradient(getColor(c.colorCore), getColor(c.colorMid), getColor(c.colorEdge), getColor(c.colorEmber));
      u.uGravity.value.set(0, c.emberRise, 0);
      u.uDrag.value = 1.0;
      u.uTurbulence.value = 0.8 * g.turbulence;
      u.uTurbFrequency.value = 0.7;
      u.uTurbSpeed.value = 0.5;
      u.uSwirl.value = c.emberSwirl;
      u.uSwirlExpand.value = 0.25;
      u.uEndSize.value = 0.3;
      u.uSizeIn.value = 0.05;
      u.uFadeIn.value = 0.05;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = c.emberGlow * g.glow;
      u.uOpacity.value = g.opacity;
    }
    {
      const u = this.sparks.uniforms;
      this.sparks.setGradient(getColor('#ffffff'), getColor(c.colorCore), getColor(c.colorMid), getColor(c.colorEdge));
      u.uGravity.value.set(0, -9, 0);
      u.uDrag.value = 1.5;
      u.uTurbulence.value = 0.25;
      u.uStretch.value = 0.08;
      u.uEndSize.value = 0.3;
      u.uFadeOut.value = 0.5;
      u.uGlow.value = 2.2 * g.glow;
      u.uOpacity.value = g.opacity;
    }
  }

  /* ---- the embers ---- */

  _emitters(dt) {
    const c = this.config;
    const g = settings.global;
    const time = frame.uTime.value;
    const R = c.zoneRadius;
    const heat = 1 - this.burn;

    /* embers off the crust, spiralling up the column */
    const embers = this._embers.tick(dt, c.emberRate * g.particleCount * heat * (0.3 + 0.7 * this.reveal));
    for (let i = 0; i < embers; i++) {
      const a = Math.random() * TAU;
      const r = Math.sqrt(Math.random()) * R * 0.85;
      _emit.position.set(this.centre.x + Math.cos(a) * r, this.lift + 0.05, this.centre.z + Math.sin(a) * r);
      _emit.anchor = _pos.set(this.centre.x, this.lift + 0.05, this.centre.z);
      _emit.direction.set(0, 1, 0);
      _emit.inherit = null;
      _emit.radius = 0.05;
      _emit.speed = randRange(0.8, 2.2);
      _emit.speedVariance = 0.4;
      _emit.spread = 0.25;
      _emit.size = c.emberSize;
      _emit.sizeVariance = 0.6;
      _emit.life = c.emberLife;
      _emit.lifeVariance = 0.5;
      _emit.spin = 0;
      _emit.tint = null;
      _emit.time = time;
      this.embers.emit(1, _emit);
    }

    /* sparks and embers streaming off the flying bombs */
    const flying = this._flying.length;
    if (flying > 0) {
      const sparks = this._sparks.tick(dt, c.bombSparks * flying * g.particleCount);
      for (let i = 0; i < sparks; i++) {
        const bomb = this._flying[i % flying];
        if (bomb.heat < 0.2) continue;
        _emit.position.copy(bomb.position);
        _emit.anchor = null;
        _emit.direction.copy(bomb.velocity).negate().normalize();
        _emit.inherit = _vel.copy(bomb.velocity).multiplyScalar(0.35);
        _emit.radius = c.bombSize * bomb.size * 0.6;
        _emit.speed = 1.5;
        _emit.speedVariance = 0.6;
        _emit.spread = 0.6;
        _emit.size = 0.05;
        _emit.sizeVariance = 0.5;
        _emit.life = 0.5;
        _emit.lifeVariance = 0.5;
        _emit.time = time;
        this.sparks.emit(1, _emit);
      }
      const trail = this._trail.tick(dt, c.bombTrail * flying * g.particleCount);
      for (let i = 0; i < trail; i++) {
        const bomb = this._flying[i % flying];
        if (bomb.heat < 0.2) continue;
        _emit.position.copy(bomb.position);
        _emit.anchor = _emit.position;
        _emit.direction.copy(bomb.velocity).negate().normalize();
        _emit.inherit = _vel.copy(bomb.velocity).multiplyScalar(0.2);
        _emit.radius = c.bombSize * bomb.size * 0.5;
        _emit.speed = 0.6;
        _emit.speedVariance = 0.5;
        _emit.spread = 0.5;
        _emit.size = c.emberSize * 0.8;
        _emit.sizeVariance = 0.5;
        _emit.life = 0.7;
        _emit.lifeVariance = 0.4;
        _emit.spin = 0;
        _emit.tint = null;
        _emit.time = time;
        this.embers.emit(1, _emit);
      }
      _emit.inherit = null;
      _emit.anchor = null;
    }
  }

  /* ---- the light ---- */

  _lights(dt) {
    const c = this.config;
    const fade = 1 - this.burn;
    // The base light sits in the melt; the storm's own stands in the column.
    this.position.set(this.centre.x, this.lift + 0.6, this.centre.z);
    if (this.stormLight) {
      _pos.set(this.centre.x, this.lift + c.vortexHeight * this.reveal * 0.45, this.centre.z);
      this.lightColor.copy(getColor(c.colorMid));
      this.ctx.lights.set(
        this.stormLight,
        _pos,
        this.lightColor,
        c.stormLight * this.reveal * fade * this.lightShimmer(),
        c.stormLightRadius,
        dt
      );
    }
  }

  /** Fire gutters. */
  lightShimmer() {
    const c = this.config;
    const t = this.age;
    const gutter = Math.sin(t * c.lightGutterSpeed) * Math.sin(t * c.lightGutterSpeed * 0.37 + 1.3);
    return 1 - c.lightGutter * 0.5 + c.lightGutter * 0.5 * gutter;
  }

  dispose() {
    super.dispose();
    this.seamMaterial.dispose();
    this.crustMaterial.dispose();
    this.crust.geometry.dispose();
    this.lavaMaterial.dispose();
    this.steamMaterial.dispose();
    this.smokeMaterial.dispose();
    this.bombMaterial.dispose();
    for (const mesh of this.bombMeshes) mesh.geometry.dispose();
    this.ribbonMaterial.dispose();
    this.ribbons.geometry.dispose();
    this.coreMaterial.dispose();
    this.core.geometry.dispose();
    this.skirtMaterial.dispose();
    this.skirt.geometry.dispose();
  }
}

/** Hermite step, for the puff envelopes. */
function smooth(a, b, x) {
  const t = saturate((x - a) / (b - a || 1e-6));
  return t * t * (3 - 2 * t);
}
