import { EventEmitter } from '../utils/EventEmitter.js';

/**
 * The summon's control deck: a thumbstick and a fire button, the way a phone
 * game does it.
 *
 * Shown only while a summon is deployed — the drone or the monowheel bot,
 * one deck between them. The stick is a velocity, not a position — drag it
 * and the construct moves that way for as long as it is held, let go and it
 * holds — because that is the one control scheme every person in the room
 * has already used. The fire button is hold-to-fire, so the same finger that
 * closes on it is the fist that closes in camera mode.
 *
 * Emits `steer` (x, y — each -1..1, +y is up the screen) and `fire` (boolean).
 * Nothing here knows what a drone is; `App` wires the events to the ability
 * and tells the deck what to call itself (`setLabel`).
 *
 * Pointer events are captured on the pad, so a drag that leaves the pad keeps
 * driving, and a finger lifted anywhere lets go.
 */

const MARKUP = `
  <div class="drone-deck" data-drone-deck>
    <div class="drone-deck__status" data-drone-status>
      <span class="drone-deck__badge" data-drone-badge>DRONE</span>
      <span data-drone-line>Deploying…</span>
    </div>
    <div class="drone-stick" data-drone-stick>
      <div class="drone-stick__ring"></div>
      <div class="drone-stick__cross"></div>
      <div class="drone-stick__knob" data-drone-knob></div>
      <div class="drone-stick__label">FLY</div>
    </div>
    <div class="drone-fire" data-drone-fire>
      <div class="drone-fire__core"></div>
      <div class="drone-fire__label">FIRE</div>
    </div>
    <div class="drone-deck__hint">
      <b>WASD</b> <span data-drone-verb>fly</span> · <b>Space</b> / <b>hold click</b> fire · <b data-drone-key>U</b> recall
    </div>
  </div>
`;

export { MARKUP as DRONE_DECK_MARKUP };

export class DroneControls extends EventEmitter {
  constructor(root) {
    super();
    this.element = root.querySelector('[data-drone-deck]');
    this.stick = root.querySelector('[data-drone-stick]');
    this.knob = root.querySelector('[data-drone-knob]');
    this.fire = root.querySelector('[data-drone-fire]');
    this.line = root.querySelector('[data-drone-line]');
    this.status = root.querySelector('[data-drone-status]');
    this.badge = root.querySelector('[data-drone-badge]');
    this.verb = root.querySelector('[data-drone-verb]');
    this.key = root.querySelector('[data-drone-key]');

    this._stickPointer = null;
    this._firePointer = null;
    this._x = 0;
    this._y = 0;
    this._lineShown = '';
    this._hotShown = null;

    this._bind();
  }

  _bind() {
    const stop = (event) => event.stopPropagation();

    this.stick.addEventListener('pointerdown', (event) => {
      stop(event);
      if (this._stickPointer !== null) return;
      this._stickPointer = event.pointerId;
      this.stick.setPointerCapture(event.pointerId);
      this.stick.classList.add('is-held');
      this._drag(event);
    });
    this.stick.addEventListener('pointermove', (event) => {
      if (event.pointerId !== this._stickPointer) return;
      stop(event);
      this._drag(event);
    });
    const release = (event) => {
      if (event.pointerId !== this._stickPointer) return;
      stop(event);
      this._stickPointer = null;
      this.stick.classList.remove('is-held');
      this._set(0, 0);
    };
    this.stick.addEventListener('pointerup', release);
    this.stick.addEventListener('pointercancel', release);
    this.stick.addEventListener('lostpointercapture', release);

    this.fire.addEventListener('pointerdown', (event) => {
      stop(event);
      if (this._firePointer !== null) return;
      this._firePointer = event.pointerId;
      this.fire.setPointerCapture(event.pointerId);
      this.fire.classList.add('is-held');
      this.emit('fire', true);
    });
    const fireUp = (event) => {
      if (event.pointerId !== this._firePointer) return;
      stop(event);
      this._firePointer = null;
      this.fire.classList.remove('is-held');
      this.emit('fire', false);
    };
    this.fire.addEventListener('pointerup', fireUp);
    this.fire.addEventListener('pointercancel', fireUp);
    this.fire.addEventListener('lostpointercapture', fireUp);

    // A stick that fired the ability behind it would be a bad stick.
    for (const el of [this.stick, this.fire, this.status]) {
      el.addEventListener('contextmenu', (event) => event.preventDefault());
    }
  }

  _drag(event) {
    const rect = this.stick.getBoundingClientRect();
    const radius = rect.width * 0.5;
    const cx = rect.left + radius;
    const cy = rect.top + radius;
    // The knob's throw is the pad's radius less the knob's own, so the knob
    // never leaves the ring.
    const throwPx = Math.max(1, radius - this.knob.offsetWidth * 0.5);
    let dx = (event.clientX - cx) / throwPx;
    let dy = (event.clientY - cy) / throwPx;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    this._set(dx, -dy);
  }

  _set(x, y) {
    this._x = x;
    this._y = y;
    const throwPx = Math.max(1, this.stick.clientWidth * 0.5 - this.knob.offsetWidth * 0.5);
    this.knob.style.transform = `translate(${x * throwPx}px, ${-y * throwPx}px)`;
    this.emit('steer', x, y);
  }

  /**
   * Which construct the deck is driving: the badge, the recall key, and the
   * verb the hint uses for the stick.
   * @param {string} badge
   * @param {string} key
   * @param {string} [verb]
   */
  setLabel(badge, key, verb = 'fly') {
    this.badge.textContent = badge;
    this.key.textContent = key;
    this.verb.textContent = verb;
  }

  /** Whether the pad is currently being dragged. */
  get held() {
    return this._stickPointer !== null;
  }

  setVisible(on) {
    this.element.classList.toggle('is-visible', on);
    if (!on) {
      this._stickPointer = null;
      this._firePointer = null;
      this.stick.classList.remove('is-held');
      this.fire.classList.remove('is-held');
      this.knob.style.transform = '';
      this._x = 0;
      this._y = 0;
    }
  }

  /**
   * One line of status, and whether the deck is running hot.
   * @param {string} text
   * @param {boolean} hot firing
   */
  setStatus(text, hot) {
    if (text !== this._lineShown) {
      this._lineShown = text;
      this.line.textContent = text;
    }
    if (hot !== this._hotShown) {
      this._hotShown = hot;
      this.element.classList.toggle('is-hot', hot);
    }
  }
}
