import { ELEMENT_META } from '../config/settings.js';
import { ELEMENT_SIGILS } from './glyphs.js';
import { GESTURE_GLYPHS, gestureGuide, gestureTitle } from './gestures.js';
import { PHONE_PAIRING_MARKUP, PhonePairing } from './PhonePairing.js';

/**
 * The camera-mode readout: a mirrored preview with the tracked skeleton drawn
 * over it, a wake ring, a grab meter, and under them the gesture guide for
 * whatever is in the slot.
 *
 * The skeleton is not decoration. On a stage the audience cannot tell a working
 * tracker from a lucky one, and neither can the presenter — when a cast does
 * not fire, the twenty-one dots are the only thing that says whether the model
 * lost the hand or the pose simply was not read as a fist. It is the debugger
 * and the party trick at once, which is why it is on by default.
 *
 * The guide is the same idea one level up. A fist means four different things
 * across the bar — cast along the arrow, drop the circle, deploy the drone,
 * hold its fire — so under the preview the panel lays out the hand shapes the
 * *current* ability answers to, a tile for each with the hand drawn large and
 * a line of what it does, and rebuilds them whenever the slot or the summon's
 * state changes. The tile of the gesture the tracker is reading right now
 * lights up in the engaged green: the presenter sees the pose land before the
 * ability answers it.
 *
 * The preview is mirrored, because an un-mirrored self view is unusable — you
 * move left and the hand on screen goes right. Everything drawn on top has to
 * be mirrored with it, hence the flipped x below.
 *
 * Under the meter sits the phone pairing (`PhonePairing.js`): the way to use
 * a phone's camera instead of the webcam, for a machine that has none or a
 * bad one. It is part of this panel because it is part of camera mode — the
 * preview, the skeleton and the guide are the same whichever camera feeds
 * them.
 */

/** Bones, as index pairs into the 21 landmarks. */
const BONES = [
  // palm
  [0, 1], [0, 5], [0, 17], [5, 9], [9, 13], [13, 17],
  // thumb
  [1, 2], [2, 3], [3, 4],
  // index
  [5, 6], [6, 7], [7, 8],
  // middle
  [9, 10], [10, 11], [11, 12],
  // ring
  [13, 14], [14, 15], [15, 16],
  // pinky
  [17, 18], [18, 19], [19, 20]
];

/**
 * How long the "lower your hand" tile stays lit after the hand has gone. The
 * pose is an absence, so it has nothing to hold the light on; a short flash
 * is what says "that was read as a cancel".
 */
const LOST_FLASH_MS = 1200;

const MARKUP = `
  <div class="hud__camera" data-camera>
    <div class="camera__frame">
      <div class="camera__video" data-camera-video></div>
      <canvas class="camera__overlay" data-camera-overlay width="320" height="240"></canvas>
      <div class="camera__wake" data-camera-wake></div>
    </div>
    <div class="camera__readout">
      <div class="camera__row">
        <span class="camera__label" data-camera-status>Starting camera…</span>
        <span class="camera__slot" data-camera-slot></span>
      </div>
      <div class="camera__meter"><i data-camera-grab></i></div>
      ${PHONE_PAIRING_MARKUP}
      <div class="camera__guide" data-camera-guide>
        <div class="guide__head">
          <span class="guide__sigil" data-guide-sigil></span>
          <span class="guide__title" data-guide-title></span>
          <kbd class="guide__key" data-guide-key></kbd>
        </div>
        <div class="guide__kind" data-guide-kind></div>
        <div class="guide__rows" data-guide-rows></div>
      </div>
    </div>
  </div>
`;

export { MARKUP as CAMERA_MARKUP };

export class CameraPanel {
  constructor(root) {
    this.element = root.querySelector('[data-camera]');
    this.videoSlot = root.querySelector('[data-camera-video]');
    this.canvas = root.querySelector('[data-camera-overlay]');
    this.ctx = this.canvas.getContext('2d');
    this.wake = root.querySelector('[data-camera-wake]');
    this.status = root.querySelector('[data-camera-status]');
    this.slot = root.querySelector('[data-camera-slot]');
    this.grab = root.querySelector('[data-camera-grab]');

    this.guide = root.querySelector('[data-camera-guide]');
    this.guideSigil = root.querySelector('[data-guide-sigil]');
    this.guideTitle = root.querySelector('[data-guide-title]');
    this.guideKey = root.querySelector('[data-guide-key]');
    this.guideKind = root.querySelector('[data-guide-kind]');
    this.guideRows = root.querySelector('[data-guide-rows]');

    this.phone = new PhonePairing(this.element);

    this._statusShown = '';
    this._slotShown = '';
    this._grabShown = -1;

    /** What the guide was last built for, so a frame that changes nothing costs nothing. */
    this._guideKey = '';
    /** Tiles by the tracker reading that lights them, for `_highlight`. */
    this._liveRows = new Map();
    /** The two point icons, by direction, so only the one being read lights. */
    this._pointIcons = { '-1': null, '1': null };
    this._litShown = new Set();
    this._pointDirShown = 0;
    this._wasEngaged = false;
    this._lostFlashUntil = 0;

    this._dragPointer = null;
    this._dragOffset = { x: 0, y: 0 };
    this._bindDrag();
  }

  /**
   * The panel can be dragged anywhere on screen. It starts anchored to the
   * bottom-right corner via CSS; the first drag converts that to an explicit
   * left/top so the CSS anchor no longer fights the pointer. The position is
   * kept within the viewport on release so the panel cannot be lost off-screen.
   */
  _bindDrag() {
    const el = this.element;

    el.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
      if (this._dragPointer !== null || event.button !== 0) return;
      // A press on a control is a click, not the start of a drag — capturing
      // the pointer here would steal the click from the button.
      if (event.target.closest('button, a, input')) return;
      this._dragPointer = event.pointerId;
      const rect = el.getBoundingClientRect();
      this._dragOffset.x = event.clientX - rect.left;
      this._dragOffset.y = event.clientY - rect.top;
      el.setPointerCapture(event.pointerId);
      el.classList.add('is-dragging');
      this._place(rect.left, rect.top);
    });

    el.addEventListener('pointermove', (event) => {
      if (event.pointerId !== this._dragPointer) return;
      event.stopPropagation();
      this._place(event.clientX - this._dragOffset.x, event.clientY - this._dragOffset.y);
    });

    const release = (event) => {
      if (event.pointerId !== this._dragPointer) return;
      event.stopPropagation();
      this._dragPointer = null;
      el.classList.remove('is-dragging');
      this._clamp();
    };
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);

    window.addEventListener('resize', () => {
      if (el.classList.contains('is-placed')) this._clamp();
    });
  }

  _place(x, y) {
    const el = this.element;
    el.classList.add('is-placed');
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }

  _clamp() {
    const el = this.element;
    const rect = el.getBoundingClientRect();
    const x = Math.min(Math.max(0, rect.left), Math.max(0, window.innerWidth - rect.width));
    const y = Math.min(Math.max(0, rect.top), Math.max(0, window.innerHeight - rect.height));
    this._place(x, y);
  }

  setVisible(on) {
    this.element.classList.toggle('is-visible', on);
    if (!on) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Adopt the tracker's video element rather than opening a second stream. */
  attach(video) {
    if (!video || video.parentElement === this.videoSlot) return;
    this.videoSlot.replaceChildren(video);
  }

  setStatus(text) {
    if (text === this._statusShown) return;
    this._statusShown = text;
    this.status.textContent = text;
  }

  /**
   * @param {object} state  the tracker's snapshot
   * @param {object|null} result  its newest raw inference, for the skeleton
   * @param {object} [context]
   * @param {string} [context.element]  id of the ability in the slot
   * @param {boolean} [context.deployed] a summon is out and holding the bar,
   *   so the slot's gestures are its controls rather than a cast's
   * @param {string|null} [context.status] what to say instead of "Aiming" —
   *   a summon, when it is out, is driven rather than aimed
   */
  update(state, result, { element = '', deployed = false, status = null } = {}) {
    this.element.classList.toggle('is-engaged', state.engaged);

    if (!state.ready) {
      // Still opening the device or loading the model: the line App set
      // ("Starting camera…") stands until there is a tracker to report on.
    } else if (!state.engaged) {
      this.setStatus(state.aimSeen ? 'Hold your palm open to engage' : 'Show your casting hand');
    } else if (state.pointing) {
      this.setStatus(status ? 'Recalling…' : state.pointing > 0 ? 'Next ability →' : '← Previous ability');
    } else {
      this.setStatus(status ?? 'Aiming');
    }

    const slotLabel = ELEMENT_META[element]?.key ?? '';
    if (slotLabel !== this._slotShown) {
      this._slotShown = slotLabel;
      this.slot.textContent = slotLabel;
    }

    // The wake ring doubles as the grab meter once engaged: before engaging it
    // fills over the hold, after it tracks how closed the hand is. One control,
    // two phases, and the presenter only ever watches one thing.
    const fill = state.engaged ? state.grab : state.wake;
    if (Math.abs(fill - this._grabShown) > 0.01) {
      this._grabShown = fill;
      this.wake.style.setProperty('--fill', fill);
      this.grab.style.transform = `scaleX(${fill})`;
    }

    this._syncGuide(element, deployed);
    this._highlight(state);
    this._drawSkeleton(result);
  }

  /* ------------------------------------------------------------------ */
  /* The gesture guide                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Rebuild the guide when the slot or the summon's state has changed, and
   * only then — this runs every frame, and the DOM it would build is the
   * same one it built last frame almost every time.
   */
  _syncGuide(element, deployed) {
    if (!element) return;
    const key = `${element}:${deployed ? 1 : 0}`;
    if (key === this._guideKey) return;
    this._guideKey = key;

    const { label, key: slotKey, accent } = gestureTitle(element);
    const { kind, rows } = gestureGuide(element, { deployed });

    this.guide.style.setProperty('--guide-accent', accent);
    this.guideSigil.innerHTML = ELEMENT_SIGILS[element] ?? '';
    this.guideTitle.textContent = label;
    this.guideKey.textContent = slotKey;
    this.guideKind.textContent = kind;

    this._liveRows.clear();
    this._pointIcons['-1'] = null;
    this._pointIcons['1'] = null;
    this._litShown.clear();
    this._pointDirShown = 0;

    // Tiles wrap three to a line; the count picks how the last line fills.
    this.guideRows.dataset.count = rows.length;
    this.guideRows.innerHTML = rows
      .map(
        (row, i) => `
          <div class="gesture" data-live="${row.live}" style="--i:${i}">
            <span class="gesture__icons">
              ${row.icons.map((icon) => `<span class="gesture__icon" data-icon="${icon}">${GESTURE_GLYPHS[icon] ?? ''}</span>`).join('')}
            </span>
            <b class="gesture__name">${row.name}</b>
            ${row.hand ? `<i class="gesture__hand">other hand</i>` : ''}
            <span class="gesture__does">${row.does}</span>
          </div>`
      )
      .join('');

    for (const el of this.guideRows.querySelectorAll('.gesture')) {
      this._liveRows.set(el.dataset.live, el);
    }
    this._pointIcons['-1'] = this.guideRows.querySelector('[data-icon="prev"]');
    this._pointIcons['1'] = this.guideRows.querySelector('[data-icon="next"]');

    // Replay the entrance so a slot change is seen as one, not as tiles that
    // silently swapped under the eye. Removing and re-adding the class in the
    // same frame would coalesce, hence the forced reflow between.
    this.guide.classList.remove('is-fresh');
    void this.guide.offsetWidth;
    this.guide.classList.add('is-fresh');
  }

  /**
   * Light the tiles of the gestures the tracker is reading this frame.
   *
   * Each reading is judged on its own — the select hand can be pointing while
   * the aim hand holds a fist — so more than one tile can be lit at once. Only
   * the tiles whose state actually changed touch the DOM.
   */
  _highlight(state) {
    const now = performance.now();

    // The hand going away is the one gesture with no pose to hold the light on,
    // so it is lit on the transition and for a moment after.
    if (this._wasEngaged && !state.engaged && !state.aimSeen) this._lostFlashUntil = now + LOST_FLASH_MS;
    this._wasEngaged = state.engaged;

    const lit = {
      wake: !state.engaged && state.aimSeen,
      aim: state.engaged && state.aimSeen && !state.grabbing,
      grab: state.grabbing,
      point: state.pointing !== 0,
      lost: now < this._lostFlashUntil
    };

    for (const [live, el] of this._liveRows) {
      const on = !!lit[live];
      if (on === this._litShown.has(live)) continue;
      if (on) this._litShown.add(live);
      else this._litShown.delete(live);
      el.classList.toggle('is-live', on);
    }

    // The point tile carries both directions; only the one being read lights.
    const dir = lit.point ? state.pointing : 0;
    if (dir !== this._pointDirShown) {
      this._pointIcons[String(this._pointDirShown)]?.classList.remove('is-live');
      this._pointIcons[String(dir)]?.classList.add('is-live');
      this._pointDirShown = dir;
    }
  }

  _drawSkeleton(result) {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const hands = result?.landmarks;
    if (!hands?.length) return;

    // The preview is `object-fit: cover`, and the phone's frame is rarely the
    // webcam's 4:3 — a portrait feed is cropped top and bottom. The landmarks
    // are normalised to the *frame*, so they go through the same fit, or the
    // dots would float off the fingers whenever the aspect differs.
    const video = this.videoSlot.firstElementChild;
    const vw = video?.videoWidth || w;
    const vh = video?.videoHeight || h;
    const scale = Math.max(w / vw, h / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const ox = (w - dw) / 2;
    const oy = (h - dh) / 2;

    for (const landmarks of hands) {
      // Mirrored to match the preview underneath.
      const px = (p) => ox + (1 - p.x) * dw;
      const py = (p) => oy + p.y * dh;

      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(127, 214, 255, 0.75)';
      ctx.beginPath();
      for (const [a, b] of BONES) {
        ctx.moveTo(px(landmarks[a]), py(landmarks[a]));
        ctx.lineTo(px(landmarks[b]), py(landmarks[b]));
      }
      ctx.stroke();

      ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
      for (const p of landmarks) {
        ctx.beginPath();
        ctx.arc(px(p), py(p), 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
