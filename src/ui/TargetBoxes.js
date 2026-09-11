import { Vector3 } from 'three';
import { settings } from '../config/settings.js';

/**
 * Detection boxes: the summon's target list, drawn on the glass.
 *
 * Every body standing inside the drone's or the bot's ring gets a bracketed
 * box fitted to it on screen — the reading a detector gives, corner brackets
 * with a label tab — so the operator sees what the construct sees. The one it
 * has chosen tightens: the brackets close on the body as the lock builds, the
 * tab counts the lock up, and the whole thing goes red and strobes while the
 * burst is going out. A body that drops keeps its box for a beat, marked
 * DOWN, and fades.
 *
 * Plain DOM, one element per box, pooled. The box is positioned with a
 * `transform` and sized directly, and nothing else about it is touched unless
 * it changed — the tab text and the state attribute are compared before they
 * are written — so six boxes tracking six bodies cost six transforms a frame.
 *
 * The screen rectangle is the body's hit cylinder (`settings.dummies.height`
 * by `bodyRadius`) projected through the camera: eight corners, min and max.
 * That is the same cylinder the summon measures range against, so the box
 * frames exactly what the construct is counting.
 *
 * Track numbers (`TGT-07`) are handed out as bodies are first seen and given
 * back when the box is released, so a body that walks out of the ring and
 * back in is a new contact — which is what a detector would say.
 */

const MARKUP = `<div class="target-layer" data-target-layer></div>`;

export { MARKUP as TARGET_LAYER_MARKUP };

/** Seconds a downed body's box lingers before it is released. */
const DOWN_HOLD = 0.75;
/** Seconds the brackets take to close in from their entrance onto the body. */
const ACQUIRE_TIME = 0.22;
/** Screen padding around the body while it is only detected, CSS px. */
const PAD_DETECTED = 9;
/** Extra padding the brackets start at when a box first appears. */
const PAD_ENTRANCE = 18;
/** Below this, the brackets would overlap and the box reads as a smudge. */
const MIN_WIDTH = 30;
const MIN_HEIGHT = 44;
/** Highest track number handed out before they wrap. */
const TRACK_WRAP = 99;

const _corner = new Vector3();

export class TargetBoxes {
  constructor(root) {
    this.layer = root.querySelector('[data-target-layer]');
    /** Every box ever built; released ones stay hidden and are reused. */
    this._pool = [];
    /** Boxes in use, keyed by the body they frame. */
    this._live = new Map();
    this._nextTrack = 1;
    this._colorsShown = '';
  }

  /** Release every box. Called while nothing is out, so it is cheap to spam. */
  clear() {
    if (!this._live.size) return;
    for (const box of this._live.values()) this._release(box);
    this._live.clear();
  }

  /**
   * One frame of tracking.
   *
   * @param {number} dt real seconds
   * @param {import('three').Camera} camera whose matrices the last render used
   * @param {{targets: import('../combat/Dummy.js').Dummy[], mark: object|null,
   *          lock: number, position: import('three').Vector3}} summon
   *   The construct doing the looking: who it has in range, who it has
   *   chosen, how far the lock has come, and where the range is measured from.
   * @param {{colorReticle: string, colorLocked: string}} config
   *   The summon's settings, for the colours the reticle on the floor uses.
   */
  update(dt, camera, summon, config) {
    this._syncColors(config);

    const targets = summon.targets;
    const mark = summon.mark;

    // Everyone in range gets a box, and keeps the one they have.
    for (let i = 0; i < targets.length; i++) {
      const dummy = targets[i];
      let box = this._live.get(dummy);
      if (!box) {
        box = this._acquire(dummy);
        this._live.set(dummy, box);
      }
      box.seen = true;
    }

    const width = window.innerWidth;
    const height = window.innerHeight;
    const bodyHeight = settings.dummies.height;
    const bodyRadius = settings.dummies.bodyRadius;

    for (const [dummy, box] of this._live) {
      box.age += dt;

      if (!box.seen) {
        // Out of the list. Down is a story worth a beat; merely out of range
        // is not — the box lets go at once.
        if (box.state !== 'down') {
          if (dummy.alive) {
            this._release(box);
            this._live.delete(dummy);
            continue;
          }
          this._setState(box, 'down', 'DOWN');
          box.downFor = 0;
        }
        box.downFor += dt;
        if (box.downFor >= DOWN_HOLD) {
          this._release(box);
          this._live.delete(dummy);
          continue;
        }
        box.el.style.opacity = String(Math.max(0, 1 - box.downFor / DOWN_HOLD));
        continue;
      }
      box.seen = false;

      // Which reading it is this frame, and how tight the brackets sit.
      let pad = PAD_DETECTED;
      if (dummy === mark) {
        const lock = Math.min(1, Math.max(0, summon.lock));
        if (lock >= 1) {
          this._setState(box, 'firing', 'FIRING');
          pad = 0;
        } else {
          this._setState(box, 'locking', 'LOCK ' + String(Math.round(lock * 100)).padStart(2, '0') + '%');
          pad = PAD_DETECTED * (1 - lock);
        }
      } else {
        this._setState(box, 'detected', 'TARGET');
      }
      // The entrance: the brackets come in from wide and settle on the body.
      const acquire = Math.min(1, box.age / ACQUIRE_TIME);
      pad += PAD_ENTRANCE * (1 - acquire) * (1 - acquire);

      if (!this._project(box, camera, dummy.position, bodyHeight, bodyRadius, width, height)) {
        if (!box.el.hidden) box.el.hidden = true;
        continue;
      }
      if (box.el.hidden) box.el.hidden = false;

      // Fit, pad, and hold a floor so the brackets never meet.
      let w = box.x1 - box.x0 + pad * 2;
      let h = box.y1 - box.y0 + pad * 2;
      const cx = (box.x0 + box.x1) * 0.5;
      const cy = (box.y0 + box.y1) * 0.5;
      w = Math.max(MIN_WIDTH, w);
      h = Math.max(MIN_HEIGHT, h);
      const x = Math.round(cx - w * 0.5);
      const y = Math.round(cy - h * 0.5);
      w = Math.round(w);
      h = Math.round(h);

      const style = box.el.style;
      style.transform = `translate3d(${x}px, ${y}px, 0)`;
      if (w !== box.w) {
        box.w = w;
        style.width = w + 'px';
      }
      if (h !== box.h) {
        box.h = h;
        style.height = h + 'px';
      }

      // Range, flat, from where the construct measures it. A tenth of a metre
      // is enough resolution to read as live without flickering every frame.
      const dx = dummy.position.x - summon.position.x;
      const dz = dummy.position.z - summon.position.z;
      const range = (Math.hypot(dx, dz)).toFixed(1) + 'M';
      if (range !== box.rangeShown) {
        box.rangeShown = range;
        box.range.textContent = range;
      }
    }
  }

  /**
   * The body's cylinder on screen. Writes `x0, y0, x1, y1` into the box and
   * returns false if any corner is behind the camera or the whole box is off
   * the glass.
   */
  _project(box, camera, position, bodyHeight, bodyRadius, width, height) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < 8; i++) {
      _corner.set(
        position.x + (i & 1 ? bodyRadius : -bodyRadius),
        position.y + (i & 2 ? bodyHeight : 0),
        position.z + (i & 4 ? bodyRadius : -bodyRadius)
      );
      _corner.applyMatrix4(camera.matrixWorldInverse);
      // The camera looks down -z; a corner at or past the eye has no screen point.
      if (_corner.z > -camera.near) return false;
      _corner.applyMatrix4(camera.projectionMatrix);
      const sx = (_corner.x * 0.5 + 0.5) * width;
      const sy = (0.5 - _corner.y * 0.5) * height;
      if (sx < x0) x0 = sx;
      if (sx > x1) x1 = sx;
      if (sy < y0) y0 = sy;
      if (sy > y1) y1 = sy;
    }
    if (x1 < 0 || y1 < 0 || x0 > width || y0 > height) return false;
    box.x0 = x0;
    box.y0 = y0;
    box.x1 = x1;
    box.y1 = y1;
    return true;
  }

  _setState(box, state, word) {
    if (box.state !== state) {
      // A body that was fading out and stood back up (a reset) is whole again.
      if (box.state === 'down') box.el.style.opacity = '';
      box.state = state;
      box.el.dataset.state = state;
    }
    if (box.wordShown !== word) {
      box.wordShown = word;
      box.word.textContent = word;
    }
  }

  /** A box for a body: a pooled element, or a fresh one, with a new track number. */
  _acquire(dummy) {
    let box = this._pool.find((candidate) => !candidate.used);
    if (!box) {
      box = this._build();
      this._pool.push(box);
    }
    box.used = true;
    box.seen = false;
    box.age = 0;
    box.downFor = 0;
    box.state = '';
    box.wordShown = '';
    box.rangeShown = '';
    box.w = -1;
    box.h = -1;
    box.dummy = dummy;

    const track = this._nextTrack;
    this._nextTrack = track >= TRACK_WRAP ? 1 : track + 1;
    box.id.textContent = 'TGT-' + String(track).padStart(2, '0');

    box.el.style.opacity = '';
    box.el.hidden = true;
    return box;
  }

  _release(box) {
    box.used = false;
    box.dummy = null;
    box.el.hidden = true;
  }

  _build() {
    const el = document.createElement('div');
    el.className = 'tgt';
    el.hidden = true;
    el.innerHTML = `
      <div class="tgt__tag"><span class="tgt__id" data-id></span><span class="tgt__word" data-word></span></div>
      <div class="tgt__rng" data-rng></div>
      <i class="tgt__x"></i>
    `;
    this.layer.appendChild(el);
    return {
      el,
      id: el.querySelector('[data-id]'),
      word: el.querySelector('[data-word]'),
      range: el.querySelector('[data-rng]'),
      used: false,
      seen: false,
      dummy: null,
      state: '',
      wordShown: '',
      rangeShown: '',
      age: 0,
      downFor: 0,
      x0: 0,
      y0: 0,
      x1: 0,
      y1: 0,
      w: -1,
      h: -1
    };
  }

  /** The lock and fire colours follow the reticle's, so the editor moves both. */
  _syncColors(config) {
    const key = config.colorReticle + '|' + config.colorLocked;
    if (key === this._colorsShown) return;
    this._colorsShown = key;
    this.layer.style.setProperty('--tgt-lock', config.colorReticle);
    this.layer.style.setProperty('--tgt-fire', config.colorLocked);
  }
}
