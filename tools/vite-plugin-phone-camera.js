/**
 * The phone-camera signalling relay, as a Vite dev-server plugin.
 *
 * A phone on the same Wi-Fi can stand in for the webcam: it opens
 * `phone.html`, and its camera is streamed to the desktop over WebRTC — a
 * direct peer-to-peer connection on the local network, hardware-encoded on
 * the phone and decoded by the desktop's browser. WebRTC needs a way for the
 * two ends to swap a handful of messages before that connection exists (the
 * offer, the answer and the ICE candidates), and that is all this plugin is:
 * a mailbox with two slots per room, served under `/__phone-cam/`.
 *
 *   GET  /__phone-cam/info                    what the desktop needs to draw
 *                                             the QR code — whether the server
 *                                             is on the LAN over HTTPS, and at
 *                                             which addresses
 *   GET  /__phone-cam/events?room=…&role=…    a server-sent-event stream of
 *                                             everything the *other* role posts
 *   POST /__phone-cam/send?room=…&role=…      post one JSON message to the
 *                                             other role
 *
 * SSE + fetch rather than a WebSocket on purpose: they are plain HTTPS
 * requests, so once the phone has accepted the dev server's self-signed
 * certificate for the page, they work — iOS Safari in particular will refuse
 * a `wss://` upgrade to an untrusted certificate even after the page loaded.
 *
 * LOCAL ONLY. This lives in the dev server, so it exists only while
 * `npm run dev:lan` is running and only for devices that can reach that
 * machine. A deployed build has no relay at all: shipping this for real would
 * need a small signalling backend (this file, on a server, with some notion
 * of who is pairing with whom) and, off the local network, a TURN server. For
 * now the sandbox is one person at one desk, and the dev server is enough.
 */

const PREFIX = '/__phone-cam';
const ROLES = new Set(['desktop', 'phone']);
/** Messages held for a role that is not connected yet. A handshake is ~20. */
const QUEUE_CAP = 64;
/** SSE comment lines keep proxies and idle-timeouts from dropping the stream. */
const HEARTBEAT_MS = 15000;
const MAX_BODY = 64 * 1024;

const other = (role) => (role === 'desktop' ? 'phone' : 'desktop');

export default function phoneCamera() {
  /** @type {Map<string, {desktop: Side, phone: Side}>} */
  const rooms = new Map();
  /** @type {import('vite').ViteDevServer} */
  let server = null;

  /** @typedef {{res: import('node:http').ServerResponse|null, queue: object[]}} Side */

  function room(id) {
    let entry = rooms.get(id);
    if (!entry) {
      entry = { desktop: { res: null, queue: [] }, phone: { res: null, queue: [] } };
      rooms.set(id, entry);
    }
    return entry;
  }

  /** Deliver now if the role is listening, otherwise hold it for when it is. */
  function push(side, message) {
    if (side.res) {
      write(side.res, `data: ${JSON.stringify(message)}\n\n`);
      return;
    }
    side.queue.push(message);
    if (side.queue.length > QUEUE_CAP) side.queue.shift();
  }

  /** A write racing the client's disconnect must not take the dev server down. */
  function write(res, chunk) {
    try {
      res.write(chunk);
    } catch {
      /* the close handler is about to run */
    }
  }

  function json(res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function info(res) {
    const urls = server?.resolvedUrls ?? { local: [], network: [] };
    const all = [...urls.network, ...urls.local];
    json(res, 200, {
      available: true,
      https: all.some((url) => url.startsWith('https:')),
      // The phone has to reach the server across the LAN, so only the
      // network-facing addresses are any use to it; `local` is loopback.
      // Windows machines often expose several (Wi-Fi, Ethernet, a Hyper-V or
      // WSL virtual switch, a VPN); the desktop lets the user step through.
      urls: urls.network
    });
  }

  function events(req, res, id, role) {
    const entry = room(id);
    const side = entry[role];
    const peer = entry[other(role)];

    // A second tab, or a reconnect the server has not noticed yet: the old
    // stream is ended so the room never has two listeners in one slot.
    if (side.res) side.res.end();

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    // No `Connection: keep-alive` header: Vite serves HTTPS over HTTP/2, which
    // rejects connection-specific headers outright.
    res.flushHeaders?.();
    // An unhandled 'error' on a response is fatal to the process; a client
    // that vanishes mid-write is routine here.
    res.on('error', () => {});
    write(res, ': open\n\n');
    side.res = res;

    for (const message of side.queue.splice(0)) push(side, message);
    push(side, { type: 'peer', present: !!peer.res });
    // Presence is only ever told live. Queued, it would replay stale — a
    // phone joining later would first hear "the desktop is here" from an
    // hour ago, then "it left", before anything current.
    if (peer.res) push(peer, { type: 'peer', present: true });

    const heartbeat = setInterval(() => write(res, ': ping\n\n'), HEARTBEAT_MS);

    req.on('close', () => {
      clearInterval(heartbeat);
      if (side.res !== res) return;
      side.res = null;
      if (peer.res) push(peer, { type: 'peer', present: false });
      if (!peer.res && !peer.queue.length) rooms.delete(id);
    });
  }

  async function send(req, res, id, role) {
    let message;
    try {
      message = JSON.parse(await readBody(req));
    } catch {
      json(res, 400, { error: 'expected a JSON body' });
      return;
    }
    if (!message || typeof message.type !== 'string') {
      json(res, 400, { error: 'message needs a string `type`' });
      return;
    }
    push(room(id)[other(role)], message);
    res.statusCode = 204;
    res.end();
  }

  function handle(req, res, next) {
    const url = new URL(req.url, 'http://localhost');
    const route = url.pathname;

    if (route === '/info' && req.method === 'GET') {
      info(res);
      return;
    }

    const id = url.searchParams.get('room') ?? '';
    const role = url.searchParams.get('role') ?? '';
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(id) || !ROLES.has(role)) {
      json(res, 400, { error: 'need a room id and a role of desktop|phone' });
      return;
    }

    if (route === '/events' && req.method === 'GET') {
      events(req, res, id, role);
      return;
    }
    if (route === '/send' && req.method === 'POST') {
      send(req, res, id, role);
      return;
    }
    next();
  }

  return {
    name: 'phone-camera-signal',
    apply: 'serve',
    configureServer(devServer) {
      server = devServer;
      // Registered inside `configureServer` so it runs *before* Vite's own
      // middlewares — the SPA fallback would otherwise answer `/info` with
      // index.html and a 200.
      devServer.middlewares.use(PREFIX, handle);
    }
  };
}
