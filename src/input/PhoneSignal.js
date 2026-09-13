/**
 * Browser half of the phone-camera signalling relay — the client of
 * `tools/vite-plugin-phone-camera.js`, used by both ends: the desktop in
 * `PhoneCamera.js`, and the phone in `src/phone/main.js`.
 *
 * Messages flow one way per role: everything a role `send`s arrives on the
 * other role's `EventSource`, in order, held by the server if the other side is
 * not listening yet. The relay adds one message of its own — `peer` — whenever
 * the other role connects or drops, which is how each side knows there is
 * anyone to talk to.
 *
 * Local dev only: the relay is a dev-server plugin, and `probe()` is how the
 * app finds out whether it is there at all (a built, deployed page has no
 * relay and would need a signalling backend of its own).
 */

const BASE = './__phone-cam';

/**
 * Ask the dev server whether the relay exists and how the phone can reach it.
 *
 * On a static host with a SPA fallback the request comes back 200 with
 * `index.html`, so the content type is checked and not just the status.
 *
 * @returns {Promise<{available: boolean, https: boolean, urls: string[]}>}
 */
export async function probeSignal() {
  try {
    const res = await fetch(`${BASE}/info`, { cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) {
      return { available: false, https: false, urls: [] };
    }
    const body = await res.json();
    return {
      available: body.available === true,
      https: !!body.https,
      urls: Array.isArray(body.urls) ? body.urls : []
    };
  } catch {
    return { available: false, https: false, urls: [] };
  }
}

/**
 * Open one role's side of a room.
 *
 * @param {object} options
 * @param {string} options.room
 * @param {'desktop'|'phone'} options.role
 * @param {(message: object) => void} options.onMessage   anything the other role sent
 * @param {(present: boolean) => void} [options.onPeer]   the other role came or went
 * @param {() => void} [options.onOpen]                   the stream is up (again)
 * @param {() => void} [options.onError]                  the stream dropped; it retries on its own
 * @returns {{send: (message: object) => Promise<void>, close: () => void}}
 */
export function openSignal({ room, role, onMessage, onPeer, onOpen, onError }) {
  const query = `room=${encodeURIComponent(room)}&role=${role}`;
  const source = new EventSource(`${BASE}/events?${query}`);

  source.onmessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message?.type === 'peer') onPeer?.(!!message.present);
    else if (message?.type) onMessage(message);
  };
  source.onopen = () => onOpen?.();
  source.onerror = () => onError?.();

  return {
    async send(message) {
      const res = await fetch(`${BASE}/send?${query}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message)
      });
      if (!res.ok) throw new Error(`signal relay answered ${res.status}`);
    },
    close() {
      source.close();
    }
  };
}
