import { Mesh, Vector3 } from 'three';
import { Ability } from './Ability.js';
import { createFlameConeGeometry, createIceShardGeometry } from '../assets/TwilightGeometry.js';
import { createBoltRibbonGeometry } from '../assets/ProceduralGeometry.js';
import {
  createTwilightSpineUniforms,
  syncTwilightSpine,
  twilightSpineFrame,
  twilightSpinePoint
} from '../materials/TwilightSpine.js';
import { createWispBeamMaterial } from '../materials/WispBeamMaterial.js';
import { createIceShardMaterial } from '../materials/IceShardMaterial.js';
import { createMuzzlePlumeMaterial } from '../materials/MuzzlePlumeMaterial.js';
import { createFlameConeMaterial } from '../materials/FlameConeMaterial.js';
import { LAYER } from '../core/Layers.js';
import { settings } from '../config/settings.js';
import { getColor } from '../utils/color.js';
import { Easing, saturate } from '../utils/math.js';

/** Hard ceilings. The editor's sliders clamp here. */
const MAX_WISPS = 8;
const MAX_TONGUES = 40;
/** Per crystal *variant* — the field is two of these. */
const MAX_SHARDS = 220;

/** Tessellation. Nothing about the *shape* of either mesh lives here. */
const WISP_NODES = 112;
const PLUME_NODES = 28;
const TIP_RINGS = 64;
// High, and it has to be: the back half of the body is cut into teeth along
// v, and each tooth needs enough columns to curl on its own. A multiple of the
// default tooth count, so the slot boundaries fall on columns.
const TIP_SEGMENTS = 168;

const _tangent = new Vector3();
const _side = new Vector3();
const _up = new Vector3();
const _head = new Vector3();
const _root = new Vector3();
const _worldUp = new Vector3(0, 1, 0);

/**
 * SCORCHED TWILIGHT OF RAGE — a linear cast, built to the three-panel
 * breakdown and to nothing else.
 *
 * The sheet names three layers and this file draws three layers. There is no
 * fourth. No sparks, no smoke puff, no scorch decal on the floor, no white
 * screen flash on the strike, no shockwave ring — and, most deliberately of
 * all, **no particle system anywhere in the ability**. Those are the reflexes
 * that make an effect look like every other effect, and the entire value of a
 * breakdown sheet is that somebody already decided what this one is made of.
 * Three meshes, three shaders, one flight path.
 *
 * In the order the composite reads them, back to front:
 *
 *  1. **the wispy beam core** — a braid of flat, soft-edged strips pointed at
 *     both ends, twisting about the flight line. Not a helix: they cross.
 *     See `materials/WispBeamMaterial.js`.
 *  2. **the stylized ice particles** — real faceted bipyramids, two silhouettes,
 *     tumbling, with a hairline on every facet edge and dispersion on the
 *     silhouette. Placed, launched and lit entirely in the vertex stage.
 *     See `materials/IceShardMaterial.js` and `assets/TwilightGeometry.js`.
 *  3. **the burning tip** — a painted teardrop with a needle point, drawn as
 *     a solid so it has a silhouette: an orange skin whose back half is cut
 *     into sharp teeth, over a paler core that shows through the gaps, with a
 *     fan of opaque, cel-shaded flame leaves streaming off its flanks. See
 *     `materials/FlameConeMaterial.js` for the two shells of the body and
 *     `materials/MuzzlePlumeMaterial.js` for the leaves.
 *
 *     Everything in the tip is a solid. A fan of additive strips has no edge —
 *     every strand is soft, they stack where they cross, and bloom rounds off
 *     what survives — so built that way the front of the shot came out as a
 *     warm smear rather than a point; and a cone carved into a few strips had
 *     an edge but read as a faceted dart. A flat-painted flame has a jagged
 *     outline and flat tones with hard boundaries, and that is alpha-clipped
 *     geometry with a depth write, not glow.
 *
 * ## The one structural decision: it flies fire first
 *
 * The sheet captions its third panel "Source Muzzle Glow", and that caption
 * will talk you into parking the flame at the caster's hand and flying the ice
 * out in front of it. This was built that way once and the whole ability read
 * back to front. The composite says otherwise in three places: the flame is the
 * compact, *pointed* shape and everything streams away from it in one
 * direction; the crystals fan wider the further from it they are, which is what
 * debris does behind a moving thing and never ahead of one; and the wisps taper
 * away from the flame rather than into it.
 *
 * So it is a comet and the flame is its nose. The plume's tongues root at the
 * head. The crystals are struck off there and fall back down the path, opening
 * out as they go. The braid trails from the same point. Everything in this file
 * exists to protect that read, and the one silhouette failure it has had that
 * mattered was a failure of it.
 *
 * ## Two lights, not one
 *
 * The base class gives every ability one dynamic light. This one is two
 * temperatures at opposite ends of the same object, and lighting the floor a
 * single colour under it throws away half of what the sheet is about — so the
 * inherited light rides the burning tip warm and a second is acquired for the
 * cold wake a few metres behind it. `LightPool#acquire` returns null when the
 * pool is exhausted and `set` ignores a null handle, so a fifth simultaneous
 * cast simply goes back to one light rather than failing.
 *
 * ## The rule that makes the editor work
 *
 * A cast captures exactly one number — `_seed` — plus timestamps. Every metre,
 * radian and second is resolved against `settings.twilight` each frame, on a
 * zero-length frame included: dragging `iceThrow` re-flies crystals already in
 * the air, dragging `wispRadius` re-braids a beam already drawn, dragging
 * `drift` re-flies the whole path and all three layers follow it. That is what
 * pausing with **P** mid-flight is for.
 */
export class ScorchedTwilightAbility extends Ability {
  constructor(context) {
    super('twilight', context);
  }

  /* ------------------------------------------------------------------ */
  /* Construction                                                        */
  /* ------------------------------------------------------------------ */

  createShaders() {
    /**
     * One spine, three materials, one write per value per frame.
     *
     * The uniform boxes are created here and *shared by identity* with the
     * wisps, the crystals and the plume, so `syncTwilightSpine` cannot leave
     * two of them disagreeing about where the flight path is — which is the one
     * failure this ability could not survive, because the whole composite is
     * three layers sitting on one line.
     */
    this.spine = createTwilightSpineUniforms();
    /** The cast's own frame, in the shape `TwilightSpine` reads. */
    this._path = {
      origin: new Vector3(),
      dir: new Vector3(0, 0, 1),
      side: new Vector3(1, 0, 0),
      seed: 0
    };

    /* ---- 2 · the stylized ice particles ---- */
    // Two silhouettes, and both are **four-sided** — octahedra. That is the
    // whole shape language of the sheet: seen from any generic angle an
    // octahedron is a rhombus split down the middle by a ridge into two facets
    // that catch the key differently, which is the crystal drawn twenty-odd
    // times on that panel. More sides rounds the silhouette off into a polygon
    // and the diamond read goes with it.
    //
    // The jitter is correspondingly tiny. It exists to stop every crystal being
    // the same regular solid, not to make them lumpy — these are cut gems, not
    // gravel, and at 0.34 they were reading as chipped rock.
    //
    // One material, two draws, and the kite's instance indices start past the
    // gem's so the two variants hash to different rolls — share the index range
    // and the kite flies inside the gem, which is invisible and pointless.
    this.iceMaterial = createIceShardMaterial(this.spine);
    this.gemGeometry = createIceShardGeometry({
      sides: 4,
      top: 1.0,
      bottom: 0.9,
      jitter: 0.22,
      seed: 3,
      capacity: MAX_SHARDS,
      indexOffset: 0
    });
    this.splinterGeometry = createIceShardGeometry({
      sides: 4,
      top: 1.25,
      bottom: 0.55,
      jitter: 0.28,
      seed: 11,
      capacity: MAX_SHARDS,
      indexOffset: MAX_SHARDS
    });

    this.gemMesh = this._addMesh(this.gemGeometry, this.iceMaterial, 10);
    this.splinterMesh = this._addMesh(this.splinterGeometry, this.iceMaterial, 10);

    /* ---- 3 · the burning tip: the body ---- */
    // One surface, two shells: the pale core first, then the orange skin over
    // it, so the skin's anti-aliased tooth edges blend over the core rather
    // than under it. Both are solids like the crystals, so the depth buffer
    // sorts the three against each other where the wake overtakes the teeth.
    this.tipGeometry = createFlameConeGeometry(TIP_RINGS, TIP_SEGMENTS);
    this.coreMaterial = createFlameConeMaterial(this.spine, { core: true });
    this.coreMesh = this._addMesh(this.tipGeometry, this.coreMaterial, 8);
    this.tipMaterial = createFlameConeMaterial(this.spine);
    this.tipMesh = this._addMesh(this.tipGeometry, this.tipMaterial, 9);

    /* ---- 3 · ... and the leaves streaming off its flanks ---- */
    this.plumeGeometry = createBoltRibbonGeometry(PLUME_NODES, MAX_TONGUES);
    this.plumeMaterial = createMuzzlePlumeMaterial(this.spine);
    this.plumeMesh = this._addMesh(this.plumeGeometry, this.plumeMaterial, 12);

    /* ---- 1 · the wispy beam core ---- */
    // Drawn last of the three. The crystals write depth, so they occlude the
    // braid correctly whatever order these are submitted in; the plume is put
    // ahead of the wisps only because where the two overlap, at the source end,
    // the blue should read as passing *through* the fire.
    this.wispGeometry = createBoltRibbonGeometry(WISP_NODES, MAX_WISPS);
    this.wispMaterial = createWispBeamMaterial(this.spine);
    this.wispMesh = this._addMesh(this.wispGeometry, this.wispMaterial, 14);

    /** Re-rolled per cast, so no two casts braid, shatter or burn alike. */
    this._seed = 0;
    /** Seconds since the strike; < 0 while the shot is still flying. */
    this._burstTime = -1;
    this._wispCount = 1;
    this._tongueCount = 1;
    this._shardCount = 1;
    /** The cold light standing back in the ice wake. See the class header. */
    this._wakeLight = null;

    // Scratch handed to the three materials each frame. One object each, reused.
    this._iceState = { headSpeed: 0, stopped: 0, fade: 1 };
    this._wispState = { span: 1, strands: 1, fade: 1 };
    this._plumeState = { tongues: 1, root: 1, flare: 0, fade: 1 };
    this._tipState = { burst: 0, fade: 1 };
  }

  /** Every mesh in this ability is placed in world space by its vertex stage. */
  _addMesh(geometry, material, renderOrder) {
    const mesh = new Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.layers.set(LAYER.VFX);
    mesh.renderOrder = renderOrder;
    this.group.add(mesh);
    return mesh;
  }

  /* ------------------------------------------------------------------ */
  /* Timing                                                              */
  /* ------------------------------------------------------------------ */

  get instanceCount() {
    return this._shardCount * 2 + this._wispCount + this._tongueCount;
  }

  /** The strike: how long the shot takes to come apart. */
  get impactDuration() {
    return Math.max(0.05, settings.twilight.burstTime * settings.global.lifetime);
  }

  get fadeDuration() {
    return Math.max(0.05, settings.twilight.fadeTime * settings.global.lifetime);
  }

  /**
   * The inherited light rides the burning tip, so it does what fire does: it
   * gutters. Two incommensurable sines multiplied together never repeat over
   * the length of a cast, which is the cheapest honest way to say "flame" with
   * one number. The steady one is the wake light, on its own clock — two lights
   * breathing together read as one light.
   */
  lightShimmer() {
    const c = settings.twilight;
    const t = this.age * c.lightGutterSpeed;
    return 1 - c.lightGutter * 0.5 * (1 - Math.sin(t * 1.7) * Math.sin(t * 3.1 + 1.3));
  }

  /** Nominal travel speed, metres/second. What the crystals unwind history by. */
  get travelSpeed() {
    return settings.twilight.speed * settings.global.speed;
  }

  /* ------------------------------------------------------------------ */
  /* Where the shot is — every metre resolved from live settings          */
  /* ------------------------------------------------------------------ */

  /**
   * The head, in world space.
   *
   * The base class puts `position` on the floor because that is what the aim
   * indicator targets and what `DummyField` sweeps its capsule along; the shot
   * flies, so the height belongs to the spine and this is simply where it has
   * got to.
   */
  _headPoint(out) {
    return twilightSpinePoint(this._path, this.front, out);
  }

  /** The middle of the ice wake, where the cold light stands. */
  _wakePoint(out) {
    const back = Math.max(0, this.front - settings.twilight.wakeLightBack);
    return twilightSpinePoint(this._path, back, out);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  onSpawn() {
    this._seed = Math.random() * 100;
    this._burstTime = -1;

    this._path.origin.copy(this.origin);
    this._path.dir.copy(this.direction);
    // The shader's lateral is `up × dir`; taking the same one here is what
    // keeps the JS and GLSL halves of the spine on the same side of the line.
    this._path.side.crossVectors(_worldUp, this.direction).normalize();
    this._path.seed = this._seed;

    this._wakeLight = this.ctx.lights.acquire();

    this._syncUniforms(0, 1);

    // The whole of the cast flourish. The plume is already rooted at the hand
    // and the crystals are already being struck off there — the three layers
    // are the cast, so all this has to add is the punch of light they throw.
    this.lightBoost = settings.twilight.lightIntensity * 0.5 * settings.global.explosionIntensity;
  }

  /* ------------------------------------------------------------------ */
  /* Feedback                                                            */
  /* ------------------------------------------------------------------ */

  /**
   * Push the live settings and the cast's state into all three materials.
   *
   * @param {number} burst 0..1 — the shot coming apart on the strike
   * @param {number} fade  1 while it is flying, ramping to 0 as it dies
   */
  _syncUniforms(burst, fade) {
    const c = settings.twilight;
    const g = settings.global;

    syncTwilightSpine(this.spine, this._path, this.front);

    /* ---- 2 · the crystals ---- */
    this._shardCount = Math.max(1, Math.min(MAX_SHARDS, Math.round(c.iceCount * g.particleCount)));
    this.gemGeometry.instanceCount = this._shardCount;
    // The splinters are the minority: the sheet is mostly gems with a scatter of
    // slivers between them, not a fifty-fifty mix.
    this.splinterGeometry.instanceCount = Math.max(1, Math.round(this._shardCount * c.iceSplinters));

    const iceState = this._iceState;
    // Held at the travel speed for the whole cast, strike included. Zeroing it
    // when the head stops is the obvious move and it is wrong: `uHeadSpeed`
    // sets how far back down the spine each crystal has slipped, so dropping it
    // to nothing teleports the entire wake forward onto the impact point in one
    // frame — which, with a burst term on top, is the "blow" at the end. The
    // shader freezes the trail against `stopped` instead, and stops feeding it.
    iceState.headSpeed = this.travelSpeed;
    // Seconds since the head came to rest; 0 while it is still flying. This is
    // all the crystals are ever told about the strike — they are a trail, and a
    // trail does not detonate. See `materials/IceShardMaterial.js`.
    iceState.stopped = Math.max(0, this._burstTime);
    // The ice outlives the other two layers a little — it is the only matter in
    // the ability, and matter does not switch off with the light that made it.
    iceState.fade = fade;
    this.iceMaterial.userData.sync(iceState);

    /* ---- 3 · the body at the point ---- */
    const tipState = this._tipState;
    tipState.burst = burst * c.tipBurstFlare * g.explosionIntensity;
    // The body goes with the thing it is the nose of, and it goes first: what
    // was driving the shot stops when the shot stops.
    tipState.fade = fade * (1 - Easing.outQuad(saturate(burst * 1.5)));
    this.coreMaterial.userData.sync(tipState);
    this.tipMaterial.userData.sync(tipState);

    /* ---- 3 · ... and the leaves off its flanks ---- */
    this._tongueCount = Math.max(1, Math.min(MAX_TONGUES, Math.round(c.plumeTongues)));
    this.plumeGeometry.instanceCount = this._tongueCount;

    const plumeState = this._plumeState;
    plumeState.tongues = this._tongueCount;
    plumeState.root = c.plumeRoot;
    // Blows open on the strike and is gone well before the crystals are: the
    // fire is what was pushing the thing, and it stops when the thing stops.
    plumeState.flare = burst * c.plumeBurstFlare * g.explosionIntensity;
    plumeState.fade = fade * (1 - Easing.outQuad(saturate(burst * 1.35)));
    this.plumeMaterial.userData.sync(plumeState);

    /* ---- 1 · the braid ---- */
    this._wispCount = Math.max(1, Math.min(MAX_WISPS, Math.round(c.wisps)));
    this.wispGeometry.instanceCount = this._wispCount;

    const wispState = this._wispState;
    // It can never reach further back than the shot has flown, or the tail
    // bunches on the caster's chest on the first frame.
    wispState.span = Math.max(0.5, Math.min(c.wispSpan, this.front + c.wispLead));
    wispState.strands = this._wispCount;
    // Carried by the shot, so it goes with it — the braid snaps back rather
    // than hanging in the air over the shatter.
    wispState.fade = fade * (1 - Easing.outQuad(saturate(burst * 1.2)));
    this.wispMaterial.userData.sync(wispState);
  }

  /**
   * The cold light standing in the ice wake, a few metres behind the tip.
   *
   * Ice glints, it does not gutter, so this one only breathes — and on a
   * different clock from the flame at the nose, because two lights moving
   * together read as one light.
   *
   * @param {number} scale 1 while it flies, falling away as it dies
   */
  _updateWakeLight(dt, scale) {
    if (!this._wakeLight) return;
    const c = settings.twilight;
    const t = this.age * c.wakeBreathSpeed;
    const breath = 1 - c.wakeBreath * 0.5 * (1 - Math.sin(t * 1.3) * Math.sin(t * 0.7 + 1.9));

    this._wakePoint(_root);
    this.ctx.lights.set(
      this._wakeLight,
      _root,
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
    const c = settings.twilight;
    const g = settings.global;

    this._syncUniforms(0, 1);
    // The light rides the head, not the floor under it — and so does the camera.
    this._headPoint(this.position);
    this._updateWakeLight(dt, 1);

    this.ctx.shake.rumble(c.rumble * g.cameraShake, dt);
  }

  onImpact() {
    const c = settings.twilight;
    const g = settings.global;

    this._burstTime = 0;
    this._headPoint(_head);
    twilightSpineFrame(this._path, this.front, _tangent, _side, _up);

    // The strike does two things that are not one of the three layers, and only
    // two: a shove and a punch of light. The fire at the nose blows open and
    // goes out, and that is the event. The ice does *not* take part: it is the
    // record of where the shot has been, so all the strike does to it is stop
    // laying more of it down — `_syncUniforms` hands the shader the time since
    // the head stopped and the wake freezes where it was drawn and drains, one
    // crystal at a time, as each lives out its life.
    this.ctx.shake.add(
      c.impactShake * g.explosionIntensity * g.cameraShake,
      1 / Math.max(0.1, c.shakeDuration),
      24
    );
    this.lightBoost = c.lightIntensity * 1.2 * g.explosionIntensity;
  }

  onFade(dt, t) {
    const c = settings.twilight;

    if (this._burstTime >= 0) this._burstTime += dt;

    // `t` runs 0..1 while the shot comes apart, then 1..2 while what is left of
    // it goes out.
    const burst = saturate(t);
    const fade = t > 1 ? 1 - Easing.inQuad(saturate(t - 1)) : 1;

    this._syncUniforms(burst, fade);
    this._headPoint(this.position);
    // The wake outlives the fire that struck it off — see `_syncUniforms`.
    this._updateWakeLight(dt, Math.max(0, 1 - burst * 1.6) * fade);

    if (t <= 1) this.ctx.shake.rumble(c.burnShake * settings.global.cameraShake, dt);
  }

  onDestroy() {
    this._burstTime = -1;
    this._wispCount = 1;
    this._tongueCount = 1;
    this._shardCount = 1;
    this.wispGeometry.instanceCount = 1;
    this.plumeGeometry.instanceCount = 1;
    this.gemGeometry.instanceCount = 1;
    this.splinterGeometry.instanceCount = 1;
    this.iceMaterial.uniforms.uFade.value = 0;
    this.iceMaterial.uniforms.uStopped.value = 0;
    this.wispMaterial.uniforms.uFade.value = 0;
    this.plumeMaterial.uniforms.uFade.value = 0;
    this.plumeMaterial.uniforms.uFlare.value = 0;
    this.tipMaterial.uniforms.uFade.value = 0;
    this.tipMaterial.uniforms.uBurst.value = 0;
    this.coreMaterial.uniforms.uFade.value = 0;
    this.coreMaterial.uniforms.uBurst.value = 0;

    this.ctx.lights.release(this._wakeLight);
    this._wakeLight = null;
  }

  dispose() {
    this.gemGeometry.dispose();
    this.splinterGeometry.dispose();
    this.iceMaterial.dispose();
    this.wispGeometry.dispose();
    this.wispMaterial.dispose();
    this.plumeGeometry.dispose();
    this.plumeMaterial.dispose();
    this.tipGeometry.dispose();
    this.tipMaterial.dispose();
    this.coreMaterial.dispose();
    super.dispose();
  }
}
