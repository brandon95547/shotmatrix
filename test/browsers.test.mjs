// The end-to-end version of the guard test: real browsers, pointed at the proxy the way
// the service points them, asked to load a server on loopback. Slow (it starts all three
// engines), which is why it is its own file: `node --test test/browsers.test.mjs`.
//
// It checks the service's setup, and it also records what each engine does WITHOUT the
// in-context fence — whether it would have gone around the proxy for a loopback address.
// As of Playwright 1.55 all three send loopback through the proxy, so every line reads
// "blocked" and the fence is a second layer. If a line ever reads REACHED under "proxy
// only", an engine has started going around the proxy and the fence is what is holding.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ENGINES } from '../lib/matrix.mjs';
import { startProxy, guardContext, ALLOWED_PORTS } from '../lib/guard.mjs';

const firefoxPrefs = {
  'network.proxy.allow_hijacking_localhost': true,
  'media.peerconnection.enabled': false,
  'network.http.http3.enable': false,
};

test('no engine reaches a loopback server through the service setup', async (t) => {
  let hits = 0;
  const secret = http.createServer((req, res) => { hits += 1; res.end('<h1>secret</h1>'); });
  await new Promise((r) => secret.listen(0, '127.0.0.1', r));
  const port = secret.address().port;
  ALLOWED_PORTS.add(port);
  const proxy = await startProxy();
  t.after(async () => { ALLOWED_PORTS.delete(port); secret.close(); await proxy.close(); });

  for (const [key, engine] of Object.entries(ENGINES)) {
    const browser = await engine.launcher.launch({
      proxy: { server: proxy.server },
      ...(key === 'chromium' ? { args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] } : {}),
      ...(key === 'firefox' ? { firefoxUserPrefs: firefoxPrefs } : {}),
    });
    try {
      for (const fenced of [false, true]) {
        const ctx = await browser.newContext({ serviceWorkers: 'block' });
        if (fenced) await guardContext(ctx);
        const page = await ctx.newPage();
        for (const host of ['127.0.0.1', 'localhost', 'localtest.me']) {
          const before = hits;
          await page.goto(`http://${host}:${port}/`, { timeout: 15000 }).catch(() => {});
          const reached = hits > before;
          t.diagnostic(`${key.padEnd(8)} ${fenced ? 'fenced  ' : 'proxy only'} ${host.padEnd(12)} ${reached ? 'REACHED' : 'blocked'}`);
          if (fenced) assert.equal(reached, false, `${key} reached ${host} with the fence on`);
        }
        if (fenced) {
          // WebKit has no launch switch for WebRTC; the fence deletes the API instead.
          const rtc = await page.evaluate(() => typeof window.RTCPeerConnection);
          assert.equal(rtc, 'undefined', `${key} still exposes RTCPeerConnection`);
        }
        await ctx.close();
      }
    } finally {
      await browser.close();
    }
  }
});
