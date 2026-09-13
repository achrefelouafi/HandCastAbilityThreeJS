import { EventEmitter } from '../utils/EventEmitter.js';
import { openSignal, probeSignal } from './PhoneSignal.js';

/**
 * The desktop end of "use my phone as the camera".
 *
 * `HandInput` does not care where its frames come from — it reads a `<video>`
 * — so a phone can stand in for the webcam if its camera can be got onto this
 * page as a `MediaStream`. WebRTC does exactly that, peer to peer across the
 * local network, and this class is the receiving peer: it opens a room on the
 * dev server's signalling relay, hands the app a URL to put in a QR code,
 * answers the offer the phone sends once it has scanned it, and emits the
 * stream when video is actually flowing.
 *
 * The relay only carries the handshake. Once ICE has found a route the video
 * goes phone → desktop directly, which is why this needs no STUN or TURN: both
 * devices are on one Wi-Fi and host candidates are enough.
 *
 * Reconnection is the phone's job. The desktop announces itself with `hello`
 * whenever its side of the room opens — on pairing, and again after a page
 * reload, since the room id is kept in `sessionStorage` — and the phone answers
 * any `hello` with a fresh offer. So a reloaded sandbox gets its camera back
 * without a rescan.
 *
 * LOCAL ONLY. The relay is a Vite dev-server plugin; there is no backend, so
 * this works for one person at one desk with `npm run dev:lan`. Shipping it
 * would mean a signalling service and, beyond the LAN, a TURN server.
 *
 * Events:
 *   `status` (text, kind)   — a line for the panel; kind is 'info'|'warn'|'error'|'live'
 *   `phone`  (present)      — the phone page is (not) connected to the relay
 *   `stream` (MediaStream)  — video is flowing; hand this to the tracker
 *   `ended`  (reason)       — the stream went away, cleanly ('bye') or not
 */

const ROOM_KEY = 'elemental.phoneCam.room';
/** ICE on a LAN is quick; longer than this and something is blocking it. */
const CONNECT_TIMEOUT_MS = 15000;
/** A `disconnected` that lasts this long is treated as gone, not a blip. */
const DISCONNECT_GRACE_MS = 4000;

function randomRoom() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('');
}

/**
 * The address the QR code should carry, out of the ones the server listens
 * on. A Windows box with Docker or Hyper-V reports a virtual switch beside
 * the real Wi-Fi; a `192.168.` address is the one most likely to be the LAN.
 */
function rankUrls(urls) {
  const score = (url) => {
    const host = new URL(url).hostname;
    if (host.startsWith('192.168.')) return 0;
    if (host.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return 2;
    return 3;
  };
  return [...urls].sort((a, b) => score(a) - score(b));
}

export class PhoneCameraLink extends EventEmitter {
  constructor() {
    super();

    /** Result of `probe()`, or null until it has run. */
    this.info = null;
    this.room = null;
    /**
     * Identifies this page load to the phone. A `hello` carrying a new
     * instance means the desktop was reloaded and its peer connection is
     * gone; the same instance again is only the relay stream reconnecting,
     * and a phone that is already streaming leaves that alone.
     */
    this.instance = randomRoom();
    /** Candidate page URLs for the phone, best first; `urlIndex` picks one. */
    this.urls = [];
    this.urlIndex = 0;

    this.open = false;
    this.live = false;
    this.phonePresent = false;
    this.stream = null;

    this._signal = null;
    this._pc = null;
    /** The phone's id for the offer `_pc` answers; stale candidates are dropped. */
    this._offerId = '';
    this._connectTimer = 0;
    this._disconnectTimer = 0;
    /** Signalling is handled strictly in order — an ICE candidate must not
     *  race the offer it belongs to through `setRemoteDescription`. */
    this._chain = Promise.resolve();
  }

  /** Whether the relay exists at all — false on a built, deployed page. */
  get available() {
    return !!this.info?.available;
  }

  /** Whether the server is reachable from a phone: on the LAN, over HTTPS. */
  get reachable() {
    return this.available && this.info.https && this.info.urls.length > 0;
  }

  /** The URL the phone should open, for the current address choice. */
  get pageUrl() {
    if (!this.room || !this.urls.length) return '';
    const base = this.urls[this.urlIndex % this.urls.length];
    return `${base.replace(/\/$/, '')}/phone.html?room=${this.room}`;
  }

  async probe() {
    this.info = await probeSignal();
    this.urls = rankUrls(this.info.urls);
    return this.info;
  }

  /** Step the QR code to the next address the server listens on. */
  nextUrl() {
    if (this.urls.length < 2) return this.pageUrl;
    this.urlIndex = (this.urlIndex + 1) % this.urls.length;
    return this.pageUrl;
  }

  /**
   * Open the room and start listening. Idempotent; `pageUrl` is valid after.
   * @returns {Promise<boolean>} false when the relay is not usable
   */
  async connect() {
    if (this.open) return true;
    if (!this.info) await this.probe();
    if (!this.reachable) return false;

    // The room outlives a reload of this tab, so the phone — which is still
    // in the room — hears the fresh `hello` and offers again unprompted.
    let room = null;
    try {
      room = sessionStorage.getItem(ROOM_KEY);
    } catch {
      /* private mode or a blocked store; a new room each time is fine */
    }
    if (!room) {
      room = randomRoom();
      try {
        sessionStorage.setItem(ROOM_KEY, room);
      } catch {
        /* same */
      }
    }
    this.room = room;
    this.open = true;

    this._signal = openSignal({
      room,
      role: 'desktop',
      onMessage: (message) => this._enqueue(message),
      onPeer: (present) => {
        this.phonePresent = present;
        this.emit('phone', present);
        if (!this.live) {
          this._status(present ? 'Phone found — allow the camera on it' : 'Waiting for the phone…', 'info');
        }
      },
      onOpen: () => {
        // Every (re)open of this side is a fresh start for the phone: a
        // reloaded page has lost its peer connection, and asking for a new
        // offer costs nothing if the phone is not there yet.
        this._send({ type: 'hello', instance: this.instance });
      },
      onError: () => {
        if (!this.live) this._status('Lost the dev server — retrying…', 'warn');
      }
    });

    this._status('Waiting for the phone…', 'info');
    return true;
  }

  /** Tear everything down. Tells the phone, so it can show "disconnected". */
  close(reason = 'bye') {
    if (!this.open) return;
    const wasLive = this.live;
    this.open = false;

    if (this._signal) {
      // Best effort; the phone also notices the peer connection dying.
      this._send({ type: 'bye' });
      this._signal.close();
      this._signal = null;
    }
    this._teardownPeer();
    this.phonePresent = false;
    if (wasLive) this.emit('ended', reason);
  }

  /* ------------------------------------------------------------------ */

  _status(text, kind = 'info') {
    this.emit('status', text, kind);
  }

  _send(message) {
    this._signal?.send(message).catch(() => {
      // The relay is gone; the EventSource's own error path reports it.
    });
  }

  _enqueue(message) {
    this._chain = this._chain
      .then(() => this._handle(message))
      .catch((error) => {
        console.warn('[phone-camera] signalling failed', error);
        this._status(`Pairing failed: ${error?.message ?? error}`, 'error');
      });
  }

  async _handle(message) {
    switch (message.type) {
      case 'offer':
        await this._answer(message);
        break;
      case 'ice':
        if (this._pc && message.candidate && message.offerId === this._offerId) {
          try {
            await this._pc.addIceCandidate(message.candidate);
          } catch {
            // A candidate for a connection we have since replaced. Harmless.
          }
        }
        break;
      case 'bye':
        this._lost('Phone disconnected');
        break;
      case 'facing':
        // The phone flipped cameras mid-stream (the track was swapped in
        // place, no renegotiation); only the status line cares.
        if (this.live) this._status(`Phone camera live${message.facing === 'environment' ? ' (rear camera)' : ''}`, 'live');
        break;
      default:
        break;
    }
  }

  /** The phone has sent an offer: build a peer for it and answer. */
  async _answer(message) {
    this._teardownPeer();
    this._status('Connecting…', 'info');

    const pc = new RTCPeerConnection({ iceServers: [] });
    this._pc = pc;
    this._offerId = message.offerId ?? '';

    pc.onicecandidate = (event) => {
      if (event.candidate) this._send({ type: 'ice', candidate: event.candidate.toJSON(), offerId: this._offerId });
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      // A remote track is born muted and unmutes on the first packet. Handing
      // the tracker a stream with no frames yet would only make it wait, so
      // "live" is that first packet, not the track's arrival.
      const goLive = () => {
        if (this._pc !== pc || this.live) return;
        this.live = true;
        this.stream = stream;
        clearTimeout(this._connectTimer);
        this._status(`Phone camera live${message.facing === 'environment' ? ' (rear camera)' : ''}`, 'live');
        this.emit('stream', stream);
      };
      if (event.track.muted) event.track.addEventListener('unmute', goLive, { once: true });
      else goLive();
      event.track.addEventListener('ended', () => {
        if (this._pc === pc) this._lost('The phone stopped its camera');
      });
    };

    pc.onconnectionstatechange = () => {
      if (this._pc !== pc) return;
      switch (pc.connectionState) {
        case 'connected':
          clearTimeout(this._disconnectTimer);
          break;
        case 'disconnected':
          // Wi-Fi hiccups produce this and recover; give it a moment.
          clearTimeout(this._disconnectTimer);
          this._disconnectTimer = setTimeout(() => {
            if (this._pc === pc && pc.connectionState === 'disconnected') this._lost('Lost the phone');
          }, DISCONNECT_GRACE_MS);
          break;
        case 'failed':
        case 'closed':
          this._lost(pc.connectionState === 'failed' ? 'Connection to the phone failed' : 'Phone disconnected');
          break;
        default:
          break;
      }
    };

    await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this._send({ type: 'answer', sdp: pc.localDescription.sdp, offerId: this._offerId });

    clearTimeout(this._connectTimer);
    this._connectTimer = setTimeout(() => {
      if (this._pc !== pc || this.live) return;
      this._status(
        'Still connecting — both devices on the same Wi-Fi? Guest networks and "client isolation" block this.',
        'warn'
      );
    }, CONNECT_TIMEOUT_MS);
  }

  _lost(reason) {
    const wasLive = this.live;
    this._teardownPeer();
    this._status(reason, 'warn');
    if (wasLive) this.emit('ended', reason);
    // Nothing else to do: the room stays open, and the phone will offer
    // again when it can.
  }

  _teardownPeer() {
    clearTimeout(this._connectTimer);
    clearTimeout(this._disconnectTimer);
    this._connectTimer = 0;
    this._disconnectTimer = 0;
    if (this._pc) {
      this._pc.ontrack = null;
      this._pc.onicecandidate = null;
      this._pc.onconnectionstatechange = null;
      this._pc.close();
      this._pc = null;
    }
    this.live = false;
    this.stream = null;
  }

  dispose() {
    this.close();
    this.clear();
  }
}
