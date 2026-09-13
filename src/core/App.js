import { Vector3, MathUtils } from 'three';

import { Renderer } from './Renderer.js';
import { Time } from './Time.js';
import { CameraRig } from './CameraRig.js';
import { frame } from './FrameUniforms.js';

import { Environment } from '../world/Environment.js';
import { Ground } from '../world/Ground.js';
import { DustMotes } from '../world/DustMotes.js';
import { ContactShadows } from '../world/ContactShadows.js';

import { AssetLoader } from '../loaders/AssetLoader.js';
import { getStoneTextures } from '../loaders/StoneTextures.js';
import { buildDroneRig } from '../assets/DroneRig.js';
import { buildMonowheelRig } from '../assets/MonowheelRig.js';
import { buildPhoenixRig } from '../assets/PhoenixRig.js';
import { CharacterController } from '../animation/CharacterController.js';
import { DummyField } from '../combat/DummyField.js';

import { InputManager } from '../input/InputManager.js';
import { AimController } from '../input/AimController.js';
import { HandInput } from '../input/HandInput.js';

import { ParticleEngine } from '../particles/ParticleEngine.js';
import { LightPool } from '../effects/LightPool.js';
import { DecalSystem } from '../effects/GroundDecals.js';
import { BurstSystem } from '../effects/BurstSphere.js';
import { CameraShake } from '../effects/CameraShake.js';
import { ScreenFlash } from '../effects/ScreenFlash.js';

import { AbilityManager } from '../abilities/AbilityManager.js';
import { DroneState } from '../abilities/DroneAbility.js';
import { PostProcessing } from '../postprocessing/PostProcessing.js';

import { HUD, LoadingScreen } from '../ui/HUD.js';
import { Editor } from '../ui/Editor.js';

import { settings, ELEMENTS, ELEMENT_META, isSummon } from '../config/settings.js';

const HDR_URL = './hdri/spruit_sunrise.hdr';
const DRONE_URL = './models/drone.glb';
const MONOWHEEL_URL = './models/monowheelArmyBot.glb';
const PHOENIX_URL = './models/phoenix_bird.glb';

const _summonHeading = new Vector3();

/** What the toasts call each construct. */
const SUMMON_NAMES = { drone: 'drone', monowheel: 'bot' };

/** Hand the page back for one frame, so the loading veil can repaint. */
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Poll `test` once a frame until it passes or `timeout` runs out.
 *
 * Resolves either way: everything this waits on during boot is an optimisation,
 * and a slow download must not be able to hold the loading screen up forever.
 */
async function waitFor(test, timeout) {
  const deadline = performance.now() + timeout;
  while (!test() && performance.now() < deadline) await nextFrame();
}

/**
 * Application root: owns every subsystem and the frame loop.
 *
 * The wiring is deliberately one-directional — App builds the systems, hands the
 * ability manager a context object of the shared services, and then does nothing
 * but order the per-frame updates. No subsystem reaches back into App.
 *
 * The interaction is a single loop: select and arm an ability (Q / E), swing the
 * ground arrow with the mouse, click to fire. `AimController` owns the targeting
 * and emits one `cast` event; App turns that into an ability, a heading for the
 * character and a cooldown.
 *
 * The exception is a **summon** (`CastShape.SUMMON`: the drone, the monowheel
 * bot): its slot is a toggle rather than an arm, it is driven for as long as
 * it is out, and every other slot is refused while it is. App owns that lock,
 * because it is the one place every route into a cast — key, HUD click, hand
 * — passes. Both constructs answer the same control surface, so one deck and
 * one set of handlers drive whichever is out.
 */
export class App {
  constructor(canvas) {
    this.canvas = canvas;
    this.time = new Time();
    this.elapsed = 0;
    this.paused = false;
    this._raf = 0;

    /**
     * Seconds left before each ability can be armed again. Per element, so
     * spending one slot never locks the other out.
     */
    this.cooldowns = new Map(ELEMENTS.map((element) => [element, 0]));

    /* ---- core ---- */
    this.renderer = new Renderer(canvas);
    this.rig = new CameraRig(canvas);
    this.camera = this.rig.camera;

    this.environment = new Environment(this.renderer, this.camera);
    this.scene = this.environment.scene;

    /* ---- world ---- */
    this.ground = new Ground(this.environment);
    this.dust = new DustMotes();
    this.contactShadows = new ContactShadows(this.renderer, { size: 2.6, height: 2.4, blur: 2.0 });

    this.scene.add(this.ground.mesh, this.dust.points, this.contactShadows.group);
    this.dust.setPixelRatio(this.renderer.gl.getPixelRatio());

    /* ---- shared VFX services ---- */
    this.particles = new ParticleEngine(this.scene);
    this.lights = new LightPool(this.scene);
    this.decals = new DecalSystem(this.scene);
    this.bursts = new BurstSystem(this.scene);
    this.shake = new CameraShake(this.rig);
    this.flash = new ScreenFlash();

    /* ---- what the abilities are aimed at ---- */
    // Most abilities never hear about these: the field reads the casts instead
    // (`DummyField#applyHits`). The one exception is a cast that picks its own
    // targets, which needs to *ask* who is standing nearby — so the field is
    // built before the manager and handed over in its context.
    this.dummies = new DummyField(this.environment);
    this.scene.add(this.dummies.group);

    /**
     * Geometry that had to be loaded rather than generated, keyed by name.
     *
     * Handed to the abilities by reference and filled in by `load()`: the pools
     * build their instances lazily, on the first cast of an ability, which is
     * long after the assets have landed.
     */
    this.models = {};

    this.abilities = new AbilityManager({
      scene: this.scene,
      camera: this.camera,
      environment: this.environment,
      particles: this.particles,
      lights: this.lights,
      decals: this.decals,
      bursts: this.bursts,
      shake: this.shake,
      flash: this.flash,
      dummies: this.dummies,
      models: this.models
    });

    /* ---- character ---- */
    this.character = new CharacterController(this.environment);
    this.scene.add(this.character.root);

    /* ---- input & targeting ---- */
    this.input = new InputManager(canvas);
    /**
     * Camera mode. Constructed cold — it opens no device until `M` asks it to,
     * so a machine with no webcam, or a user who never grants the permission,
     * pays nothing and notices nothing.
     */
    this.hands = new HandInput();
    this.cameraMode = false;
    this._editorWasHidden = false;

    /**
     * The summon that is out, or null, and which slot it came from. Every
     * input route checks this before it arms anything — while it is set, the
     * caster is driving, not casting.
     */
    this.summon = null;
    this.summonElement = null;
    /** Which of the hold-to-fire sources are down, so releasing one does not
     *  silence another. */
    this._mouseFiring = false;
    this._keysFiring = false;
    this._keySteering = false;
    this.aim = new AimController(this.camera);
    this.scene.add(this.aim.object3D);

    /* ---- post ---- */
    this.post = new PostProcessing(this.renderer, this.scene, this.camera);

    /* ---- UI ---- */
    this.loading = new LoadingScreen();
    this.hud = new HUD(document.getElementById('hud'));
    this.editor = new Editor({
      onClear: () => this.clearEffects(),
      onToast: (message) => this.hud.showToast(message)
    });

    this._bindEvents();
    this.selectAbility(ELEMENTS[0], { silent: true });

    this._focusPoint = new Vector3();
  }

  /** The ability currently in the slot. */
  get element() {
    return this.abilities.selected;
  }

  /* ------------------------------------------------------------------ */

  _bindEvents() {
    this.renderer.onResize((width, height, pixelRatio) => {
      this.rig.resize(width, height);
      this.post.setSize(width, height, pixelRatio);
      this.dust.setPixelRatio(pixelRatio);
    });

    this.input.on('pointer:move', (pointer) => this.aim.point(pointer));
    this.input.on('pointer:confirm', (pointer) => {
      // With a summon out, the button is a trigger and stays one until it
      // comes back up.
      if (this.summonOnStation) {
        this._mouseFiring = true;
        this._syncSummonFire();
        return;
      }
      this.aim.point(pointer);
      this.aim.confirm();
    });
    this.input.on('pointer:release', () => {
      if (!this._mouseFiring) return;
      this._mouseFiring = false;
      this._syncSummonFire();
    });
    this.input.on('action', (action, slot) => this._handleAction(action, slot, 'keys'));

    this.aim.on('cast', (origin, direction, distance) => this._cast(origin, direction, distance));
    this.aim.on('reject', () => this.hud.showToast('Too close — aim further out'));

    // Hand tracking speaks the same three events as the keyboard and mouse, so
    // it subscribes to the same handlers. Nothing downstream of this bus knows
    // which of the two is driving, and both stay live at once — on a stage the
    // keyboard fallback has to be one keypress away, never a mode away.
    this.hands.on('pointer:move', (pointer) => {
      // The open hand is the summon's stick while it is out: off the centre
      // of the frame it drives, near the centre it holds.
      if (this.summonOnStation) this.summon.steerFromPointer(pointer);
      this.aim.point(pointer);
    });
    this.hands.on('pointer:confirm', (pointer) => {
      // The fist is the trigger while it is out — `grab` carries that — and
      // must not also be read as a cast.
      if (this.summonLocked) return;
      this.aim.point(pointer);
      this.aim.confirm();
    });
    this.hands.on('grab', () => this._syncSummonFire());
    this.hands.on('pointer:lost', () => {
      // The arm came down. The summon holds where it is and stops shooting;
      // it does not come home — that is a deliberate gesture, not a lapse.
      if (!this.summonDeployed) return;
      this.summon.setSteer(0, 0);
      this._syncSummonFire();
    });
    this.hands.on('action', (action, slot) => this._handleAction(action, slot, 'hand'));
    this.hands.on('engaged', () => {
      if (this.summonLocked) {
        this.hud.showToast(`Hand tracking engaged — you are driving the ${this.summonName}`);
        return;
      }
      this.aim.arm();
      this.hud.showToast('Hand tracking engaged');
    });
    this.hands.on('error', () => {
      this.cameraMode = false;
      this.hud.setCameraVisible(false);
      this.hud.showToast('Camera unavailable — keyboard still works');
    });

    this.hud.onAbility = (element) => this.armAbility(element);
    this.hud.drone.on('steer', (x, y) => {
      if (this.summonOnStation) this.summon.steerFromStick(x, y);
    });
    this.hud.drone.on('fire', (down) => {
      this._mouseFiring = down;
      this._syncSummonFire();
    });
  }

  /** The summon is out, in any state — deploying, on station, or on its way home. */
  get summonDeployed() {
    return !!this.summon && this.summon.isActive;
  }

  /**
   * The summon is out and *holding the bar*: deploying or on station. One
   * on its way home has let go — the slot can be cast again while it prints
   * out, which is a second the presenter does not have to wait.
   */
  get summonLocked() {
    return this.summonDeployed && this.summon.state !== DroneState.RECALL;
  }

  /** The summon is out *and* answering the stick. */
  get summonOnStation() {
    return !!this.summon && this.summon.isOnStation;
  }

  /** Fold every hold-to-fire source into the one flag the summon reads. */
  _syncSummonFire() {
    if (!this.summonOnStation) return;
    this.summon.setFiring(this._mouseFiring || this._keysFiring || this.hands.state.grabbing);
  }

  /**
   * @param {string} action
   * @param {number} slot
   * @param {'keys'|'hand'} [source] which bus it came in on. Almost nothing
   *   cares; `cancel` does, because a hand that dropped out of frame and a
   *   presenter pressing Escape mean different things to a drone.
   */
  _handleAction(action, slot, source = 'keys') {
    switch (action) {
      case 'ability': {
        const element = ELEMENTS[slot] ?? this.element;
        // A summon's slot is a switch: the same press deploys and recalls.
        if (isSummon(element)) {
          this._toggleSummon(element);
          break;
        }
        if (this.summonLocked) {
          this.hud.showToast(`Recall the ${this.summonName} first`);
          break;
        }
        // Pressing the *same* key again puts an armed cast away, as it does in a
        // MOBA; pressing a different one swaps the slot without disarming.
        if (this.aim.isArmed && element === this.element) this.aim.cancel();
        else this.armAbility(element);
        break;
      }
      case 'abilityStep': {
        // With a summon out, the swap gesture is the recall: the presenter
        // is saying "next", and the construct is what has to go first. The
        // slot stays where it is — the next point steps it.
        if (this.summonLocked) {
          this._toggleSummon(this.summonElement);
          break;
        }
        // `slot` carries a direction here, not an index — the hand steps
        // relative to whatever is selected, so it cannot disagree with the
        // keyboard about which ability that is.
        const index = ELEMENTS.indexOf(this.element);
        const element = ELEMENTS[(index + slot + ELEMENTS.length) % ELEMENTS.length];
        // The slot moves even when the ability is cooling. `armAbility` would
        // refuse both the move and the arm together, and a swap gesture that
        // silently does nothing reads as the tracker having failed.
        this.selectAbility(element);
        if ((this.cooldowns.get(element) ?? 0) > 0) this.hud.showToast('Not ready');
        else this.aim.arm();
        break;
      }
      case 'cancel':
        // Escape brings the summon home. A hand lost to the tracker does not
        // — that fires the same action, and the construct should hold through
        // it — and neither does the right button, which is how the view is
        // orbited and would otherwise recall it on every drag.
        if (this.summonLocked && source !== 'hand' && slot !== 'pointer') {
          this._toggleSummon(this.summonElement);
          break;
        }
        this.aim.cancel();
        break;
      case 'toggleHelp':
        this.hud.toggleHelp();
        break;
      case 'toggleEditor':
        this.editor.toggle();
        break;
      case 'clear':
        this.clearEffects();
        this.hud.showToast('Effects cleared');
        break;
      case 'resetDummies':
        this.dummies.reset();
        this.hud.showToast('Targets reset');
        break;
      case 'toggleCamera':
        this._toggleCamera();
        break;
      case 'swapHands':
        // The roles came out backwards on this machine; see `HandInput`.
        if (!this.cameraMode) break;
        this.hands.swapHands();
        this.hud.showToast(`Aiming with your ${this.hands.aimHand.toLowerCase()} hand`);
        break;
      case 'togglePause':
        this.paused = !this.paused;
        this.hud.setPaused(this.paused);
        this.hud.showToast(this.paused ? 'Paused — the editor still applies' : 'Resumed');
        break;
      default:
        break;
    }
  }

  /**
   * Put an ability in the slot. The aim indicator and the HUD both follow,
   * because `range` and `minRange` are the ability's, not the app's.
   */
  selectAbility(element, options = {}) {
    if (!ELEMENTS.includes(element)) return;
    this.abilities.select(element);
    this.aim.setElement(element);
    this.hud.setElement(element, options);
  }

  /** Select an ability and arm it, unless it is still cooling down. */
  armAbility(element = this.element) {
    if (isSummon(element)) {
      this._toggleSummon(element);
      return;
    }
    if (this.summonLocked) {
      this.hud.showToast(`Recall the ${this.summonName} first`);
      return;
    }
    if ((this.cooldowns.get(element) ?? 0) > 0) {
      this.hud.showToast('Not ready');
      return;
    }
    // Selecting before arming means the arrow is already drawn to the new
    // ability's range on the frame it appears.
    if (element !== this.element) this.selectAbility(element);
    this.aim.arm();
  }

  _cast(origin, direction, distance) {
    const element = this.element;
    // A summon in the slot has no line to cast along: the confirm is the
    // toggle. This is the hand's way in — point to the slot, close the fist.
    if (isSummon(element)) {
      this._toggleSummon(element);
      return;
    }
    this.abilities.cast(origin, direction, distance, element);
    this.cooldowns.set(element, Math.max(0, settings[element].cooldown));

    // Snap onto the shot and throw the body into it. Which clip that is belongs
    // to the ability, so each spell can be cast with its own gesture.
    this.character.setFacing(this.aim.facing);
    this.character.playCast(settings[element].castAnim);
    this.character.castLunge();
  }

  /** What the toasts call the construct that is out. */
  get summonName() {
    return SUMMON_NAMES[this.summonElement] ?? 'summon';
  }

  /**
   * Deploy a summon, or bring it home.
   *
   * Deploying is a cast in every way that matters to the rest of the app —
   * it goes through the manager, it is pooled, the camera follows it — but
   * it is not aimed, and it does not start a cooldown: that starts on the
   * recall, because until then the slot is *in use*, not spent.
   *
   * Only one construct is out at a time. Pressing the slot of the one that is
   * out recalls it; pressing the other's while it holds the bar is refused,
   * the same as any cast would be.
   */
  _toggleSummon(element) {
    if (this.summonDeployed) {
      if (element !== this.summonElement) {
        if (this.summonLocked) {
          this.hud.showToast(`Recall the ${this.summonName} first`);
          return;
        }
        // The other one is already on its way out: it has let go of the bar,
        // and the manager retires it on its own. This one can go straight out.
      } else {
        if (this.summon.state === DroneState.RECALL) return;
        this.summon.recall();
        this.cooldowns.set(element, Math.max(0, settings[element].cooldown));
        this.hud.setDeployed(element, false);
        this.hud.drone.setVisible(false);
        this.hud.showToast(`${ELEMENT_META[element].label} recalled`);
        return;
      }
    }

    if ((this.cooldowns.get(element) ?? 0) > 0) {
      this.hud.showToast('Not ready');
      return;
    }

    this.selectAbility(element, { silent: true });
    this.aim.cancel();

    const yaw = this.character.facing;
    _summonHeading.set(Math.sin(yaw), 0, Math.cos(yaw));
    const summon = this.abilities.cast(this.character.position, _summonHeading, settings[element].range, element);
    if (!summon) return;
    this.summon = summon;
    this.summonElement = element;

    this._mouseFiring = false;
    this._keysFiring = false;
    this._keySteering = false;
    this.hud.setDeployed(element, true);
    this.hud.drone.setLabel(
      ELEMENT_META[element].deck ?? element.toUpperCase(),
      ELEMENT_META[element].key,
      element === 'drone' ? 'fly' : 'drive'
    );
    this.hud.drone.setVisible(true);
    this.hud.showToast(`${ELEMENT_META[element].label} deployed — hold fire to engage`);
    this.character.playCast(settings[element].castAnim);
  }

  /** The summon is gone — recalled, cleared, or retired. Put the deck away. */
  _summonDown() {
    if (this.summonElement) this.hud.setDeployed(this.summonElement, false);
    this.summon = null;
    this.summonElement = null;
    this._mouseFiring = false;
    this._keysFiring = false;
    this._keySteering = false;
    this.hud.drone.setVisible(false);
  }

  /**
   * The keys as a stick: WASD or the arrows drive, Space fires.
   *
   * Only ever *writes* the steer while a key is down, and writes a zero once
   * on the release, so the stick and the hand are free to drive in between.
   */
  _pollSummonKeys() {
    if (!this.summonOnStation) return;
    const keys = this.input.keys;

    let x = 0;
    let y = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) y += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) y -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;
    const steering = x !== 0 || y !== 0;
    if (steering) this.summon.setSteer(x, y);
    else if (this._keySteering) this.summon.setSteer(0, 0);
    this._keySteering = steering;

    const firing = keys.has('Space');
    if (firing !== this._keysFiring) {
      this._keysFiring = firing;
      this._syncSummonFire();
    }
  }

  clearEffects() {
    this.aim.cancel();
    this.abilities.clear();
    if (this.summon) this._summonDown();
    this.particles.reset();
    this.decals.clear();
    this.bursts.clear();
    this.lights.reset();
    this.shake.reset();
    this.flash.reset();
  }

  /* ------------------------------------------------------------------ */

  /** Load assets, warm the shader cache, then start the loop. */
  async load() {
    const assets = new AssetLoader();

    this.loading.setProgress(0.05, 'Loading environment…');
    const hdr = await assets.loadHDR(HDR_URL);
    await this.environment.loadEnvironment(hdr);
    frame.uEnvMap.value = this.environment.equirect;

    this.loading.setProgress(0.35, 'Loading floor…');
    await this.ground.loadTextures(assets);

    this.loading.setProgress(0.5, 'Loading character…');
    await this.character.load(assets);

    this.loading.setProgress(0.72, 'Loading targets…');
    await this.dummies.load(assets);

    this.loading.setProgress(0.8, 'Loading the drone…');
    const drone = await assets.loadGLTF(DRONE_URL);
    this.models.drone = buildDroneRig(drone.scene, { span: settings.drone.size });

    this.loading.setProgress(0.838, 'Loading the monowheel bot…');
    const monowheel = await assets.loadGLTF(MONOWHEEL_URL);
    this.models.monowheel = buildMonowheelRig(monowheel.scene, { height: settings.monowheel.size });

    this.loading.setProgress(0.845, 'Waking the phoenix…');
    const phoenix = await assets.loadGLTF(PHOENIX_URL);
    // The textures are still in flight when the model resolves; the bird's
    // shaders sample them on the warm-up draw, so wait for them to land.
    await assets.settled();
    this.models.phoenix = buildPhoenixRig(phoenix, { wingspan: settings.phoenix.wingspan });

    await this._precompile(0.85, 0.99);

    this.loading.setProgress(1, 'Ready');
    this.loading.hide();
    this.hud.reveal();

    this.start();
  }

  /**
   * Build every ability and draw it once, behind the loading veil.
   *
   * This used to be a single `WebGLRenderer#compileAsync` over the scene, and it
   * was doing close to nothing, for two separate reasons.
   *
   * The first is that **the abilities were not in the scene yet.** Their pools
   * are lazy, so at that point not one ability object existed and there was
   * nothing of theirs to compile.
   *
   * The second would have bitten even if they had been: **three compiles a
   * program for the state a material is drawn in, and `compile` guesses that
   * state from the render target that happens to be bound.** The program cache
   * key carries `outputColorSpace` and `toneMapping`, and both differ between
   * drawing to the canvas (sRGB, ACES) and drawing into the composer's HDR
   * target (linear, none) — which is the only way this app ever draws. Every
   * program that call produced was keyed for a render that never happens, and
   * was compiled a second time on the first real frame. The light counts have
   * the same problem: the distortion pass renders with the camera restricted to
   * one layer, so its materials want a *no point lights* variant that a compile
   * against the full camera never asks for.
   *
   * So the warm-up is a real frame from the real pipeline instead — depth
   * prepass, distortion pass, shadow map, composer — with the ability revealed
   * inside it. That pays up front, one ability at a time, for everything the
   * first cast used to pay for mid-fight: the geometry generation, the program
   * compiles for all four passes, and the first upload of every vertex buffer.
   *
   * @param {number} from progress ratio to start the labels at
   * @param {number} to   progress ratio to finish on
   */
  async _precompile(from, to) {
    const elements = this.abilities.elements;
    // Impact-only shaders: these are built on the first decal or shell of each
    // kind, which is a second hitch a moment after the first cast's.
    const releaseDecals = this.decals.prewarm();
    const releaseBursts = this.bursts.prewarm();

    // The arrow and the zone circle are hidden until the first arm, so they
    // would otherwise compile on the first press of Q.
    this._warmDraw([this.aim.object3D]);

    const warmed = [];
    for (let i = 0; i < elements.length; i++) {
      const element = elements[i];
      this.loading.setProgress(
        from + (to - from) * (i / elements.length),
        `Compiling ${ELEMENT_META[element]?.label ?? element}…`
      );
      // Both halves below block the main thread for as long as they take, so
      // yield first or the veil never shows a single one of these labels.
      await nextFrame();

      const ability = this.abilities.prewarm(element);
      if (!ability) continue;
      warmed.push(ability.group);
      this._warmDraw([ability.group]);
    }

    // Building the Toxic Shield is what *starts* the cathedral scan
    // downloading (loaders/StoneTextures.js), and a texture is uploaded to the
    // GPU by the first draw that binds it after its image lands — which would
    // be the first cast again, decoding four JPEGs mid-frame. So wait for them
    // and draw once more. Everything else on this pass is already compiled;
    // this frame exists only to move bytes.
    await waitFor(() => getStoneTextures().state.loaded >= 4, 4000);
    this._warmDraw(warmed);

    releaseDecals();
    releaseBursts();
  }

  /**
   * One full pipeline frame with `roots` forced visible.
   *
   * Visibility and frustum culling are both overridden, because three skips an
   * invisible subtree outright and a culled mesh never reaches `setProgram` —
   * either one would leave a shader for the first cast to compile. Only what
   * this call changed is put back, so a mesh that was hidden by its own
   * constructor stays hidden.
   *
   * @param {THREE.Object3D[]} roots
   */
  _warmDraw(roots) {
    const hidden = [];
    const culled = [];

    for (const root of roots) {
      root.traverse((node) => {
        if (node.visible === false) {
          node.visible = true;
          hidden.push(node);
        }
        if (node.frustumCulled === true) {
          node.frustumCulled = false;
          culled.push(node);
        }
      });
    }

    // Same order as `frame()`, so every pass sees what it will see in flight.
    // Nothing here is skipped: the warm-up has to touch every program the
    // pipeline can ask for, which is the whole point of it.
    this.renderer.gl.shadowMap.needsUpdate = true;
    this.contactShadows.render(this.scene);
    this.post.sync(this.elapsed, this.flash);
    this.post.render();

    for (const node of hidden) node.visible = false;
    for (const node of culled) node.frustumCulled = true;
  }

  /**
   * Is anything on screen that samples the depth buffer or writes a distortion
   * offset? Ability meshes, particles and burst shells are the only three, so
   * when all of them are gone both auxiliary passes have nothing to feed and
   * `PostProcessing#render` skips them.
   */
  get _liveEffects() {
    return (
      this.abilities.active.length > 0 ||
      this.particles.live ||
      this.bursts.active.length > 0
    );
  }

  start() {
    this.time.reset();
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      this.frame();
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this._raf);
  }

  /**
   * Turn camera mode on or off.
   *
   * Starting is asynchronous — the permission prompt, the wasm fileset and a
   * 7 MB model all have to land — so the panel is shown first and carries its
   * own "starting" line rather than the app freezing on a black corner.
   */
  async _toggleCamera() {
    if (this.cameraMode) {
      this.cameraMode = false;
      this.hands.stop();
      this.hud.setCameraVisible(false);
      this.editor.setHidden(this._editorWasHidden);
      this.aim.cancel();
      this.hud.showToast('Camera mode off');
      return;
    }

    this.cameraMode = true;
    // The editor is a tall right-hand column and the preview wants the corner
    // underneath it; at a laptop's window height they overlap outright. Camera
    // mode is a presentation mode, so the dev tool stands down — `G` still
    // brings it back for anyone who wants both.
    this._editorWasHidden = this.editor.hidden;
    this.editor.setHidden(true);
    this.hud.setCameraVisible(true);
    this.hud.camera.setStatus('Starting camera…');

    if (!(await this.hands.start())) return;
    this.hud.camera.attach(this.hands.video);
    this.hud.showToast('Open your palm to engage');
  }

  /* ------------------------------------------------------------------ */

  frame() {
    const gl = this.renderer.gl;
    gl.info.reset();

    const raw = this.time.tick();
    const dt = this.paused ? 0 : raw * settings.global.timeScale;
    this.elapsed += dt;

    /* ---- shared uniforms ---- */
    frame.uTime.value = this.elapsed;
    frame.uDelta.value = dt;
    frame.uShaderIntensity.value = settings.global.shaderIntensity;
    frame.uGlobalGlow.value = settings.global.glow;
    frame.uCameraNear.value = this.camera.near;
    frame.uCameraFar.value = this.camera.far;

    /* ---- simulation ---- */
    this.renderer.syncSettings();

    this.environment.setFocus(this.character.position.x, this.character.position.z);
    this.environment.update();

    // Hand tracking also runs on real time, and *before* targeting: the pointer
    // it emits has to be in the aim controller by the time that resolves, or the
    // indicator trails the hand by a frame.
    if (this.cameraMode) {
      this.hands.update(raw);
      this.hud.camera.update(this.hands.state, this.hands.latest, {
        element: this.element,
        // Locked, not merely deployed: one on its way home has let go of the
        // bar, and the slot's gestures are a cast's again.
        deployed: this.summonLocked,
        status: this._summonHandStatus()
      });
    }

    // Targeting runs on *real* time so the arrow keeps sweeping and animating
    // while the sandbox is paused — pausing freezes the effects, not the UI.
    this.aim.setOrigin(this.character.position);
    this.aim.update(raw);

    // The summon's bookkeeping. It can go on its own — recalled and faded,
    // cleared with C, retired by the manager — and the deck has to follow.
    if (this.summon && !this.summon.isActive) this._summonDown();
    this._pollSummonKeys();

    if (settings.character.turnToAim && this.aim.isArmed) {
      this.character.turnToward(this.aim.facing, settings.character.turnRate, raw);
    } else if (this.summonDeployed && settings[this.summonElement].watch) {
      // The operator watches the construct.
      const dx = this.summon.position.x - this.character.position.x;
      const dz = this.summon.position.z - this.character.position.z;
      if (dx * dx + dz * dz > 1) {
        this.character.turnToward(Math.atan2(dx, dz), settings.character.turnRate, raw);
      }
    }
    this.character.update(dt);

    for (const [element, remaining] of this.cooldowns) {
      if (remaining > 0) this.cooldowns.set(element, Math.max(0, remaining - raw));
    }

    this.ground.update(this.elapsed);
    this.dust.update(this.elapsed, this.character.position);

    this.abilities.update(dt);
    // The targets step first, then read the casts that were just advanced: a
    // body has to be standing in this frame's pose before it can be knocked
    // out of it.
    this.dummies.update(dt, this.character.position);
    this.dummies.applyHits(this.abilities.active);
    this.particles.flush(this.elapsed);
    this.decals.update(dt);
    this.bursts.update(dt);
    this.lights.update(dt);

    /* ---- camera ---- */
    const focus = this.abilities.focus;
    if (focus) this.rig.lookAt(focus.position, focus.cameraWeight);
    this.rig.setAnchor(this.character.position.x, 0, this.character.position.z);
    // Steering the view is edge-only, and only while a cast is armed: holding
    // the hand anywhere in the middle of the frame moves nothing, and letting
    // the aim go slides the view back over the caster.
    this.rig.pan(this.aim.isArmed ? this.aim.pointer : null, raw);
    this.shake.update(raw);
    this.flash.update(raw);
    this.rig.update(raw);

    this.contactShadows.setPosition(this.character.position.x, this.character.position.z);
    this.contactShadows.render(this.scene);

    /* ---- render ---- */
    // Exactly one sun shadow update per frame (see Renderer). The flag is
    // raised here but only *consumed* by the main pass: every auxiliary pass
    // holds it back, because each of them renders with the camera pinned to a
    // single layer and would build a map missing everyone else's casters.
    gl.shadowMap.needsUpdate = true;
    this.post.sync(this.elapsed, this.flash);
    this.post.render(this._liveEffects);

    /* ---- readouts ---- */
    for (const element of ELEMENTS) {
      this.hud.setCooldown(element, this.cooldowns.get(element) ?? 0, settings[element].cooldown);
    }
    this.hud.setArmed(this.aim.isArmed);
    if (this.summonDeployed) this.hud.drone.setStatus(...this._summonStatus());
    // The detection boxes read the camera the frame was just drawn with, so
    // they sit on the bodies rather than a frame behind them.
    if (this.summonOnStation) {
      this.hud.targets.update(raw, this.camera, this.summon, settings[this.summonElement]);
    } else {
      this.hud.targets.clear();
    }
    this.hud.update(raw, () => ({
      particles: this.particles.countLive(this.elapsed),
      calls: gl.info.render.calls,
      spikes: this.abilities.active.reduce((total, ability) => total + ability.instanceCount, 0),
      abilities: this.abilities.active.length
    }));
  }

  /** One line for the deck: what the summon is doing, and whether it is hot. */
  _summonStatus() {
    const summon = this.summon;
    if (summon.state === DroneState.DEPLOY) return ['Deploying…', false];
    if (summon.state === DroneState.RECALL) return [this.summonElement === 'drone' ? 'Returning' : 'Standing down', false];
    const n = summon.targetsInRange;
    if (summon.firing) {
      if (summon.mark) return [summon.lock >= 1 ? 'FIRING' : 'Locking…', true];
      return [n ? 'Acquiring…' : 'Scanning — nothing in range', true];
    }
    return [n ? 'On station · ' + n + ' in range' : 'On station', false];
  }

  /** What the camera panel should say while the hand is driving the summon. */
  _summonHandStatus() {
    if (!this.summonDeployed) return null;
    if (this.hands.state.grabbing) return 'Fist — firing';
    return this.summonElement === 'drone' ? 'Flying the drone' : 'Driving the bot';
  }

  /* ------------------------------------------------------------------ */

  dispose() {
    this.stop();
    this.input.dispose();
    this.hands.dispose();
    this.aim.dispose();
    this.abilities.dispose();
    this.particles.dispose();
    this.decals.dispose();
    this.bursts.dispose();
    this.lights.dispose();
    this.dummies.dispose();
    this.character.dispose();
    this.ground.dispose();
    this.dust.dispose();
    this.contactShadows.dispose();
    this.post.dispose();
    this.environment.dispose();
    this.editor.dispose();
    this.rig.dispose();
    this.renderer.dispose();
  }
}
