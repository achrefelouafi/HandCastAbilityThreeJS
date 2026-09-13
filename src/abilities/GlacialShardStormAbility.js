import { Mesh, PlaneGeometry, Vector3 } from 'three';
import { Ability } from './Ability.js';
import { createGlacialCoreGeometry, createGlacialQuadGeometry } from '../assets/GlacialGeometry.js';
import { createIceShardGeometry } from '../assets/TwilightGeometry.js';
import { createBoltRibbonGeometry } from '../assets/ProceduralGeometry.js';
import { createGlacialSpineUniforms, syncGlacialSpine, glacialSpinePoint } from '../materials/GlacialSpine.js';
import {
  createGlacialCoreMaterial,
  createGlacialGlintMaterial,
  createGlacialLatticeMaterial,
  createGlacialShardMaterial,
  createGlacialSilkMaterial,
  createGlacialVaporMaterial,
  createGlacialWarpMaterial,
  createIceLookUniforms
} from '../materials/GlacialShardStormMaterials.js';
import { LAYER } from '../core/Layers.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { Easing, saturate } from '../utils/math.js';

/** Hard ceilings. The editor's sliders clamp here. */
const MAX_VAPOR = 800;
const MAX_VAPOR_BURST = 240;
const MAX_SILKS = 8;
const MAX_LATTICE = 200;
const MAX_LATTICE_BURST = 140;
/** Per shard *variant* - the field is two of these. */
const MAX_SHARDS = 200;
const MAX_SHARD_BURST = 160;

/** Tessellation. Nothing about the *shape* of any layer lives here. */
const SILK_NODES = 112;

const _wake = new Vector3();
const _worldUp = new Vector3(0, 1, 0);

/**
 * GLACIAL SHARD STORM — a line cast, built to the five-panel breakdown and to
 * nothing else.
 *
 * The sheet names five layers and this file draws five: the subsurface ice
 * mesh, the fluid frost vapour, the ordered frost lattice, the glinting ice
 * shards and the refractive distortion. There is nothing added: no floor
 * decal, no pressure shell, no screen flash on the strike, no particle system.
 * Ten draws, nine shaders, one flight path.
 * See `materials/GlacialShardStormMaterials.js` for what each one is.
 *
 * ## Which way it flies
 *
 * Read the composite's shapes, not its captions. The crystal is the compact,
 * *pointed* thing and everything streams away from it in one direction; the
 * vapour widens the further from it it gets, which is what a wake does behind
 * a moving thing and never ahead of one; the shards and the snowflakes are
 * scattered wider the further back they are. So the crystal is the nose and
 * the rest is the wake, and every metre in this file is measured back from
 * its point.
 *
 * ## The rule that makes the editor work
 *
 * A cast captures exactly one number — `_seed` — plus timestamps. Every metre,
 * radian and second is resolved against `settings.glacial` each frame, on a
 * zero-length frame included: the crystal, the vapour, the lattice and the
 * shards are all pure functions of the clock and how far the head has flown,
 * so dragging any slider re-flies a cast already in the air. That is what
 * pausing with **P** mid-flight is for.
 *
 * ## The strike
 *
 * The crystal is what hits. It comes apart facet by facet - every triangle of
 * it flies off as a rigid sliver, tumbling, flashing white - the vapour gouts
 * out of the point of impact, a shell of snowflakes and of shards is thrown,
 * and the lens on the distortion layer fires one big ring. The wake does
 * *not* take part: the vapour, the lattice and the shards already in the air
 * are the record of where the shot has been, so the strike simply stops
 * laying more of them down and they drain where they were drawn. The vapour
 * is the last thing on screen.
 */
export class GlacialShardStormAbility extends Ability {
  constructor(context) {
    super('glacial', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * One spine and one ice palette, ten materials, one write per value per
     * frame. The uniform boxes are shared by identity, so no two layers can
     * disagree about where the flight path is or what colour the ice is.
     */
    this.spine = createGlacialSpineUniforms();
    this.ice = createIceLookUniforms();
    this._path = {
      origin: new Vector3(),
      dir: new Vector3(0, 0, 1),
      side: new Vector3(1, 0, 0),
      seed: 0
    };

    /* ---- 1 · the crystal: its inside, then its surface ---- */
    // Drawn first and solid, so the depth buffer sorts everything else
    // against its silhouette. The back faces are the facets seen through it.
    this.coreGeometry = createGlacialCoreGeometry({ sides: 7, jitter: 0.3, satellites: 3, seed: 3 });
    this.coreInsideMaterial = createGlacialCoreMaterial(this.spine, this.ice, true);
    this.coreMaterial = createGlacialCoreMaterial(this.spine, this.ice, false);
    this.coreInsideMesh = this._addMesh(this.coreGeometry, this.coreInsideMaterial, 8, LAYER.VFX);
    this.coreMesh = this._addMesh(this.coreGeometry, this.coreMaterial, 9, LAYER.VFX);

    /* ---- 4 · the shards: gems and splinters, two draws, and their glints ---- */
    this.gemGeometry = createIceShardGeometry({ sides: 6, top: 1.1, bottom: 0.7, jitter: 0.3, seed: 3, capacity: 1 + MAX_SHARDS + MAX_SHARD_BURST });
    this.splinterGeometry = createIceShardGeometry({ sides: 4, top: 1.9, bottom: 0.9, jitter: 0.4, seed: 17, capacity: 1 + MAX_SHARDS + MAX_SHARD_BURST });
    this.gemMaterial = createGlacialShardMaterial(this.spine, this.ice, 0);
    this.splinterMaterial = createGlacialShardMaterial(this.spine, this.ice, 1000);
    this.gemMesh = this._addMesh(this.gemGeometry, this.gemMaterial, 10, LAYER.VFX);
    this.splinterMesh = this._addMesh(this.splinterGeometry, this.splinterMaterial, 10, LAYER.VFX);

    this.gemGlintGeometry = createGlacialQuadGeometry(1 + MAX_SHARDS + MAX_SHARD_BURST, 0);
    this.splinterGlintGeometry = createGlacialQuadGeometry(1 + MAX_SHARDS + MAX_SHARD_BURST, 0);
    this.gemGlintMaterial = createGlacialGlintMaterial(this.spine, 0);
    this.splinterGlintMaterial = createGlacialGlintMaterial(this.spine, 1000);

    /* ---- 2 · the vapour: silks furthest back, then the streaks ---- */
    this.silkGeometry = createBoltRibbonGeometry(SILK_NODES, MAX_SILKS);
    this.silkMaterial = createGlacialSilkMaterial(this.spine);
    this.silkMesh = this._addMesh(this.silkGeometry, this.silkMaterial, 11, LAYER.VFX);

    this.vaporGeometry = createGlacialQuadGeometry(1 + MAX_VAPOR + MAX_VAPOR_BURST, 0);
    this.vaporMaterial = createGlacialVaporMaterial(this.spine);
    this.vaporMesh = this._addMesh(this.vaporGeometry, this.vaporMaterial, 12, LAYER.VFX);

    /* ---- 3 · the lattice, over the vapour it hangs in ---- */
    this.latticeGeometry = createGlacialQuadGeometry(1 + MAX_LATTICE + MAX_LATTICE_BURST, 0);
    this.latticeMaterial = createGlacialLatticeMaterial(this.spine);
    this.latticeMesh = this._addMesh(this.latticeGeometry, this.latticeMaterial, 13, LAYER.VFX);

    // The glints last: they are the brightest thing and sit on top of all of it.
    this.gemGlintMesh = this._addMesh(this.gemGlintGeometry, this.gemGlintMaterial, 14, LAYER.VFX);
    this.splinterGlintMesh = this._addMesh(this.splinterGlintGeometry, this.splinterGlintMaterial, 14, LAYER.VFX);

    /* ---- 5 · the refractive distortion: a proxy, invisible to the main pass ---- */
    this.warpGeometry = new PlaneGeometry(1, 1);
    this.warpMaterial = createGlacialWarpMaterial();
    this.warpMesh = new Mesh(this.warpGeometry, this.warpMaterial);
    this.warpMesh.frustumCulled = false;
    this.warpMesh.layers.set(LAYER.DISTORTION);
    this.group.add(this.warpMesh);

    /** Re-rolled per cast, so no two casts cut, coil or scatter alike. */
    this._seed = 0;
    /** Seconds since the strike; < 0 while the crystal is still flying. */
    this._burstTime = -1;
    /** Where it struck. */
    this._impact = new Vector3();
    this._vaporTrail = 1;
    this._vaporBurst = 1;
    this._silkCount = 1;
    this._latticeTrail = 1;
    this._latticeBurst = 1;
    this._gemTrail = 1;
    this._splinterTrail = 1;
    this._shardBurst = 1;
    /** The second light, standing back in the wake. */
    this._wakeLight = null;

    // Scratch handed to the materials each frame. One object each, reused.
    this._coreState = { burst: 0, burstTime: 0, grow: 1, fade: 1, seed: 0 };
    this._vaporState = { trail: 1, headSpeed: 0, stopped: 0, impact: this._impact, fade: 1 };
    this._silkState = { strands: 1, span: 1, fade: 1 };
    this._latticeState = { trail: 1, headSpeed: 0, stopped: 0, impact: this._impact, fade: 1 };
    this._gemState = { trail: 1, headSpeed: 0, stopped: 0, impact: this._impact, fade: 1 };
    this._splinterState = { trail: 1, headSpeed: 0, stopped: 0, impact: this._impact, fade: 1 };
    this._warpState = { heading: new Vector3(0, 0, 1), size: 4, seed: 0, burst: 0, burstFront: 0, fade: 1 };
  }

  /** Every mesh in this ability is placed in world space by its vertex stage. */
  _addMesh(geometry, material, renderOrder, layer) {
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.layers.set(layer);
    mesh.renderOrder = renderOrder;
    this.group.add(mesh);
    return mesh;
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return (
      2 +
      this._vaporTrail +
      this._vaporBurst +
      this._silkCount +
      this._latticeTrail +
      this._latticeBurst +
      (this._gemTrail + this._splinterTrail + this._shardBurst * 2) * 2
    );
  }

  /** The strike: how long the crystal takes to come apart. */
  get impactDuration() {
    return Math.max(0.05, settings.glacial.burstTime * settings.global.lifetime);
  }

  /** Long, on purpose: the vapour has to be the last thing on screen. */
  get fadeDuration() {
    return Math.max(0.05, settings.glacial.fadeTime * settings.global.lifetime);
  }

  /** Ice glints; it does not gutter. A slow shimmer on two clocks. */
  lightShimmer() {
    const c = settings.glacial;
    const t = this.age * c.lightShimmerSpeed;
    return 1 - c.lightShimmer * 0.5 * (1 - Math.sin(t * 1.3) * Math.sin(t * 2.1 + 0.7));
  }

  /** Nominal travel speed, metres/second. What the wake unwinds history by. */
  get travelSpeed() {
    return settings.glacial.speed * settings.global.speed;
  }

  /* ------------------------------------------------------------------ */
  /* Where the shot is - every metre resolved from live settings          */
  /* ------------------------------------------------------------------ */

  /** The nose of the crystal, in world space. */
  _nosePoint(out) {
    return glacialSpinePoint(this._path, this.front + settings.glacial.coreLead, out);
  }

  /** The middle of the crystal - what the light, the lens and the camera ride. */
  _corePoint(out) {
    const c = settings.glacial;
    return glacialSpinePoint(this._path, this.front + c.coreLead - c.coreLength * 0.45, out);
  }

  /** The middle of the wake, where the second light stands. */
  _wakePoint(out) {
    const back = Math.max(0, this.front - settings.glacial.wakeLightBack);
    return glacialSpinePoint(this._path, back, out);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this._seed = Math.random() * 100;
    this._burstTime = -1;

    this._path.origin.copy(this.origin);
    this._path.dir.copy(this.direction);
    // The shader's lateral is up x dir; taking the same one here keeps the JS
    // and GLSL halves of the spine on the same side of the line.
    this._path.side.crossVectors(_worldUp, this.direction).normalize();
    this._path.seed = this._seed;

    this._wakeLight = this.ctx.lights.acquire();

    this._syncUniforms(0, 1);

    // The whole of the cast flourish: the crystal grows out of the hand, and
    // the layers are the cast. All this adds is the punch of light.
    this.lightBoost = settings.glacial.lightIntensity * 0.4 * settings.global.explosionIntensity;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the cast's state into every material.
   *
   * @param {number} burst 0..1 - the crystal coming apart on the strike
   * @param {number} fade  1 while it flies, ramping to 0 as it dies
   */
  _syncUniforms(burst, fade) {
    const c = settings.glacial;
    const g = settings.global;

    syncGlacialSpine(this.spine, this._path, this.front);

    const stopped = Math.max(0, this._burstTime);
    // The crystal grows out of the caster's hand over the first fraction of
    // a second rather than appearing whole.
    const grow = Easing.outCubic(saturate(this.age / Math.max(0.02, c.growTime)));

    /* ---- 1 · the crystal ---- */
    const coreState = this._coreState;
    coreState.burst = burst;
    coreState.burstTime = stopped;
    coreState.grow = grow;
    coreState.fade = fade;
    coreState.seed = this._seed;
    this.coreInsideMaterial.userData.sync(coreState);
    this.coreMaterial.userData.sync(coreState);

    /* ---- 2 · the vapour ---- */
    this._vaporTrail = Math.max(1, Math.min(MAX_VAPOR, Math.round(c.vaporCount * g.particleCount)));
    this._vaporBurst = Math.max(1, Math.min(MAX_VAPOR_BURST, Math.round(c.vaporBurst * g.particleCount)));
    this.vaporGeometry.instanceCount = 1 + this._vaporTrail + this._vaporBurst;

    const vaporState = this._vaporState;
    vaporState.trail = this._vaporTrail;
    // Held at the travel speed for the whole cast, strike included: this sets
    // how far back down the spine each puff has slipped, and zeroing it would
    // teleport the wake onto the impact point. The shader freezes the trail
    // against `stopped` instead.
    vaporState.headSpeed = this.travelSpeed;
    vaporState.stopped = stopped;
    vaporState.fade = fade;
    this.vaporMaterial.userData.sync(vaporState);

    this._silkCount = Math.max(1, Math.min(MAX_SILKS, Math.round(c.silks)));
    this.silkGeometry.instanceCount = this._silkCount;

    const silkState = this._silkState;
    silkState.strands = this._silkCount;
    // They can never reach further back than the shot has flown.
    silkState.span = Math.max(0.5, Math.min(c.silkSpan, this.front + c.silkLead + 0.5));
    // The silks are wound onto the crystal, so they go with it as it comes
    // apart rather than hanging in the air until the wake has died.
    silkState.fade = fade * (1 - Easing.inOutQuad(saturate(burst * 1.4)));
    this.silkMaterial.userData.sync(silkState);

    /* ---- 3 · the lattice ---- */
    this._latticeTrail = Math.max(1, Math.min(MAX_LATTICE, Math.round(c.latticeCount * g.particleCount)));
    this._latticeBurst = Math.max(1, Math.min(MAX_LATTICE_BURST, Math.round(c.latticeBurst * g.particleCount)));
    this.latticeGeometry.instanceCount = 1 + this._latticeTrail + this._latticeBurst;

    const latticeState = this._latticeState;
    latticeState.trail = this._latticeTrail;
    latticeState.headSpeed = this.travelSpeed;
    latticeState.stopped = stopped;
    latticeState.fade = fade;
    this.latticeMaterial.userData.sync(latticeState);

    /* ---- 4 · the shards, and their glints ---- */
    const shards = Math.max(1, Math.min(MAX_SHARDS, Math.round(c.shardCount * g.particleCount)));
    this._splinterTrail = Math.max(1, Math.min(MAX_SHARDS, Math.round(shards * c.shardSplinters)));
    this._gemTrail = shards;
    this._shardBurst = Math.max(1, Math.min(MAX_SHARD_BURST, Math.round(c.shardBurst * g.particleCount * 0.5)));
    this.gemGeometry.instanceCount = 1 + this._gemTrail + this._shardBurst;
    this.gemGlintGeometry.instanceCount = this.gemGeometry.instanceCount;
    this.splinterGeometry.instanceCount = 1 + this._splinterTrail + this._shardBurst;
    this.splinterGlintGeometry.instanceCount = this.splinterGeometry.instanceCount;

    const gemState = this._gemState;
    gemState.trail = this._gemTrail;
    gemState.headSpeed = this.travelSpeed;
    gemState.stopped = stopped;
    gemState.fade = fade;
    this.gemMaterial.userData.sync(gemState);
    this.gemGlintMaterial.userData.sync(gemState);

    const splinterState = this._splinterState;
    splinterState.trail = this._splinterTrail;
    splinterState.headSpeed = this.travelSpeed;
    splinterState.stopped = stopped;
    splinterState.fade = fade;
    this.splinterMaterial.userData.sync(splinterState);
    this.splinterGlintMaterial.userData.sync(splinterState);

    /* ---- 5 · the lens ---- */
    const warpState = this._warpState;
    warpState.heading.copy(this.direction);
    warpState.size = c.warpSize * (1 + burst * c.warpBurstSize * g.explosionIntensity);
    warpState.seed = this._seed;
    if (this._burstTime >= 0) {
      const life = Math.max(0.05, c.warpBurstLife);
      warpState.burst = c.warpBurst * Math.max(0, 1 - this._burstTime / life);
      warpState.burstFront = saturate((this._burstTime * c.warpBurstSpeed) / Math.max(0.01, warpState.size));
    } else {
      warpState.burst = 0;
      warpState.burstFront = 0;
    }
    // The ball of glass goes with the crystal; the ring it fires lives its own
    // life in the shader.
    warpState.fade = fade * (1 - Easing.outQuad(saturate(burst * 1.5)));
    this.warpMaterial.userData.sync(warpState);
    this._corePoint(this.warpMesh.position);
  }

  /**
   * The second light, standing back in the wake on its own clock - two lights
   * breathing together read as one light.
   *
   * @param {number} scale 1 while it flies, falling away as it dies
   */
  _updateWakeLight(dt, scale) {
    if (!this._wakeLight) return;
    const c = settings.glacial;
    const t = this.age * c.wakeBreathSpeed;
    const breath = 1 - c.wakeBreath * 0.5 * (1 - Math.sin(t * 1.3) * Math.sin(t * 0.7 + 1.9));

    this._wakePoint(_wake);
    this.ctx.lights.set(
      this._wakeLight,
      _wake,
      getColor(c.wakeLightColor),
      c.wakeLightIntensity * scale * breath,
      c.wakeLightRadius,
      dt
    );
  }

  /* ------------------------------------------------------------------ */
  /* Phases                                                              */
  /* ------------------------------------------------------------------ */

  onTravel(dt) {
    const c = settings.glacial;
    const g = settings.global;

    this._syncUniforms(0, 1);
    // The light rides the crystal, not the floor under it - and so does the
    // camera. `DummyField` reads only the x and z of this.
    this._corePoint(this.position);
    this._updateWakeLight(dt, 1);

    this.ctx.shake.rumble(c.rumble * g.cameraShake, dt);
  }

  onImpact() {
    const c = settings.glacial;
    const g = settings.global;

    this._burstTime = 0;
    this._nosePoint(this._impact);

    // The strike does two things that are not one of the five layers, and only
    // two: a shove and a punch of light.
    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      24
    );
    this.lightBoost = c.lightIntensity * 1.2 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.glacial;

    if (this._burstTime >= 0) this._burstTime += dt;

    // `t` runs 0..1 while the crystal comes apart, then 1..2 while what is
    // left of it goes out.
    const burst = saturate(t);
    const fade = t > 1 ? 1 - Easing.inQuad(saturate(t - 1)) : 1;

    this._syncUniforms(burst, fade);
    this._corePoint(this.position);
    // The wake outlives the crystal that shed it.
    this._updateWakeLight(dt, Math.max(0, 1 - burst * 1.2) * fade);

    if (t <= 1) this.ctx.shake.rumble(c.burnShake * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this._burstTime = -1;
    this._vaporTrail = 1;
    this._vaporBurst = 1;
    this._silkCount = 1;
    this._latticeTrail = 1;
    this._latticeBurst = 1;
    this._gemTrail = 1;
    this._splinterTrail = 1;
    this._shardBurst = 1;
    this.vaporGeometry.instanceCount = 1;
    this.silkGeometry.instanceCount = 1;
    this.latticeGeometry.instanceCount = 1;
    this.gemGeometry.instanceCount = 1;
    this.splinterGeometry.instanceCount = 1;
    this.gemGlintGeometry.instanceCount = 1;
    this.splinterGlintGeometry.instanceCount = 1;
    for (const material of [this.coreInsideMaterial, this.coreMaterial]) {
      material.uniforms.uFade.value = 0;
      material.uniforms.uGrow.value = 0;
      material.uniforms.uBurst.value = 0;
      material.uniforms.uBurstTime.value = 0;
    }
    for (const material of [
      this.vaporMaterial,
      this.latticeMaterial,
      this.gemMaterial,
      this.splinterMaterial,
      this.gemGlintMaterial,
      this.splinterGlintMaterial
    ]) {
      material.uniforms.uFade.value = 0;
      material.uniforms.uStopped.value = 0;
    }
    this.silkMaterial.uniforms.uFade.value = 0;
    this.warpMaterial.uniforms.uFade.value = 0;
    this.warpMaterial.uniforms.uBurst.value = 0;

    this.ctx.lights.release(this._wakeLight);
    this._wakeLight = null;
  }

  dispose() {
    this.coreGeometry.dispose();
    this.coreInsideMaterial.dispose();
    this.coreMaterial.dispose();
    this.gemGeometry.dispose();
    this.splinterGeometry.dispose();
    this.gemMaterial.dispose();
    this.splinterMaterial.dispose();
    this.gemGlintGeometry.dispose();
    this.splinterGlintGeometry.dispose();
    this.gemGlintMaterial.dispose();
    this.splinterGlintMaterial.dispose();
    this.silkGeometry.dispose();
    this.silkMaterial.dispose();
    this.vaporGeometry.dispose();
    this.vaporMaterial.dispose();
    this.latticeGeometry.dispose();
    this.latticeMaterial.dispose();
    this.warpGeometry.dispose();
    this.warpMaterial.dispose();
    super.dispose();
  }
}
