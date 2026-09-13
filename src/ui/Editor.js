import GUI from 'lil-gui';
import { settings, CAST_ANIMATIONS } from '../config/settings.js';
import { PresetManager } from './PresetManager.js';

/**
 * Real-time VFX editor.
 *
 * Every control binds straight to a field in `config/settings.js`. Because all
 * shaders, particle systems, lights and post passes *read* those fields each
 * frame, no controller needs an onChange handler: moving a slider updates the
 * prison that is already standing, the lance that is already in the air, the
 * next cast, the environment and the post stack simultaneously, with no rebuild
 * and no shader recompilation.
 *
 * That holds while the simulation is paused (`P`), which is the point — the
 * silhouette of a frozen shatter and the shape of a stopped wake are the
 * things worth tuning, and every ability re-resolves itself from these
 * values on a zero-length frame.
 */
export class Editor {
  /**
   * @param {object} hooks { onClear, onToast }
   */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.presets = new PresetManager();

    this.gui = new GUI({ title: 'VFX Editor', width: 330 });
    this.gui.domElement.style.setProperty('--title-height', '30px');

    this._presetState = { name: 'My preset', selected: this.presets.names[0] ?? '' };

    this._buildPresets();
    this._buildGlobal();
    this._buildAim();
    this._buildZone();
    this._buildFlux();
    this._buildTwilight();
    this._buildVoidSlash();
    this._buildDrone();
    this._buildPhoenix();
    this._buildMonowheel();
    this._buildShard();
    this._buildFrost();
    this._buildToxic();
    this._buildEnvironment();
    this._buildPost();
    this._buildCamera();
    this._buildCharacter();
    this._buildDummies();

    // Everything starts collapsed, top-level folders included. There are enough
    // controls here that any folder left open pushes the rest off the screen,
    // so the panel opens as a list of sections and the user picks one.
    this.gui.foldersRecursive().forEach((folder) => folder.close());
  }

  /* ------------------------------------------------------------------ */
  /* helpers                                                             */
  /* ------------------------------------------------------------------ */

  static range(folder, object, key, min, max, step, label) {
    return folder.add(object, key, min, max, step).name(label ?? key);
  }

  /**
   * Which clip the body throws when this ability fires.
   *
   * One per ability, because the gesture is part of how a spell reads — the
   * prison and the lance should not be cast the same way. `App` reads the value
   * at the moment of the cast, so switching it applies to the very next click.
   */
  static castAnimation(folder, object) {
    return folder.add(object, 'castAnim', CAST_ANIMATIONS).name('cast animation');
  }

  /**
   * The four colour stops of a particle system's lifetime gradient.
   *
   * `ParticleSystem#setGradient` samples them across a particle's own life, so
   * they are labelled by *when* they are seen rather than by what they are —
   * `A` is the instant it is born, `D` is the moment it dies.
   *
   * @param {string} prefix settings key without the A/B/C/D suffix
   */
  static gradient(folder, object, prefix, title) {
    const group = folder.addFolder(title);
    group.addColor(object, `${prefix}A`).name('birth');
    group.addColor(object, `${prefix}B`).name('early');
    group.addColor(object, `${prefix}C`).name('late');
    group.addColor(object, `${prefix}D`).name('death');
    return group;
  }

  refresh() {
    this.gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
  }

  toggle() {
    this.setHidden(!this._hidden);
  }

  /** Whether the column is currently stood down. */
  get hidden() {
    return this._hidden;
  }

  /**
   * Force a visibility. Remembers nothing — the caller owns the previous state,
   * because the only thing that drives this is camera mode wanting the right
   * hand column back, and it has to be able to give it up again.
   */
  setHidden(hidden) {
    this._hidden = hidden;
    this.gui.show(!hidden);
  }

  /* ------------------------------------------------------------------ */
  /* folders                                                             */
  /* ------------------------------------------------------------------ */

  _buildPresets() {
    const folder = this.gui.addFolder('Presets');
    const state = this._presetState;

    let selector = folder
      .add(state, 'selected', this.presets.names.length ? this.presets.names : [''])
      .name('preset');

    // lil-gui rebuilds the controller when the option list changes, so the
    // reference has to be replaced rather than mutated.
    const refreshOptions = () => {
      const names = this.presets.names;
      selector = selector.options(names.length ? names : ['']).name('preset');
      selector.setValue(names.includes(state.selected) ? state.selected : (names[0] ?? ''));
    };

    folder.add(state, 'name').name('name');

    folder
      .add(
        {
          save: () => {
            this.presets.save(state.name);
            state.selected = state.name;
            refreshOptions();
            this.hooks.onToast?.(`Saved preset "${state.name}"`);
          }
        },
        'save'
      )
      .name('Save preset');

    folder
      .add(
        {
          load: () => {
            if (this.presets.load(state.selected)) {
              this.refresh();
              this.hooks.onToast?.(`Loaded "${state.selected}"`);
            }
          }
        },
        'load'
      )
      .name('Load preset');

    folder
      .add(
        {
          duplicate: () => {
            const copy = this.presets.duplicate(state.selected);
            if (copy) {
              state.selected = copy;
              refreshOptions();
              this.hooks.onToast?.(`Duplicated to "${copy}"`);
            }
          }
        },
        'duplicate'
      )
      .name('Duplicate');

    folder
      .add(
        {
          remove: () => {
            if (this.presets.remove(state.selected)) {
              refreshOptions();
              this.hooks.onToast?.('Preset deleted');
            }
          }
        },
        'remove'
      )
      .name('Delete');

    folder.add({ exportOne: () => this.presets.exportJSON() }, 'exportOne').name('Export current (JSON)');
    folder.add({ exportAll: () => this.presets.exportAll() }, 'exportAll').name('Export all presets');

    folder
      .add(
        {
          import: async () => {
            const result = await this.presets.importFromFile();
            refreshOptions();
            this.refresh();
            this.hooks.onToast?.(
              result.applied
                ? 'Settings imported'
                : result.imported.length
                  ? `Imported ${result.imported.length} preset(s)`
                  : 'Nothing imported'
            );
          }
        },
        'import'
      )
      .name('Import JSON…');

    folder
      .add(
        {
          reset: () => {
            this.presets.reset();
            this.refresh();
            this.hooks.onToast?.('Reset to defaults');
          }
        },
        'reset'
      )
      .name('Reset to defaults');

    this.presetFolder = folder;
  }

  _buildGlobal() {
    const folder = this.gui.addFolder('Global');
    const g = settings.global;
    const R = Editor.range;

    R(folder, g, 'timeScale', 0.02, 2, 0.01, 'time scale');
    R(folder, g, 'speed', 0.1, 4, 0.01, 'cast speed');
    R(folder, g, 'lifetime', 0.1, 4, 0.01, 'lifetime');
    R(folder, g, 'glow', 0, 5, 0.01, 'glow intensity');
    R(folder, g, 'shaderIntensity', 0, 2, 0.01, 'shader intensity');
    R(folder, g, 'opacity', 0, 2, 0.01, 'opacity');
    R(folder, g, 'noiseFrequency', 0.1, 4, 0.01, 'noise frequency');
    R(folder, g, 'noiseSpeed', 0, 4, 0.01, 'noise speed');
    R(folder, g, 'turbulence', 0, 4, 0.01, 'turbulence');
    R(folder, g, 'randomness', 0, 2, 0.01, 'randomness');
    R(folder, g, 'fresnel', 0, 3, 0.01, 'fresnel strength');
    R(folder, g, 'distortion', 0, 3, 0.01, 'heat distortion');

    const particles = folder.addFolder('Particles');
    R(particles, g, 'particleCount', 0, 3, 0.01, 'count');
    R(particles, g, 'particleLifetime', 0.1, 3, 0.01, 'lifetime');
    R(particles, g, 'particleSpeed', 0.1, 3, 0.01, 'speed');
    R(particles, g, 'particleSize', 0.1, 3, 0.01, 'size');
    R(particles, g, 'emissionRate', 0, 3, 0.01, 'emission rate');

    const lighting = folder.addFolder('Lighting & impact');
    R(lighting, g, 'lightIntensity', 0, 4, 0.01, 'light intensity');
    R(lighting, g, 'lightRadius', 0.1, 4, 0.01, 'light radius');
    R(lighting, g, 'explosionIntensity', 0, 3, 0.01, 'impact intensity');
    R(lighting, g, 'cameraShake', 0, 3, 0.01, 'camera shake');
    R(lighting, g, 'animationSpeed', 0, 3, 0.01, 'animation speed');

    this.globalFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  _buildAim() {
    const folder = this.gui.addFolder('➤  Aim indicator');
    const a = settings.aim;
    const R = Editor.range;

    const shape = folder.addFolder('Silhouette (metres)');
    R(shape, a, 'shaftWidth', 0.05, 2, 0.01, 'shaft half-width');
    R(shape, a, 'headLength', 0.2, 8, 0.05, 'head length');
    R(shape, a, 'headWidth', 0.1, 5, 0.01, 'head half-width');
    R(shape, a, 'round', 0, 0.6, 0.01, 'corner rounding');
    R(shape, a, 'startOffset', 0, 5, 0.05, 'gap at the caster');
    R(shape, a, 'height', 0.005, 0.4, 0.005, 'hover height');

    const look = folder.addFolder('Rendering');
    R(look, a, 'edge', 0.01, 0.5, 0.005, 'outline thickness');
    R(look, a, 'edgeGlow', 0, 8, 0.05, 'outline glow');
    R(look, a, 'softness', 0.005, 0.5, 0.005, 'edge softness');
    R(look, a, 'fill', 0, 1.5, 0.01, 'interior fill');
    R(look, a, 'fillFalloff', 0.1, 4, 0.05, 'fill falloff');
    R(look, a, 'opacity', 0, 2, 0.01, 'opacity');
    look.addColor(a, 'colorCore').name('core colour');
    look.addColor(a, 'colorEdge').name('edge colour');
    look.addColor(a, 'colorInvalid').name('too-close colour');

    const energy = folder.addFolder('Energy & frost');
    R(energy, a, 'stripes', 0, 4, 0.01, 'chevrons / metre');
    R(energy, a, 'stripeSharp', 0, 1, 0.01, 'chevron sharpness');
    R(energy, a, 'stripeDepth', 0, 1, 0.01, 'chevron depth');
    R(energy, a, 'scrollSpeed', -10, 10, 0.05, 'scroll speed');
    R(energy, a, 'pulse', 0, 1, 0.01, 'pulse');
    R(energy, a, 'pulseSpeed', 0, 8, 0.05, 'pulse speed');
    R(energy, a, 'noise', 0, 1.5, 0.01, 'frost noise');
    R(energy, a, 'noiseScale', 0.1, 8, 0.05, 'noise scale');
    R(energy, a, 'noiseSpeed', 0, 3, 0.01, 'noise speed');
    R(energy, a, 'crystals', 0, 2, 0.01, 'frost plates');
    R(energy, a, 'crystalScale', 0.2, 10, 0.05, 'plate scale');

    const furniture = folder.addFolder('Rings & rosette');
    R(furniture, a, 'baseRing', 0, 3, 0.01, 'base ring radius');
    R(furniture, a, 'baseRingWidth', 0.005, 0.4, 0.005, 'base ring width');
    R(furniture, a, 'tipGlyph', 0, 2, 0.01, 'tip rosette');
    R(furniture, a, 'tipGlyphSize', 0.1, 4, 0.05, 'rosette radius');
    R(furniture, a, 'tipSpin', -3, 3, 0.01, 'rosette spin');
    R(furniture, a, 'rangeArc', 0, 2, 0.01, 'range arc');
    R(furniture, a, 'reveal', 0.01, 1, 0.005, 'sweep-out time');
  }

  /* ------------------------------------------------------------------ */

  /**
   * The far-cast indicator — the circle every zone ability is aimed with.
   *
   * Shared, like the arrow: it is a property of the *targeting*, not of any one
   * ability, so a second far cast inherits the whole thing and brings only its
   * own `zoneRadius`. The two controls worth reaching for first are `boundary`
   * (how thick the footprint edge reads) and `snap` (how hard it overshoots on
   * the way out), which between them decide whether the circle feels like a UI
   * overlay or like something the caster is doing.
   */
  _buildZone() {
    const folder = this.gui.addFolder('◎  Far-cast circle');
    const z = settings.zone;
    const R = Editor.range;

    const edge = folder.addFolder('The boundary (metres)');
    R(edge, z, 'boundary', 0.02, 2, 0.01, 'band thickness');
    R(edge, z, 'boundaryBias', 0, 1, 0.01, 'band bias out/in');
    R(edge, z, 'boundaryGlow', 0, 8, 0.05, 'band glow');
    R(edge, z, 'liner', 0.005, 0.4, 0.005, 'inner liner');
    R(edge, z, 'softness', 0.005, 0.4, 0.005, 'edge softness');
    R(edge, z, 'height', 0.005, 0.4, 0.005, 'hover height');

    const inside = folder.addFolder('The interior');
    R(inside, z, 'fill', 0, 1.5, 0.01, 'interior fill');
    R(inside, z, 'fillFalloff', 0.1, 5, 0.05, 'fill falloff');
    R(inside, z, 'rings', 0, 12, 0.1, 'contour rings');
    R(inside, z, 'ringWidth', 0.005, 0.5, 0.005, 'ring width');
    R(inside, z, 'ringSpeed', -4, 4, 0.01, 'ring speed');
    R(inside, z, 'crawl', 0, 3, 0.01, 'filaments');
    R(inside, z, 'crawlScale', 0.1, 8, 0.05, 'filaments / metre');
    R(inside, z, 'crawlSpeed', -4, 4, 0.01, 'filament crawl');
    R(inside, z, 'noise', 0, 1.5, 0.01, 'break-up');
    R(inside, z, 'noiseScale', 0.1, 8, 0.05, 'break-up scale');

    const furniture = folder.addFolder('Ticks, sweep & reticle');
    R(furniture, z, 'ticks', 0, 96, 1, 'boundary ticks');
    R(furniture, z, 'tickLength', 0.05, 3, 0.01, 'tick length');
    R(furniture, z, 'tickWidth', 0.02, 0.9, 0.01, 'tick duty');
    R(furniture, z, 'tickSpin', -2, 2, 0.005, 'tick spin');
    R(furniture, z, 'sweep', 0, 3, 0.01, 'radar sweep');
    R(furniture, z, 'sweepSpeed', -3, 3, 0.01, 'sweep speed');
    R(furniture, z, 'core', 0, 3, 0.01, 'centre mark');
    R(furniture, z, 'coreSize', 0.05, 3, 0.01, 'centre size');
    R(furniture, z, 'crosshair', 0, 3, 0.01, 'reticle arms');
    R(furniture, z, 'crosshairLength', 0.1, 6, 0.05, 'arm length');
    R(furniture, z, 'pulse', 0, 1, 0.01, 'pulse');
    R(furniture, z, 'pulseSpeed', 0, 8, 0.05, 'pulse speed');

    const reach = folder.addFolder('The reach ring');
    R(reach, z, 'reach', 0, 3, 0.01, 'reach brightness');
    R(reach, z, 'reachWidth', 0.005, 0.5, 0.005, 'reach width');
    R(reach, z, 'reachDashes', 0, 200, 1, 'dashes');
    R(reach, z, 'reachDashGap', 0, 0.95, 0.01, 'dash gap');
    R(reach, z, 'reachSpin', -1, 1, 0.005, 'dash creep');
    R(reach, z, 'reachLead', 0, 3, 0.01, 'lead marker');

    const look = folder.addFolder('Rendering');
    R(look, z, 'opacity', 0, 2, 0.01, 'opacity');
    R(look, z, 'reveal', 0.01, 1, 0.005, 'snap-out time');
    R(look, z, 'snap', 1, 2, 0.01, 'snap overshoot');
    look.addColor(z, 'colorCore').name('core colour');
    look.addColor(z, 'colorEdge').name('fill colour');
    look.addColor(z, 'colorInvalid').name('too-close colour');
  }

  /**
   * The Shimmering Flux of Chaos, grouped by the six panels of its breakdown
   * sheet.
   *
   * The folder names are the panel names on purpose. Judging a stacked effect
   * means being able to look at one layer at a time, and the fastest way to do
   * that here is to walk down this folder zeroing `coneOpacity`,
   * `bloodOpacity`, `ribbonOpacity`, `glintRate`, `warpStrength` and `moteRate`
   * in turn — each one takes exactly one panel of the reference out of the
   * frame.
   *
   * Two units are in play. Anything about the **cast** is in metres; anything
   * named `cone*` that is a count or a fraction — rings, ribs, turns, `coneHead`,
   * `coneTailFade` — is in the funnel's own parameter space, where u runs 0 → 1
   * from the nose to the mouth. That is what lets the same mesh sit on a
   * two-metre funnel and a ten-metre one.
   */
  _buildFlux() {
    const folder = this.gui.addFolder('✦  Shimmering Flux');
    const c = settings.flux;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'range', 4, 60, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 12, 0.1, 'min range');
    R(cast, c, 'speed', 4, 90, 0.5, 'flight speed (m/s)');
    R(cast, c, 'burstTime', 0.1, 3, 0.01, 'tears apart over');
    R(cast, c, 'fadeTime', 0.1, 4, 0.01, 'what is left fades over');
    R(cast, c, 'cooldown', 0, 10, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    /* ---- the curve everything else is hung off ---- */
    const path = folder.addFolder('The flight path');
    R(path, c, 'weave', 0, 3, 0.01, 'wander (m)');
    R(path, c, 'weaveWaves', 0.05, 3, 0.01, 'long swing (rad/m)');
    R(path, c, 'weaveWaves2', 0.05, 4, 0.01, 'short swing (rad/m)');
    R(path, c, 'weaveRise', 0, 2, 0.01, 'vertical wander');
    R(path, c, 'launchHeight', 0.2, 3, 0.01, 'launch height (m)');
    R(path, c, 'flightHeight', 0.2, 6, 0.01, 'cruise height (m)');
    R(path, c, 'riseDistance', 0.5, 20, 0.1, 'settles over (m)');
    R(path, c, 'trailSpan', 1, 30, 0.1, 'emitters seed over (m)');

    /* ---- panel 1 ---- */
    const cone = folder.addFolder('1 · The conical mesh trail');
    R(cone, c, 'coneLength', 0.5, 25, 0.1, 'reach back (m)');
    R(cone, c, 'coneRadius', 0.05, 5, 0.01, 'trailing mouth radius (m)');
    R(cone, c, 'coneTip', 0.005, 0.6, 0.005, 'radius at the nose');
    R(cone, c, 'coneFlare', 0.1, 4, 0.01, 'flare (>1 horn)');
    R(cone, c, 'coneRings', 2, 80, 1, 'rings across it');
    R(cone, c, 'coneRibs', 3, 64, 1, 'ribs around it');
    R(cone, c, 'coneSpiralArms', 1, 12, 1, 'helices');
    R(cone, c, 'coneSpiralTurns', 0, 20, 0.1, 'turns each makes');
    R(cone, c, 'coneSpiralSpin', -4, 4, 0.01, 'helix roll (turns/s)');
    R(cone, c, 'coneFlow', -8, 8, 0.05, 'rings travel (per second)');
    R(cone, c, 'coneWire', 0.1, 6, 0.05, 'ring/rib width (px)');
    R(cone, c, 'coneSpiralWire', 0.1, 8, 0.05, 'helix width (px)');
    R(cone, c, 'coneMesh', 0, 3, 0.01, 'ring/rib strength');
    R(cone, c, 'coneSpiral', 0, 3, 0.01, 'helix strength');
    R(cone, c, 'coneFill', 0, 0.6, 0.005, 'interior wash');
    R(cone, c, 'coneFresnel', 0, 3, 0.01, 'silhouette rim');
    R(cone, c, 'coneFresnelPower', 0.5, 8, 0.05, 'rim tightness');
    R(cone, c, 'coneErode', 0, 1.5, 0.01, 'eaten through');
    R(cone, c, 'coneErodeScale', 0.1, 6, 0.05, 'erosion scale');
    R(cone, c, 'coneErodeSpeed', 0, 6, 0.05, 'erosion speed');
    R(cone, c, 'coneWobble', 0, 1, 0.005, 'off a clean cone');
    R(cone, c, 'coneWobbleScale', 0.1, 6, 0.05, 'wobble scale');
    R(cone, c, 'coneWobbleSpeed', 0, 6, 0.05, 'wobble speed');
    R(cone, c, 'coneHead', 0.01, 0.6, 0.005, 'white nose reaches');
    R(cone, c, 'coneNoseFade', 0.001, 0.5, 0.005, 'nose capped off');
    R(cone, c, 'coneTailFade', 0.05, 1, 0.01, 'mouth dissolves from');
    R(cone, c, 'conePulse', 0, 5, 0.01, 'charge along it');
    R(cone, c, 'conePulseFreq', 0.2, 10, 0.05, 'charges over it');
    R(cone, c, 'conePulseSpeed', -6, 6, 0.05, 'charge speed');
    R(cone, c, 'coneBurstFlare', 0, 4, 0.01, 'mouth blows open');
    R(cone, c, 'coneIntensity', 0, 8, 0.01, 'intensity');
    R(cone, c, 'coneOpacity', 0, 2, 0.01, 'opacity');
    R(cone, c, 'coneSoftFade', 0.02, 3, 0.01, 'soft fade (m)');
    cone.addColor(c, 'colorConeCore').name('nose');
    cone.addColor(c, 'colorCone').name('body');
    cone.addColor(c, 'colorConeTail').name('mouth');

    /* ---- panel 2 ---- */
    const blood = folder.addFolder('2 · The fluid blood splatter');
    R(blood, c, 'ligaments', 1, 16, 1, 'strands');
    R(blood, c, 'bloodRate', 0.1, 12, 0.05, 'throws/second each');
    R(blood, c, 'bloodLife', 0.05, 3, 0.01, 'one strand lasts');
    R(blood, c, 'bloodThrow', 0, 20, 0.05, 'thrown at (m/s)');
    R(blood, c, 'bloodBack', 0, 3, 0.01, 'backwards along the path');
    R(blood, c, 'bloodForward', 0, 3, 0.01, 'forwards, on the strike');
    R(blood, c, 'bloodBurstThrow', 0, 6, 0.05, 'strike throws harder');
    R(blood, c, 'bloodSpread', 0, 3, 0.01, 'off the axis');
    R(blood, c, 'bloodCarry', 0, 1, 0.01, 'keeps the head\'s speed');
    R(blood, c, 'bloodRootSpread', 0, 8, 0.05, 'tears from back to (m)');
    R(blood, c, 'bloodGravity', 0, 30, 0.1, 'gravity');
    R(blood, c, 'bloodNeck', 0, 0.95, 0.01, 'stretch (tail is slower)');
    R(blood, c, 'bloodCurl', 0, 5, 0.05, 'how far it bows');
    R(blood, c, 'bloodWidth', 0.005, 0.4, 0.005, 'width (m)');
    R(blood, c, 'bloodTaper', 0.1, 5, 0.05, 'thins toward the tail');
    R(blood, c, 'bloodBeads', 0, 1.5, 0.01, 'beading');
    R(blood, c, 'bloodBeadFreq', 0.2, 12, 0.1, 'beads over the strand');
    R(blood, c, 'bloodNeckDepth', 0, 1, 0.01, 'thins before it breaks');
    R(blood, c, 'bloodGloss', 1, 120, 0.5, 'highlight tightness');
    R(blood, c, 'bloodSheen', 0, 4, 0.01, 'highlight strength');
    R(blood, c, 'bloodRim', 0, 3, 0.01, 'lit through where thin');
    R(blood, c, 'bloodOpacity', 0, 1.5, 0.01, 'opacity');
    R(blood, c, 'bloodSoftFade', 0.02, 2, 0.01, 'soft fade (m)');
    blood.addColor(c, 'colorBloodDeep').name('in shadow');
    blood.addColor(c, 'colorBlood').name('lit');
    blood.addColor(c, 'colorBloodSheen').name('wet highlight');
    blood.addColor(c, 'colorBloodRim').name('lit through');
    R(blood, c, 'dropRate', 0, 400, 1, 'droplets/second');
    R(blood, c, 'dropRadius', 0, 1, 0.01, 'born within (m)');
    R(blood, c, 'dropSize', 0.005, 0.4, 0.005, 'droplet size');
    R(blood, c, 'dropLifetime', 0.05, 4, 0.01, 'droplet lifetime');
    R(blood, c, 'dropGravity', 0, 40, 0.1, 'droplet gravity');
    R(blood, c, 'dropStretch', 0, 2, 0.01, 'droplet stretch');
    R(blood, c, 'dropOpacity', 0, 1.5, 0.01, 'droplet opacity');
    R(blood, c, 'dropGlow', 0, 3, 0.01, 'droplet glow');
    R(blood, c, 'burstDrops', 0, 600, 1, 'thrown by the strike');
    Editor.gradient(blood, c, 'colorDrop', 'droplet gradient');

    /* ---- panel 3 ---- */
    const ribbons = folder.addFolder('3 · The chaotic energy ribbons');
    R(ribbons, c, 'ribbons', 1, 12, 1, 'strands');
    R(ribbons, c, 'ribbonSpan', 1, 30, 0.1, 'reach back (m)');
    R(ribbons, c, 'ribbonLead', 0, 8, 0.05, 'run past the head (m)');
    R(ribbons, c, 'ribbonRadius', 0, 4, 0.01, 'coil radius (m)');
    R(ribbons, c, 'ribbonCoil', 0, 8, 0.05, 'turns over the span');
    R(ribbons, c, 'ribbonSpin', -3, 3, 0.01, 'roll (turns/s)');
    R(ribbons, c, 'ribbonSwell', 0.1, 3, 0.01, 'where it is fattest');
    R(ribbons, c, 'ribbonChaos', 0, 4, 0.01, 'thrown off axis (m)');
    R(ribbons, c, 'ribbonChaosScale', 0.1, 8, 0.05, 'chaos scale');
    R(ribbons, c, 'ribbonChaosSpeed', 0, 5, 0.01, 'chaos speed');
    R(ribbons, c, 'ribbonStraight', 0, 1, 0.01, 'run straight (fraction)');
    R(ribbons, c, 'ribbonStraightRadius', 0, 1, 0.01, 'straight: orbit radius');
    R(ribbons, c, 'ribbonStraightChaos', 0, 1, 0.01, 'straight: wander');
    R(ribbons, c, 'ribbonStraightWidth', 0.05, 2, 0.01, 'straight: width');
    R(ribbons, c, 'ribbonWidth', 0.005, 0.6, 0.005, 'width (m)');
    R(ribbons, c, 'ribbonWidthTip', 0, 4, 0.01, 'width at the tail');
    R(ribbons, c, 'ribbonTwist', 0, 1, 0.01, 'how far the strip rolls');
    R(ribbons, c, 'ribbonTwistTurns', 0, 10, 0.05, 'twists over the span');
    R(ribbons, c, 'ribbonTwistSpeed', -4, 4, 0.01, 'twist speed');
    R(ribbons, c, 'ribbonTwistFace', 0.02, 1, 0.01, 'width when edge-on');
    R(ribbons, c, 'ribbonSharp', 0.2, 8, 0.05, 'edge falloff');
    R(ribbons, c, 'ribbonCore', 1, 40, 0.5, 'core thread');
    R(ribbons, c, 'ribbonPulse', 0, 5, 0.01, 'charge along it');
    R(ribbons, c, 'ribbonPulseFreq', 0.2, 10, 0.05, 'charges over it');
    R(ribbons, c, 'ribbonPulseSpeed', -6, 6, 0.05, 'charge speed');
    R(ribbons, c, 'ribbonFlicker', 0, 1, 0.01, 'stutter');
    R(ribbons, c, 'ribbonFlickerScale', 0.5, 20, 0.1, 'stutter scale');
    R(ribbons, c, 'ribbonFlickerSpeed', 0, 8, 0.05, 'stutter speed');
    R(ribbons, c, 'ribbonTailFade', 0.05, 1, 0.01, 'dissolves at');
    R(ribbons, c, 'ribbonIntensity', 0, 8, 0.01, 'intensity');
    R(ribbons, c, 'ribbonOpacity', 0, 2, 0.01, 'opacity');
    R(ribbons, c, 'ribbonSoftFade', 0.02, 3, 0.01, 'soft fade (m)');
    ribbons.addColor(c, 'colorRibbonCore').name('core');
    ribbons.addColor(c, 'colorRibbon').name('crimson strands');
    ribbons.addColor(c, 'colorRibbonAlt').name('rose strands');
    ribbons.addColor(c, 'colorRibbonTail').name('tail');

    /* ---- panel 4 ---- */
    const glints = folder.addFolder('4 · The glinting sparkles');
    R(glints, c, 'glintRate', 0, 600, 1, 'sparkles/second');
    R(glints, c, 'glintRadius', 0, 2, 0.01, 'born within (m)');
    R(glints, c, 'glintSize', 0.01, 1, 0.005, 'size');
    R(glints, c, 'glintLifetime', 0.05, 4, 0.01, 'lifetime');
    R(glints, c, 'glintSpeed', 0, 10, 0.05, 'speed');
    R(glints, c, 'glintRise', -3, 3, 0.01, 'rise');
    R(glints, c, 'glintDrift', 0, 3, 0.01, 'left behind');
    R(glints, c, 'glintSpin', 0, 6, 0.05, 'star turns (rad/s)');
    R(glints, c, 'glintTurbulence', 0, 3, 0.01, 'turbulence');
    R(glints, c, 'glintGlow', 0, 6, 0.01, 'glow');
    R(glints, c, 'castGlints', 0, 300, 1, 'thrown on the cast');
    R(glints, c, 'burstGlints', 0, 600, 1, 'thrown by the strike');
    Editor.gradient(glints, c, 'colorGlint', 'sparkle gradient');

    /* ---- panel 5 ---- */
    const warp = folder.addFolder('5 · The distortion wave');
    R(warp, c, 'warpSize', 0.5, 16, 0.05, 'reach (m)');
    R(warp, c, 'warpLens', 0, 3, 0.01, 'the lens');
    R(warp, c, 'warpLensPower', 0.2, 6, 0.05, 'lens tightness');
    R(warp, c, 'warpChurn', 0, 3, 0.01, 'how hard it boils');
    R(warp, c, 'warpScale', 0.1, 6, 0.05, 'churn scale');
    R(warp, c, 'warpSpeed', 0, 6, 0.05, 'churn speed');
    R(warp, c, 'warpWave', 0, 3, 0.01, 'wave packets');
    R(warp, c, 'warpWaveRate', 0, 8, 0.05, 'waves/second');
    R(warp, c, 'warpWaveWidth', 0.02, 0.6, 0.005, 'packet depth');
    R(warp, c, 'warpRipples', 1, 40, 0.5, 'bands inside it');
    R(warp, c, 'warpBurst', 0, 6, 0.05, 'the strike\'s wave');
    R(warp, c, 'warpBurstLife', 0.1, 4, 0.05, 'it lasts');
    R(warp, c, 'warpBurstSpeed', 1, 60, 0.5, 'it crosses at (m/s)');
    R(warp, c, 'warpBurstSize', 0, 4, 0.05, 'proxy grows by');
    R(warp, c, 'warpBurstWidth', 0.02, 0.8, 0.005, 'its depth');
    R(warp, c, 'warpStrength', 0, 3, 0.01, 'strength');

    /* ---- panel 6 ---- */
    const motes = folder.addFolder('6 · The lingering crimson motes');
    R(motes, c, 'moteRate', 0, 400, 1, 'motes/second');
    R(motes, c, 'moteRadius', 0, 2, 0.01, 'born within (m)');
    R(motes, c, 'moteSize', 0.005, 0.4, 0.005, 'size');
    R(motes, c, 'moteLifetime', 0.1, 8, 0.05, 'lifetime');
    R(motes, c, 'moteSpeed', 0, 8, 0.05, 'speed');
    R(motes, c, 'moteRise', -3, 3, 0.01, 'rise');
    R(motes, c, 'moteDrift', 0, 3, 0.01, 'left behind');
    R(motes, c, 'moteTurbulence', 0, 3, 0.01, 'turbulence');
    R(motes, c, 'moteOpacity', 0, 2, 0.01, 'opacity');
    R(motes, c, 'moteGlow', 0, 4, 0.01, 'glow');
    R(motes, c, 'castMotes', 0, 300, 1, 'thrown on the cast');
    R(motes, c, 'burstMotes', 0, 600, 1, 'thrown by the strike');
    Editor.gradient(motes, c, 'colorMote', 'mote gradient');

    /* ---- everything the strike does that is not one of the six ---- */
    const strike = folder.addFolder('The strike, camera & light');
    R(strike, c, 'impactShake', 0, 1, 0.005, 'impact shake');
    R(strike, c, 'shakeDuration', 0.05, 2, 0.01, 'shake decay');
    R(strike, c, 'rumble', 0, 0.3, 0.002, 'flight rumble');
    R(strike, c, 'burnShake', 0, 0.3, 0.002, 'break-up rumble');
    R(strike, c, 'lightIntensity', 0, 160, 0.5, 'light intensity');
    R(strike, c, 'lightRadius', 0.5, 60, 0.1, 'light radius');
    R(strike, c, 'lightFlicker', 0, 1, 0.01, 'flicker depth');
    R(strike, c, 'lightFlickerSpeed', 0.5, 30, 0.1, 'flicker speed');
    strike.addColor(c, 'lightColor').name('light colour');

    this.fluxFolder = folder;
  }

  /**
   * Scorched Twilight of Rage — three panels, three folders, in the order the
   * composite reads them.
   *
   * The fastest way to judge a stacked effect is to look at one layer at a
   * time, and here that is exactly three controls: `wispOpacity`, `iceOpacity`
   * and `plumeOpacity`. Zeroing any one of them removes precisely one panel of
   * the reference sheet from the frame and nothing else, because there is
   * nothing else — no particle system, no decal, no flash.
   *
   * Units: metres for anything about the cast, the path or a layer's reach;
   * unitless for counts, fractions and exponents. `ice edge (px)` is the single
   * control in the folder measured in pixels, and it is a screen-space hairline.
   */
  _buildTwilight() {
    const folder = this.gui.addFolder('❄  Scorched Twilight');
    const c = settings.twilight;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'range', 4, 60, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 12, 0.1, 'min range');
    R(cast, c, 'speed', 4, 90, 0.5, 'flight speed (m/s)');
    R(cast, c, 'burstTime', 0.1, 3, 0.01, 'comes apart over');
    R(cast, c, 'fadeTime', 0.1, 4, 0.01, 'what is left fades over');
    R(cast, c, 'cooldown', 0, 10, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    /* ---- the line all three layers are hung off ---- */
    const path = folder.addFolder('The flight path');
    R(path, c, 'drift', 0, 3, 0.01, 'wander (m)');
    R(path, c, 'driftWaves', 0.02, 2, 0.01, 'swing (rad/m)');
    R(path, c, 'driftRise', 0, 2, 0.01, 'vertical wander');
    R(path, c, 'launchHeight', 0.2, 3, 0.01, 'launch height (m)');
    R(path, c, 'flightHeight', 0.2, 6, 0.01, 'cruise height (m)');
    R(path, c, 'riseDistance', 0.5, 20, 0.1, 'settles over (m)');

    /* ---- panel 1 ---- */
    const wisps = folder.addFolder('1 · The wispy beam core');
    R(wisps, c, 'wisps', 1, 8, 1, 'strands');
    R(wisps, c, 'wispSpan', 1, 30, 0.1, 'reach back (m)');
    R(wisps, c, 'wispLead', 0, 6, 0.05, 'run past the head (m)');
    R(wisps, c, 'wispRadius', 0, 3, 0.01, 'how far it bows (m)');
    R(wisps, c, 'wispFlatten', 0, 2, 0.01, 'vertical half of that bow');
    R(wisps, c, 'wispCoil', 0, 4, 0.01, 'turns over the span');
    R(wisps, c, 'wispSpin', -3, 3, 0.01, 'roll (turns/s)');
    R(wisps, c, 'wispBow', 0.05, 3, 0.01, 'converges at the ends');
    R(wisps, c, 'wispWander', 0, 2, 0.01, 'noise off the braid (m)');
    R(wisps, c, 'wispWanderScale', 0.1, 8, 0.05, 'wander scale');
    R(wisps, c, 'wispWanderSpeed', 0, 5, 0.01, 'wander speed');
    R(wisps, c, 'wispWidth', 0.005, 0.6, 0.005, 'width (m)');
    R(wisps, c, 'wispWidthBow', 0.05, 3, 0.01, 'points at both ends');
    R(wisps, c, 'wispTwist', 0, 1, 0.01, 'how far the strip rolls');
    R(wisps, c, 'wispTwistTurns', 0, 10, 0.05, 'twists over the span');
    R(wisps, c, 'wispTwistSpeed', -4, 4, 0.01, 'twist speed');
    R(wisps, c, 'wispTwistFace', 0.02, 1, 0.01, 'width when edge-on');
    R(wisps, c, 'wispSoft', 0.1, 6, 0.05, 'edge falloff (low is wispy)');
    R(wisps, c, 'wispCore', 1, 40, 0.5, 'core thread');
    R(wisps, c, 'wispCoreWeight', 0, 3, 0.01, 'core strength');
    R(wisps, c, 'wispFiber', 0, 1.5, 0.01, 'fibres');
    R(wisps, c, 'wispFiberScale', 0.5, 20, 0.1, 'fibre scale');
    R(wisps, c, 'wispFiberSpeed', 0, 8, 0.05, 'fibre speed');
    R(wisps, c, 'wispPulse', 0, 5, 0.01, 'charge along it');
    R(wisps, c, 'wispPulseFreq', 0.2, 10, 0.05, 'charges over it');
    R(wisps, c, 'wispPulseSpeed', -6, 6, 0.05, 'charge speed');
    R(wisps, c, 'wispHeadGlow', 0, 4, 0.01, 'leading end runs hotter');
    R(wisps, c, 'wispIntensity', 0, 8, 0.01, 'intensity');
    R(wisps, c, 'wispOpacity', 0, 2, 0.01, 'opacity');
    R(wisps, c, 'wispSoftFade', 0.02, 3, 0.01, 'soft fade (m)');
    wisps.addColor(c, 'colorWispCore').name('core');
    wisps.addColor(c, 'colorWisp').name('body');
    wisps.addColor(c, 'colorWispTail').name('tail');

    /* ---- panel 2 ---- */
    const ice = folder.addFolder('2 · The stylized ice particles');
    const field = ice.addFolder('The field & its flight');
    R(field, c, 'iceCount', 1, 220, 1, 'crystals');
    R(field, c, 'iceSplinters', 0, 1, 0.01, 'slivers alongside them');
    R(field, c, 'iceLife', 0.1, 4, 0.01, 'one crystal lasts');
    R(field, c, 'iceLead', -4, 8, 0.05, 'struck off ahead by (m)');
    R(field, c, 'iceRadius', 0, 3, 0.01, 'born within (m)');
    R(field, c, 'iceThrow', 0, 20, 0.05, 'thrown at (m/s)');
    R(field, c, 'iceForward', 0, 3, 0.01, 'along the heading');
    R(field, c, 'iceSpread', 0, 3, 0.01, 'off the axis');
    R(field, c, 'iceCarry', 0, 1.4, 0.01, "keeps the head's speed");
    R(field, c, 'iceDrag', 0.05, 8, 0.05, 'drag');
    R(field, c, 'iceGravity', 0, 20, 0.05, 'gravity');
    R(field, c, 'iceSize', 0.01, 1.2, 0.005, 'size (m)');
    R(field, c, 'iceSizeVariance', 0, 1, 0.01, 'size spread');
    R(field, c, 'iceLong', 0.5, 5, 0.05, 'slenderest crystal');
    R(field, c, 'iceSpin', 0, 4, 0.01, 'tumble (turns/s)');
    R(field, c, 'iceGrowIn', 0.01, 0.6, 0.005, 'snaps to size over');
    R(field, c, 'iceShrinkOut', 0.1, 1, 0.01, 'shrink starts at');

    const facets = ice.addFolder('How a crystal is lit');
    R(facets, c, 'iceBands', 1, 12, 1, 'facet steps');
    R(facets, c, 'icePosterize', 0, 1, 0.01, 'pushed toward the steps');
    R(facets, c, 'iceScreenKey', 0, 1, 0.01, 'key: sun \u2192 camera-relative');
    R(facets, c, 'iceAmbient', 0, 2, 0.01, 'ambient');
    R(facets, c, 'iceRim', 0, 5, 0.01, 'silhouette rim');
    R(facets, c, 'iceRimPower', 0.2, 8, 0.05, 'rim tightness');
    R(facets, c, 'iceDispersion', 0, 1.5, 0.01, 'dispersion');
    R(facets, c, 'iceEdge', 0, 4, 0.01, 'facet hairline');
    R(facets, c, 'iceEdgeWidth', 0.2, 5, 0.05, 'ice edge (px)');
    R(facets, c, 'iceCore', 0, 3, 0.01, 'light inside it');
    R(facets, c, 'iceTip', 0, 3, 0.01, 'light at the two points');
    R(facets, c, 'iceTipStart', 0, 1.2, 0.01, 'where the points begin');
    R(facets, c, 'iceBack', 0, 3, 0.01, 'lit through the shadow side');
    R(facets, c, 'iceBackPower', 0.2, 8, 0.05, 'how thin it must be');
    R(facets, c, 'iceSpecular', 0, 6, 0.01, 'glint');
    R(facets, c, 'iceGloss', 2, 120, 0.5, 'glint tightness');
    R(facets, c, 'iceTwinkle', 0, 1, 0.01, 'glint blinks');
    R(facets, c, 'iceTwinkleSpeed', 0, 8, 0.05, 'blink speed');
    R(facets, c, 'iceFlash', 0, 2, 0.01, 'white-hot when struck off');
    R(facets, c, 'iceFlashLife', 0.01, 0.6, 0.005, 'that flash lasts');
    R(facets, c, 'iceIntensity', 0, 6, 0.01, 'intensity');
    R(facets, c, 'iceRolloff', 0.05, 2, 0.01, 'body roll-off (keeps it matter)');
    R(facets, c, 'iceOpacity', 0, 1.5, 0.01, 'opacity (leave at 1)');
    R(facets, c, 'iceSoftFade', 0.02, 2, 0.01, 'soft fade (m)');
    facets.addColor(c, 'colorIceDeep').name('facing away');
    facets.addColor(c, 'colorIce').name('body');
    facets.addColor(c, 'colorIceLit').name('facing the key');
    facets.addColor(c, 'colorIceEdge').name('edges & rim');
    facets.addColor(c, 'colorIceFlash').name('struck off');

    /* ---- panel 3 ---- */
    const tip = folder.addFolder('3 · The burning tip (the cone)');
    R(tip, c, 'tipLength', 0.2, 12, 0.05, 'apex to mouth (m)');
    R(tip, c, 'tipRadius', 0.02, 3, 0.01, 'mouth radius (m)');
    R(tip, c, 'tipFlare', 0.2, 4, 0.01, 'sharpness (>1 needle)');
    R(tip, c, 'tipTongues', 1, 24, 1, 'licks it is cut into');
    R(tip, c, 'tipSplitStart', 0, 0.9, 0.01, 'they separate from');
    R(tip, c, 'tipTongueWidth', 0.05, 1, 0.01, 'lick fills its slot');
    R(tip, c, 'tipPoint', 0.02, 0.9, 0.01, 'lick comes to a point over');
    R(tip, c, 'tipLengthVar', 0, 0.9, 0.01, 'unequal reaches');
    R(tip, c, 'tipCurl', 0, 1.5, 0.01, 'lick swings off (rad)');
    R(tip, c, 'tipCurlScale', 0.1, 8, 0.05, 'curl scale');
    R(tip, c, 'tipCurlSpeed', 0, 8, 0.05, 'curl speed');
    R(tip, c, 'tipSpread', 0, 1, 0.01, 'lick leaves the envelope');
    R(tip, c, 'tipRipple', 0, 1, 0.005, 'off a clean cone');
    R(tip, c, 'tipRippleFreq', 0.1, 8, 0.05, 'ripple around');
    R(tip, c, 'tipRippleScale', 0.1, 8, 0.05, 'ripple along');
    R(tip, c, 'tipRippleSpeed', 0, 8, 0.05, 'ripple speed');
    R(tip, c, 'tipBands', 1, 12, 1, 'length steps');
    R(tip, c, 'tipPosterize', 0, 1, 0.01, 'pushed toward the steps');
    R(tip, c, 'tipRim', 0, 4, 0.01, 'silhouette rim');
    R(tip, c, 'tipRimPower', 0.2, 8, 0.05, 'rim tightness');
    R(tip, c, 'tipApex', 0, 4, 0.01, 'heat at the point');
    R(tip, c, 'tipApexTight', 0.5, 16, 0.1, 'how tight that is');
    R(tip, c, 'tipErode', 0, 1.5, 0.01, 'how raggedly');
    R(tip, c, 'tipErodeFreq', 0.1, 8, 0.05, 'erode around');
    R(tip, c, 'tipErodeScale', 0.1, 8, 0.05, 'erode along');
    R(tip, c, 'tipErodeSpeed', 0, 8, 0.05, 'erode speed');
    R(tip, c, 'tipIntensity', 0, 6, 0.01, 'intensity');
    R(tip, c, 'tipRolloff', 0.02, 2, 0.01, 'body roll-off (keeps the edge)');
    R(tip, c, 'tipOpacity', 0, 1.5, 0.01, 'opacity');
    R(tip, c, 'tipSoftFade', 0.02, 2, 0.01, 'soft fade (m)');
    R(tip, c, 'tipBurstFlare', 0, 4, 0.01, 'mouth blows open');
    tip.addColor(c, 'colorTipCore').name('the point');
    tip.addColor(c, 'colorTipHot').name('hot');
    tip.addColor(c, 'colorTip').name('body');
    tip.addColor(c, 'colorTipBase').name('the mouth');

    const plume = folder.addFolder('3 · ... and the licks off its mouth');
    R(plume, c, 'plumeTongues', 1, 28, 1, 'tongues');
    R(plume, c, 'plumeRoot', 0, 6, 0.05, 'nose behind the head (m)');
    R(plume, c, 'plumeLength', 0.2, 12, 0.05, 'streams back (m)');
    R(plume, c, 'plumeSplay', 0, 4, 0.01, 'off the axis at the tail (m)');
    R(plume, c, 'plumeSplayPow', 0.2, 5, 0.05, 'opens late');
    R(plume, c, 'plumeWidth', 0.01, 1.2, 0.005, 'width at the root (m)');
    R(plume, c, 'plumeNoseWidth', 0.02, 1, 0.01, 'pinch at the apex');
    R(plume, c, 'plumeTaper', 0.1, 6, 0.05, 'comes to a point');
    R(plume, c, 'plumeNeedles', 0, 1, 0.01, 'long thin licks (fraction)');
    R(plume, c, 'plumeNeedleLength', 1, 4, 0.05, 'needles: longer by');
    R(plume, c, 'plumeNeedleWidth', 0.05, 1, 0.01, 'needles: thinner by');
    R(plume, c, 'plumeSpikes', 0, 1, 0.01, 'forward licks (fraction)');
    R(plume, c, 'plumeSpikeLength', 0, 2, 0.01, 'forward licks: reach');
    R(plume, c, 'plumeRootSpread', 0, 6, 0.05, 'roots strung out over (m)');
    R(plume, c, 'plumeLick', 0, 3, 0.01, 'pushed off its spoke');
    R(plume, c, 'plumeLickScale', 0.1, 8, 0.05, 'lick scale');
    R(plume, c, 'plumeLickSpeed', 0, 8, 0.05, 'lick speed');
    R(plume, c, 'plumeRoll', -2, 2, 0.01, 'fan rotates (turns/s)');
    R(plume, c, 'plumeBurstFlare', 0, 4, 0.01, 'strike blows it open');
    R(plume, c, 'plumeSharp', 0.1, 6, 0.05, 'edge falloff');
    R(plume, c, 'plumeCore', 1, 40, 0.5, 'core thread');
    R(plume, c, 'plumeHeat', 0.05, 5, 0.05, 'root hotter than tip');
    R(plume, c, 'plumeMass', 0, 6, 0.01, 'the white core');
    R(plume, c, 'plumeMassTight', 0.5, 16, 0.1, 'how tight that core is');
    R(plume, c, 'plumeEat', 0, 1.5, 0.01, 'eaten into');
    R(plume, c, 'plumeEatScale', 0.1, 10, 0.05, 'eat scale');
    R(plume, c, 'plumeEatSpeed', 0, 8, 0.05, 'eat speed');
    R(plume, c, 'plumeFlicker', 0, 1, 0.01, 'gutter');
    R(plume, c, 'plumeFlickerSpeed', 0, 30, 0.1, 'gutter speed');
    R(plume, c, 'plumeIntensity', 0, 8, 0.01, 'intensity');
    R(plume, c, 'plumeOpacity', 0, 2, 0.01, 'opacity');
    R(plume, c, 'plumeSoftFade', 0.02, 3, 0.01, 'soft fade (m)');
    plume.addColor(c, 'colorPlumeCore').name('incandescent root');
    plume.addColor(c, 'colorPlumeHot').name('hot');
    plume.addColor(c, 'colorPlume').name('body');
    plume.addColor(c, 'colorPlumeTip').name('ember tips');

    /* ---- everything the strike does that is not one of the three ---- */
    const strike = folder.addFolder('The strike, camera & lights');
    R(strike, c, 'impactShake', 0, 1, 0.005, 'impact shake');
    R(strike, c, 'shakeDuration', 0.05, 2, 0.01, 'shake decay');
    R(strike, c, 'rumble', 0, 0.3, 0.002, 'flight rumble');
    R(strike, c, 'burnShake', 0, 0.3, 0.002, 'break-up rumble');
    R(strike, c, 'lightIntensity', 0, 160, 0.5, 'tip light');
    R(strike, c, 'lightRadius', 0.5, 60, 0.1, 'tip light radius');
    R(strike, c, 'lightGutter', 0, 1, 0.01, 'tip light gutter');
    R(strike, c, 'lightGutterSpeed', 0.5, 30, 0.1, 'gutter speed');
    strike.addColor(c, 'lightColor').name('tip light colour');
    R(strike, c, 'wakeLightIntensity', 0, 160, 0.5, 'wake light');
    R(strike, c, 'wakeLightRadius', 0.5, 60, 0.1, 'wake light radius');
    R(strike, c, 'wakeLightBack', 0, 20, 0.1, 'wake light sits back (m)');
    R(strike, c, 'wakeBreath', 0, 1, 0.01, 'wake light breath');
    R(strike, c, 'wakeBreathSpeed', 0.2, 20, 0.1, 'breath speed');
    strike.addColor(c, 'wakeLightColor').name('wake light colour');

    this.twilightFolder = folder;
  }

  _buildVoidSlash() {
    const folder = this.gui.addFolder('🗡  Void Slash');
    const c = settings.voidslash;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'range', 4, 60, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 12, 0.1, 'min range');
    R(cast, c, 'speed', 4, 90, 0.5, 'flight speed (m/s)');
    R(cast, c, 'burstTime', 0.1, 3, 0.01, 'comes apart over');
    R(cast, c, 'fadeTime', 0.1, 6, 0.01, 'what is left fades over');
    R(cast, c, 'cooldown', 0, 10, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    /* ---- the line all six layers are hung off ---- */
    const path = folder.addFolder('The flight path');
    R(path, c, 'drift', 0, 3, 0.01, 'wander (m)');
    R(path, c, 'driftWaves', 0.02, 2, 0.01, 'swing (rad/m)');
    R(path, c, 'driftRise', 0, 2, 0.01, 'vertical wander');
    R(path, c, 'launchHeight', 0.2, 3, 0.01, 'launch height (m)');
    R(path, c, 'flightHeight', 0.2, 6, 0.01, 'cruise height (m)');
    R(path, c, 'riseDistance', 0.5, 20, 0.1, 'settles over (m)');

    /* ---- panel 1 ---- */
    const lance = folder.addFolder('1 · The shadow core: the lance');
    R(lance, c, 'lanceRows', 1, 24, 1, 'rows of scales');
    R(lance, c, 'lanceAround', 1, 12, 1, 'scales around');
    R(lance, c, 'lanceLength', 0.5, 12, 0.05, 'point to rear (m)');
    R(lance, c, 'lanceLead', -2, 4, 0.05, 'point ahead of the front (m)');
    R(lance, c, 'lanceRadius', 0.05, 2, 0.01, 'rear radius (m)');
    R(lance, c, 'lanceFlare', 0.3, 4, 0.01, 'sharpness (>1 needle)');
    R(lance, c, 'lanceScale', 0.02, 0.6, 0.005, 'scale size (m)');
    R(lance, c, 'lanceTipScale', 0.05, 1, 0.01, "the point's scales, x");
    R(lance, c, 'lanceLong', 1, 5, 0.05, 'scale length, x width');
    R(lance, c, 'lanceTilt', -0.5, 1, 0.01, 'scale lean (rad)');
    R(lance, c, 'lanceJitter', 0, 1, 0.01, 'placement jitter');
    R(lance, c, 'lanceFrayStart', 0, 1, 0.01, 'frays from');
    R(lance, c, 'lanceLift', 0, 1.5, 0.01, 'rear scales lift (rad)');
    R(lance, c, 'lanceFraySpread', 0, 1.5, 0.01, 'rear scales stand off (m)');
    R(lance, c, 'lanceFlutter', 0, 1, 0.01, 'they shiver');
    R(lance, c, 'lanceFlutterSpeed', 0, 12, 0.05, 'shiver speed');
    R(lance, c, 'lanceVein', 0, 4, 0.01, 'vein of light');
    R(lance, c, 'lanceVeinWidth', 0.02, 0.6, 0.01, 'vein width');
    R(lance, c, 'lanceVeinFlow', 0, 12, 0.05, 'pulses along it');
    R(lance, c, 'lanceVeinSpeed', -6, 6, 0.05, 'pulse speed');
    R(lance, c, 'lanceTipGlow', 0, 4, 0.01, 'light at the point');
    R(lance, c, 'lanceTipPow', 0.3, 12, 0.05, 'how tight that is');
    R(lance, c, 'lanceBurstSpeed', 0, 30, 0.1, 'strike: blown off at (m/s)');
    R(lance, c, 'lanceBurstSpin', 0, 8, 0.05, 'strike: tumble (turns/s)');
    R(lance, c, 'lanceBurstDrag', 0.05, 8, 0.05, 'strike: drag');
    R(lance, c, 'lanceBurstHeat', 0, 2, 0.01, 'strike: flash');
    R(lance, c, 'lanceIntensity', 0, 6, 0.01, 'intensity');
    R(lance, c, 'lanceRolloff', 0.05, 2, 0.01, 'body roll-off (keeps it matter)');
    R(lance, c, 'lanceOpacity', 0, 1.5, 0.01, 'opacity');
    R(lance, c, 'lanceSoftFade', 0.02, 2, 0.01, 'soft fade (m)');
    lance.addColor(c, 'colorLanceGlow').name('the light in it');
    lance.addColor(c, 'colorLanceHot').name('the point');

    const glass = folder.addFolder('How the black glass is lit');
    R(glass, c, 'obsidianBands', 1, 12, 1, 'facet steps');
    R(glass, c, 'obsidianPosterize', 0, 1, 0.01, 'pushed toward the steps');
    R(glass, c, 'obsidianScreenKey', 0, 1, 0.01, 'key: sun \u2192 camera-relative');
    R(glass, c, 'obsidianAmbient', 0, 2, 0.01, 'ambient');
    R(glass, c, 'obsidianRim', 0, 5, 0.01, 'silhouette rim');
    R(glass, c, 'obsidianRimPower', 0.2, 8, 0.05, 'rim tightness');
    R(glass, c, 'obsidianEdge', 0, 4, 0.01, 'facet hairline');
    R(glass, c, 'obsidianEdgeWidth', 0.2, 5, 0.05, 'hairline (px)');
    R(glass, c, 'obsidianSpecular', 0, 6, 0.01, 'glass highlight');
    R(glass, c, 'obsidianGloss', 2, 120, 0.5, 'highlight tightness');
    glass.addColor(c, 'colorObsidianDeep').name('facing away');
    glass.addColor(c, 'colorObsidian').name('body');
    glass.addColor(c, 'colorObsidianLit').name('facing the key');
    glass.addColor(c, 'colorObsidianEdge').name('edges & rim');

    const beam = folder.addFolder('1 · ... and the beam down its axis');
    R(beam, c, 'beamStrands', 1, 8, 1, 'axis + satellites');
    R(beam, c, 'beamSpan', 1, 30, 0.1, 'reach back (m)');
    R(beam, c, 'beamLead', -2, 4, 0.05, 'point ahead of the front (m)');
    R(beam, c, 'beamRadius', 0, 1, 0.005, 'satellite orbit (m)');
    R(beam, c, 'beamCoil', 0, 12, 0.05, 'satellite turns');
    R(beam, c, 'beamSpin', -6, 6, 0.05, 'satellite roll (turns/s)');
    R(beam, c, 'beamWidth', 0.005, 1, 0.005, 'width (m)');
    R(beam, c, 'beamSatellite', 0.05, 1.5, 0.01, 'satellite width, x');
    R(beam, c, 'beamBow', 0.05, 3, 0.01, 'pinched at the point');
    R(beam, c, 'beamTailThin', 0, 1, 0.01, 'thin at the tail, x');
    R(beam, c, 'beamWander', 0, 1, 0.005, 'wander (m)');
    R(beam, c, 'beamWanderScale', 0.1, 10, 0.05, 'wander scale');
    R(beam, c, 'beamWanderSpeed', 0, 6, 0.05, 'wander speed');
    R(beam, c, 'beamSoft', 0.1, 6, 0.05, 'edge falloff');
    R(beam, c, 'beamCore', 1, 40, 0.5, 'core thread');
    R(beam, c, 'beamCoreWeight', 0, 3, 0.01, 'core strength');
    R(beam, c, 'beamFiber', 0, 1.5, 0.01, 'fibres');
    R(beam, c, 'beamFiberScale', 0.5, 20, 0.1, 'fibre scale');
    R(beam, c, 'beamFiberSpeed', 0, 8, 0.05, 'fibre speed');
    R(beam, c, 'beamPulse', 0, 5, 0.01, 'charge along it');
    R(beam, c, 'beamPulseFreq', 0.2, 10, 0.05, 'charges over it');
    R(beam, c, 'beamPulseSpeed', -6, 6, 0.05, 'charge speed (+ to the point)');
    R(beam, c, 'beamHeadGlow', 0, 4, 0.01, 'the point runs hotter');
    R(beam, c, 'beamFlare', 0, 6, 0.05, 'strike: point blows open');
    R(beam, c, 'beamIntensity', 0, 8, 0.01, 'intensity');
    R(beam, c, 'beamOpacity', 0, 2, 0.01, 'opacity');
    R(beam, c, 'beamSoftFade', 0.02, 3, 0.01, 'soft fade (m)');
    beam.addColor(c, 'colorBeamCore').name('core');
    beam.addColor(c, 'colorBeam').name('body');
    beam.addColor(c, 'colorBeamTail').name('tail');

    /* ---- panel 2 ---- */
    const debris = folder.addFolder('2 · The particle debris');
    R(debris, c, 'debrisCount', 1, 220, 1, 'chips');
    R(debris, c, 'debrisSlivers', 0, 1, 0.01, 'slivers alongside them');
    R(debris, c, 'debrisLife', 0.1, 4, 0.01, 'one flake lasts');
    R(debris, c, 'debrisLead', -8, 4, 0.05, 'comes off ahead by (m)');
    R(debris, c, 'debrisRadius', 0, 3, 0.01, 'born within (m)');
    R(debris, c, 'debrisThrow', 0, 20, 0.05, 'thrown at (m/s)');
    R(debris, c, 'debrisForward', 0, 3, 0.01, 'along the heading');
    R(debris, c, 'debrisSpread', 0, 3, 0.01, 'off the axis');
    R(debris, c, 'debrisCarry', 0, 1.4, 0.01, "keeps the head's speed");
    R(debris, c, 'debrisDrag', 0.05, 8, 0.05, 'drag');
    R(debris, c, 'debrisGravity', 0, 20, 0.05, 'gravity');
    R(debris, c, 'debrisSize', 0.01, 0.8, 0.005, 'size (m)');
    R(debris, c, 'debrisSizeVariance', 0, 1, 0.01, 'size spread');
    R(debris, c, 'debrisLong', 1, 5, 0.05, 'longest sliver, x');
    R(debris, c, 'debrisSpin', 0, 4, 0.01, 'tumble (turns/s)');
    R(debris, c, 'debrisGrowIn', 0.01, 0.6, 0.005, 'snaps to size over');
    R(debris, c, 'debrisShrinkOut', 0.1, 1, 0.01, 'shrink starts at');
    R(debris, c, 'debrisHot', 0, 1, 0.01, 'still lit (fraction)');
    R(debris, c, 'debrisHotGlow', 0, 4, 0.01, 'that light');
    R(debris, c, 'debrisHotPulse', 0, 10, 0.05, 'it breathes at');
    R(debris, c, 'debrisFlash', 0, 2, 0.01, 'flash when it comes away');
    R(debris, c, 'debrisFlashLife', 0.01, 0.6, 0.005, 'that flash lasts');
    R(debris, c, 'debrisIntensity', 0, 6, 0.01, 'intensity');
    R(debris, c, 'debrisRolloff', 0.05, 2, 0.01, 'body roll-off');
    R(debris, c, 'debrisSoftFade', 0.02, 2, 0.01, 'soft fade (m)');
    debris.addColor(c, 'colorDebrisGlow').name('the light in it');
    debris.addColor(c, 'colorDebrisFlash').name('comes away as');

    /* ---- panel 3 ---- */
    const ribbons = folder.addFolder('3 · The shadow ribbon trails');
    R(ribbons, c, 'ribbons', 1, 8, 1, 'ribbons');
    R(ribbons, c, 'ribbonSpan', 1, 30, 0.1, 'reach back (m)');
    R(ribbons, c, 'ribbonLead', -6, 4, 0.05, 'start ahead of the front (m)');
    R(ribbons, c, 'ribbonRadius', 0, 4, 0.01, 'bow at the tail (m)');
    R(ribbons, c, 'ribbonHeadRadius', 0, 1, 0.01, 'bow at the head, x');
    R(ribbons, c, 'ribbonFlatten', 0, 2, 0.01, 'vertical half of the bow');
    R(ribbons, c, 'ribbonCoil', 0, 4, 0.01, 'turns over the span');
    R(ribbons, c, 'ribbonSpin', -3, 3, 0.01, 'roll (turns/s)');
    R(ribbons, c, 'ribbonBow', 0.05, 3, 0.01, 'converges at the ends');
    R(ribbons, c, 'ribbonWander', 0, 2, 0.01, 'wander (m)');
    R(ribbons, c, 'ribbonWanderScale', 0.1, 8, 0.05, 'wander scale');
    R(ribbons, c, 'ribbonWanderSpeed', 0, 5, 0.01, 'wander speed');
    R(ribbons, c, 'ribbonWidth', 0.02, 1.5, 0.005, 'width (m)');
    R(ribbons, c, 'ribbonWidthBow', 0.05, 3, 0.01, 'points at both ends');
    R(ribbons, c, 'ribbonTwist', 0, 1, 0.01, 'how far the silk rolls');
    R(ribbons, c, 'ribbonTwistTurns', 0, 10, 0.05, 'twists over the span');
    R(ribbons, c, 'ribbonTwistSpeed', -4, 4, 0.01, 'twist speed');
    R(ribbons, c, 'ribbonTwistFace', 0.02, 1, 0.01, 'width when edge-on');
    R(ribbons, c, 'ribbonSoft', 0.1, 6, 0.05, 'edge falloff');
    R(ribbons, c, 'ribbonFiber', 0, 1.5, 0.01, 'fibres');
    R(ribbons, c, 'ribbonFiberScale', 0.5, 20, 0.1, 'fibre scale');
    R(ribbons, c, 'ribbonFiberSpeed', 0, 8, 0.05, 'fibre speed');
    R(ribbons, c, 'ribbonHem', 0.01, 0.6, 0.01, 'lit hem width');
    R(ribbons, c, 'ribbonHemGlow', 0, 5, 0.01, 'hem light');
    R(ribbons, c, 'ribbonHeadGlow', 0, 4, 0.01, 'head end runs hotter');
    R(ribbons, c, 'ribbonPulse', 0, 5, 0.01, 'charge along it');
    R(ribbons, c, 'ribbonPulseFreq', 0.2, 10, 0.05, 'charges over it');
    R(ribbons, c, 'ribbonPulseSpeed', -6, 6, 0.05, 'charge speed');
    R(ribbons, c, 'ribbonInner', 0, 2, 0.01, 'violet through the shadow');
    R(ribbons, c, 'ribbonOpacity', 0, 1.5, 0.01, 'shadow opacity');
    R(ribbons, c, 'ribbonSoftFade', 0.02, 3, 0.01, 'soft fade (m)');
    ribbons.addColor(c, 'colorRibbonShadow').name('shadow');
    ribbons.addColor(c, 'colorRibbon').name('violet');
    ribbons.addColor(c, 'colorRibbonHem').name('hem');

    /* ---- panel 4 ---- */
    const sparks = folder.addFolder('4 · The energy sparks');
    R(sparks, c, 'sparkCount', 1, 200, 1, 'in the trail');
    R(sparks, c, 'sparkLife', 0.1, 3, 0.01, 'one lasts');
    R(sparks, c, 'sparkLead', -6, 4, 0.05, 'shed ahead by (m)');
    R(sparks, c, 'sparkRadius', 0, 3, 0.01, 'born within (m)');
    R(sparks, c, 'sparkThrow', 0, 20, 0.05, 'thrown at (m/s)');
    R(sparks, c, 'sparkCarry', 0, 1.4, 0.01, "keeps the head's speed");
    R(sparks, c, 'sparkDrag', 0.05, 8, 0.05, 'drag');
    R(sparks, c, 'sparkGravity', 0, 20, 0.05, 'gravity');
    R(sparks, c, 'sparkSize', 0.01, 0.6, 0.005, 'size (m)');
    R(sparks, c, 'sparkSizeVariance', 0, 1, 0.01, 'size spread');
    R(sparks, c, 'sparkRayLength', 0, 3, 0.01, 'ray reach, x');
    R(sparks, c, 'sparkLongRays', 0, 1, 0.01, 'long-rayed (fraction)');
    R(sparks, c, 'sparkCoreTight', 1, 40, 0.5, 'core tightness');
    R(sparks, c, 'sparkRays', 0, 4, 0.01, 'ray brightness');
    R(sparks, c, 'sparkRaySharp', 1, 60, 0.5, 'ray thinness');
    R(sparks, c, 'sparkTwinkle', 0, 1, 0.01, 'twinkle');
    R(sparks, c, 'sparkTwinkleSpeed', 0, 20, 0.1, 'twinkle speed');
    R(sparks, c, 'sparkIntensity', 0, 8, 0.01, 'intensity');
    R(sparks, c, 'sparkSoftFade', 0.02, 2, 0.01, 'soft fade (m)');
    R(sparks, c, 'glareSize', 0.05, 4, 0.01, 'glare at the point (m)');
    R(sparks, c, 'glareRays', 0, 4, 0.01, 'glare ray reach, x');
    R(sparks, c, 'glareIntensity', 0, 8, 0.01, 'glare intensity');
    R(sparks, c, 'glareFlare', 0, 6, 0.05, 'strike: glare blows open');
    R(sparks, c, 'sparkBurst', 1, 200, 1, 'strike: thrown');
    R(sparks, c, 'sparkBurstLife', 0.1, 3, 0.01, 'strike: they last');
    R(sparks, c, 'sparkBurstThrow', 0, 40, 0.1, 'strike: thrown at (m/s)');
    R(sparks, c, 'sparkBurstDrag', 0.05, 8, 0.05, 'strike: drag');
    R(sparks, c, 'sparkBurstSize', 0.01, 0.6, 0.005, 'strike: size (m)');
    sparks.addColor(c, 'colorSparkCore').name('core');
    sparks.addColor(c, 'colorSpark').name('rays');

    /* ---- panel 5 ---- */
    const warp = folder.addFolder('5 · The distortion wave');
    R(warp, c, 'warpSize', 0.5, 12, 0.1, 'reach (m)');
    R(warp, c, 'warpBack', -2, 6, 0.05, 'behind the point (m)');
    R(warp, c, 'warpLens', 0, 2, 0.01, 'lens along the heading');
    R(warp, c, 'warpLensPower', 0.2, 6, 0.05, 'lens packed into the middle');
    R(warp, c, 'warpSwirl', 0, 3, 0.01, 'swirl');
    R(warp, c, 'warpArms', 1, 8, 1, 'spiral arms');
    R(warp, c, 'warpSpiral', 0, 20, 0.1, 'how tightly they wind');
    R(warp, c, 'warpSpin', -4, 4, 0.05, 'spin (turns/s)');
    R(warp, c, 'warpChurn', 0, 2, 0.01, 'churn');
    R(warp, c, 'warpScale', 0.1, 8, 0.05, 'churn scale');
    R(warp, c, 'warpSpeed', 0, 6, 0.05, 'churn speed');
    R(warp, c, 'warpWave', 0, 2, 0.01, 'waves shed');
    R(warp, c, 'warpWaveRate', 0, 6, 0.05, 'waves/second');
    R(warp, c, 'warpWaveWidth', 0.02, 0.6, 0.005, 'wave depth');
    R(warp, c, 'warpRipples', 1, 30, 0.5, 'bands in a wave');
    R(warp, c, 'warpBurst', 0, 4, 0.01, 'strike: wave');
    R(warp, c, 'warpBurstLife', 0.05, 3, 0.01, 'strike: lasts');
    R(warp, c, 'warpBurstSpeed', 1, 60, 0.5, 'strike: crosses at (m/s)');
    R(warp, c, 'warpBurstSize', 1, 4, 0.05, 'strike: proxy grows, x');
    R(warp, c, 'warpBurstWidth', 0.02, 0.6, 0.005, 'strike: wave depth');
    R(warp, c, 'warpStrength', 0, 3, 0.01, 'strength');

    /* ---- panel 6 ---- */
    const motes = folder.addFolder('6 · The lingering shadow motes');
    R(motes, c, 'moteCount', 1, 260, 1, 'puffs and motes');
    R(motes, c, 'moteBright', 0, 1, 0.01, 'bright motes (fraction)');
    R(motes, c, 'moteLife', 0.2, 8, 0.05, 'one lasts');
    R(motes, c, 'moteLead', -12, 4, 0.05, 'laid down ahead by (m)');
    R(motes, c, 'moteRadius', 0, 4, 0.01, 'off the axis (m)');
    R(motes, c, 'moteCarry', 0, 1, 0.01, "keeps the head's speed");
    R(motes, c, 'moteRise', -1, 3, 0.01, 'climbs at (m/s)');
    R(motes, c, 'moteDrift', 0, 4, 0.01, 'spreads at (m/s)');
    R(motes, c, 'moteDrag', 0.05, 8, 0.05, 'drag');
    R(motes, c, 'moteSize', 0.05, 3, 0.01, 'puff size (m)');
    R(motes, c, 'moteGrow', 0, 4, 0.01, 'swells by, x');
    R(motes, c, 'moteSizeVariance', 0, 1, 0.01, 'size spread');
    R(motes, c, 'moteSpin', 0, 1, 0.005, 'turns (turns/s)');
    R(motes, c, 'moteErode', 0, 1, 0.01, 'eaten by noise');
    R(motes, c, 'moteNoiseScale', 0.2, 8, 0.05, 'noise scale');
    R(motes, c, 'moteNoiseSpeed', 0, 3, 0.01, 'noise speed');
    R(motes, c, 'moteInnerGlow', 0, 4, 0.01, 'lit from inside');
    R(motes, c, 'moteOpacity', 0, 1.5, 0.01, 'shadow opacity');
    R(motes, c, 'moteBrightSize', 0.01, 0.5, 0.005, 'bright mote size (m)');
    R(motes, c, 'moteBrightIntensity', 0, 8, 0.01, 'bright mote intensity');
    R(motes, c, 'moteTwinkleSpeed', 0, 12, 0.05, 'twinkle speed');
    R(motes, c, 'moteSoftFade', 0.02, 3, 0.01, 'soft fade (m)');
    motes.addColor(c, 'colorMoteShadow').name('shadow');
    motes.addColor(c, 'colorMote').name('violet');
    motes.addColor(c, 'colorMoteGlow').name('lit inside');
    motes.addColor(c, 'colorMoteBright').name('bright motes');

    /* ---- everything the strike does that is not one of the six ---- */
    const strike = folder.addFolder('The strike, camera & lights');
    R(strike, c, 'impactShake', 0, 1, 0.005, 'impact shake');
    R(strike, c, 'shakeDuration', 0.05, 2, 0.01, 'shake decay');
    R(strike, c, 'rumble', 0, 0.3, 0.002, 'flight rumble');
    R(strike, c, 'burnShake', 0, 0.3, 0.002, 'break-up rumble');
    R(strike, c, 'lightIntensity', 0, 160, 0.5, 'point light');
    R(strike, c, 'lightRadius', 0.5, 60, 0.1, 'point light radius');
    R(strike, c, 'lightFlicker', 0, 1, 0.01, 'point light stutter');
    R(strike, c, 'lightFlickerSpeed', 0.5, 40, 0.1, 'stutter speed');
    strike.addColor(c, 'lightColor').name('point light colour');
    R(strike, c, 'wakeLightIntensity', 0, 160, 0.5, 'wake light');
    R(strike, c, 'wakeLightRadius', 0.5, 60, 0.1, 'wake light radius');
    R(strike, c, 'wakeLightBack', 0, 20, 0.1, 'wake light sits back (m)');
    R(strike, c, 'wakeBreath', 0, 1, 0.01, 'wake light breath');
    R(strike, c, 'wakeBreathSpeed', 0.2, 20, 0.1, 'breath speed');
    strike.addColor(c, 'wakeLightColor').name('wake light colour');

    this.voidslashFolder = folder;
  }

  _buildDrone() {
    const folder = this.gui.addFolder('✈  Sentinel Drone');
    const c = settings.drone;
    const R = Editor.range;

    const cast = folder.addFolder('The summon');
    R(cast, c, 'range', 2, 20, 0.1, 'kill ring radius (m)');
    R(cast, c, 'cooldown', 0, 10, 0.05, 'cooldown after recall');
    R(cast, c, 'deployTime', 0.2, 4, 0.01, 'deploys over (s)');
    R(cast, c, 'recallTime', 0.2, 4, 0.01, 'recalls over (s)');
    R(cast, c, 'launchHeight', 0.5, 4, 0.01, 'appears at (m)');
    R(cast, c, 'deployShake', 0, 0.5, 0.005, 'arrival rumble');
    cast.add(c, 'watch').name('caster watches it');
    Editor.castAnimation(cast, c);

    const airframe = folder.addFolder('The airframe');
    R(airframe, c, 'size', 0.5, 6, 0.01, 'span (m)');
    R(airframe, c, 'altitude', 1, 10, 0.05, 'hover height (m)');
    R(airframe, c, 'bladeSpeed', 0, 60, 0.1, 'rotor speed (rev/s)');
    R(airframe, c, 'bladeSpinUp', 0.05, 4, 0.01, 'spin-up (s)');
    R(airframe, c, 'bladeBlur', 0, 1.5, 0.01, 'rotor blur');
    airframe.add(c, 'counterRotate').name('counter-rotate');
    airframe.addColor(c, 'rimColor').name('rim colour');
    R(airframe, c, 'rimStrength', 0, 2, 0.01, 'rim');
    R(airframe, c, 'rimPower', 0.5, 8, 0.05, 'rim tightness');
    airframe.addColor(c, 'revealColor').name('print edge colour');
    R(airframe, c, 'revealWidth', 0.005, 0.5, 0.005, 'print edge (m)');
    R(airframe, c, 'revealGlow', 0, 20, 0.1, 'print edge glow');
    R(airframe, c, 'navLights', 0, 4, 0.01, 'nav lights');
    R(airframe, c, 'navSize', 0.02, 0.4, 0.005, 'nav light size (m)');
    R(airframe, c, 'strobeRate', 0, 6, 0.05, 'strobe (flashes/s)');
    airframe.addColor(c, 'navColorFront').name('front lamps');
    airframe.addColor(c, 'navColorBack').name('rear lamps');

    const hover = folder.addFolder('The hover');
    R(hover, c, 'hoverAmplitude', 0, 0.6, 0.005, 'bob (m)');
    R(hover, c, 'hoverFrequency', 0, 3, 0.01, 'bobs/s');
    R(hover, c, 'sway', 0, 0.2, 0.001, 'wobble (rad)');
    R(hover, c, 'swaySpeed', 0, 4, 0.01, 'wobble speed');
    R(hover, c, 'bank', 0, 0.9, 0.005, 'lean into speed (rad)');
    R(hover, c, 'bankRate', 0.0001, 0.5, 0.0001, 'lean lag');
    R(hover, c, 'aimPitch', 0, 1, 0.01, 'nose dips onto target');

    const flight = folder.addFolder('Flight & control');
    R(flight, c, 'maxSpeed', 0.5, 25, 0.1, 'top speed (m/s)');
    R(flight, c, 'acceleration', 0.0005, 0.6, 0.0005, 'throttle lag');
    R(flight, c, 'leash', 2, 40, 0.1, 'leash (m)');
    R(flight, c, 'turnRate', 0.0005, 0.6, 0.0005, 'heading lag');
    R(flight, c, 'stickDeadZone', 0, 0.5, 0.01, 'stick dead zone');
    R(flight, c, 'stickExpo', 0.5, 4, 0.05, 'stick expo');
    R(flight, c, 'handDeadZone', 0, 0.8, 0.01, 'hand dead zone (ndc)');
    R(flight, c, 'handFullRange', 0.1, 1, 0.01, 'hand full stick (ndc)');
    R(flight, c, 'downwash', 0, 120, 1, 'floor dust (particles/s)');
    R(flight, c, 'downwashSize', 0.1, 2.5, 0.01, 'floor dust size');

    const ring = folder.addFolder('The range ring');
    R(ring, c, 'ringWidth', 0.02, 1, 0.005, 'band width (m)');
    R(ring, c, 'ringGlow', 0, 4, 0.01, 'band glow');
    R(ring, c, 'ringSoftness', 0.005, 0.4, 0.005, 'softness');
    R(ring, c, 'ringFill', 0, 0.6, 0.005, 'interior wash');
    R(ring, c, 'ringTicks', 0, 96, 1, 'ticks');
    R(ring, c, 'ringTickLength', 0, 1.2, 0.01, 'tick length (m)');
    R(ring, c, 'ringTickWidth', 0.02, 0.9, 0.01, 'tick duty');
    R(ring, c, 'ringTickSpin', -0.5, 0.5, 0.005, 'tick spin (rev/s)');
    R(ring, c, 'ringSweep', 0, 2, 0.01, 'radar sweep');
    R(ring, c, 'ringSweepSpeed', 0, 2, 0.01, 'sweep (rev/s)');
    R(ring, c, 'ringPulse', 0, 3, 0.01, 'hot pulses');
    R(ring, c, 'ringOpacity', 0, 1, 0.01, 'opacity');
    ring.addColor(c, 'colorRing').name('watching');
    ring.addColor(c, 'colorRingHot').name('hunting');

    const beam = folder.addFolder('The searchlight');
    R(beam, c, 'beamAngle', 1, 30, 0.1, 'half-angle (deg)');
    R(beam, c, 'beamIntensity', 0, 2, 0.01, 'cone');
    R(beam, c, 'beamEdge', 0.2, 6, 0.05, 'edge softness');
    R(beam, c, 'beamFalloff', 0, 3, 0.01, 'fades toward the floor');
    R(beam, c, 'beamNoise', 0, 1, 0.01, 'dust in the beam');
    R(beam, c, 'beamNoiseScale', 0.2, 8, 0.05, 'dust scale');
    R(beam, c, 'beamSwing', 0.0001, 0.5, 0.0001, 'swing lag');
    R(beam, c, 'spotIntensity', 0, 3, 0.01, 'pool on the floor');
    R(beam, c, 'spotLight', 0, 40, 0.1, 'floor light');
    R(beam, c, 'spotLightRadius', 0.5, 20, 0.1, 'floor light radius');
    beam.addColor(c, 'colorBeam').name('watching');
    beam.addColor(c, 'colorBeamHot').name('hunting');

    const hunt = folder.addFolder('Targeting');
    R(hunt, c, 'aimTurnRate', 0.0001, 0.5, 0.0001, 'turn-onto lag');
    R(hunt, c, 'lockTime', 0.02, 3, 0.01, 'lock time (s)');
    R(hunt, c, 'lockCone', 0.02, 1.2, 0.01, 'fires within (rad)');
    R(hunt, c, 'aimHeight', 0, 1, 0.01, 'aims at (body height)');
    R(hunt, c, 'retarget', 0, 3, 0.01, 'between targets (s)');
    R(hunt, c, 'reticleSize', 0.2, 4, 0.01, 'reticle size (m)');
    R(hunt, c, 'reticleGlow', 0, 5, 0.01, 'reticle glow');
    hunt.addColor(c, 'colorReticle').name('locking');
    hunt.addColor(c, 'colorLocked').name('locked');

    const burst = folder.addFolder('The burst');
    R(burst, c, 'rounds', 1, 24, 1, 'rounds');
    R(burst, c, 'burstTime', 0.05, 2, 0.01, 'over (s)');
    R(burst, c, 'tracerSpeed', 10, 200, 1, 'tracer speed (m/s)');
    R(burst, c, 'tracerSize', 0.02, 0.4, 0.005, 'tracer width (m)');
    R(burst, c, 'tracerLength', 0.1, 6, 0.05, 'tracer length (m)');
    R(burst, c, 'spread', 0, 0.2, 0.001, 'dispersion (rad)');
    R(burst, c, 'muzzleSize', 0, 2, 0.01, 'muzzle flash (m)');
    R(burst, c, 'muzzleLight', 0, 200, 1, 'muzzle light');
    burst.add(c, 'casings').name('eject casings');
    R(burst, c, 'impactSparks', 0, 80, 1, 'impact sparks');
    burst.add(c, 'scorch').name('scorch the floor');
    R(burst, c, 'fireShake', 0, 0.5, 0.005, 'recoil shake');
    R(burst, c, 'fireFlash', 0, 0.4, 0.005, 'screen flash');
    burst.addColor(c, 'colorTracer').name('tracer');
    burst.addColor(c, 'colorTracerTail').name('tracer tail');
    burst.addColor(c, 'colorFlash').name('flash');
    burst.addColor(c, 'colorSpark').name('sparks');
    const hit = burst.addFolder('The hit');
    R(hit, c.hit, 'impulse', 0, 20, 0.1, 'thrown at (m/s)');
    R(hit, c.hit, 'lift', 0, 10, 0.1, 'lifted (m/s)');
    R(hit, c.hit, 'spin', 0, 5, 0.05, 'torque');

    const light = folder.addFolder('The body light');
    R(light, c, 'lightIntensity', 0, 60, 0.5, 'intensity');
    R(light, c, 'lightRadius', 0.5, 30, 0.1, 'radius');
    light.addColor(c, 'lightColor').name('colour');

    this.droneFolder = folder;
  }

  /**
   * The Serpent Tide Field, laid out in the order of its breakdown sheet.
   *
   * Units: metres for anything about the cast, the bird or a layer's reach;
   * kelvin for the two temperatures the fire is shaded between; unitless for
   * fractions, counts and exponents.
   */
  _buildPhoenix() {
    const folder = this.gui.addFolder('🔥  Serpent Tide Field');
    const c = settings.phoenix;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'range', 4, 60, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 12, 0.1, 'min range');
    R(cast, c, 'zoneRadius', 1, 14, 0.1, 'field radius (m)');
    R(cast, c, 'speed', 4, 90, 0.5, 'seed speed (m/s)');
    R(cast, c, 'seedHeight', 0, 3, 0.01, 'seed leaves at (m)');
    R(cast, c, 'seedArc', 0, 6, 0.05, 'seed lob (m)');
    R(cast, c, 'seedTrail', 0, 400, 1, 'seed embers/s');
    R(cast, c, 'seedSize', 0.05, 1.5, 0.01, 'seed comet (m)');
    R(cast, c, 'lifetime', 1, 40, 0.1, 'hunts for (s)');
    R(cast, c, 'fadeTime', 0.1, 6, 0.01, 'burns out over (s)');
    R(cast, c, 'cooldown', 0, 15, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const eruption = folder.addFolder('The eruption');
    R(eruption, c, 'eruptionEmbers', 0, 600, 1, 'embers thrown up');
    R(eruption, c, 'eruptionLight', 0, 300, 1, 'light punch');
    R(eruption, c, 'eruptionShake', 0, 1.5, 0.005, 'shake');
    R(eruption, c, 'eruptionFlash', 0, 0.6, 0.005, 'screen flash');
    R(eruption, c, 'spreadTime', 0.05, 3, 0.01, 'scorch spreads over (s)');

    /* ---- panel 1 ---- */
    const bird = folder.addFolder('1 · The phoenix');
    const flight = bird.addFolder('The flight');
    R(flight, c, 'wingspan', 1, 12, 0.05, 'wingspan (m)');
    R(flight, c, 'altitude', 0.5, 8, 0.05, 'hover height (m)');
    R(flight, c, 'riseTime', 0.1, 4, 0.01, 'rises over (s)');
    R(flight, c, 'riseFrom', -3, 0, 0.01, 'rises from (m)');
    R(flight, c, 'hoverAmplitude', 0, 0.6, 0.005, 'bob (m)');
    R(flight, c, 'hoverFrequency', 0.05, 3, 0.01, 'bobs/s');
    R(flight, c, 'sway', 0, 0.2, 0.001, 'wobble (rad)');
    R(flight, c, 'swaySpeed', 0.1, 4, 0.01, 'wobble speed');
    R(flight, c, 'flapSpeed', 0.1, 4, 0.01, 'flap rate');
    R(flight, c, 'turnRate', 0.0001, 0.2, 0.0001, 'turn (fraction left/s)');
    R(flight, c, 'bank', 0, 1.2, 0.01, 'bank (rad)');
    R(flight, c, 'bankRate', 0.001, 0.5, 0.001, 'bank rate');
    R(flight, c, 'aimPitch', 0, 1, 0.01, 'head dips onto target');
    R(flight, c, 'divePitch', 0, 1.5, 0.01, 'dive pitch (rad)');
    R(flight, c, 'burnClimb', 0, 5, 0.05, 'lifts as it burns (m/s)');
    R(flight, c, 'flareStrength', 0, 3, 0.01, 'flares as it acts');

    const fire = bird.addFolder('The fire it is made of');
    R(fire, c, 'tempCore', 1500, 8000, 10, 'core (K)');
    R(fire, c, 'tempEdge', 1000, 4000, 10, 'edge (K)');
    R(fire, c, 'emissionCurve', 0.5, 6, 0.05, 'radiance exponent');
    R(fire, c, 'palette', 0, 1, 0.01, 'radiator → palette');
    fire.addColor(c, 'colorCore').name('core');
    fire.addColor(c, 'colorMid').name('mid');
    fire.addColor(c, 'colorEdge').name('edge');
    fire.addColor(c, 'colorEmber').name('ember');
    R(fire, c, 'bodyHeat', 0, 1.5, 0.01, 'plumage heat');
    R(fire, c, 'rimPower', 0.5, 8, 0.05, 'rim power');
    R(fire, c, 'rimStrength', 0, 4, 0.01, 'rim heat');
    R(fire, c, 'flameScale', 0.2, 6, 0.05, 'flame scale (1/m)');
    R(fire, c, 'flameRise', 0, 6, 0.05, 'flames climb (m/s)');
    R(fire, c, 'flameStrength', 0, 2, 0.01, 'flames move the heat');
    R(fire, c, 'lick', 0, 5, 0.05, 'rim drags them up');
    R(fire, c, 'paintShow', 0, 1.5, 0.01, 'painted plumage shows');
    R(fire, c, 'emission', 0, 8, 0.05, 'emission');
    R(fire, c, 'featherBurn', 0, 1, 0.01, 'feather edges flicker');
    R(fire, c, 'auraSize', 0, 0.3, 0.005, 'aura stand-off (m)');
    R(fire, c, 'auraStrength', 0, 4, 0.01, 'aura');
    R(fire, c, 'auraThreshold', 0, 1, 0.01, 'aura sparseness');
    R(fire, c, 'revealWidth', 0.01, 1, 0.005, 'molten edge (m)');
    R(fire, c, 'revealGlow', 0, 20, 0.1, 'molten edge glow');

    const hunt = bird.addFolder('The hunt');
    R(hunt, c, 'fireRange', 1, 30, 0.1, 'engages within (m)');
    R(hunt, c, 'retarget', 0, 3, 0.01, 'between bodies (s)');
    R(hunt, c, 'aimTime', 0.02, 2, 0.01, 'comes onto a body in (s)');
    R(hunt, c, 'lockCone', 0.02, 1.5, 0.01, 'spits within (rad)');
    R(hunt, c, 'aimHeight', 0, 1, 0.01, 'aims at (of height)');
    R(hunt, c, 'spread', 0, 0.3, 0.001, 'dispersion (rad)');

    const volley = bird.addFolder('The volley');
    R(volley, c, 'volleyRounds', 1, 12, 1, 'fireballs per body');
    R(volley, c, 'volleyInterval', 0.02, 1, 0.01, 'between them (s)');
    R(volley, c, 'fireballSpeed', 3, 80, 0.5, 'speed (m/s)');
    R(volley, c, 'fireballSize', 0.05, 1.5, 0.01, 'head radius (m)');
    R(volley, c, 'fireballTail', 0.2, 8, 0.05, 'wake (m)');
    R(volley, c, 'fireballArc', 0, 1.5, 0.01, 'lob');
    R(volley, c, 'fireballHoming', 0.0001, 0.9, 0.0001, 'homing (fraction left/s)');
    const comet = volley.addFolder('The comet');
    R(comet, c, 'fireballIntensity', 0, 16, 0.05, 'emission');
    R(comet, c, 'fireballWakeWidth', 0.1, 1.5, 0.01, 'wake pinch');
    R(comet, c, 'fireballWakeSpread', 0, 2, 0.01, 'wake swell');
    R(comet, c, 'fireballPlume', 1, 3, 0.01, 'plume');
    R(comet, c, 'fireballBulge', 0, 0.8, 0.01, 'lobes');
    R(comet, c, 'fireballShred', 0, 3, 0.01, 'fringe shred');
    R(comet, c, 'fireballNoiseScale', 0.5, 8, 0.05, 'turbulence scale');
    R(comet, c, 'fireballFlow', 0, 2, 0.01, 'gas hangs back');
    R(comet, c, 'fireballBuoyancy', 0, 6, 0.05, 'buoyancy');
    R(comet, c, 'fireballVortex', 0, 3, 0.01, 'roll-up');
    R(comet, c, 'fireballDetach', 0, 2, 0.01, 'tears into puffs');
    R(comet, c, 'fireballSoftness', 0.05, 1, 0.01, 'softness');
    R(comet, c, 'fireballTailHeat', 0, 1, 0.01, 'wake heat');
    R(comet, c, 'fireballDensity', 0, 4, 0.01, 'density');
    R(comet, c, 'fireballSoot', 0, 5, 0.01, 'soot');
    R(comet, c, 'fireballSteps', 6, 48, 1, 'march steps');
    R(comet, c, 'fireballHalo', 0, 3, 0.01, 'halo');
    R(comet, c, 'trailRate', 0, 200, 1, 'shed / s each');
    R(volley, c, 'spitFlash', 0, 3, 0.01, 'flash off the beak (m)');
    R(volley, c, 'spitLight', 0, 120, 0.5, 'spit light');
    R(volley, c, 'spitShake', 0, 0.5, 0.005, 'spit shake');
    R(volley, c, 'impactRadius', 0.2, 5, 0.05, 'burst (m)');
    R(volley, c, 'impactSparks', 0, 120, 1, 'impact sparks');
    volley.add(c, 'impactScorch').name('scorches under the body');
    R(volley, c, 'hitShake', 0, 1, 0.005, 'hit shake');
    R(volley, c, 'hitFlash', 0, 0.5, 0.005, 'hit flash');
    R(volley, c, 'fireballLight', 0, 160, 0.5, 'hit light');
    const kickOff = volley.addFolder('The kick it lands');
    R(kickOff, c.hit, 'impulse', 0, 30, 0.1, 'impulse (m/s)');
    R(kickOff, c.hit, 'lift', 0, 20, 0.1, 'lift');
    R(kickOff, c.hit, 'spin', 0, 8, 0.05, 'spin');

    const talons = bird.addFolder('The talons');
    R(talons, c, 'kickRange', 0, 12, 0.1, 'kicks within (m)');
    R(talons, c, 'kickTime', 0.2, 3, 0.01, 'dive and back (s)');
    R(talons, c, 'kickHeight', -0.5, 1.5, 0.01, 'stops above the chest (m)');
    R(talons, c, 'kickBurst', 0.2, 6, 0.05, 'gout of fire (m)');
    R(talons, c, 'kickShake', 0, 1.5, 0.005, 'shake');
    R(talons, c.kickHit, 'impulse', 0, 40, 0.1, 'impulse (m/s)');
    R(talons, c.kickHit, 'lift', 0, 25, 0.1, 'lift');
    R(talons, c.kickHit, 'spin', 0, 10, 0.05, 'spin');

    /* ---- panel 2 ---- */
    const serpents = folder.addFolder('2 · The serpentine fire trails');
    R(serpents, c, 'serpents', 0, 6, 1, 'serpents');
    R(serpents, c, 'serpentGrowTime', 0.05, 5, 0.01, 'grow out over (s)');
    R(serpents, c, 'serpentRadius', 0.1, 1.5, 0.01, 'orbit (of field radius)');
    R(serpents, c, 'serpentWeave', 0, 0.9, 0.01, 'S-bend swing');
    R(serpents, c, 'serpentWaves', 1, 8, 1, 'bends per lap');
    R(serpents, c, 'serpentHeight', 0, 2, 0.01, 'rise and dip (m)');
    R(serpents, c, 'serpentLift', 0, 2, 0.01, 'spine height (m)');
    R(serpents, c, 'serpentLength', 0.05, 1, 0.01, 'trail (of a lap)');
    R(serpents, c, 'serpentSpeed', -1.5, 1.5, 0.01, 'laps/s');
    R(serpents, c, 'serpentWidth', 0.05, 2, 0.01, 'width (m)');
    R(serpents, c, 'serpentFloorWidth', 0, 4, 0.05, 'floor pool (m)');
    R(serpents, c, 'serpentNoiseScale', 0.2, 6, 0.05, 'noise scale');
    R(serpents, c, 'serpentFlow', -6, 6, 0.05, 'flow');
    R(serpents, c, 'serpentRise', 0, 4, 0.05, 'rise');
    R(serpents, c, 'serpentShred', 0, 3, 0.01, 'shred');
    R(serpents, c, 'serpentHeadGlow', 0, 4, 0.01, 'head glow');
    R(serpents, c, 'serpentIntensity', 0, 8, 0.05, 'intensity');
    R(serpents, c, 'serpentFloorGlow', 0, 2, 0.01, 'floor glow');
    R(serpents, c, 'serpentEmbers', 0, 120, 1, 'embers/s off each head');

    /* ---- panel 3 ---- */
    const skirt = folder.addFolder('3 · The wispy flame waves');
    R(skirt, c, 'skirtRadius', 0.05, 1.5, 0.01, 'ring (of field radius)');
    R(skirt, c, 'skirtHeight', 0.1, 6, 0.05, 'height (m)');
    R(skirt, c, 'skirtRiseTime', 0.05, 3, 0.01, 'stands up in (s)');
    R(skirt, c, 'skirtFlare', -0.5, 1.5, 0.01, 'top leans out');
    R(skirt, c, 'skirtBreathe', 0, 0.4, 0.005, 'breathes');
    R(skirt, c, 'skirtNoiseScale', 0.1, 4, 0.05, 'noise scale');
    R(skirt, c, 'skirtRise', 0, 5, 0.05, 'tongues climb (m/s)');
    R(skirt, c, 'skirtShred', 0, 3, 0.01, 'shred');
    R(skirt, c, 'skirtWisp', 0, 2, 0.01, 'wisps');
    R(skirt, c, 'skirtWaveSpeed', -3, 3, 0.01, 'waves/s');
    R(skirt, c, 'skirtWaveDepth', 0, 1, 0.01, 'wave depth');
    R(skirt, c, 'skirtHeat', 0, 2, 0.01, 'heat');
    R(skirt, c, 'skirtIntensity', 0, 8, 0.05, 'intensity');
    R(skirt, c, 'skirtOpacity', 0, 2, 0.01, 'opacity');
    R(skirt, c, 'smokeRate', 0, 80, 1, 'smoke/s');
    R(skirt, c, 'smokeOpacity', 0, 1, 0.01, 'smoke opacity');

    /* ---- panel 4 ---- */
    const scorch = folder.addFolder('4 · The ground scorch');
    R(scorch, c, 'scorchRadius', 0.2, 2, 0.01, 'reach (of field radius)');
    R(scorch, c, 'scorchDark', 0, 1, 0.01, 'darkening');
    scorch.addColor(c, 'colorScorch').name('char');
    R(scorch, c, 'crackScale', 0.2, 5, 0.05, 'plates per metre');
    R(scorch, c, 'crackWidth', 0.005, 0.4, 0.005, 'crack width');
    R(scorch, c, 'crackGlow', 0, 8, 0.05, 'crack glow');
    R(scorch, c, 'crackReach', 0.1, 1.5, 0.01, 'cracks run out to');
    R(scorch, c, 'groundEmbers', 0, 5, 0.05, 'embers in the crust');

    /* ---- panel 5 ---- */
    const embers = folder.addFolder('5 · The floating embers');
    R(embers, c, 'emberRate', 0, 500, 1, 'embers/s over the field');
    R(embers, c, 'bodyEmbers', 0, 300, 1, 'embers/s off the bird');
    R(embers, c, 'emberSize', 0.01, 0.4, 0.005, 'size (m)');
    R(embers, c, 'emberLife', 0.2, 8, 0.05, 'life (s)');
    R(embers, c, 'emberRise', -2, 6, 0.05, 'lift (m/s²)');
    R(embers, c, 'emberGlow', 0, 8, 0.05, 'glow');

    /* ---- panel 6 ---- */
    const glow = folder.addFolder('6 · The sub-surface glow');
    R(glow, c, 'glowRadius', 0.2, 2.5, 0.01, 'reach (of field radius)');
    R(glow, c, 'glowIntensity', 0, 6, 0.05, 'intensity');
    R(glow, c, 'glowPulse', 0, 1, 0.01, 'breath');
    R(glow, c, 'glowPulseSpeed', 0.1, 8, 0.05, 'breath speed');
    glow.addColor(c, 'colorGlow').name('colour');

    const light = folder.addFolder('The light');
    R(light, c, 'lightIntensity', 0, 120, 0.5, 'the bird');
    R(light, c, 'lightRadius', 1, 40, 0.1, 'bird light radius');
    light.addColor(c, 'lightColor').name('bird light colour');
    R(light, c, 'lightGutter', 0, 1, 0.01, 'gutter');
    R(light, c, 'lightGutterSpeed', 0.5, 30, 0.1, 'gutter speed');
    R(light, c, 'fieldLight', 0, 120, 0.5, 'the pyre');
    R(light, c, 'fieldLightRadius', 1, 40, 0.1, 'pyre light radius');

    this.phoenixFolder = folder;
  }

  _buildMonowheel() {
    const folder = this.gui.addFolder('◎  Monowheel Bot');
    const c = settings.monowheel;
    const R = Editor.range;

    const cast = folder.addFolder('The summon');
    R(cast, c, 'range', 2, 20, 0.1, 'kill ring radius (m)');
    R(cast, c, 'cooldown', 0, 10, 0.05, 'cooldown after recall');
    R(cast, c, 'deployTime', 0.2, 4, 0.01, 'deploys over (s)');
    R(cast, c, 'recallTime', 0.2, 4, 0.01, 'recalls over (s)');
    R(cast, c, 'deployDistance', 0, 6, 0.05, 'appears ahead by (m)');
    R(cast, c, 'deployShake', 0, 0.5, 0.005, 'arrival rumble');
    cast.add(c, 'watch').name('caster watches it');
    Editor.castAnimation(cast, c);

    const chassis = folder.addFolder('The chassis');
    R(chassis, c, 'size', 0.5, 4, 0.01, 'height (m)');
    chassis.addColor(c, 'rimColor').name('rim colour');
    R(chassis, c, 'rimStrength', 0, 2, 0.01, 'rim');
    R(chassis, c, 'rimPower', 0.5, 8, 0.05, 'rim tightness');
    chassis.addColor(c, 'revealColor').name('print edge colour');
    R(chassis, c, 'revealWidth', 0.005, 0.5, 0.005, 'print edge (m)');
    R(chassis, c, 'revealGlow', 0, 20, 0.1, 'print edge glow');

    const balance = folder.addFolder('The balance');
    R(balance, c, 'lean', 0, 0.8, 0.005, 'lean into speed (rad)');
    R(balance, c, 'leanRate', 0.0001, 0.5, 0.0001, 'lean lag');
    R(balance, c, 'bankIntoTurns', 0, 0.6, 0.005, 'lean into turns');
    R(balance, c, 'recoil', 0, 0.3, 0.002, 'recoil rock (rad)');
    R(balance, c, 'wobble', 0, 0.1, 0.001, 'idle wobble (rad)');
    R(balance, c, 'wobbleSpeed', 0, 6, 0.01, 'wobble speed');

    const drive = folder.addFolder('The drive');
    R(drive, c, 'maxSpeed', 0.5, 20, 0.1, 'top speed (m/s)');
    R(drive, c, 'acceleration', 0.0005, 0.6, 0.0005, 'throttle lag');
    R(drive, c, 'leash', 2, 40, 0.1, 'leash (m)');
    R(drive, c, 'turnRate', 0.0005, 0.6, 0.0005, 'steering lag');
    R(drive, c, 'stickDeadZone', 0, 0.5, 0.01, 'stick dead zone');
    R(drive, c, 'stickExpo', 0.5, 4, 0.05, 'stick expo');
    R(drive, c, 'handDeadZone', 0, 0.8, 0.01, 'hand dead zone (ndc)');
    R(drive, c, 'handFullRange', 0.1, 1, 0.01, 'hand full stick (ndc)');
    R(drive, c, 'treadDust', 0, 160, 1, 'tread dust (particles/s)');
    R(drive, c, 'treadDustSize', 0.1, 2.5, 0.01, 'tread dust size');

    const ring = folder.addFolder('The range ring');
    R(ring, c, 'ringWidth', 0.02, 1, 0.005, 'band width (m)');
    R(ring, c, 'ringGlow', 0, 4, 0.01, 'band glow');
    R(ring, c, 'ringSoftness', 0.005, 0.4, 0.005, 'softness');
    R(ring, c, 'ringFill', 0, 0.6, 0.005, 'interior wash');
    R(ring, c, 'ringTicks', 0, 96, 1, 'ticks');
    R(ring, c, 'ringTickLength', 0, 1.2, 0.01, 'tick length (m)');
    R(ring, c, 'ringTickWidth', 0.02, 0.9, 0.01, 'tick duty');
    R(ring, c, 'ringTickSpin', -0.5, 0.5, 0.005, 'tick spin (rev/s)');
    R(ring, c, 'ringSweep', 0, 2, 0.01, 'radar sweep');
    R(ring, c, 'ringSweepSpeed', 0, 2, 0.01, 'sweep (rev/s)');
    R(ring, c, 'ringPulse', 0, 3, 0.01, 'hot pulses');
    R(ring, c, 'ringOpacity', 0, 1, 0.01, 'opacity');
    ring.addColor(c, 'colorRing').name('watching');
    ring.addColor(c, 'colorRingHot').name('hunting');

    const lamp = folder.addFolder('The headlamp');
    R(lamp, c, 'beamAngle', 1, 30, 0.1, 'half-angle (deg)');
    R(lamp, c, 'beamIntensity', 0, 2, 0.01, 'cone');
    R(lamp, c, 'beamEdge', 0.2, 6, 0.05, 'edge softness');
    R(lamp, c, 'beamFalloff', 0, 3, 0.01, 'fades toward the floor');
    R(lamp, c, 'beamNoise', 0, 1, 0.01, 'dust in the beam');
    R(lamp, c, 'beamNoiseScale', 0.2, 8, 0.05, 'dust scale');
    R(lamp, c, 'beamSwing', 0.0001, 0.5, 0.0001, 'swing lag');
    R(lamp, c, 'headlightReach', 0.5, 15, 0.1, 'lights ahead by (m)');
    R(lamp, c, 'spotIntensity', 0, 3, 0.01, 'pool on the floor');
    R(lamp, c, 'spotLight', 0, 40, 0.1, 'floor light');
    R(lamp, c, 'spotLightRadius', 0.5, 20, 0.1, 'floor light radius');
    lamp.addColor(c, 'colorBeam').name('watching');
    lamp.addColor(c, 'colorBeamHot').name('hunting');

    const hunt = folder.addFolder('Targeting');
    R(hunt, c, 'aimTurnRate', 0.0001, 0.5, 0.0001, 'turn-onto lag');
    R(hunt, c, 'lockTime', 0.02, 3, 0.01, 'lock time (s)');
    R(hunt, c, 'lockCone', 0.02, 1.2, 0.01, 'fires within (rad)');
    R(hunt, c, 'aimHeight', 0, 1, 0.01, 'aims at (body height)');
    R(hunt, c, 'retarget', 0, 3, 0.01, 'between targets (s)');
    R(hunt, c, 'reticleSize', 0.2, 4, 0.01, 'reticle size (m)');
    R(hunt, c, 'reticleGlow', 0, 5, 0.01, 'reticle glow');
    hunt.addColor(c, 'colorReticle').name('locking');
    hunt.addColor(c, 'colorLocked').name('locked');

    const burst = folder.addFolder('The burst');
    R(burst, c, 'rounds', 1, 24, 1, 'rounds (alternating guns)');
    R(burst, c, 'burstTime', 0.05, 2, 0.01, 'over (s)');
    R(burst, c, 'tracerSpeed', 10, 200, 1, 'tracer speed (m/s)');
    R(burst, c, 'tracerSize', 0.02, 0.4, 0.005, 'tracer width (m)');
    R(burst, c, 'tracerLength', 0.1, 6, 0.05, 'tracer length (m)');
    R(burst, c, 'spread', 0, 0.2, 0.001, 'dispersion (rad)');
    R(burst, c, 'muzzleSize', 0, 2, 0.01, 'muzzle flash core (m)');
    R(burst, c, 'muzzleLength', 0, 3, 0.01, 'muzzle flame (m)');
    R(burst, c, 'muzzleStreaks', 0, 16, 1, 'muzzle flame streaks');
    R(burst, c, 'muzzleLight', 0, 200, 1, 'muzzle light');
    burst.add(c, 'casings').name('eject casings');
    R(burst, c, 'impactSparks', 0, 80, 1, 'impact sparks');
    burst.add(c, 'scorch').name('scorch the floor');
    R(burst, c, 'fireShake', 0, 0.5, 0.005, 'recoil shake');
    R(burst, c, 'fireFlash', 0, 0.4, 0.005, 'screen flash');
    burst.addColor(c, 'colorTracer').name('tracer');
    burst.addColor(c, 'colorTracerTail').name('tracer tail');
    burst.addColor(c, 'colorFlash').name('flash');
    burst.addColor(c, 'colorSpark').name('sparks');
    const hit = burst.addFolder('The hit');
    R(hit, c.hit, 'impulse', 0, 20, 0.1, 'thrown at (m/s)');
    R(hit, c.hit, 'lift', 0, 10, 0.1, 'lifted (m/s)');
    R(hit, c.hit, 'spin', 0, 5, 0.05, 'torque');

    const light = folder.addFolder('The body light');
    R(light, c, 'lightIntensity', 0, 60, 0.5, 'intensity');
    R(light, c, 'lightRadius', 0.5, 30, 0.1, 'radius');
    light.addColor(c, 'lightColor').name('colour');

    this.monowheelFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  /**
   * The Corrupted Shard Spawn.
   *
   * Grouped the way the reference sheet is: one folder per panel, in the order
   * they appear on screen — the rune is cut, the crystals tear up, the water is
   * thrown, the mist coils, the flash ignites, the droplets drift — and then a
   * seventh for the beam the flash fires, which is what the composite implies.
   * `The sequence` sits at the top because it reaches into all of them.
   *
   * `crystals` is the performance dial and is a live slider on purpose.
   */
  _buildShard() {
    const folder = this.gui.addFolder('✦  Corrupted Shard');
    const c = settings.shard;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'zoneRadius', 1, 12, 0.05, 'footprint radius');
    R(cast, c, 'range', 2, 50, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 10, 0.1, 'min range');
    R(cast, c, 'speed', 5, 300, 1, 'seed speed');
    R(cast, c, 'lifetime', 0.5, 20, 0.05, 'hold time');
    R(cast, c, 'fadeTime', 0.1, 8, 0.01, 'fade time');
    R(cast, c, 'cooldown', 0, 10, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const sequence = folder.addFolder('The sequence');
    R(sequence, c, 'runeTime', 0.05, 2, 0.01, 'rune opens over');
    R(sequence, c, 'crystalDelay', 0, 2, 0.01, 'crystals start at');
    R(sequence, c, 'crystalTime', 0.05, 3, 0.01, 'one rises over');
    R(sequence, c, 'crystalStagger', 0, 2, 0.01, 'first-to-last lag');
    R(sequence, c, 'crystalOvershoot', 0, 0.5, 0.005, 'rise overshoot');
    R(sequence, c, 'crystalSettle', 0.05, 1.5, 0.01, 'settle time');
    R(sequence, c, 'splashRise', 0.05, 1, 0.01, 'crown rises over');
    R(sequence, c, 'splashHold', 0, 1, 0.01, 'crown hangs for');
    R(sequence, c, 'splashFall', 0.1, 3, 0.01, 'crown falls over');
    R(sequence, c, 'mistDelay', 0, 2, 0.01, 'mist starts at');
    R(sequence, c, 'flareDelay', 0, 3, 0.01, 'flash ignites at');
    R(sequence, c, 'flareTime', 0.02, 2, 0.01, 'flash lights over');
    R(sequence, c, 'fireDelay', 0, 3, 0.01, 'first beam after');
    R(sequence, c, 'pulseRate', 0.05, 6, 0.01, 'pulse speed');
    R(sequence, c, 'pulseDepth', 0, 2, 0.01, 'pulse depth');

    /* ---- layer 1 ---- */
    const rune = folder.addFolder('1 · The ground rune');
    R(rune, c, 'runeRailWidth', 0.005, 0.2, 0.001, 'rail width (m)');
    R(rune, c, 'runeRailOuter', 0.4, 1.4, 0.005, 'outer rail');
    R(rune, c, 'runeRailTwin', 0.4, 1.3, 0.005, 'twin rail');
    R(rune, c, 'runeRailInner', 0.2, 1.2, 0.005, 'inner rail');
    R(rune, c, 'runeRailMid', 0.1, 1.0, 0.005, 'star rail');
    R(rune, c, 'runeRailHub', 0.02, 0.6, 0.005, 'hub');
    R(rune, c, 'runeRailGlow', 0, 6, 0.01, 'rail glow');
    R(rune, c, 'runeSpin', -0.2, 0.2, 0.001, 'ring spin');
    R(rune, c, 'runeGlyphs', 6, 120, 1, 'glyphs');
    R(rune, c, 'runeGlyphBand', 0.05, 1.2, 0.005, 'band height (m)');
    R(rune, c, 'runeGlyphSeat', 0.3, 1.3, 0.005, 'band seat');
    R(rune, c, 'runeGlyphWeight', 0.01, 0.2, 0.001, 'stroke weight');
    R(rune, c, 'runeGlyphStrokes', 0, 1, 0.01, 'strokes kept');
    R(rune, c, 'runeGlyphSweep', 0, 4, 0.01, 'read head');
    R(rune, c, 'runeGlyphSweepSpeed', -1, 1, 0.005, 'head speed');
    R(rune, c, 'runeGlyphSweepWidth', 0.01, 0.5, 0.005, 'head width');
    R(rune, c, 'runeGlyphFlicker', 0, 1, 0.01, 'glyph flicker');
    R(rune, c, 'runeGlyphGlow', 0, 6, 0.01, 'glyph glow');
    R(rune, c, 'runeStar', 0, 4, 0.01, 'hexagram');
    R(rune, c, 'runeStarWidth', 0.005, 0.15, 0.001, 'star width (m)');
    R(rune, c, 'runeStarSpin', -0.2, 0.2, 0.001, 'star spin');
    R(rune, c, 'runeHex', 0, 4, 0.01, 'hexagon');
    R(rune, c, 'runeOrbits', 0, 4, 0.01, 'point circles');
    R(rune, c, 'runeOrbitRadius', 0.02, 0.3, 0.005, 'circle radius');
    R(rune, c, 'runeSpokes', 1, 24, 1, 'spokes');
    R(rune, c, 'runeSpokeWidth', 0.004, 0.1, 0.001, 'spoke width (m)');
    R(rune, c, 'runeSpokeGlow', 0, 4, 0.01, 'spoke glow');
    R(rune, c, 'runeTicks', 0, 3, 0.01, 'graduations');
    R(rune, c, 'runeTickCount', 4, 240, 1, 'tick count');
    R(rune, c, 'runeTickWidth', 0.02, 1, 0.01, 'tick width');
    R(rune, c, 'runeTickLength', 0.005, 0.3, 0.005, 'tick length');
    R(rune, c, 'runeWash', 0, 2, 0.01, 'inner wash');
    R(rune, c, 'runeWashFalloff', 0.2, 6, 0.05, 'wash falloff');
    R(rune, c, 'runeGrain', 0, 2, 0.01, 'wash grain');
    R(rune, c, 'runeGrainScale', 0.2, 10, 0.05, 'grain scale');
    R(rune, c, 'runeOpacity', 0, 2, 0.01, 'opacity');
    R(rune, c, 'runeGlow', 0, 3, 0.01, 'glow');
    R(rune, c, 'runeHeight', 0.005, 0.2, 0.002, 'hover height');
    rune.addColor(c, 'colorRune').name('lines');
    rune.addColor(c, 'colorRuneCore').name('line core');
    rune.addColor(c, 'colorGlyph').name('glyphs');
    rune.addColor(c, 'colorRuneWash').name('inner wash');
    rune.addColor(c, 'colorRuneFront').name('opening front');

    /* ---- layer 2 ---- */
    const crystals = folder.addFolder('2 · The crystal shards');
    R(crystals, c, 'crystals', 1, 24, 1, 'crystals');
    R(crystals, c, 'spireHeight', 0.5, 8, 0.05, 'spire height (m)');
    R(crystals, c, 'bladeHeight', 0.3, 6, 0.05, 'blade height (m)');
    R(crystals, c, 'shardHeight', 0.1, 3, 0.05, 'shard height (m)');
    R(crystals, c, 'crystalHeightJitter', 0, 1, 0.01, 'height jitter');
    R(crystals, c, 'crystalRadius', 0.05, 1.2, 0.01, 'base radius (m)');
    R(crystals, c, 'crystalRadiusJitter', 0, 1, 0.01, 'radius jitter');
    R(crystals, c, 'bladeSeat', 0.05, 1, 0.005, 'blade ring, x footprint');
    R(crystals, c, 'shardSeat', 0.05, 1.2, 0.005, 'shard ring, x footprint');
    R(crystals, c, 'crystalSeatJitter', 0, 1, 0.01, 'seat jitter');
    R(crystals, c, 'bladeLean', 0, 1.4, 0.01, 'blade lean (rad)');
    R(crystals, c, 'shardLean', 0, 1.5, 0.01, 'shard lean (rad)');
    R(crystals, c, 'crystalLeanJitter', 0, 1, 0.01, 'lean jitter');
    R(crystals, c, 'crystalTwist', 0, 2, 0.01, 'twist');
    R(crystals, c, 'crystalFacets', 4, 9, 1, 'facets');
    R(crystals, c, 'crystalTaper', 0.02, 0.6, 0.005, 'tip taper');
    R(crystals, c, 'crystalRough', 0, 1, 0.01, 'facet roughness');
    R(crystals, c, 'crystalBend', 0, 0.8, 0.01, 'bend');
    R(crystals, c, 'crystalSinkTime', 0.1, 4, 0.01, 'withdraw over');
    R(crystals, c, 'shatterChips', 0, 400, 1, 'fragments on the way out');

    const stone = folder.addFolder('2 · What the stone is made of');
    R(stone, c, 'gemDepthTint', 0, 3, 0.01, 'depth tint');
    R(stone, c, 'gemFresnel', 0, 5, 0.01, 'rim gain');
    R(stone, c, 'gemFresnelPower', 0.5, 6, 0.05, 'rim power');
    R(stone, c, 'gemDispersion', 0, 1.5, 0.01, 'dispersion');
    R(stone, c, 'gemFacetSharp', 0, 1, 0.01, 'facet lift');
    R(stone, c, 'gemScreenKey', 0, 1, 0.01, 'screen key');
    R(stone, c, 'gemCleave', 0, 2, 0.01, 'cleavage planes');
    R(stone, c, 'gemCleaveScale', 1, 20, 0.1, 'cleavage scale');
    R(stone, c, 'gemVein', 0, 5, 0.01, 'corruption glow');
    R(stone, c, 'gemVeinScale', 0.5, 10, 0.05, 'corruption scale');
    R(stone, c, 'gemVeinFlow', 0, 3, 0.01, 'corruption climb');
    R(stone, c, 'gemVeinBase', 0, 1, 0.01, 'thins toward tip');
    R(stone, c, 'gemVeinSharp', 0.5, 8, 0.05, 'corruption sharpness');
    R(stone, c, 'gemBaseDark', 0, 0.8, 0.005, 'obsidian foot');
    R(stone, c, 'gemTipFrost', 0, 1, 0.01, 'tip frost');
    R(stone, c, 'gemTipStart', 0, 1, 0.01, 'frost starts at');
    R(stone, c, 'gemGlint', 0, 4, 0.01, 'glints');
    R(stone, c, 'gemGlintScale', 4, 80, 0.5, 'glint scale');
    R(stone, c, 'gemGlintSpeed', 0, 4, 0.01, 'glint drift');
    R(stone, c, 'gemGlow', 0, 3, 0.01, 'emissive master');
    R(stone, c, 'gemEdgeGlow', 0, 4, 0.01, 'edge glow');
    R(stone, c, 'gemBodyGlow', 0, 2, 0.01, 'body glow');
    R(stone, c, 'gemBirthGlow', 0, 10, 0.05, 'birth flash');
    R(stone, c, 'gemBirthFade', 0.05, 2, 0.01, 'birth cools over');
    R(stone, c, 'gemChargeGlow', 0, 8, 0.05, 'charge glow');
    R(stone, c, 'gemCoreBleed', 0, 5, 0.01, 'lit by the flash');
    R(stone, c, 'gemCoreBleedRadius', 0.2, 12, 0.05, 'flash light reach');
    R(stone, c, 'gemOpacity', 0, 1, 0.01, 'opacity');
    R(stone, c, 'gemRoughness', 0, 1, 0.01, 'roughness');
    R(stone, c, 'gemEnv', 0, 3, 0.01, 'reflections');
    stone.addColor(c, 'colorGem').name('body');
    stone.addColor(c, 'colorGemDeep').name('deep body');
    stone.addColor(c, 'colorGemRim').name('rim');
    stone.addColor(c, 'colorVein').name('corruption');
    stone.addColor(c, 'colorGemTip').name('tip frost');
    stone.addColor(c, 'colorGemBase').name('obsidian foot');

    /* ---- layer 3 ---- */
    const splash = folder.addFolder('3 · The radial water splash');
    R(splash, c, 'splashRadius', 0.1, 1.2, 0.005, 'crown seat, x footprint');
    R(splash, c, 'splashHeight', 0.1, 5, 0.05, 'crown height (m)');
    R(splash, c, 'splashFingers', 4, 60, 1, 'fingers');
    R(splash, c, 'splashFingerDepth', 0, 1, 0.01, 'finger depth');
    R(splash, c, 'splashFlare', 0, 1, 0.01, 'standing lean');
    R(splash, c, 'splashLean', 0, 3, 0.01, 'falling lean');
    R(splash, c, 'splashCurl', 0, 0.6, 0.01, 'tip curl');
    R(splash, c, 'splashWobble', 0, 0.3, 0.005, 'wall wander');
    R(splash, c, 'splashWobbleScale', 0.5, 6, 0.05, 'wander scale');
    R(splash, c, 'splashTear', 0, 1, 0.01, 'crest tear');
    R(splash, c, 'splashFresnel', 0, 4, 0.01, 'rim gain');
    R(splash, c, 'splashOpacity', 0, 1, 0.01, 'opacity');
    R(splash, c, 'splashGlow', 0, 3, 0.01, 'glow');
    R(splash, c, 'splashRipple', 0.2, 3, 0.01, 'floor ring, x footprint');
    R(splash, c, 'splashDrops', 0, 600, 1, 'droplets');
    R(splash, c, 'splashDropSpeed', 0.5, 16, 0.1, 'droplet speed');
    R(splash, c, 'splashDropSize', 0.02, 0.4, 0.005, 'droplet size');
    R(splash, c, 'splashDropLife', 0.2, 4, 0.05, 'droplet life');
    splash.addColor(c, 'colorWater').name('water');
    splash.addColor(c, 'colorWaterDeep').name('deep water');
    splash.addColor(c, 'colorWaterRim').name('rim');
    splash.addColor(c, 'colorWaterCrest').name('crest');
    Editor.gradient(splash, c, 'colorDrop', 'Droplet gradient');

    /* ---- layer 4 ---- */
    const mist = folder.addFolder('4 · The dark mist tendrils');
    R(mist, c, 'mistRate', 0, 120, 1, 'rate');
    R(mist, c, 'mistSize', 0.1, 4, 0.05, 'size');
    R(mist, c, 'mistLifetime', 0.3, 8, 0.05, 'lifetime');
    R(mist, c, 'mistSpeed', 0, 4, 0.05, 'speed');
    R(mist, c, 'mistRise', -1, 3, 0.05, 'rise');
    R(mist, c, 'mistSwirl', -4, 4, 0.05, 'coil speed');
    R(mist, c, 'mistSwirlExpand', 0, 2, 0.01, 'coil widens by');
    R(mist, c, 'mistOpacity', 0, 1, 0.01, 'opacity');
    R(mist, c, 'mistTurbulence', 0, 3, 0.01, 'turbulence');
    R(mist, c, 'mistBurst', 0, 300, 1, 'gout as the floor breaks');
    Editor.gradient(mist, c, 'colorMist', 'Mist gradient');

    /* ---- layer 5 ---- */
    const flare = folder.addFolder('5 · The glow flash');
    R(flare, c, 'flareHeight', 0.2, 6, 0.05, 'height (m)');
    R(flare, c, 'flareSize', 0.2, 8, 0.05, 'size (m)');
    R(flare, c, 'flareCore', 0, 3, 0.01, 'white point');
    R(flare, c, 'flareCoreSize', 0.02, 0.5, 0.005, 'point size');
    R(flare, c, 'flareRays', 0, 3, 0.01, 'long rays');
    R(flare, c, 'flareRayLength', 0.1, 1.2, 0.01, 'ray length');
    R(flare, c, 'flareRaySharp', 0.5, 12, 0.1, 'ray sharpness');
    R(flare, c, 'flareDiagonals', 0, 2, 0.01, 'diagonal rays');
    R(flare, c, 'flareStreak', 0, 3, 0.01, 'lens streak');
    R(flare, c, 'flareStreakLength', 0.1, 1.2, 0.01, 'streak length');
    R(flare, c, 'flareHalo', 0, 3, 0.01, 'halo');
    R(flare, c, 'flareHaloFalloff', 0.5, 8, 0.05, 'halo falloff');
    R(flare, c, 'flareRing', 0, 2, 0.01, 'ring');
    R(flare, c, 'flareRingRadius', 0.1, 1, 0.01, 'ring radius');
    R(flare, c, 'flareSpin', -0.5, 0.5, 0.005, 'ray spin');
    R(flare, c, 'flareFlicker', 0, 1, 0.01, 'flicker');
    R(flare, c, 'flareChargeGain', 0, 4, 0.05, 'swell on charge');
    R(flare, c, 'flareIgnite', 0, 8, 0.05, 'ignition pop');
    R(flare, c, 'flareIntensity', 0, 6, 0.05, 'intensity');
    R(flare, c, 'flareOpacity', 0, 1, 0.01, 'opacity');
    flare.addColor(c, 'colorFlareCore').name('point');
    flare.addColor(c, 'colorFlareGlow').name('rays');
    flare.addColor(c, 'colorFlareHalo').name('halo');
    flare.addColor(c, 'colorFlareStreak').name('streak');

    /* ---- layer 6 ---- */
    const beads = folder.addFolder('6 · The corrupted droplets');
    R(beads, c, 'beadRate', 0, 120, 1, 'bead rate');
    R(beads, c, 'beadSize', 0.02, 0.4, 0.005, 'bead size');
    R(beads, c, 'beadLifetime', 0.3, 8, 0.05, 'bead lifetime');
    R(beads, c, 'beadSpeed', 0, 4, 0.05, 'bead speed');
    R(beads, c, 'beadRise', -2, 3, 0.05, 'bead rise');
    R(beads, c, 'beadSwirl', -4, 4, 0.05, 'bead drift round');
    R(beads, c, 'beadBurst', 0, 400, 1, 'beads on ignition');
    R(beads, c, 'glintRate', 0, 120, 1, 'glint rate');
    R(beads, c, 'glintSize', 0.02, 0.3, 0.005, 'glint size');
    R(beads, c, 'glintLifetime', 0.2, 5, 0.05, 'glint lifetime');
    Editor.gradient(beads, c, 'colorBead', 'Bead gradient');
    Editor.gradient(beads, c, 'colorGlint', 'Glint gradient');

    /* ---- the beam ---- */
    const beam = folder.addFolder('7 · The beam');
    beam.add(c, 'laserEnabled').name('fires');
    R(beam, c, 'laserRange', 1, 30, 0.1, 'range (m)');
    R(beam, c, 'laserInterval', 0.05, 4, 0.01, 'interval');
    R(beam, c, 'laserWarmup', 0, 2, 0.01, 'warmup');
    R(beam, c, 'laserVolley', 1, 6, 1, 'targets per shot');
    R(beam, c, 'laserLife', 0.1, 2, 0.01, 'on screen for');
    R(beam, c, 'laserWidth', 0.1, 4, 0.05, 'thickness');
    R(beam, c, 'laserAim', 0, 1, 0.01, 'aims up the body');
    R(beam, c, 'laserShake', 0, 2, 0.01, 'shake');
    R(beam, c, 'laserFlash', 0, 2, 0.01, 'flash');
    R(beam, c.laserHit, 'impulse', 0, 20, 0.1, 'blow, back');
    R(beam, c.laserHit, 'lift', 0, 12, 0.1, 'blow, up');
    R(beam, c.laserHit, 'spin', 0, 5, 0.05, 'blow, torque');
    R(beam, c, 'impactBeads', 0, 300, 1, 'beads out of the wound');
    R(beam, c, 'impactGlints', 0, 300, 1, 'glints out of it');
    R(beam, c, 'impactScorch', 0, 3, 0.05, 'mark under it (m)');

    const burn = folder.addFolder('7 · What the light burns');
    const bc = c.burn;
    burn.add(bc, 'enabled').name('burns bodies out');
    R(burn, bc, 'stain', 0.1, 8, 0.05, 'violet takes over / second');
    R(burn, bc, 'onset', 0, 4, 0.01, 'flesh goes after');
    R(burn, bc, 'rate', 0.05, 6, 0.01, 'body burnt / second');
    R(burn, bc.look, 'rimEmissive', 0, 8, 0.05, 'burnt rim glow');
    R(burn, bc.look, 'edgeEmissive', 0, 16, 0.05, 'burn line glow');
    R(burn, bc.look, 'edgeWidth', 0.005, 0.4, 0.005, 'burn line width');
    burn.addColor(bc.look, 'color').name('burnt flesh');
    burn.addColor(bc.look, 'rimColor').name('burnt rim');
    burn.addColor(bc.look, 'edgeColor').name('burn line');

    const shape = folder.addFolder('7 · The beam itself');
    R(shape, c, 'beamRadius', 0.01, 0.5, 0.005, 'radius at target (m)');
    R(shape, c, 'beamMuzzleRadius', 0.01, 0.8, 0.005, 'radius at the flash (m)');
    R(shape, c, 'beamRadiusCurve', 0.1, 3, 0.05, 'taper curve');
    R(shape, c, 'beamFlare', 0, 3, 0.01, 'flare at target');
    R(shape, c, 'beamFlareWidth', 0.01, 0.6, 0.005, 'flare length');
    R(shape, c, 'beamRipple', 0, 0.6, 0.005, 'ripple');
    R(shape, c, 'beamRippleBands', 1, 24, 1, 'ripple bands');
    R(shape, c, 'beamRippleSpeed', 0, 20, 0.1, 'ripple speed');
    R(shape, c, 'beamStrike', 0.02, 0.6, 0.005, 'arrives in');
    R(shape, c, 'beamHold', 0.05, 0.95, 0.005, 'holds until');
    R(shape, c, 'beamCoreFill', 0.2, 8, 0.05, 'core weight');
    R(shape, c, 'beamEdgePower', 0.2, 8, 0.05, 'sheath power');
    R(shape, c, 'beamSheath', 0, 3, 0.01, 'sheath gain');
    R(shape, c, 'beamPulse', 0, 4, 0.01, 'racing charge');
    R(shape, c, 'beamPulseBands', 1, 24, 1, 'charge bands');
    R(shape, c, 'beamPulseSpeed', 0, 30, 0.1, 'charge speed');
    R(shape, c, 'beamPulseSharp', 1, 20, 0.5, 'charge sharpness');
    R(shape, c, 'beamHeadGlow', 0, 8, 0.05, 'head glow');
    R(shape, c, 'beamHeadWidth', 0.01, 0.4, 0.005, 'head width');
    R(shape, c, 'beamMuzzleGlow', 0, 8, 0.05, 'muzzle glow');
    R(shape, c, 'beamMuzzleWidth', 0.01, 0.4, 0.005, 'muzzle width');
    R(shape, c, 'beamIntensity', 0, 8, 0.05, 'intensity');
    R(shape, c, 'beamOpacity', 0, 1, 0.01, 'opacity');
    R(shape, c, 'beamSoftFade', 0.02, 2, 0.01, 'soft fade');
    shape.addColor(c, 'colorBeamCore').name('core');
    shape.addColor(c, 'colorBeamInner').name('inner');
    shape.addColor(c, 'colorBeamOuter').name('sheath');
    shape.addColor(c, 'colorBeamPulse').name('charge');

    const impact = folder.addFolder('Throw, ignition & hold');
    R(impact, c, 'handHeight', 0, 3, 0.01, 'hand height');
    R(impact, c, 'handForward', -1, 3, 0.01, 'hand forward');
    R(impact, c, 'handSide', -1.5, 1.5, 0.01, 'hand lateral');
    R(impact, c, 'muzzleSize', 0.05, 6, 0.05, 'muzzle size');
    R(impact, c, 'muzzleIntensity', 0, 5, 0.01, 'muzzle intensity');
    R(impact, c, 'castFlash', 0, 2, 0.01, 'flash on release');
    R(impact, c, 'seedBeads', 0, 200, 1, 'beads off the hand');
    R(impact, c, 'creepRate', 0, 200, 1, 'beads off the seed');
    R(impact, c, 'igniteFlash', 0, 2, 0.01, 'ignition flash');
    R(impact, c, 'igniteShake', 0, 3, 0.01, 'landing shake');
    R(impact, c, 'shakeDuration', 0.1, 4, 0.01, 'shake duration');
    R(impact, c, 'holdShake', 0, 0.5, 0.005, 'hold rumble');
    R(impact, c, 'rumble', 0, 0.5, 0.005, 'creep rumble');
    R(impact, c, 'stainLife', 0.5, 20, 0.1, 'floor mark life');
    R(impact, c, 'stainIntensity', 0, 2, 0.01, 'floor mark intensity');
    impact.addColor(c, 'colorBurstA').name('shell inner');
    impact.addColor(c, 'colorBurstB').name('shell mid');
    impact.addColor(c, 'colorBurstC').name('shell core');
    impact.addColor(c, 'colorScorch').name('floor mark');
    impact.addColor(c, 'colorScorchEdge').name('floor mark edge');
    impact.addColor(c, 'colorCastFlash').name('release flash');
    impact.addColor(c, 'colorFlash').name('beam flash');

    const light = folder.addFolder('Dynamic light');
    R(light, c, 'lightIntensity', 0, 120, 0.5, 'light intensity');
    R(light, c, 'lightRadius', 0.5, 50, 0.1, 'light radius');
    R(light, c, 'lightHeight', 0, 1, 0.01, 'height, floor to flash');
    R(light, c, 'lightPulse', 0, 1, 0.01, 'owned by the pulse');
    light.addColor(c, 'lightColor').name('light colour');

    this.shardFolder = folder;
  }

  /**
   * The Glacial Prison, in the order the sheet stacks it: the ice cylinder,
   * the frost in the air, the ground ice, the cold mist, the crystals, the
   * glow — then what it does to a body, the ice every layer is made of, and
   * the light. It lands where it is aimed on the frame it is cast; there is
   * no arriving to dial.
   */
  _buildFrost() {
    const folder = this.gui.addFolder('❄️  Glacial Prison');
    const c = settings.frost;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'zoneRadius', 1, 8, 0.05, 'prison radius (m)');
    R(cast, c, 'range', 4, 50, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 12, 0.1, 'min range');
    R(cast, c, 'lifetime', 1, 30, 0.1, 'stands for (s)');
    R(cast, c, 'fadeTime', 0.1, 8, 0.01, 'thaws over (s)');
    R(cast, c, 'cooldown', 0, 15, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const landing = folder.addFolder('The landing');
    R(landing, c, 'landShake', 0, 1.5, 0.005, 'shake');
    R(landing, c, 'landLight', 0, 300, 1, 'light punch');
    R(landing, c, 'landGlints', 0, 800, 1, 'glints thrown up');
    R(landing, c, 'landMotes', 0, 500, 1, 'frost off the rim');

    /* ---- panel 1 ---- */
    const wall = folder.addFolder('1 · Ice cylinder mesh');
    R(wall, c, 'wallDelay', 0, 1, 0.01, 'stands at (s)');
    R(wall, c, 'wallRiseTime', 0.05, 3, 0.01, 'rises over (s)');
    R(wall, c, 'wallHeight', 0.5, 12, 0.1, 'height (m)');
    R(wall, c, 'wallOpacity', 0, 1, 0.01, 'opacity');
    R(wall, c, 'wallBody', 0, 1, 0.01, 'clear ice body');
    R(wall, c, 'wallTopFade', 0.1, 1, 0.01, 'thins from (of height)');
    R(wall, c, 'wallRimPower', 0.5, 6, 0.05, 'fresnel');
    R(wall, c, 'wallRimGlow', 0, 3, 0.01, 'rim light');
    R(wall, c, 'wallFrostScale', 0.2, 5, 0.01, 'frost scale');
    R(wall, c, 'wallFrost', 0, 1.5, 0.01, 'frosted');
    R(wall, c, 'wallStriaScale', 0.2, 6, 0.05, 'striation scale');
    R(wall, c, 'wallFlow', 0, 3, 0.01, 'caustic climb (m/s)');
    R(wall, c, 'wallCaustic', 0, 2, 0.01, 'caustic light');
    R(wall, c, 'wallFootGlow', 0, 3, 0.01, 'lit at the foot');
    R(wall, c, 'wallCracks', 0, 1.5, 0.01, 'hairline cracks');
    R(wall, c, 'wallRefraction', 0, 2, 0.01, 'refraction');

    /* ---- panel 2 ---- */
    const air = folder.addFolder('2 · Frost particles');
    R(air, c, 'glintRate', 0, 400, 1, 'glints/s');
    R(air, c, 'glintSize', 0.01, 0.4, 0.005, 'glint size');
    R(air, c, 'glintLife', 0.2, 8, 0.05, 'glint life (s)');
    R(air, c, 'glintRise', -2, 4, 0.05, 'glint lift');
    R(air, c, 'glintGlow', 0, 6, 0.05, 'glint glow');
    R(air, c, 'moteRate', 0, 300, 1, 'snow/s');
    R(air, c, 'moteSize', 0.01, 0.3, 0.005, 'snow size');
    R(air, c, 'moteLife', 0.2, 8, 0.05, 'snow life (s)');
    R(air, c, 'moteFall', -4, 2, 0.05, 'snow fall');

    /* ---- panel 3 ---- */
    const floor = folder.addFolder('3 · Ground ice decal');
    R(floor, c, 'floorReach', 1, 2.5, 0.01, 'frost reaches (× radius)');
    R(floor, c, 'floorFreezeTime', 0.05, 2, 0.01, 'freezes over (s)');
    R(floor, c, 'floorOpacity', 0, 1, 0.01, 'sheet opacity');
    R(floor, c, 'floorFrost', 0, 1, 0.01, 'frost opacity');
    R(floor, c, 'floorFrostScale', 0.2, 5, 0.01, 'frost scale');
    R(floor, c, 'crackScale', 0.2, 4, 0.01, 'crack cells per metre');
    R(floor, c, 'crackWidth', 0.005, 0.15, 0.001, 'crack width (m)');
    R(floor, c, 'crackGlow', 0, 6, 0.05, 'crack light');
    R(floor, c, 'crackDepth', 0, 0.5, 0.005, 'crack depth (m)');
    R(floor, c, 'spokes', 0, 24, 1, 'radial cracks');
    R(floor, c, 'footGlow', 0, 4, 0.05, 'foot ring');
    R(floor, c, 'floorSparkle', 0, 3, 0.01, 'glitter');
    R(floor, c, 'floorPulse', 0, 1, 0.01, 'breath');

    /* ---- panel 4 ---- */
    const mist = folder.addFolder('4 · Cold air mist');
    R(mist, c, 'mistRate', 0, 120, 1, 'rate');
    R(mist, c, 'mistDelay', 0, 2, 0.01, 'starts at (s)');
    R(mist, c, 'mistSize', 0.1, 4, 0.05, 'size');
    R(mist, c, 'mistLifetime', 0.3, 8, 0.05, 'lifetime');
    R(mist, c, 'mistSpeed', 0, 4, 0.05, 'rolls out at (m/s)');
    R(mist, c, 'mistRise', -1, 3, 0.05, 'rise');
    R(mist, c, 'mistSwirl', -4, 4, 0.05, 'coil speed');
    R(mist, c, 'mistSwirlExpand', 0, 2, 0.01, 'coil widens by');
    R(mist, c, 'mistOpacity', 0, 1, 0.01, 'opacity');
    R(mist, c, 'mistTurbulence', 0, 3, 0.01, 'turbulence');
    R(mist, c, 'mistBurst', 0, 300, 1, 'gout as the floor freezes');
    Editor.gradient(mist, c, 'colorMist', 'Mist gradient');

    /* ---- panel 5 ---- */
    const shards = folder.addFolder('5 · Rising shards');
    const risers = shards.addFolder('In the air');
    R(risers, c, 'shardCount', 0, 72, 1, 'splinters');
    R(risers, c, 'shardDelay', 0, 3, 0.01, 'start lifting at (s)');
    R(risers, c, 'shardSize', 0.02, 0.6, 0.005, 'size (m)');
    R(risers, c, 'shardRise', 0, 3, 0.01, 'rise (m/s)');
    R(risers, c, 'shardLife', 0.5, 10, 0.05, 'in the air (s)');
    R(risers, c, 'shardSpin', 0, 6, 0.05, 'tumble (rad/s)');
    const crown = shards.addFolder('At the foot of the wall');
    R(crown, c, 'crownCount', 0, 48, 1, 'crystals');
    R(crown, c, 'crownDelay', 0, 2, 0.01, 'grow at (s)');
    R(crown, c, 'crownGrowTime', 0.05, 3, 0.01, 'grow over (s)');
    R(crown, c, 'crownHeight', 0.1, 3, 0.01, 'height (m)');
    R(crown, c, 'crownBase', 0.02, 0.6, 0.005, 'base radius (m)');
    R(crown, c, 'crownRadius', 0.5, 1.3, 0.01, 'stand at (× radius)');
    R(crown, c, 'crownLean', -0.5, 1, 0.01, 'lean outward (rad)');
    const crystal = shards.addFolder('The crystal');
    R(crystal, c, 'crystalOpacity', 0, 1, 0.01, 'opacity');
    R(crystal, c, 'crystalScreenKey', 0, 1, 0.01, 'key toward camera');
    R(crystal, c, 'crystalInclusions', 0.5, 15, 0.1, 'inclusions scale');
    R(crystal, c, 'crystalRim', 0, 3, 0.01, 'rim light');

    /* ---- panel 6 ---- */
    const glow = folder.addFolder('6 · Ambient glow');
    R(glow, c, 'glowRadius', 0.2, 3, 0.01, 'reach (× radius)');
    R(glow, c, 'glowHeight', 0, 4, 0.01, 'height (m)');
    R(glow, c, 'glowIntensity', 0, 3, 0.01, 'intensity');
    R(glow, c, 'glowPulse', 0, 1, 0.01, 'breath');
    R(glow, c, 'glowPulseSpeed', 0.1, 8, 0.05, 'breath speed');

    /* ---- the bodies ---- */
    const bodies = folder.addFolder('The frozen bodies');
    const freeze = bodies.addFolder('The freeze');
    R(freeze, c, 'freezeReach', 0.2, 2, 0.01, 'reach (× radius)');
    R(freeze, c, 'freezeDelay', 0, 2, 0.01, 'first body at (s)');
    R(freeze, c, 'freezeStagger', 0, 2, 0.01, 'outer bodies later by (s)');
    R(freeze, c, 'freezeTime', 0.05, 3, 0.01, 'frost climbs over (s)');
    R(freeze, c, 'holdTime', 0, 10, 0.05, 'held frozen (s)');
    R(freeze, c, 'crackTime', 0.05, 3, 0.01, 'cracks run over (s)');
    R(freeze, c, 'bodyCrackWidth', 0.002, 0.08, 0.001, 'crack width (m)');
    R(freeze, c, 'crackGlowBody', 0, 10, 0.05, 'crack light');
    const shatter = bodies.addFolder('The shatter');
    R(shatter, c, 'shatterChunks', 4, 48, 1, 'pieces');
    R(shatter, c, 'shatterGap', 0, 0.05, 0.001, 'gap between pieces (m)');
    R(shatter, c, 'shatterSpeed', 0, 10, 0.05, 'thrown at (m/s)');
    R(shatter, c, 'shatterLift', 0, 10, 0.05, 'thrown up (m/s)');
    R(shatter, c, 'shatterOut', 0, 3, 0.01, 'out of the circle');
    R(shatter, c, 'shatterSpin', 0, 25, 0.1, 'tumble (rad/s)');
    R(shatter, c, 'shatterGravity', -30, -2, 0.1, 'gravity');
    R(shatter, c, 'shatterBounce', 0, 0.9, 0.01, 'bounce');
    R(shatter, c, 'shatterFriction', 0, 1, 0.01, 'friction');
    R(shatter, c, 'shatterChips', 0, 500, 1, 'splinters');
    R(shatter, c, 'chipSize', 0.01, 0.3, 0.005, 'splinter size');
    R(shatter, c, 'shatterLight', 0, 200, 1, 'light punch');
    R(shatter, c, 'shatterShake', 0, 1, 0.005, 'shake');
    const melt = bodies.addFolder('The melt');
    R(melt, c, 'meltDelay', 0, 10, 0.05, 'pieces lie for (s)');
    R(melt, c, 'meltTime', 0.1, 6, 0.05, 'melt over (s)');
    R(melt, c, 'meltVapour', 0, 80, 1, 'vapour puffs/s');
    const statue = bodies.addFolder('The ice on the body');
    R(statue, c, 'bodyFrostScale', 1, 30, 0.1, 'frost scale');
    R(statue, c, 'iceRough', 0, 1, 0.01, 'clear roughness');
    R(statue, c, 'frostRough', 0, 1, 0.01, 'frost roughness');
    R(statue, c, 'iceGlow', 0, 3, 0.01, 'cold light in it');
    R(statue, c, 'iceRim', 0, 4, 0.01, '...at the graze');
    R(statue, c, 'iceClearcoat', 0, 1, 0.01, 'glass coat');
    R(statue, c, 'iceEnv', 0, 4, 0.05, 'reflections');

    /* ---- what everything is made of ---- */
    const ice = folder.addFolder('The ice');
    ice.addColor(c, 'colorDeep').name('deep');
    ice.addColor(c, 'colorIce').name('ice');
    ice.addColor(c, 'colorFrost').name('frost');
    ice.addColor(c, 'colorGlow').name('cold light');
    R(ice, c, 'envStrength', 0, 3, 0.05, 'reflections');
    R(ice, c, 'sunSpec', 0, 4, 0.05, 'sun highlight');

    const light = folder.addFolder('The light');
    R(light, c, 'lightIntensity', 0, 200, 0.5, 'intensity');
    R(light, c, 'lightRadius', 1, 50, 0.1, 'radius');
    light.addColor(c, 'lightColor').name('colour');

    this.frostFolder = folder;
  }

  /**
   * The Toxic Shield of Conquest, in the order the sheet stacks it: the
   * crystalline barrier, the poison gas, the ground rupture, the shockwave —
   * then what it does to a body, the glass every layer is made of, and the
   * light. It lands where it is aimed on the frame it is cast; there is no
   * arriving to dial.
   */
  _buildToxic() {
    const folder = this.gui.addFolder('☣️  Toxic Shield');
    const c = settings.toxic;
    const R = Editor.range;

    const cast = folder.addFolder('The cast');
    R(cast, c, 'zoneRadius', 1, 8, 0.05, 'barrier radius (m)');
    R(cast, c, 'range', 4, 50, 0.1, 'max range');
    R(cast, c, 'minRange', 0, 12, 0.1, 'min range');
    R(cast, c, 'lifetime', 1, 30, 0.1, 'stands for (s)');
    R(cast, c, 'fadeTime', 0.1, 8, 0.01, 'breaks over (s)');
    R(cast, c, 'cooldown', 0, 15, 0.05, 'cooldown');
    Editor.castAnimation(cast, c);

    const landing = folder.addFolder('The landing');
    R(landing, c, 'landShake', 0, 1.5, 0.005, 'shake');
    R(landing, c, 'landLight', 0, 300, 1, 'light punch');
    R(landing, c, 'landSpores', 0, 800, 1, 'spores thrown up');

    /* ---- panel 1 ---- */
    const dome = folder.addFolder('1 · Crystalline barrier mesh');
    R(dome, c, 'domeDelay', 0, 1, 0.01, 'stands at (s)');
    R(dome, c, 'domeRiseTime', 0.05, 3, 0.01, 'rises over (s)');
    R(dome, c, 'domeSink', 0, 0.9, 0.01, 'sunk into the floor');
    R(dome, c, 'domeSpin', -0.5, 0.5, 0.005, 'lattice turns (rad/s)');
    R(dome, c, 'domeOpacity', 0, 1, 0.01, 'opacity');
    R(dome, c, 'domeBody', 0, 1, 0.01, 'clear glass body');
    R(dome, c, 'domeRimPower', 0.5, 6, 0.05, 'fresnel');
    R(dome, c, 'domeRimGlow', 0, 3, 0.01, 'rim light');
    R(dome, c, 'domeFootGlow', 0, 3, 0.01, 'lit at the foot');
    R(dome, c, 'domeRefraction', 0, 2, 0.01, 'refraction');
    const spars = dome.addFolder('The lattice');
    R(spars, c, 'sparCount', 0, 28, 1, 'spars');
    R(spars, c, 'sparWidth', 0.002, 0.05, 0.001, 'thickness');
    R(spars, c, 'sparMinArc', 0.1, 3.14, 0.01, 'shortest arc (rad)');
    R(spars, c, 'sparMaxArc', 0.1, 3.14, 0.01, 'longest arc (rad)');
    R(spars, c, 'sparGlow', 0, 5, 0.05, 'glow');
    R(spars, c, 'sparSpeed', 0, 10, 0.05, 'light runs at');
    R(spars, c, 'cellScale', 0.5, 10, 0.05, 'facets per radius');
    R(spars, c, 'cellWidth', 0.005, 0.15, 0.001, 'facet seam width');
    R(spars, c, 'cellGlow', 0, 2, 0.01, 'facet seam glow');
    const poison = dome.addFolder('The poison inside');
    R(poison, c, 'domeSwirl', 0, 2, 0.01, 'swirl');
    R(poison, c, 'domeSwirlScale', 0.3, 8, 0.05, 'swirl scale');
    R(poison, c, 'domeSwirlSpeed', 0, 1, 0.005, 'swirl speed');

    /* ---- panel 2 ---- */
    const gas = folder.addFolder('2 · Poison gas miasma');
    R(gas, c, 'gasRate', 0, 120, 1, 'rate');
    R(gas, c, 'gasDelay', 0, 2, 0.01, 'starts at (s)');
    R(gas, c, 'gasRadius', 0.3, 1.5, 0.01, 'born at (× radius)');
    R(gas, c, 'gasSize', 0.1, 4, 0.05, 'size');
    R(gas, c, 'gasLifetime', 0.3, 8, 0.05, 'lifetime');
    R(gas, c, 'gasSpeed', 0, 4, 0.05, 'seeps out at (m/s)');
    R(gas, c, 'gasRise', -1, 3, 0.05, 'rise');
    R(gas, c, 'gasSwirl', -4, 4, 0.05, 'coil speed');
    R(gas, c, 'gasSwirlExpand', 0, 2, 0.01, 'coil widens by');
    R(gas, c, 'gasOpacity', 0, 1, 0.01, 'opacity');
    R(gas, c, 'gasTurbulence', 0, 3, 0.01, 'turbulence');
    R(gas, c, 'gasBurst', 0, 300, 1, 'gout as the floor breaks');
    Editor.gradient(gas, c, 'colorGas', 'Gas gradient');
    const spores2 = gas.addFolder('The spores');
    R(spores2, c, 'sporeRate', 0, 400, 1, 'spores/s');
    R(spores2, c, 'sporeSize', 0.01, 0.4, 0.005, 'size');
    R(spores2, c, 'sporeLife', 0.2, 8, 0.05, 'life (s)');
    R(spores2, c, 'sporeRise', -2, 4, 0.05, 'lift');
    R(spores2, c, 'sporeGlow', 0, 6, 0.05, 'glow');

    /* ---- panel 3 ---- */
    const crust = folder.addFolder('3 · Ground rupture decal');
    R(crust, c, 'plateReach', 0.5, 1.6, 0.01, 'reach (× radius)');
    R(crust, c, 'plateCells', 8, 120, 1, 'slabs');
    R(crust, c, 'plateDepth', 0.02, 0.4, 0.005, 'slab depth');
    R(crust, c, 'plateRagged', 0, 0.6, 0.01, 'ragged rim');
    R(crust, c, 'plateBias', 0.2, 1, 0.01, 'cell bias');
    R(crust, c, 'plateBreakTime', 0.05, 2, 0.01, 'breaks over (s)');
    R(crust, c, 'plateGap', 0, 0.3, 0.005, 'seam gap');
    R(crust, c, 'plateHeave', 0, 0.4, 0.005, 'heave');
    R(crust, c, 'plateTilt', 0, 1, 0.01, 'tilt (rad)');
    R(crust, c, 'plateRumble', 0, 0.1, 0.001, 'tremor (m)');
    R(crust, c, 'plateWallDark', 0, 1, 0.01, 'wall shade');
    const venom = crust.addFolder('The venom in it');
    R(venom, c, 'seamGlow', 0, 10, 0.05, 'seam light');
    R(venom, c, 'crustCrackScale', 0.3, 8, 0.05, 'cracks per metre');
    R(venom, c, 'crustCrackWidth', 0.005, 0.2, 0.001, 'crack width');
    R(venom, c, 'crustCrackGlow', 0, 8, 0.05, 'crack light');
    R(venom, c, 'crustCrackReach', 0.1, 1, 0.01, 'cracks reach');
    R(venom, c, 'crustStain', 0, 1, 0.01, 'stain');
    venom.addColor(c, 'colorStain').name('stain colour');
    R(venom, c, 'crustPulse', 0, 1, 0.01, 'breath');
    R(venom, c, 'crustPulseSpeed', 0.1, 8, 0.05, 'breath speed');
    const embers = crust.addFolder('The embers');
    R(embers, c, 'crustEmber', 0, 3, 0.01, 'in the cracks');
    R(embers, c, 'crustEmberScale', 1, 30, 0.1, 'embers per metre');
    embers.addColor(c, 'colorEmber').name('ember colour');
    R(embers, c, 'emberRate', 0, 200, 1, 'embers/s lifting');
    R(embers, c, 'emberSize', 0.01, 0.3, 0.005, 'ember size');
    R(embers, c, 'emberLife', 0.2, 5, 0.05, 'ember life (s)');
    R(embers, c, 'emberRise', -2, 5, 0.05, 'ember lift');
    const stone = crust.addFolder('The stone');
    R(stone, c, 'texAmount', 0, 1, 0.01, 'scan amount');
    R(stone, c, 'texScale', 0.3, 8, 0.05, 'scan tile (m)');
    R(stone, c, 'normalScale', 0, 3, 0.01, 'normal strength');
    R(stone, c, 'stoneRough', 0.2, 2, 0.01, 'roughness');
    R(stone, c, 'stoneRoughFloor', 0, 1, 0.01, 'roughness floor');
    R(stone, c, 'stoneAO', 0, 1, 0.01, 'occlusion');
    R(stone, c, 'stoneDesat', 0, 1, 0.01, 'desaturate');
    R(stone, c, 'stoneGrade', 0, 1, 0.01, 'grade');
    stone.addColor(c, 'colorStoneGrade').name('grade colour');
    stone.addColor(c, 'colorStone').name('fallback light');
    stone.addColor(c, 'colorStoneDeep').name('fallback dark');

    /* ---- panel 4 ---- */
    const ring = folder.addFolder('4 · Radial shockwave ring');
    R(ring, c, 'ringReach', 0.5, 4, 0.01, 'reach (× radius)');
    R(ring, c, 'ringTime', 0.1, 4, 0.01, 'runs out over (s)');
    R(ring, c, 'ringWidth', 0.005, 0.15, 0.001, 'thickness');
    R(ring, c, 'ringSpikes', 4, 80, 1, 'flares');
    R(ring, c, 'ringSpikeReach', 0, 40, 0.5, 'flare reach');
    R(ring, c, 'ringIntensity', 0, 5, 0.05, 'intensity');
    R(ring, c, 'pulsePeriod', 0, 6, 0.05, 'pulse every (s)');
    R(ring, c, 'pulseReach', 0.5, 4, 0.01, 'pulse reach (× radius)');
    R(ring, c, 'pulseIntensity', 0, 3, 0.05, 'pulse intensity');

    /* ---- the bodies ---- */
    const bodies = folder.addFolder('The bodies turned to glass');
    const convert = bodies.addFolder('The conversion');
    R(convert, c, 'convertReach', 0.2, 2, 0.01, 'reach (× radius)');
    R(convert, c, 'convertDelay', 0, 2, 0.01, 'first body at (s)');
    R(convert, c, 'convertStagger', 0, 2, 0.01, 'outer bodies later by (s)');
    R(convert, c, 'convertTime', 0.05, 3, 0.01, 'climbs over (s)');
    R(convert, c, 'convertCellWise', 0, 1, 0.01, 'cell by cell');
    R(convert, c, 'convertLead', 0.02, 1, 0.01, 'seams lead by');
    R(convert, c, 'holdTime', 0, 10, 0.05, 'held as glass (s)');
    R(convert, c, 'crackTime', 0.05, 3, 0.01, 'cracks run over (s)');
    R(convert, c, 'bodyCrackWidth', 0.002, 0.08, 0.001, 'crack width (m)');
    R(convert, c, 'crackGlowBody', 0, 10, 0.05, 'crack light');
    const shatter = bodies.addFolder('The shatter');
    R(shatter, c, 'shatterChunks', 4, 48, 1, 'pieces');
    R(shatter, c, 'shatterGap', 0, 0.05, 0.001, 'gap between pieces (m)');
    R(shatter, c, 'shatterSpeed', 0, 10, 0.05, 'thrown at (m/s)');
    R(shatter, c, 'shatterLift', 0, 10, 0.05, 'thrown up (m/s)');
    R(shatter, c, 'shatterOut', 0, 3, 0.01, 'out of the circle');
    R(shatter, c, 'shatterSpin', 0, 25, 0.1, 'tumble (rad/s)');
    R(shatter, c, 'shatterGravity', -30, -2, 0.1, 'gravity');
    R(shatter, c, 'shatterBounce', 0, 0.9, 0.01, 'bounce');
    R(shatter, c, 'shatterFriction', 0, 1, 0.01, 'friction');
    R(shatter, c, 'shatterChips', 0, 500, 1, 'splinters');
    R(shatter, c, 'chipSize', 0.01, 0.3, 0.005, 'splinter size');
    R(shatter, c, 'shatterLight', 0, 200, 1, 'light punch');
    R(shatter, c, 'shatterShake', 0, 1, 0.005, 'shake');
    R(shatter, c, 'breakChips', 0, 400, 1, 'glass off the barrier/s');
    const dissolve = bodies.addFolder('The dissolve');
    R(dissolve, c, 'dissolveDelay', 0, 10, 0.05, 'pieces lie for (s)');
    R(dissolve, c, 'dissolveTime', 0.1, 6, 0.05, 'dissolve over (s)');
    R(dissolve, c, 'dissolveVapour', 0, 80, 1, 'vapour puffs/s');
    const statue = bodies.addFolder('The glass on the body');
    R(statue, c, 'bodySeamWidth', 0.002, 0.05, 0.001, 'lattice width (m)');
    R(statue, c, 'bodySeamGlow', 0, 8, 0.05, 'lattice glow');
    R(statue, c, 'bodySeamSet', 0, 1, 0.01, 'lattice once set');
    R(statue, c, 'bodySwirl', 0, 2, 0.01, 'poison inside');
    R(statue, c, 'bodySwirlScale', 0.5, 12, 0.1, 'poison scale');
    R(statue, c, 'glassGlow', 0, 3, 0.01, 'venom light in it');
    R(statue, c, 'glassRim', 0, 4, 0.01, '...at the graze');
    R(statue, c, 'glassClearcoat', 0, 1, 0.01, 'glass coat');
    R(statue, c, 'glassRough', 0, 1, 0.01, 'roughness');
    R(statue, c, 'glassEnv', 0, 4, 0.05, 'reflections');

    /* ---- what everything is made of ---- */
    const glass = folder.addFolder('The glass');
    glass.addColor(c, 'colorDeep').name('deep');
    glass.addColor(c, 'colorGlass').name('glass');
    glass.addColor(c, 'colorGlow').name('venom light');
    glass.addColor(c, 'colorLattice').name('lattice');
    glass.addColor(c, 'colorVenom').name('bruise');
    R(glass, c, 'envStrength', 0, 3, 0.05, 'reflections');
    R(glass, c, 'sunSpec', 0, 4, 0.05, 'sun highlight');

    const light = folder.addFolder('The light');
    R(light, c, 'lightIntensity', 0, 200, 0.5, 'intensity');
    R(light, c, 'lightRadius', 1, 50, 0.1, 'radius');
    light.addColor(c, 'lightColor').name('colour');

    this.toxicFolder = folder;
  }

  /* ------------------------------------------------------------------ */

  _buildEnvironment() {
    const folder = this.gui.addFolder('Environment');
    const e = settings.environment;
    const R = Editor.range;

    R(folder, e, 'sunIntensity', 0, 8, 0.01, 'key intensity');
    folder.addColor(e, 'sunColor').name('key colour');
    R(folder, e, 'sunAzimuth', 0, Math.PI * 2, 0.01, 'key azimuth');
    R(folder, e, 'sunElevation', 0.05, 1.5, 0.01, 'key elevation');
    R(folder, e, 'ambientIntensity', 0, 3, 0.01, 'ambient');
    folder.addColor(e, 'ambientColor').name('ambient colour');
    R(folder, e, 'hemiIntensity', 0, 3, 0.01, 'hemisphere');
    R(folder, e, 'envIntensity', 0, 3, 0.01, 'env (IBL)');
    R(folder, e, 'shadowRadius', 0, 8, 0.05, 'shadow softness');
    R(folder, e, 'shadowBias', -0.01, 0.001, 0.0001, 'shadow bias');
    R(folder, e, 'contactShadow', 0, 1.5, 0.01, 'contact shadow');

    const rim = folder.addFolder('Rim light');
    R(rim, e, 'rimIntensity', 0, 4, 0.01, 'rim intensity');
    rim.addColor(e, 'rimColor').name('rim colour');
    R(rim, e, 'rimAzimuth', 0, Math.PI * 2, 0.01, 'rim azimuth');
    R(rim, e, 'rimElevation', 0.05, 1.5, 0.01, 'rim elevation');
    rim.addColor(e, 'hemiSkyColor').name('hemi sky');
    rim.addColor(e, 'hemiGroundColor').name('hemi bounce');

    const fog = folder.addFolder('Backdrop, fog & dust');
    fog.addColor(e, 'backgroundColor').name('backdrop');
    fog.add(e, 'fogEnabled').name('fog enabled');
    fog.addColor(e, 'fogColor').name('fog colour');
    // near = where the fog starts, far = where it is total; widening the gap or
    // pushing both out thins the fog, closing it thickens it.
    R(fog, e, 'fogNear', 1, 200, 1, 'fog near');
    R(fog, e, 'fogFar', 10, 400, 1, 'fog far');
    R(fog, e, 'dustAmount', 0, 3, 0.01, 'floating dust');

    const floor = folder.addFolder('Stage floor');
    floor.add(e, 'floorTexture').name('stone tile');
    R(floor, e, 'floorTextureScale', 0.5, 24, 0.1, 'tile size (m)');
    R(floor, e, 'floorNormalScale', 0, 3, 0.01, 'relief strength');
    R(floor, e, 'floorTexTint', 0, 1, 0.01, 'tint toward floor');
    floor.addColor(e, 'floorColor').name('floor colour');
    floor.addColor(e, 'floorTint').name('floor tint');
    R(floor, e, 'floorRoughness', 0.05, 1, 0.01, 'roughness');
    R(floor, e, 'floorSheen', 0, 1, 0.01, 'sheen');
    R(floor, e, 'floorPool', 0, 1, 0.01, 'light pool');
  }

  _buildPost() {
    const folder = this.gui.addFolder('Post processing');
    const p = settings.post;
    const R = Editor.range;

    folder.add(p, 'enabled').name('enabled');
    R(folder, p, 'exposure', 0.1, 3, 0.01, 'exposure');
    R(folder, p, 'bloomStrength', 0, 3, 0.01, 'bloom intensity');
    R(folder, p, 'bloomRadius', 0, 1.5, 0.01, 'bloom radius');
    R(folder, p, 'bloomThreshold', 0, 2, 0.01, 'bloom threshold');
    R(folder, p, 'contrast', 0.5, 2, 0.01, 'contrast');
    R(folder, p, 'saturation', 0, 2.5, 0.01, 'saturation');
    R(folder, p, 'temperature', -0.5, 0.5, 0.01, 'temperature');
    R(folder, p, 'lift', -0.2, 0.2, 0.005, 'lift');
    R(folder, p, 'gain', 0.5, 2, 0.01, 'gain');
    R(folder, p, 'vignette', 0, 1.5, 0.01, 'vignette');
    R(folder, p, 'chromaticAberration', 0, 3, 0.01, 'chromatic aberration');
    R(folder, p, 'grain', 0, 0.2, 0.001, 'film grain');
    R(folder, p, 'distortion', 0, 0.2, 0.001, 'screen warp');
    R(folder, p, 'flashStrength', 0, 2, 0.01, 'impact flash');
  }

  _buildCamera() {
    const folder = this.gui.addFolder('Camera');
    const c = settings.camera;
    const R = Editor.range;

    // The wheel writes `distance` straight into settings, so the slider listens.
    R(folder, c, 'distance', 1, 40, 0.1, 'distance').listen();
    R(folder, c, 'minDistance', 1, 20, 0.1, 'min distance');
    R(folder, c, 'maxDistance', 4, 40, 0.1, 'max distance');
    R(folder, c, 'zoomSpeed', 0.1, 3, 0.01, 'zoom speed');
    R(folder, c, 'fov', 20, 90, 0.5, 'field of view');
    R(folder, c, 'targetHeight', 0, 4, 0.01, 'target height');
    R(folder, c, 'minPolar', 0.05, 1.5, 0.01, 'min pitch');
    R(folder, c, 'maxPolar', 0.2, 1.55, 0.01, 'max pitch');
    R(folder, c, 'damping', 0.001, 0.5, 0.001, 'follow damping');
    R(folder, c, 'autoFrame', 0, 1, 0.01, 'auto framing');

    // Edge panning. `dead zone` is the share of the frame that moves nothing —
    // raise it if the hand is shaky, lower it to start panning sooner.
    const panning = folder.addFolder('Edge panning');
    R(panning, c, 'panDeadZone', 0, 0.95, 0.01, 'dead zone');
    R(panning, c, 'panSpeed', 0, 20, 0.1, 'pan speed');
    R(panning, c, 'panRange', 0, 30, 0.5, 'pan range');
    R(panning, c, 'panRecenter', 0.01, 1, 0.01, 'recentre hold');

    folder.add({ clear: () => this.hooks.onClear?.() }, 'clear').name('Clear effects (C)');
  }

  _buildCharacter() {
    const folder = this.gui.addFolder('Character');
    const c = settings.character;
    const R = Editor.range;

    // The mixer's own rate, so it scales the idle and the cast clips together.
    // The same value as Global → animation speed, mirrored here where it is
    // actually reached for; `listen` keeps the two readouts honest.
    R(folder, settings.global, 'animationSpeed', 0.1, 3, 0.01, 'playback rate').listen();

    // Which clip each ability throws lives in that ability's own folder, under
    // "The cast"; these are the edges of the blend that lays it over the idle.
    const cast = folder.addFolder('Casting');
    R(cast, c, 'castBlendIn', 0.01, 1, 0.01, 'blend into cast');
    R(cast, c, 'castBlendOut', 0.01, 1.5, 0.01, 'blend back to idle');
    cast.add(c, 'turnToAim').name('turn to aim');
    R(cast, c, 'turnRate', 0.000001, 0.02, 0.000001, 'turn follow');

    // The procedural accent that rides on top of the clip. Zero both leans to
    // let the animation carry the cast on its own.
    const lunge = folder.addFolder('Lunge');
    R(lunge, c, 'castLean', 0, 1.2, 0.01, 'lunge lean');
    R(lunge, c, 'castRecoil', 0, 0.8, 0.005, 'lunge recoil');
    R(lunge, c, 'castSettle', 0.2, 8, 0.05, 'lunge settle');
  }

  /**
   * The target dummies and how they fall.
   *
   * Everything here is live: the ring re-populates while you watch, the fall's
   * gravity and stiffness apply to bodies already on the floor, and the blow's
   * numbers apply to the next thing that gets hit. The one exception is
   * `height`, which sizes the model when it is loaded.
   */
  _buildDummies() {
    const folder = this.gui.addFolder('Target dummies');
    const d = settings.dummies;
    const R = Editor.range;

    folder.add(d, 'enabled').name('enabled');
    R(folder, d, 'count', 0, 16, 1, 'how many');

    const ring = folder.addFolder('Where they stand');
    R(ring, d, 'radius', 4, 40, 0.5, 'ring radius');
    R(ring, d, 'minRadius', 1, 20, 0.5, 'no nearer than');
    R(ring, d, 'separation', 0.5, 6, 0.1, 'apart, metres');
    ring.add(d, 'watch').name('turn to watch');
    R(ring, d, 'turnRate', 0.000001, 0.5, 0.000001, 'turn follow');

    // What a cast has to cover to knock one down, and how hard it throws it.
    const hit = folder.addFolder('The blow');
    hit.add(d.hit, 'enabled').name('abilities kill');
    R(hit, d.hit, 'radius', 0.2, 6, 0.05, 'line reach, metres');
    R(hit, d.hit, 'zoneScale', 0.2, 2.5, 0.05, 'far-cast footprint');
    R(hit, d, 'bodyRadius', 0.1, 1.5, 0.02, 'body radius');
    R(hit, d.hit, 'impulse', 0, 30, 0.1, 'impulse');
    R(hit, d.hit, 'lift', 0, 16, 0.1, 'lift');
    R(hit, d.hit, 'spin', -3, 4, 0.05, 'spin (torque)');

    const fall = folder.addFolder('The fall');
    R(fall, d.ragdoll, 'gravity', -60, -2, 0.5, 'gravity');
    R(fall, d.ragdoll, 'damping', 0, 0.6, 0.005, 'air drag');
    R(fall, d.ragdoll, 'iterations', 1, 16, 1, 'solver passes');
    R(fall, d.ragdoll, 'brace', 0, 1, 0.01, 'torso stiffness');
    R(fall, d.ragdoll, 'radius', 0.01, 0.4, 0.005, 'joint radius');
    R(fall, d.ragdoll, 'friction', 0, 1, 0.01, 'ground friction');
    R(fall, d.ragdoll, 'bounce', 0, 0.8, 0.01, 'ground bounce');
    R(fall, d.ragdoll, 'sleep', 0.001, 0.5, 0.001, 'sleep threshold');

    const corpse = folder.addFolder('Corpse & respawn');
    R(corpse, d, 'corpseTime', 0, 20, 0.1, 'lies there, seconds');
    R(corpse, d, 'dissolveTime', 0.1, 6, 0.05, 'burns away, seconds');
    R(corpse, d, 'respawnDelay', 0, 15, 0.1, 'respawn delay');

    const look = folder.addFolder('The look');
    look.addColor(d.look, 'color').name('body');
    R(look, d.look, 'roughness', 0, 1, 0.01, 'roughness');
    R(look, d.look, 'metalness', 0, 1, 0.01, 'metalness');
    look.addColor(d.look, 'rimColor').name('rim');
    R(look, d.look, 'rimPower', 0.5, 8, 0.05, 'rim tightness');
    R(look, d.look, 'rimEmissive', 0, 6, 0.05, 'rim strength');
    look.addColor(d.look, 'edgeColor').name('burn edge');
    R(look, d.look, 'edgeEmissive', 0, 20, 0.1, 'burn glow');
    R(look, d.look, 'edgeWidth', 0.01, 0.5, 0.005, 'burn width');
    R(look, d.look, 'dissolveDetail', 1, 30, 0.5, 'burn detail');
  }

  dispose() {
    this.gui.destroy();
  }
}
