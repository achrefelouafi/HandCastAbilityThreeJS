/**
 * The camera-mode readout: a mirrored preview with the tracked skeleton drawn
 * over it, a wake ring and a grab meter.
 *
 * The skeleton is not decoration. On a stage the audience cannot tell a working
 * tracker from a lucky one, and neither can the presenter — when a cast does
 * not fire, the twenty-one dots are the only thing that says whether the model
 * lost the hand or the pose simply was not read as a fist. It is the debugger
 * and the party trick at once, which is why it is on by default.
 *
 * The preview is mirrored, because an un-mirrored self view is unusable — you
 * move left and the hand on screen goes right. Everything drawn on top has to
 * be mirrored with it, hence the flipped x below.
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
      <div class="camera__hint">
        Palm open to aim, fist to cast.
        Other hand: point <b>&rarr;</b> next ability, <b>&larr;</b> previous.
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

    this._statusShown = '';
    this._slotShown = '';
    this._grabShown = -1;

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
   * @param {string} [slotLabel] key of the ability currently in the slot
   * @param {string|null} [engagedStatus] what to say instead of "Aiming" —
   *   a summon, when it is out, is driven rather than aimed
   */
  update(state, result, slotLabel = '', engagedStatus = null) {
    this.element.classList.toggle('is-engaged', state.engaged);

    if (!state.engaged) {
      this.setStatus(state.aimSeen ? 'Hold your palm open to engage' : 'Show your casting hand');
    } else if (state.pointing) {
      this.setStatus(engagedStatus ? 'Recalling…' : state.pointing > 0 ? 'Next ability →' : '← Previous ability');
    } else {
      this.setStatus(engagedStatus ?? 'Aiming');
    }

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

    this._drawSkeleton(result);
  }

  _drawSkeleton(result) {
    const { ctx, canvas } = this;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const hands = result?.landmarks;
    if (!hands?.length) return;

    for (const landmarks of hands) {
      // Mirrored to match the preview underneath.
      const px = (p) => (1 - p.x) * w;
      const py = (p) => p.y * h;

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
