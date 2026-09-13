/**
 * The "use your phone as the camera" section of the camera panel.
 *
 * A QR code, the address it carries, one line of status and a way out. It
 * knows nothing about WebRTC — `App` feeds it the link's events — and only
 * decides what to show for each state the pairing can be in:
 *
 *   unavailable   no relay at all. This is a built page, not the dev server,
 *                 and the section says so: the feature is local-only for now.
 *   needs-lan     the dev server is up but on loopback, or over plain HTTP,
 *                 so a phone could not reach it (or would get no camera).
 *   code          scan me. Stays up while the phone is connecting.
 *   live          the phone's camera is the tracker's input.
 *
 * The QR encoder is loaded on demand: it is ~20 KB the page never needs
 * unless this opens.
 */

const MARKUP = `
  <div class="camera__source">
    <button type="button" class="camera__btn" data-phone-toggle>
      <span class="camera__btn-icon" aria-hidden="true">📱</span>
      <span data-phone-toggle-label>Use your phone as the camera</span>
    </button>
  </div>
  <div class="camera__phone" data-phone hidden>
    <div class="phone__code" data-phone-code hidden>
      <div class="phone__qr" data-phone-qr></div>
      <div class="phone__how">
        Scan with your phone. It opens a page on this dev server — accept the
        <b>certificate warning</b> (it is the server's own self-signed cert) and tap
        <b>Start camera</b>.
      </div>
      <button type="button" class="phone__url" data-phone-url title="Copy the address"></button>
      <button type="button" class="phone__alt" data-phone-alt hidden>Not this network? Try the next address</button>
    </div>
    <div class="phone__status" data-phone-status></div>
    <div class="phone__actions">
      <button type="button" class="camera__btn camera__btn--quiet" data-phone-cancel>Back to the webcam</button>
    </div>
    <div class="phone__note">
      Local network only, for now: the handshake goes through the Vite dev server
      and the video goes phone → PC directly. A deployed build has no relay — that
      would need a small signalling backend (and a TURN server off the LAN).
    </div>
  </div>
`;

export { MARKUP as PHONE_PAIRING_MARKUP };

export class PhonePairing {
  constructor(root) {
    this.element = root.querySelector('[data-phone]');
    this.toggle = root.querySelector('[data-phone-toggle]');
    this.toggleLabel = root.querySelector('[data-phone-toggle-label]');
    this.code = root.querySelector('[data-phone-code]');
    this.qr = root.querySelector('[data-phone-qr]');
    this.url = root.querySelector('[data-phone-url]');
    this.alt = root.querySelector('[data-phone-alt]');
    this.status = root.querySelector('[data-phone-status]');
    this.cancel = root.querySelector('[data-phone-cancel]');

    /** @type {(() => void)|null} the button was pressed: start (or show) pairing */
    this.onOpen = null;
    /** @type {(() => void)|null} "back to the webcam" */
    this.onClose = null;
    /** @type {(() => string)|null} step to the next address; returns the new URL */
    this.onNextUrl = null;

    this.open = false;
    this.live = false;
    this._urlShown = '';
    this._qrModule = null;

    this.toggle.addEventListener('click', () => {
      if (this.open) this.setOpen(false);
      else this.onOpen?.();
    });
    this.cancel.addEventListener('click', () => this.onClose?.());
    this.alt.addEventListener('click', () => {
      const next = this.onNextUrl?.();
      if (next) this.showCode(next, { alternatives: true });
    });
    this.url.addEventListener('click', () => {
      navigator.clipboard?.writeText(this._urlShown).then(
        () => this.setStatus('Address copied', 'info'),
        () => {}
      );
    });
  }

  setOpen(on) {
    this.open = on;
    this.element.hidden = !on;
    // The gesture guide under the preview stands down while this is open; the
    // panel is tall enough already, and nobody is casting while they pair.
    this.element.closest('[data-camera]')?.classList.toggle('is-pairing', on);
  }

  /** The relay is not there: a built page. */
  showUnavailable() {
    this.setOpen(true);
    this.code.hidden = true;
    this.setStatus(
      'The phone camera needs the local dev server — run `npm run dev:lan`. It is a local-only ' +
        'feature for now: a deployed build would need a signalling backend.',
      'warn'
    );
  }

  /** The relay is there but the phone could not reach it. */
  showNeedsLan(https) {
    this.setOpen(true);
    this.code.hidden = true;
    this.setStatus(
      https
        ? 'The dev server is only listening on this machine. Restart it with `npm run dev:lan` and reopen this page from the address it prints.'
        : 'Restart the dev server with `npm run dev:lan` — the phone needs HTTPS on your Wi-Fi before its browser will hand over the camera.',
      'warn'
    );
  }

  /**
   * Draw the code for `url`.
   * @param {string} url
   * @param {object} [options]
   * @param {boolean} [options.alternatives] there are other addresses to try
   */
  async showCode(url, { alternatives = false } = {}) {
    this.setOpen(true);
    this.code.hidden = false;
    this.alt.hidden = !alternatives;
    if (url === this._urlShown) return;
    this._urlShown = url;
    this.url.textContent = url.replace(/^https?:\/\//, '').replace(/\?room=.*$/, '');

    try {
      this._qrModule ??= (await import('qrcode-generator')).default;
    } catch (error) {
      this.qr.textContent = url;
      console.warn('[phone-camera] QR encoder failed to load', error);
      return;
    }
    if (url !== this._urlShown) return; // superseded while loading

    // Type 0 picks the smallest version that fits; M is plenty of correction
    // for a screen-to-camera scan and keeps the modules large.
    const code = this._qrModule(0, 'M');
    code.addData(url);
    code.make();
    this.qr.innerHTML = code.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  }

  /**
   * @param {string} text
   * @param {'info'|'warn'|'error'|'live'} [kind]
   */
  setStatus(text, kind = 'info') {
    this.status.textContent = text;
    this.status.dataset.kind = kind;
  }

  /** The phone's video is the tracker's input. */
  setLive(on) {
    this.live = on;
    this.toggleLabel.textContent = on ? 'Phone camera · live' : 'Use your phone as the camera';
    this.toggle.classList.toggle('is-live', on);
    // The code has done its job; a live section is the status and the way out.
    // Back from live — the phone dropped — it returns, ready for a rescan.
    if (on) this.code.hidden = true;
    else if (this._urlShown) this.code.hidden = false;
    this.cancel.textContent = on ? 'Disconnect — back to the webcam' : 'Back to the webcam';
  }

  reset() {
    this.setLive(false);
    this.setOpen(false);
    this.code.hidden = true;
    this.setStatus('', 'info');
  }
}
