/**
 * One Euro filter — the smoothing that makes webcam input feel like a mouse.
 *
 * Raw hand landmarks jitter by two or three pixels even when the hand is
 * perfectly still, and a fixed low-pass trades that jitter for lag: enough
 * smoothing to settle the aim indicator also makes it swim behind the hand.
 *
 * One Euro solves it by making the cutoff a function of speed. Slow movement
 * (a hand hovering over a target) gets a low cutoff and heavy smoothing; fast
 * movement (a hand sweeping across the floor) raises the cutoff and lets the
 * signal through almost untouched. The result is steady when you hold and
 * immediate when you move, which is exactly the trade a cursor wants.
 *
 * `minCutoff` sets the floor — lower is steadier and laggier. `beta` sets how
 * hard speed opens it up — higher is more responsive and more jittery. Tune
 * `minCutoff` until a held hand stops shaking, then raise `beta` until a
 * sweeping hand stops lagging. That order, and only that order.
 *
 * Casiez, Roussel & Vogel (2012).
 */

const TWO_PI = Math.PI * 2;

/** Smoothing factor for a first-order low-pass at `cutoff` Hz over `dt` s. */
function alphaFor(cutoff, dt) {
  const tau = 1 / (TWO_PI * cutoff);
  return 1 / (1 + tau / dt);
}

/** Scalar channel. Two of these make a filtered 2D point. */
export class OneEuroFilter {
  /**
   * @param {object} [options]
   * @param {number} [options.minCutoff=1.0] Hz, the cutoff at zero speed.
   * @param {number} [options.beta=0.007]    how much speed raises the cutoff.
   * @param {number} [options.dCutoff=1.0]   Hz, cutoff of the speed estimate itself.
   */
  constructor({ minCutoff = 1.0, beta = 0.007, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;

    this._x = 0; // last filtered value
    this._dx = 0; // last filtered derivative
    this._primed = false;
  }

  /** Forget the history. Call when the hand leaves and comes back, so the
   *  filter does not drag the cursor across the screen from where it left. */
  reset() {
    this._primed = false;
    this._dx = 0;
  }

  /**
   * @param {number} value raw sample
   * @param {number} dt    seconds since the previous sample; must be > 0
   * @returns {number} filtered value
   */
  filter(value, dt) {
    if (!this._primed) {
      this._primed = true;
      this._x = value;
      this._dx = 0;
      return value;
    }

    // A dropped frame or a tab that was backgrounded can hand us a dt of half a
    // second. Clamping keeps one stale sample from blowing the derivative up.
    const step = Math.min(Math.max(dt, 1e-4), 0.1);

    const dx = (value - this._x) / step;
    this._dx += alphaFor(this.dCutoff, step) * (dx - this._dx);

    const cutoff = this.minCutoff + this.beta * Math.abs(this._dx);
    this._x += alphaFor(cutoff, step) * (value - this._x);
    return this._x;
  }
}

/** Two channels sharing one set of constants. */
export class OneEuroVec2 {
  constructor(options) {
    this.x = new OneEuroFilter(options);
    this.y = new OneEuroFilter(options);
  }

  reset() {
    this.x.reset();
    this.y.reset();
  }

  /** @param {{x:number,y:number}} out written in place and returned */
  filter(x, y, dt, out) {
    out.x = this.x.filter(x, dt);
    out.y = this.y.filter(y, dt);
    return out;
  }
}
