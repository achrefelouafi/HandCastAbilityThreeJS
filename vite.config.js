import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import phoneCamera from './tools/vite-plugin-phone-camera.js';

/**
 * Two ways to run the dev server:
 *
 *   npm run dev       — loopback only, plain HTTP. The default.
 *   npm run dev:lan   — `--mode lan`: listens on every interface over HTTPS
 *                       with a self-signed certificate, so a phone on the
 *                       same Wi-Fi can open `phone.html` and lend its camera
 *                       to the hand tracking. HTTPS is not optional there: a
 *                       browser only exposes `getUserMedia` to a secure
 *                       origin, and a LAN address over HTTP is not one.
 *
 * The signalling relay behind the phone camera is a dev-server plugin and is
 * always registered — in plain `dev` it only answers `/__phone-cam/info`, which
 * is how the camera panel knows to say "restart with dev:lan". It is a local,
 * single-user convenience: a deployed build would need a real backend for it.
 */
export default defineConfig(({ mode }) => {
  const lan = mode === 'lan';

  return {
    base: './',
    plugins: [phoneCamera(), ...(lan ? [basicSsl()] : [])],
    server: {
      host: lan ? true : '127.0.0.1',
      port: 5173,
      open: false
    },
    build: {
      target: 'es2022',
      sourcemap: true,
      chunkSizeWarningLimit: 2000
      // `phone.html` is deliberately not a build input: the page is useless
      // without the dev server's relay, so it does not ship.
    },
    // Large binary assets (FBX / HDR) live in /public and are served untouched.
    assetsInclude: ['**/*.fbx', '**/*.hdr']
  };
});
