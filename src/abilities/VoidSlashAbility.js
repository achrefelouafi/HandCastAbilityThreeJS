import { Mesh, Vector3 } from 'three';
import { Ability } from './Ability.js';
import { createVoidFlakeGeometry, createVoidSpriteGeometry } from '../assets/VoidGeometry.js';
import { createBoltRibbonGeometry } from '../assets/ProceduralGeometry.js';
import { createVoidSpineUniforms, syncVoidSpine, voidSpinePoint } from '../materials/VoidSpine.js';
import {
  createVoidBeamMaterial,
  createVoidDebrisMaterial,
  createVoidLanceMaterial,
  createVoidMoteMaterial,
  createVoidRibbonMaterial,
  createVoidSparkMaterial
} from '../materials/VoidSlashMaterials.js';
import { LAYER } from '../core/Layers.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { Easing, saturate } from '../utils/math.js';

/** Hard ceilings. The editor's sliders clamp here. */
const MAX_LANCE_ROWS = 24;
const MAX_LANCE_AROUND = 12;
const MAX_LANCE = MAX_LANCE_ROWS * MAX_LANCE_AROUND;
const MAX_BEAM_STRANDS = 8;
/** Per debris *variant* - the field is two of these. */
const MAX_DEBRIS = 220;
const MAX_RIBBONS = 8;
const MAX_SPARKS = 200;
const MAX_BURST_SPARKS = 200;
const MAX_MOTES = 260;

/** Tessellation. Nothing about the *shape* of any layer lives here. */
const BEAM_NODES = 96;
const RIBBON_NODES = 112;

const _wake = new Vector3();
const _worldUp = new Vector3(0, 1, 0);

/**
 * LINEAR VOID SLASH — a line cast, built to the six-panel breakdown and to
 * nothing else.
 *
 * The sheet names six layers and this file draws five of them: the fifth
 * panel's distortion wave is deliberately left out, so the ability writes
 * nothing to the distortion layer. There is nothing added either: no floor
 * decal, no pressure shell, no white screen flash on the strike, no particle
 * system. Seven draws, six shaders, one flight path.
 * See `materials/VoidSlashMaterials.js` for what each one is.
 *
 * ## Which way it flies
 *
 * Read the composite's shapes, not its captions. The obsidian lance is the
 * compact, *pointed* thing and everything streams away from it in one
 * direction; the debris fans wider the further from it it gets, which is what
 * debris does behind a moving thing and never ahead of one; the ribbons taper
 * away from it, not into it; the motes are furthest back of all. So the lance
 * is the nose and the rest is the wake, and every metre in this file is
 * measured back from its point.
 *
 * ## The rule that makes the editor work
 *
 * A cast captures exactly one number — `_seed` — plus timestamps. Every metre,
 * radian and second is resolved against `settings.voidslash` each frame, on a
 * zero-length frame included: the lance, the debris, the sparks and the motes
 * are all pure functions of the clock and how far the head has flown, so
 * dragging any slider re-flies a cast already in the air. That is what
 * pausing with **P** mid-flight is for.
 *
 * ## The strike
 *
 * The lance is what hits. Its scales are blown off it and tumble away
 * white-hot, the beam's point flares and snaps back, a shell of sparks is
 * thrown, the ribbons go with the thing
 * they were trailing — and the wake does *not* take part: the debris and the
 * motes are the record of where the shot has been, so the strike simply stops
 * laying more of them down and they drain where they were drawn. The motes
 * are the last thing on screen, which is the whole point of the sixth panel.
 */
export class VoidSlashAbility extends Ability {
  constructor(context) {
    super('voidslash', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * One spine, seven materials, one write per value per frame. The uniform
     * boxes are shared by identity, so no two layers can disagree about where
     * the flight path is.
     */
    this.spine = createVoidSpineUniforms();
    this._path = {
      origin: new Vector3(),
      dir: new Vector3(0, 0, 1),
      side: new Vector3(1, 0, 0),
      seed: 0
    };

    /* ---- 1a · the lance ---- */
    // Drawn first and solid, so the depth buffer sorts everything else against
    // its silhouette.
    this.lanceGeometry = createVoidFlakeGeometry({
      sides: 6,
      nose: 1.3,
      thick: 0.14,
      jitter: 0.32,
      seed: 5,
      capacity: MAX_LANCE,
      indexOffset: 0
    });
    this.lanceMaterial = createVoidLanceMaterial(this.spine);
    this.lanceMesh = this._addMesh(this.lanceGeometry, this.lanceMaterial, 8, LAYER.VFX);

    /* ---- 2 · the debris: chips and slivers, one material, two draws ---- */
    // The sliver's instance indices start past the chip's so the two variants
    // hash to different rolls - share the range and the sliver flies inside
    // the chip.
    this.debrisMaterial = createVoidDebrisMaterial(this.spine);
    this.chipGeometry = createVoidFlakeGeometry({
      sides: 6,
      nose: 1.2,
      thick: 0.16,
      jitter: 0.3,
      seed: 11,
      capacity: MAX_DEBRIS,
      indexOffset: 0
    });
    this.sliverGeometry = createVoidFlakeGeometry({
      sides: 5,
      nose: 1.7,
      thick: 0.1,
      jitter: 0.45,
      seed: 23,
      capacity: MAX_DEBRIS,
      indexOffset: MAX_DEBRIS
    });
    this.chipMesh = this._addMesh(this.chipGeometry, this.debrisMaterial, 9, LAYER.VFX);
    this.sliverMesh = this._addMesh(this.sliverGeometry, this.debrisMaterial, 9, LAYER.VFX);

    /* ---- 6 · the motes, drawn before the ribbons: they are furthest back ---- */
    this.moteGeometry = createVoidSpriteGeometry(MAX_MOTES, 0);
    this.moteMaterial = createVoidMoteMaterial(this.spine);
    this.moteMesh = this._addMesh(this.moteGeometry, this.moteMaterial, 11, LAYER.VFX);

    /* ---- 3 · the ribbons ---- */
    this.ribbonGeometry = createBoltRibbonGeometry(RIBBON_NODES, MAX_RIBBONS);
    this.ribbonMaterial = createVoidRibbonMaterial(this.spine);
    this.ribbonMesh = this._addMesh(this.ribbonGeometry, this.ribbonMaterial, 12, LAYER.VFX);

    /* ---- 1b · the beam down the axis ---- */
    this.beamGeometry = createBoltRibbonGeometry(BEAM_NODES, MAX_BEAM_STRANDS);
    this.beamMaterial = createVoidBeamMaterial(this.spine);
    this.beamMesh = this._addMesh(this.beamGeometry, this.beamMaterial, 14, LAYER.VFX);

    /* ---- 4 · the sparks, and the glare at the point ---- */
    // Slot 0 is the glare, then the trail, then the strike's shell.
    this.sparkGeometry = createVoidSpriteGeometry(1 + MAX_SPARKS + MAX_BURST_SPARKS, 0);
    this.sparkMaterial = createVoidSparkMaterial(this.spine);
    this.sparkMesh = this._addMesh(this.sparkGeometry, this.sparkMaterial, 15, LAYER.VFX);

    /** Re-rolled per cast, so no two casts shingle, shed or weave alike. */
    this._seed = 0;
    /** Seconds since the strike; < 0 while the lance is still flying. */
    this._burstTime = -1;
    /** Where it struck. */
    this._impact = new Vector3();
    this._lanceCount = 1;
    this._beamCount = 1;
    this._debrisCount = 1;
    this._ribbonCount = 1;
    this._sparkTrail = 1;
    this._sparkBurst = 1;
    this._moteCount = 1;
    /** The second light, standing back in the wake. */
    this._wakeLight = null;

    // Scratch handed to the materials each frame. One object each, reused.
    this._lanceState = { burst: 0, burstTime: 0, fade: 1 };
    this._beamState = { strands: 1, span: 1, flare: 0, fade: 1 };
    this._debrisState = { headSpeed: 0, stopped: 0, fade: 1 };
    this._ribbonState = { strands: 1, span: 1, fade: 1 };
    this._sparkState = { trail: 1, headSpeed: 0, stopped: 0, flare: 0, impact: this._impact, fade: 1 };
    this._moteState = { headSpeed: 0, stopped: 0, fade: 1 };
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
      this._lanceCount +
      this._beamCount +
      this._debrisCount * 2 +
      this._ribbonCount +
      1 +
      this._sparkTrail +
      this._sparkBurst +
      this._moteCount
    );
  }

  /** The strike: how long the lance takes to come apart. */
  get impactDuration() {
    return Math.max(0.05, settings.voidslash.burstTime * settings.global.lifetime);
  }

  /** Long, on purpose: the motes have to be the last thing on screen. */
  get fadeDuration() {
    return Math.max(0.05, settings.voidslash.fadeTime * settings.global.lifetime);
  }

  /**
   * The inherited light rides the point. Void light does not gutter like fire;
   * it *stutters* - a fast, shallow flicker on two incommensurable clocks.
   */
  lightShimmer() {
    const c = settings.voidslash;
    const t = this.age * c.lightFlickerSpeed;
    return 1 - c.lightFlicker * 0.5 * (1 - Math.sin(t * 1.7) * Math.sin(t * 3.1 + 1.3));
  }

  /** Nominal travel speed, metres/second. What the wake unwinds history by. */
  get travelSpeed() {
    return settings.voidslash.speed * settings.global.speed;
  }

  /* ------------------------------------------------------------------ */
  /* Where the shot is - every metre resolved from live settings          */
  /* ------------------------------------------------------------------ */

  /** The point of the lance, in world space. */
  _headPoint(out) {
    return voidSpinePoint(this._path, this.front + settings.voidslash.lanceLead, out);
  }

  /** The middle of the wake, where the second light stands. */
  _wakePoint(out) {
    const back = Math.max(0, this.front - settings.voidslash.wakeLightBack);
    return voidSpinePoint(this._path, back, out);
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

    // The whole of the cast flourish: the lance draws itself out of the hand,
    // and the layers are the cast. All this adds is the punch of light.
    this.lightBoost = settings.voidslash.lightIntensity * 0.5 * settings.global.explosionIntensity;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the cast's state into every material.
   *
   * @param {number} burst 0..1 - the lance coming apart on the strike
   * @param {number} fade  1 while it flies, ramping to 0 as it dies
   */
  _syncUniforms(burst, fade) {
    const c = settings.voidslash;
    const g = settings.global;

    syncVoidSpine(this.spine, this._path, this.front);

    const stopped = Math.max(0, this._burstTime);
    // Everything that was carried by the lance goes with it on the strike.
    const carried = 1 - Easing.outQuad(saturate(burst * 1.3));

    /* ---- 1a · the lance ---- */
    const rows = Math.max(1, Math.min(MAX_LANCE_ROWS, Math.round(c.lanceRows)));
    const around = Math.max(1, Math.min(MAX_LANCE_AROUND, Math.round(c.lanceAround)));
    this._lanceCount = rows * around;
    this.lanceGeometry.instanceCount = this._lanceCount;

    const lanceState = this._lanceState;
    lanceState.burst = burst;
    lanceState.burstTime = stopped;
    lanceState.fade = fade;
    this.lanceMaterial.userData.sync(lanceState);

    /* ---- 1b · the beam ---- */
    this._beamCount = Math.max(1, Math.min(MAX_BEAM_STRANDS, Math.round(c.beamStrands)));
    this.beamGeometry.instanceCount = this._beamCount;

    const beamState = this._beamState;
    beamState.strands = this._beamCount;
    // It can never reach further back than the shot has flown.
    beamState.span = Math.max(0.5, Math.min(c.beamSpan, this.front + c.beamLead + 0.5));
    // The point flares on the strike and is gone before the lance is.
    beamState.flare = burst > 0 ? c.beamFlare * g.explosionIntensity * Math.max(0, 1 - burst * 2.5) : 0;
    beamState.fade = fade * carried;
    this.beamMaterial.userData.sync(beamState);

    /* ---- 2 · the debris ---- */
    this._debrisCount = Math.max(1, Math.min(MAX_DEBRIS, Math.round(c.debrisCount * g.particleCount)));
    this.chipGeometry.instanceCount = this._debrisCount;
    this.sliverGeometry.instanceCount = Math.max(1, Math.round(this._debrisCount * c.debrisSlivers));

    const debrisState = this._debrisState;
    // Held at the travel speed for the whole cast, strike included: this sets
    // how far back down the spine each flake has slipped, and zeroing it would
    // teleport the wake onto the impact point. The shader freezes the trail
    // against `stopped` instead.
    debrisState.headSpeed = this.travelSpeed;
    debrisState.stopped = stopped;
    debrisState.fade = fade;
    this.debrisMaterial.userData.sync(debrisState);

    /* ---- 3 · the ribbons ---- */
    this._ribbonCount = Math.max(1, Math.min(MAX_RIBBONS, Math.round(c.ribbons)));
    this.ribbonGeometry.instanceCount = this._ribbonCount;

    const ribbonState = this._ribbonState;
    ribbonState.strands = this._ribbonCount;
    ribbonState.span = Math.max(0.5, Math.min(c.ribbonSpan, this.front + c.ribbonLead + 0.5));
    ribbonState.fade = fade * carried;
    this.ribbonMaterial.userData.sync(ribbonState);

    /* ---- 4 · the sparks ---- */
    this._sparkTrail = Math.max(1, Math.min(MAX_SPARKS, Math.round(c.sparkCount * g.particleCount)));
    this._sparkBurst = Math.max(1, Math.min(MAX_BURST_SPARKS, Math.round(c.sparkBurst * g.particleCount)));
    this.sparkGeometry.instanceCount = 1 + this._sparkTrail + this._sparkBurst;

    const sparkState = this._sparkState;
    sparkState.trail = this._sparkTrail;
    sparkState.headSpeed = this.travelSpeed;
    sparkState.stopped = stopped;
    sparkState.flare = burst > 0 ? c.glareFlare * g.explosionIntensity * Math.max(0, 1 - burst * 2.0) : 0;
    // The glare goes with the lance; the trail and the shell live their own
    // lives, so the fade here is only the ability's own.
    sparkState.fade = fade;
    this.sparkMaterial.userData.sync(sparkState);

    /* ---- 6 · the motes ---- */
    this._moteCount = Math.max(1, Math.min(MAX_MOTES, Math.round(c.moteCount * g.particleCount)));
    this.moteGeometry.instanceCount = this._moteCount;

    const moteState = this._moteState;
    moteState.headSpeed = this.travelSpeed;
    moteState.stopped = stopped;
    moteState.fade = fade;
    this.moteMaterial.userData.sync(moteState);
  }

  /**
   * The second light, standing back in the wake on its own clock - two lights
   * breathing together read as one light.
   *
   * @param {number} scale 1 while it flies, falling away as it dies
   */
  _updateWakeLight(dt, scale) {
    if (!this._wakeLight) return;
    const c = settings.voidslash;
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
    const c = settings.voidslash;
    const g = settings.global;

    this._syncUniforms(0, 1);
    // The light rides the point, not the floor under it - and so does the
    // camera. `DummyField` reads only the x and z of this.
    this._headPoint(this.position);
    this._updateWakeLight(dt, 1);

    this.ctx.shake.rumble(c.rumble * g.cameraShake, dt);
  }

  onImpact() {
    const c = settings.voidslash;
    const g = settings.global;

    this._burstTime = 0;
    this._headPoint(this._impact);

    // The strike does two things that are not one of the six layers, and only
    // two: a shove and a punch of light.
    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      24
    );
    this.lightBoost = c.lightIntensity * 1.3 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.voidslash;

    if (this._burstTime >= 0) this._burstTime += dt;

    // `t` runs 0..1 while the lance comes apart, then 1..2 while what is left
    // of it goes out.
    const burst = saturate(t);
    const fade = t > 1 ? 1 - Easing.inQuad(saturate(t - 1)) : 1;

    this._syncUniforms(burst, fade);
    this._headPoint(this.position);
    // The wake outlives the lance that shed it.
    this._updateWakeLight(dt, Math.max(0, 1 - burst * 1.2) * fade);

    if (t <= 1) this.ctx.shake.rumble(c.burnShake * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this._burstTime = -1;
    this._lanceCount = 1;
    this._beamCount = 1;
    this._debrisCount = 1;
    this._ribbonCount = 1;
    this._sparkTrail = 1;
    this._sparkBurst = 1;
    this._moteCount = 1;
    this.lanceGeometry.instanceCount = 1;
    this.beamGeometry.instanceCount = 1;
    this.chipGeometry.instanceCount = 1;
    this.sliverGeometry.instanceCount = 1;
    this.ribbonGeometry.instanceCount = 1;
    this.sparkGeometry.instanceCount = 1;
    this.moteGeometry.instanceCount = 1;
    this.lanceMaterial.uniforms.uFade.value = 0;
    this.lanceMaterial.uniforms.uBurst.value = 0;
    this.lanceMaterial.uniforms.uBurstTime.value = 0;
    this.beamMaterial.uniforms.uFade.value = 0;
    this.beamMaterial.uniforms.uFlare.value = 0;
    this.debrisMaterial.uniforms.uFade.value = 0;
    this.debrisMaterial.uniforms.uStopped.value = 0;
    this.ribbonMaterial.uniforms.uFade.value = 0;
    this.sparkMaterial.uniforms.uFade.value = 0;
    this.sparkMaterial.uniforms.uStopped.value = 0;
    this.sparkMaterial.uniforms.uFlare.value = 0;
    this.moteMaterial.uniforms.uFade.value = 0;
    this.moteMaterial.uniforms.uStopped.value = 0;

    this.ctx.lights.release(this._wakeLight);
    this._wakeLight = null;
  }

  dispose() {
    this.lanceGeometry.dispose();
    this.lanceMaterial.dispose();
    this.beamGeometry.dispose();
    this.beamMaterial.dispose();
    this.chipGeometry.dispose();
    this.sliverGeometry.dispose();
    this.debrisMaterial.dispose();
    this.ribbonGeometry.dispose();
    this.ribbonMaterial.dispose();
    this.sparkGeometry.dispose();
    this.sparkMaterial.dispose();
    this.moteGeometry.dispose();
    this.moteMaterial.dispose();
    super.dispose();
  }
}
