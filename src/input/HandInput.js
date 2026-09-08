import { Vector2 } from 'three';
import { EventEmitter } from '../utils/EventEmitter.js';
import { OneEuroVec2 } from '../utils/OneEuro.js';

/**
 * Webcam hand tracking as a second source of the same input vocabulary.
 *
 * This class emits exactly what `InputManager` emits — `pointer:move`,
 * `pointer:confirm`, `action` — so `App` subscribes it to the same three
 * handlers and nothing downstream of the bus knows the difference. The aim
 * controller, the ability manager and the HUD are untouched. The keyboard stays
 * live the whole time: camera mode is an addition, never a mode switch, because
 * on a stage the fallback has to be one keypress away.
 *
 * The split is two-handed, which reads to an audience from across a room:
 *
 *   Right hand — open palm aims (the palm centre becomes the pointer), closing
 *                to a fist casts. Grab-and-release is the most robust discrete
 *                signal in landmark tracking: every one of the twenty-one
 *                points moves at once, it works at any wrist angle, and no
 *                other pose comes near it.
 *   Left hand  — point right for the next ability, left for the previous one.
 *                One gesture and its mirror image, which is as much as anyone
 *                can hold in their head while also talking to a room.
 *
 * Four guards keep it from firing on its own, which is how webcam demos
 * actually fail — not in the model, in the state machine:
 *
 *   1. It boots disengaged. An open palm held for `WAKE_MS` engages it, so
 *      gesturing at your slides does not cast.
 *   2. Every threshold is a Schmitt trigger — a pose is entered and left at
 *      different values, so a landmark sitting on the boundary cannot chatter.
 *   3. Every pose must survive `DWELL_FRAMES` consecutive frames before it
 *      emits, which kills single-frame misclassification.
 *   4. A cast opens a `REFRACTORY_MS` lockout, so the hand re-opening after a
 *      fist cannot immediately re-fire.
 *
 * Detection runs off `requestVideoFrameCallback` at camera rate and writes to
 * `_latest`; the render loop only ever reads that snapshot. `detectForVideo` is
 * synchronous and would stall a frame if it were called inline, and the camera
 * delivers 30 fps into a renderer running at 60 — decoupling the two costs one
 * field and saves half the inferences.
 */

/* Landmark indices, from the MediaPipe hand model. -------------------- */
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const PINKY_MCP = 17;
/** Fingertips, index through pinky. The thumb is judged differently. */
const FINGER_TIPS = [8, 12, 16, 20];
/** The matching PIP joints. */
const FINGER_PIPS = [6, 10, 14, 18];

/* Pose thresholds. ---------------------------------------------------- */

/**
 * A finger counts as extended when its tip is this much further from the wrist
 * than its own PIP joint. Comparing two distances from a shared origin — rather
 * than the tempting `tip.y < pip.y` — is what makes this survive a tilted or
 * upside-down hand, which is most of what a hand does while casting.
 */
const EXTEND_RATIO = 1.15;
/** Thumb tip clear of the index knuckle, in hand-scale units. */
const THUMB_OUT = 0.62;

/**
 * Mean fingertip span, in hand-scale units, for a flat hand and for a fist.
 * Measured rather than derived, so they are the first two numbers to retune if
 * the grab meter does not reach its ends on a given camera.
 */
const SPAN_OPEN = 1.9;
const SPAN_CLOSED = 1.05;

const GRAB_ENTER = 0.7;
const GRAB_EXIT = 0.4;
const PALM_OPEN_FINGERS = 4;

/**
 * How much more horizontal than vertical a pointing finger has to be before it
 * counts as a direction. A hand resting with the index half-raised is the
 * common case this rejects — pointing has to be deliberate, or the ability
 * changes while the presenter is gesturing at the screen.
 */
const POINT_RATIO = 1.2;

/* Timings. ------------------------------------------------------------ */
const WAKE_MS = 600;
const LOST_MS = 500;
const REFRACTORY_MS = 400;
const DWELL_FRAMES = 4;
/**
 * A held point starts repeating after `POINT_HOLD_MS` and steps every
 * `POINT_REPEAT_MS` after that. With ten abilities, tapping the gesture five
 * times to cross the bar is worse than holding it once.
 */
const POINT_HOLD_MS = 700;
const POINT_REPEAT_MS = 400;

/**
 * Half-width of the comfortable reach box, in normalised image coordinates.
 * A hand cannot sweep the full camera frame without the elbow leaving the
 * chair, so the middle ~64% of the image is stretched to the whole viewport.
 */
const REACH = 0.32;

/** Confidence floor. Below this the frame is dropped rather than trusted. */
const MIN_HANDEDNESS = 0.8;
/**
 * Landmarks within this margin of the frame edge are partly extrapolated and
 * the pose read off them is noise. Better to drop the hand than to cast.
 */
const EDGE_MARGIN = 0.02;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));

/**
 * Reduce twenty-one landmarks to the handful of facts the state machine needs.
 *
 * Everything is divided by the wrist-to-middle-knuckle span, so a hand held at
 * arm's length reads identically to one held close to the lens. Without that
 * normalisation every threshold here would be a function of how far away you
 * are standing, which on a stage is not a constant.
 */
function readPose(landmarks) {
  const wrist = landmarks[WRIST];
  const scale = dist(wrist, landmarks[MIDDLE_MCP]) || 1e-6;

  const fingers = FINGER_TIPS.map(
    (tip, i) => dist(landmarks[tip], wrist) > dist(landmarks[FINGER_PIPS[i]], wrist) * EXTEND_RATIO
  );
  const thumb = dist(landmarks[THUMB_TIP], landmarks[INDEX_MCP]) / scale > THUMB_OUT;

  let span = 0;
  for (const tip of FINGER_TIPS) span += dist(landmarks[tip], wrist) / scale;
  span /= FINGER_TIPS.length;

  return {
    /** Thumb first, then index through pinky. */
    fingers: [thumb, ...fingers],
    count: (thumb ? 1 : 0) + fingers.reduce((n, up) => n + (up ? 1 : 0), 0),
    /** 0 flat, 1 fist. Continuous, so the HUD can draw it as a meter. */
    grab: clamp01((SPAN_OPEN - span) / (SPAN_OPEN - SPAN_CLOSED)),
    /** Steadier than the wrist alone, which pivots as the hand rotates. */
    palm: {
      x: (landmarks[WRIST].x + landmarks[INDEX_MCP].x + landmarks[PINKY_MCP].x) / 3,
      y: (landmarks[WRIST].y + landmarks[INDEX_MCP].y + landmarks[PINKY_MCP].y) / 3
    }
  };
}

/** True when any landmark has drifted off the sensor. */
function clipped(landmarks) {
  for (const p of landmarks) {
    if (p.x < EDGE_MARGIN || p.x > 1 - EDGE_MARGIN) return true;
    if (p.y < EDGE_MARGIN || p.y > 1 - EDGE_MARGIN) return true;
  }
  return false;
}

/** Counts consecutive agreeing frames, so one bad inference decides nothing. */
class Dwell {
  constructor(frames = DWELL_FRAMES) {
    this.frames = frames;
    this.value = null;
    this._candidate = null;
    this._count = 0;
  }

  /** @returns {boolean} whether `value` changed on this push */
  push(candidate) {
    if (candidate !== this._candidate) {
      this._candidate = candidate;
      this._count = 1;
      return false;
    }
    if (this._count < this.frames) this._count += 1;
    if (this._count >= this.frames && this.value !== candidate) {
      this.value = candidate;
      return true;
    }
    return false;
  }

  reset() {
    this.value = null;
    this._candidate = null;
    this._count = 0;
  }
}

export class HandInput extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string} [options.aimHand]    MediaPipe handedness label that aims.
   * @param {string} [options.selectHand] …and that steps through the abilities.
   */
  constructor({ aimHand = 'Right', selectHand = 'Left' } = {}) {
    super();

    /**
     * Which physical hand answers to which role.
     *
     * MediaPipe decides handedness as though the frame were a selfie — already
     * mirrored — and whether that matches the raw stream depends on the camera
     * and the browser. It is one venue-day surprise waiting to happen, so it is
     * a field with a `swapHands()` beside it rather than a constant: if the
     * roles come out backwards on the demo machine, that is the whole fix.
     */
    this.aimHand = aimHand;
    this.selectHand = selectHand;

    this.enabled = false;
    this.ready = false;
    this.error = null;

    this.video = null;
    this.stream = null;
    this.landmarker = null;

    /** Newest inference, written by the camera callback, read by `update`. */
    this._latest = null;
    this._lastDetect = -1;
    this._frameHandle = 0;
    this._rafHandle = 0;

    /* Aim-hand state. */
    this._engaged = false;
    this._wakeStart = 0;
    this._lastSeen = 0;
    this._grabbing = false;
    this._refractoryUntil = 0;
    this._grabDwell = new Dwell();
    this._smooth = new OneEuroVec2({ minCutoff: 1.1, beta: 0.012 });
    this._pointer = new Vector2();
    this._raw = { x: 0, y: 0 };

    /* Step-hand state. Deliberately no notion of *which* ability is selected —
       the steps are relative and App owns the index, so the hand and the
       keyboard cannot drift apart. */
    this._pointDwell = new Dwell();
    this._pointing = 0;
    this._repeatAt = 0;

    /** Snapshot handed to the HUD each frame. */
    this.state = {
      ready: false,
      engaged: false,
      grab: 0,
      aimSeen: false,
      selectSeen: false,
      /** -1 previous, 0 neutral, +1 next. */
      pointing: 0,
      wake: 0
    };
  }

  /**
   * The newest raw inference, for anything that wants the landmarks themselves
   * rather than the interpretation — the HUD draws its skeleton off this.
   */
  get latest() {
    return this._latest;
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Open the camera and build the landmarker.
   *
   * Both the wasm runtime and the model are served from `public/mediapipe`
   * rather than Google's CDN — a demo must not depend on conference wifi
   * resolving a third-party host thirty seconds before it is needed.
   *
   * @returns {Promise<boolean>} whether tracking came up
   */
  async start() {
    if (this.ready) {
      this.enabled = true;
      return true;
    }

    try {
      const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');

      this.stream = await navigator.mediaDevices.getUserMedia({
        // 640x480 is deliberate: the model downsamples anyway, so a larger
        // capture buys no accuracy and costs milliseconds per frame.
        video: { width: 640, height: 480, facingMode: 'user' },
        audio: false
      });

      const video = document.createElement('video');
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = this.stream;
      await video.play();
      this.video = video;

      const fileset = await FilesetResolver.forVisionTasks('./mediapipe/wasm');
      this.landmarker = await HandLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: './mediapipe/hand_landmarker.task',
          delegate: 'GPU'
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.6
      });

      this.ready = true;
      this.enabled = true;
      this.state.ready = true;
      this._pump();
      this.emit('ready');
      return true;
    } catch (error) {
      this.error = error;
      this.emit('error', error);
      this.stop();
      return false;
    }
  }

  /** Release the camera. The browser indicator going out matters to an audience. */
  stop() {
    this.enabled = false;
    this.ready = false;
    this.state.ready = false;

    if (this._frameHandle && this.video?.cancelVideoFrameCallback) {
      this.video.cancelVideoFrameCallback(this._frameHandle);
    }
    if (this._rafHandle) cancelAnimationFrame(this._rafHandle);
    this._frameHandle = 0;
    this._rafHandle = 0;

    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;

    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }

    this.landmarker?.close();
    this.landmarker = null;
    this._latest = null;
    this._reset();
  }

  /** Roles came out backwards on this machine. One call, and they are not. */
  swapHands() {
    const aim = this.aimHand;
    this.aimHand = this.selectHand;
    this.selectHand = aim;
    this._reset();
  }

  dispose() {
    this.stop();
    this.clear();
  }

  /* ------------------------------------------------------------------ */
  /* Detection                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Run one inference per camera frame, forever.
   *
   * `requestVideoFrameCallback` fires once per decoded frame, which is the
   * camera's rate rather than the renderer's — Firefox has not shipped it, so
   * a rAF loop stands in and the timestamp guard below throws the duplicate
   * frames away.
   */
  _pump = () => {
    if (!this.ready || !this.video || !this.landmarker) return;

    const schedule = () => {
      if (!this.ready || !this.video) return;
      if (this.video.requestVideoFrameCallback) {
        this._frameHandle = this.video.requestVideoFrameCallback(this._pump);
      } else {
        this._rafHandle = requestAnimationFrame(this._pump);
      }
    };

    // MediaPipe rejects a timestamp that does not advance, which is exactly
    // what the rAF fallback produces whenever it outruns the camera.
    const now = performance.now();
    if (now <= this._lastDetect) {
      schedule();
      return;
    }
    this._lastDetect = now;

    try {
      this._latest = this.landmarker.detectForVideo(this.video, now);
    } catch {
      // A single failed inference is not worth tearing the session down; the
      // next frame is 33 ms away and usually fine.
    }

    schedule();
  };

  /* ------------------------------------------------------------------ */
  /* Interpretation                                                      */
  /* ------------------------------------------------------------------ */

  /** Pick out the hand playing `role`, or null. */
  _hand(result, role) {
    if (!result?.landmarks?.length) return null;
    // The field was renamed between task releases; accept both spellings so a
    // version bump cannot silently stop resolving handedness.
    const handedness = result.handednesses ?? result.handedness ?? [];
    for (let i = 0; i < result.landmarks.length; i += 1) {
      const label = handedness[i]?.[0];
      if (!label || label.categoryName !== role) continue;
      if (label.score < MIN_HANDEDNESS) continue;
      const landmarks = result.landmarks[i];
      if (clipped(landmarks)) continue;
      return landmarks;
    }
    return null;
  }

  _reset() {
    this._engaged = false;
    this._grabbing = false;
    this._wakeStart = 0;
    this._grabDwell.reset();
    this._pointDwell.reset();
    this._smooth.reset();
    this._pointing = 0;
    this.state.engaged = false;
    this.state.grab = 0;
    this.state.wake = 0;
    this.state.pointing = 0;
    this.state.aimSeen = false;
    this.state.selectSeen = false;
  }

  /**
   * Fold the newest inference into the state machine and emit.
   *
   * Called from the render loop with real seconds — the pacing of a gesture is
   * wall-clock, and must not stretch when the sandbox is paused or slowed.
   *
   * @param {number} dt real seconds since the last call
   */
  update(dt) {
    if (!this.enabled || !this.ready) return;

    const result = this._latest;
    const now = performance.now();

    this._updateStepHand(result, now);
    this._updateAimHand(result, dt, now);

    this.emit('state', this.state);
  }

  /**
   * Point right for the next ability, left for the previous one.
   *
   * The step is *relative* and carries only a sign. Nothing here knows which
   * ability is selected, which is the whole point: an absolute slot has to be
   * kept in agreement with the app, and it loses that agreement the first time
   * a selection is refused — a cooling ability, say — leaving the hand a slot
   * ahead of the game with no way for the presenter to tell.
   *
   * Only the index is inspected. The thumb rides up on its own when the hand
   * turns sideways to point, so requiring a state for it would make the pose
   * harder to hit for no gain; the other three fingers must be down, which is
   * what separates a point from the open palm and the fist.
   */
  _updateStepHand(result, now) {
    const landmarks = this._hand(result, this.selectHand);
    this.state.selectSeen = !!landmarks;

    if (!landmarks) {
      this._pointDwell.reset();
      this._pointing = 0;
      this.state.pointing = 0;
      return;
    }

    const [, index, middle, ring, pinky] = readPose(landmarks).fingers;

    let dir = 0;
    if (index && !middle && !ring && !pinky) {
      const tip = landmarks[INDEX_TIP];
      const mcp = landmarks[INDEX_MCP];
      // Negated into presenter space: the raw frame is not mirrored, so their
      // right hand side is the image's left.
      const dx = -(tip.x - mcp.x);
      const dy = tip.y - mcp.y;
      if (Math.abs(dx) > Math.abs(dy) * POINT_RATIO) dir = dx > 0 ? 1 : -1;
    }

    this.state.pointing = dir;

    if (this._pointDwell.push(dir)) {
      this._pointing = dir;
      if (dir === 0) return;
      this._repeatAt = now + POINT_HOLD_MS;
      this.emit('action', 'abilityStep', dir);
      return;
    }

    // Held past the hold time: keep stepping, so crossing the bar is one long
    // point rather than five separate ones.
    if (this._pointing !== 0 && now >= this._repeatAt) {
      this._repeatAt = now + POINT_REPEAT_MS;
      this.emit('action', 'abilityStep', this._pointing);
    }
  }

  /** Open palm aims, fist casts. */
  _updateAimHand(result, dt, now) {
    const landmarks = this._hand(result, this.aimHand);
    this.state.aimSeen = !!landmarks;

    if (!landmarks) {
      this._wakeStart = 0;
      this.state.wake = 0;
      this._grabDwell.reset();
      this._grabbing = false;
      this.state.grab = 0;
      // Losing the hand for a frame is normal; losing it for half a second is
      // the presenter putting their arm down, and the cast should go away.
      if (this._engaged && now - this._lastSeen > LOST_MS) {
        this._engaged = false;
        this.state.engaged = false;
        this._smooth.reset();
        this.emit('action', 'cancel');
      }
      return;
    }

    this._lastSeen = now;
    const pose = readPose(landmarks);
    this.state.grab = pose.grab;

    if (!this._engaged) {
      const open = pose.count >= PALM_OPEN_FINGERS;
      if (!open) {
        this._wakeStart = 0;
        this.state.wake = 0;
        return;
      }
      if (!this._wakeStart) this._wakeStart = now;
      this.state.wake = clamp01((now - this._wakeStart) / WAKE_MS);
      if (this.state.wake < 1) return;

      this._engaged = true;
      this.state.engaged = true;
      this._smooth.reset();
      // The palm that woke it is already open; without this the very next
      // frames could read the hand relaxing as a deliberate fist.
      this._refractoryUntil = now + REFRACTORY_MS;
      this.emit('engaged');
    }

    /* Aim. --------------------------------------------------------- */
    // Both axes flip: the raw camera frame is not mirrored, so a hand moving to
    // the presenter's right travels towards smaller x, and image y grows
    // downwards where NDC y grows up.
    const step = dt > 0 ? dt : 1 / 60;
    this._smooth.filter(pose.palm.x, pose.palm.y, step, this._raw);
    this._pointer.set(
      Math.max(-1, Math.min(1, (0.5 - this._raw.x) / REACH)),
      Math.max(-1, Math.min(1, (0.5 - this._raw.y) / REACH))
    );
    this.emit('pointer:move', this._pointer);

    /* Fire. -------------------------------------------------------- */
    const wants = this._grabbing ? pose.grab > GRAB_EXIT : pose.grab > GRAB_ENTER;
    if (!this._grabDwell.push(wants)) return;

    this._grabbing = wants;
    if (!wants) return;
    if (now < this._refractoryUntil) return;

    this._refractoryUntil = now + REFRACTORY_MS;
    this.emit('pointer:confirm', this._pointer);
  }
}
