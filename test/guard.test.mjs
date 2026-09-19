// The guard is the one part of the service where a mistake is a security hole rather
// than a bad screenshot, so these tests try the ways people actually sneak an internal
// address past a URL check: disguised IPv4 forms, IPv6 wrappers around IPv4, names that
// resolve to loopback, and the proxy asked directly.
//
// Two tests need the internet (resolving localtest.me, which public DNS answers with
// 127.0.0.1, and reaching example.com). They say so when they fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {
  isPublicAddress, parseTarget, requestAllowed, resolvePublic, startProxy, ALLOWED_PORTS,
} from '../lib/guard.mjs';

test('private and special-purpose addresses are never public', () => {
  for (const ip of [
    '127.0.0.1', '127.255.255.254', '10.1.2.3', '172.16.0.1', '172.17.0.1', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '0.1.2.3', '224.0.0.1',
    '255.255.255.255', '198.18.0.1', '192.0.2.1', '192.0.0.8',
    '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fe80::1', 'fe80::1%en0', 'fc00::1',
    'fd12:3456::1', 'ff02::1', '64:ff9b::7f00:1', '2002:7f00:1::', '2001:db8::1', '2001::1',
    '[::1]', 'not-an-ip', '',
  ]) assert.equal(isPublicAddress(ip), false, ip);
});

test('ordinary internet addresses are public', () => {
  for (const ip of [
    '93.184.215.14', '1.1.1.1', '8.8.8.8', '173.208.138.126', '172.32.0.1', '100.128.0.1',
    '2606:4700:4700::1111', '2a00:1450:4001:80b::200e',
  ]) assert.equal(isPublicAddress(ip), true, ip);
});

test('what people type is accepted and normalised', () => {
  assert.equal(parseTarget('example.com').url, 'https://example.com/');
  assert.equal(parseTarget('  http://example.com/a?b=1#c ').url, 'http://example.com/a?b=1#c');
  assert.equal(parseTarget('https://example.com:443/').url, 'https://example.com/');
  assert.equal(parseTarget('HTTPS://Example.COM/Path').url, 'https://example.com/Path');
  assert.equal(parseTarget('https://bücher.de/').host, 'xn--bcher-kva.de');
});

test('private, disguised and non-web targets are refused', () => {
  for (const bad of [
    '', '   ', 'localhost', 'http://localhost/', 'http://LOCALHOST./', 'http://app.localhost/',
    'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://017700000001/',
    'http://127.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:a9fe:a9fe]/',
    'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://0.0.0.0/',
    'http://example.com:8000/', 'https://example.com:22/', 'http://example.com:0/',
    'ftp://example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi',
    'http://user:pass@example.com/', 'http://intranet/', 'http://printer.local/',
    'http://db.internal/', 'http://router.home.arpa/', 'x'.repeat(3000),
  ]) assert.throws(() => parseTarget(bad), undefined, JSON.stringify(bad.slice(0, 60)));
});

test('the in-browser fence passes the web and stops local targets', () => {
  for (const ok of ['https://example.com/x.css', 'http://cdn.example.com/a.png', 'data:image/png;base64,AA', 'about:blank', 'blob:https://example.com/1'])
    assert.equal(requestAllowed(ok), true, ok);
  for (const bad of ['http://127.0.0.1/', 'http://localhost/', 'http://a.localhost/', 'http://[::1]/', 'http://10.0.0.5/',
    'http://169.254.169.254/', 'http://example.com:8080/', 'file:///etc/hosts', 'chrome://version', 'ws://127.0.0.1/', 'nonsense'])
    assert.equal(requestAllowed(bad), false, bad);
});

test('a name that resolves to loopback is refused as private (needs DNS)', async () => {
  await assert.rejects(resolvePublic('localhost'), (err) => err.reason === 'private');
  await assert.rejects(resolvePublic('localtest.me'), (err) => {
    assert.equal(err.reason, 'private', 'localtest.me should resolve to 127.0.0.1 — is this machine online?');
    return true;
  });
});

// ── the proxy ────────────────────────────────────────────────────────────────
function viaProxy(proxyPort, url) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: url, headers: { host: new URL(url).host } });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
}

function connectVia(proxyPort, authority) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    sock.once('data', (d) => { resolve(d.toString().split('\r\n')[0]); sock.destroy(); });
    sock.on('error', reject);
  });
}

test('the proxy never opens a connection to a private address', async (t) => {
  // Stands in for everything on the box that must stay out of reach.
  let hits = 0;
  const secret = http.createServer((req, res) => { hits += 1; res.end('secret'); });
  await new Promise((r) => secret.listen(0, '127.0.0.1', r));
  const port = secret.address().port;
  // Let its port through, so every refusal below is for the ADDRESS — the check that
  // matters once a request is on 80 or 443.
  ALLOWED_PORTS.add(port);
  const proxy = await startProxy();
  const proxyPort = Number(new URL(proxy.server).port);
  t.after(async () => { ALLOWED_PORTS.delete(port); secret.close(); await proxy.close(); });

  for (const host of ['127.0.0.1', 'localhost', 'localtest.me', '[::1]', '0.0.0.0', '127.1', '2130706433']) {
    assert.equal(await viaProxy(proxyPort, `http://${host}:${port}/`), 403, `http ${host}`);
    assert.match(await connectVia(proxyPort, `${host}:${port}`), /^HTTP\/1\.1 403/, `CONNECT ${host}`);
  }
  assert.match(await connectVia(proxyPort, 'example.com:22'), /^HTTP\/1\.1 403/, 'CONNECT to a non-web port');
  assert.equal(hits, 0, 'the private server was reached');
});

test('the proxy does let the public web through (needs internet)', async (t) => {
  const proxy = await startProxy();
  t.after(() => proxy.close());
  const proxyPort = Number(new URL(proxy.server).port);
  assert.equal(await viaProxy(proxyPort, 'http://example.com/'), 200);
  assert.match(await connectVia(proxyPort, 'example.com:443'), /^HTTP\/1\.1 200/);
});
