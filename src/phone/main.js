import { openSignal } from '../input/PhoneSignal.js';

/**
 * The phone end of "use my phone as the camera".
 *
 * Opened from the QR code in the sandbox's camera panel, with the room id in
 * the query string. It asks for the camera, joins the room on the dev
 * server's relay, and sends the desktop a WebRTC offer whenever the desktop
 * says `hello` — on pairing, and again after the sandbox has been reloaded,
 * which is what lets it reconnect without a rescan. The video itself never
 * touches the server: once ICE has a route it goes straight to the PC.
 *
 * The frame it sends is the raw camera frame, front or rear — a camera
 * pointed at the presenter sees their right hand on the image's left either
 * way, which is what the tracker assumes of a webcam. Only the preview here
 * is mirrored, and only for the selfie camera, as every camera app does.
 *
 * LOCAL ONLY. The relay is a Vite dev-server plugin; there is no backend.
 * See `tools/vite-plugin-phone-camera.js`.
 */

const $ = (selector) => document.querySelector(selector);
const frame = $('[data-frame]');
const video = $('[data-video]');
const badge = $('[data-badge]');
const statusLine = $('[data-status]');
const startButton = $('[data-start]');
const flipButton = $('[data-flip]');
const stopButton = $('[data-stop]');

const room = new URLSearchParams(location.search).get('room');

/** The same 4:3 the webcam is asked for; the model downsamples anyway. */
const CAMERA = (facing) => ({
  video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
  audio: false
});
/** A LAN has the headroom; sharp fingers help the tracker. */
const MAX_BITRATE = 2_500_000;
const DISCONNECT_GRACE_MS = 4000;
const RETRY_MS = 3000;
const MAX_RETRIES = 5;

let stream = null;
let facing = 'user';
let signal = null;
let pc = null;
let desktopPresent = false;
/** The desktop page load the last offer went to; a new one needs a new offer. */
let desktopInstance = null;
let wakeLock = null;
let retries = 0;
let disconnectTimer = 0;
/**
 * Tags the offer in flight. A `hello` landing while `startCamera` is still
 * awaiting the device can put two offers out; the desktop answers both, and
 * the first answer must not be applied to the second peer.
 */
let offerId = '';
/** Signalling is applied in order — an ICE candidate must follow its answer. */
let chain = Promise.resolve();

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

function setStatus(text, kind = 'info') {
  statusLine.textContent = text;
  statusLine.dataset.kind = kind;
}

function setBadge(text, live = false) {
  badge.textContent = text;
  frame.classList.toggle('is-live', live);
}

function showRunning(on) {
  startButton.hidden = on;
  startButton.disabled = false;
  flipButton.hidden = !on;
  flipButton.disabled = false;
  stopButton.hidden = !on;
}

function describeCameraError(error) {
  switch (error?.name) {
    case 'NotAllowedError':
      return 'Camera permission was refused. Allow it for this site in the browser settings, then tap Start again.';
    case 'NotFoundError':
      return 'No camera was found on this device.';
    case 'NotReadableError':
      return 'The camera is busy — another app has it. Close that app and tap Start again.';
    default:
      return `Could not open the camera: ${error?.message ?? error}`;
  }
}

/** True when the page cannot work at all, with the reason on screen. */
function preflight() {
  if (!room) {
    setStatus('Open this page by scanning the QR code in the sandbox’s camera panel — it carries the room id.', 'error');
    return false;
  }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    setStatus(
      'This browser will not hand over the camera on a plain-HTTP address. On the PC, run `npm run dev:lan` and scan the code again.',
      'error'
    );
    return false;
  }
  if (!('RTCPeerConnection' in window)) {
    setStatus('This browser has no WebRTC, which the video link needs.', 'error');
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Camera                                                              */
/* ------------------------------------------------------------------ */

async function openCamera() {
  try {
    return await navigator.mediaDevices.getUserMedia(CAMERA(facing));
  } catch (error) {
    // A phone with one camera has no `environment`; take what it has.
    if (error?.name === 'OverconstrainedError') return navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    throw error;
  }
}

async function startCamera() {
  startButton.disabled = true;
  flipButton.disabled = true;
  setStatus('Asking for the camera…');

  let next;
  try {
    next = await openCamera();
  } catch (error) {
    startButton.disabled = false;
    flipButton.disabled = false;
    setStatus(describeCameraError(error), 'error');
    return;
  }

  const previous = stream;
  stream = next;
  const [track] = stream.getVideoTracks();
  // Frame rate over resolution when the link is squeezed: a hand is read
  // from motion, and a sharp frame every 100 ms is worse than a soft one
  // every 33.
  track.contentHint = 'motion';
  track.addEventListener('ended', () => {
    // The OS took the camera — a call came in, or the page went to the
    // background on iOS. The desktop notices on its own; here, offer a way back.
    if (stream?.getVideoTracks()[0] !== track) return;
    setStatus('The camera was stopped by the phone. Tap Start to resume.', 'warn');
    setBadge('Stopped');
    showRunning(false);
  });

  video.srcObject = stream;
  frame.classList.toggle('is-mirrored', facing === 'user');
  await video.play().catch(() => {});

  if (pc) {
    // Flipping mid-stream: swap the track in the live connection rather than
    // renegotiating, and the desktop never sees a gap.
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind === 'video') await sender.replaceTrack(track).catch(() => {});
    }
    signal?.send({ type: 'facing', facing }).catch(() => {});
  }
  previous?.getTracks().forEach((t) => t.stop());

  showRunning(true);
  setBadge(pc?.connectionState === 'connected' ? 'Live' : 'Camera on', pc?.connectionState === 'connected');
  await keepAwake();

  if (pc) return;
  if (desktopPresent) await offer();
  else setStatus('Camera on — waiting for the sandbox. Is its camera panel open?');
}

function stopCamera() {
  signal?.send({ type: 'bye' }).catch(() => {});
  closePeer();
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  frame.classList.remove('is-mirrored');
  showRunning(false);
  setBadge('Idle');
  setStatus('Camera off. Tap Start to send it again.');
}

async function keepAwake() {
  // A phone that dims and locks takes the camera with it.
  try {
    wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
  } catch {
    wakeLock = null;
  }
}

/* ------------------------------------------------------------------ */
/* WebRTC                                                              */
/* ------------------------------------------------------------------ */

function closePeer() {
  clearTimeout(disconnectTimer);
  disconnectTimer = 0;
  if (!pc) return;
  pc.onicecandidate = null;
  pc.onconnectionstatechange = null;
  pc.close();
  pc = null;
}

async function offer() {
  if (!stream || !signal) return;
  closePeer();

  const peer = new RTCPeerConnection({ iceServers: [] });
  pc = peer;
  const id = Math.random().toString(36).slice(2, 10);
  offerId = id;

  const [track] = stream.getVideoTracks();
  const sender = peer.addTrack(track, stream);
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = MAX_BITRATE;
    params.degradationPreference = 'maintain-framerate';
    await sender.setParameters(params);
  } catch {
    // Not every browser lets these be set before negotiation. Defaults are fine.
  }

  peer.onicecandidate = (event) => {
    if (event.candidate) signal.send({ type: 'ice', candidate: event.candidate.toJSON(), offerId: id }).catch(() => {});
  };

  peer.onconnectionstatechange = () => {
    if (pc !== peer) return;
    switch (peer.connectionState) {
      case 'connected':
        clearTimeout(disconnectTimer);
        retries = 0;
        setStatus('Streaming to the sandbox. Leave this page open.', 'live');
        setBadge('Live', true);
        break;
      case 'disconnected':
        clearTimeout(disconnectTimer);
        disconnectTimer = setTimeout(() => {
          if (pc === peer && peer.connectionState === 'disconnected') setStatus('Connection wobbling…', 'warn');
        }, DISCONNECT_GRACE_MS);
        break;
      case 'failed':
        closePeer();
        setBadge('Camera on');
        if (desktopPresent && retries < MAX_RETRIES) {
          retries += 1;
          setStatus(`Could not reach the PC directly — retrying (${retries}/${MAX_RETRIES})…`, 'warn');
          setTimeout(() => {
            if (!pc && desktopPresent && stream) offer();
          }, RETRY_MS);
        } else {
          setStatus(
            'Could not connect to the PC. Both devices need to be on the same Wi-Fi, and guest networks or "client isolation" block this.',
            'error'
          );
        }
        break;
      default:
        break;
    }
  };

  setStatus('Connecting to the sandbox…');
  setBadge('Connecting');
  const description = await peer.createOffer();
  await peer.setLocalDescription(description);
  await signal.send({ type: 'offer', sdp: peer.localDescription.sdp, facing, offerId: id });
}

async function handle(message) {
  switch (message.type) {
    case 'hello': {
      // A new instance is a reloaded sandbox: its side of any connection is
      // gone even if ours still says `connected`. The same instance again is
      // only its relay stream reconnecting; a live link is left alone.
      const fresh = message.instance !== desktopInstance;
      desktopInstance = message.instance ?? null;
      desktopPresent = true;
      retries = 0;
      if (!stream) {
        setStatus('The sandbox is ready. Tap Start camera.');
        break;
      }
      if (fresh || pc?.connectionState !== 'connected') await offer();
      break;
    }
    case 'answer':
      if (message.offerId === offerId && pc?.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
      }
      break;
    case 'ice':
      if (message.offerId === offerId && pc && message.candidate) {
        try {
          await pc.addIceCandidate(message.candidate);
        } catch {
          // For a connection since replaced. Harmless.
        }
      }
      break;
    case 'bye':
      closePeer();
      desktopInstance = null;
      setBadge(stream ? 'Camera on' : 'Idle');
      setStatus(
        stream
          ? 'The sandbox let go of the camera. Leave this open — it reconnects when the panel asks again.'
          : 'The sandbox let go of the camera.',
        'warn'
      );
      break;
    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

if (preflight()) {
  signal = openSignal({
    room,
    role: 'phone',
    onMessage: (message) => {
      chain = chain.then(() => handle(message)).catch((error) => {
        console.warn('[phone-camera] signalling failed', error);
        setStatus(`Pairing failed: ${error?.message ?? error}`, 'error');
      });
    },
    onPeer: (present) => {
      desktopPresent = present;
      if (present) return;
      // Its relay stream dropped — a reload, or the panel closed. A live
      // video link may well survive the former; the peer connection will
      // say if it does not.
      if (pc) return;
      setStatus(
        stream
          ? 'The sandbox is away. Leave this open — it reconnects when the panel asks again.'
          : 'The sandbox is not listening. Open its camera panel (M) and tap "Use your phone".',
        'warn'
      );
    },
    onOpen: () => {
      if (!stream) setStatus(desktopPresent ? 'The sandbox is ready. Tap Start camera.' : 'Connected to the dev server. Tap Start camera.');
    },
    onError: () => {
      if (!pc) setStatus('Lost the dev server — retrying…', 'warn');
    }
  });

  startButton.addEventListener('click', startCamera);
  stopButton.addEventListener('click', stopCamera);
  flipButton.addEventListener('click', () => {
    facing = facing === 'user' ? 'environment' : 'user';
    startCamera();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && stream) keepAwake();
  });

  // Best effort on the way out, so the desktop's panel says "disconnected"
  // now rather than when ICE gives up.
  window.addEventListener('pagehide', () => {
    if (!stream) return;
    const query = `room=${encodeURIComponent(room)}&role=phone`;
    navigator.sendBeacon?.(`./__phone-cam/send?${query}`, new Blob([JSON.stringify({ type: 'bye' })], { type: 'application/json' }));
  });
} else {
  startButton.disabled = true;
}
