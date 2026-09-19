// Keeps the web service's browsers on the public internet.
//
// A tool that loads any URL a stranger types is a way into whatever network it runs on.
// On the prod box that is not hypothetical: phansora-api listens on 0.0.0.0:8000, and a
// container can reach the host through its bridge gateway. Asked for http://172.17.0.1:8000,
// an unguarded browser would render that API's answer and hand back a picture of it.
//
// So every connection any of the three browsers makes goes through a forward proxy in
// this process, and the proxy decides by the ADDRESS it is about to connect to, not by
// the name it was given:
//
//   - the port must be 80 or 443, which is where websites live and nothing else on that
//     box answers publicly;
//   - the name is resolved HERE, every address it resolves to must be public, and the
//     socket is opened to that exact address. Checking a name and then letting the
//     browser resolve it again is the DNS-rebinding hole: the second answer can be
//     127.0.0.1. Nothing resolves twice.
//
// Redirects need no special case. A public page that 302s to 169.254.169.254 makes the
// browser open a second connection, and that one goes through the proxy like the first.
//
// parseTarget() is the early, friendly check on what the visitor typed, so a bad address
// gets a sentence back instead of a failed run. requestAllowed() is a second fence inside
// each browser context for the one thing a proxy cannot see: an engine that talks to a
// literal loopback address directly instead of asking the proxy.

import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';

export const ALLOWED_PORTS = new Set([80, 443]);

export class GuardError extends Error {
  constructor(message, reason) {
    super(message);
    this.reason = reason;
  }
}

// ── which addresses count as public ─────────────────────────────────────────
// IPv4: everything except the special-purpose blocks (RFC 6890 and its updates).
// 0.0.0.0/8 matters more than it looks — on Linux, connecting to 0.0.0.0 reaches the
// local host.
const BLOCKED_V4 = new net.BlockList();
for (const [addr, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCKED_V4.addSubnet(addr, prefix, 'ipv4');

// IPv6: an ALLOW list, because the special cases are easier to miss than to list the
// one range that is actually the internet. Global unicast is 2000::/3; everything
// outside it — loopback, link-local, unique-local, multicast, and the IPv4-mapped
// ::ffff:0:0/96 that would smuggle 127.0.0.1 in as an IPv6 address — is refused.
// Inside it, the transition and documentation ranges come back out.
const GLOBAL_V6 = new net.BlockList();
GLOBAL_V6.addSubnet('2000::', 3, 'ipv6');
const SPECIAL_V6 = new net.BlockList();
for (const [addr, prefix] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
]) SPECIAL_V6.addSubnet(addr, prefix, 'ipv6');

export function isPublicAddress(ip) {
  const bare = String(ip).replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  try {
    if (net.isIPv4(bare)) return !BLOCKED_V4.check(bare, 'ipv4');
    if (net.isIPv6(bare)) return GLOBAL_V6.check(bare, 'ipv6') && !SPECIAL_V6.check(bare, 'ipv6');
  } catch { /* unparseable: not public */ }
  return false;
}

const bareHost = (h) => String(h).replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();

// Names that only mean something inside a private network. DNS would refuse most of
// them anyway, and the address check would refuse the rest; this is here so the visitor
// is told why rather than handed a lookup failure.
const PRIVATE_NAME = /(^|\.)(localhost|localdomain|local|internal|intranet|lan|home|corp|home\.arpa)$/;

// ── what the visitor typed ──────────────────────────────────────────────────
export function parseTarget(input) {
  let s = String(input ?? '').trim();
  if (!s) throw new GuardError('Enter the address of the page to capture.', 'empty');
  if (s.length > 2048) throw new GuardError('That address is too long.', 'length');
  // "example.com" is what people type. https is the right guess for it in 2026.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;

  let u;
  try { u = new URL(s); } catch { throw new GuardError('That doesn’t look like a web address.', 'syntax'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new GuardError('Only http:// and https:// pages can be captured.', 'scheme');
  }
  if (u.username || u.password) {
    throw new GuardError('Leave the username and password out of the address.', 'credentials');
  }
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (!ALLOWED_PORTS.has(port)) {
    throw new GuardError('Only sites on the standard web ports (80 and 443) can be captured.', 'port');
  }

  // The WHATWG parser has already turned 2130706433, 0x7f.1 and 017700000001 into
  // 127.0.0.1 by this point, so an IPv4 in disguise is checked as what it is.
  const host = bareHost(u.hostname);
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw new GuardError('That address is on a private network. Only public sites can be captured.', 'private');
  } else if (!host.includes('.') || PRIVATE_NAME.test(host)) {
    throw new GuardError('That looks like a private network name. Only public sites can be captured.', 'private');
  }
  return { url: u.toString(), host, port };
}

// ── resolving, once ─────────────────────────────────────────────────────────
const LOOKUP_TIMEOUT_MS = 8000;

export async function resolvePublic(hostname) {
  const host = bareHost(hostname);
  if (net.isIP(host)) {
    if (!isPublicAddress(host)) throw new GuardError('That address is on a private network.', 'private');
    return { address: host, family: net.isIP(host) };
  }
  let timer;
  let addrs;
  try {
    addrs = await Promise.race([
      dns.lookup(host, { all: true, verbatim: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('lookup timed out')), LOOKUP_TIMEOUT_MS); }),
    ]);
  } catch {
    throw new GuardError('Couldn’t find that site. Check the address and try again.', 'dns');
  } finally {
    clearTimeout(timer);
  }
  if (!addrs?.length) throw new GuardError('Couldn’t find that site. Check the address and try again.', 'dns');
  // ALL of them, not the first. A name that answers with one public address and one
  // private one is either misconfigured or trying something, and both are a no.
  if (addrs.some((a) => !isPublicAddress(a.address))) {
    throw new GuardError('That site points at a private network address, which this tool won’t visit.', 'private');
  }
  // IPv4 first: the container has no IPv6 route, so a v6 answer is a connection that
  // can only fail.
  return addrs.find((a) => a.family === 4) || addrs[0];
}

// ── the second fence, inside each browser context ───────────────────────────
// Synchronous and DNS-free on purpose: it runs for every request a page makes. It stops
// schemes a page has no business loading and literal private addresses; names are left
// to the proxy, which resolves them properly.
export function requestAllowed(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return true;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (!ALLOWED_PORTS.has(port)) return false;
  const host = bareHost(u.hostname);
  if (net.isIP(host)) return isPublicAddress(host);
  return host !== 'localhost' && !host.endsWith('.localhost');
}

// WebRTC is the one way a page opens a socket that neither the proxy nor the route
// fence sees: it sends UDP straight to whatever address the page names. Chromium and
// Firefox have launch switches for that (server.mjs), and WebKit has none, so in every
// engine the APIs are also deleted from each frame before the page's own scripts run.
const NO_WEBRTC = `for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'mozRTCPeerConnection',
  'RTCDataChannel', 'RTCIceTransport', 'RTCDtlsTransport', 'RTCSctpTransport']) {
  try { delete window[name]; } catch (e) { /* not configurable here */ }
}`;

export async function guardContext(ctx) {
  await ctx.addInitScript(NO_WEBRTC);
  await ctx.route('**/*', (route) =>
    requestAllowed(route.request().url()) ? route.continue() : route.abort('blockedbyclient'));
}

// ── the proxy ───────────────────────────────────────────────────────────────
const IDLE_MS = 30000;
const HOP_BY_HOP = ['connection', 'proxy-connection', 'keep-alive', 'proxy-authorization',
  'proxy-authenticate', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

function refuse(socket, status, text) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${text}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
}

// "host:443" or "[2001:db8::1]:443", as a CONNECT request names its target.
function parseAuthority(authority) {
  const m = /^\[([^\]]+)\]:(\d{1,5})$/.exec(authority) || /^([^:[\]]+):(\d{1,5})$/.exec(authority);
  return m ? { host: m[1], port: Number(m[2]) } : null;
}

// Listens on loopback on an ephemeral port. Only this process's browsers are pointed at
// it, and inside the container nothing else can reach it.
//
// `onBlock(reason, host)` hears every refusal. The service starts one proxy per engine,
// and each engine renders one cell at a time, so a refusal can be pinned to the cell
// that caused it — which is how a page that redirected somewhere private is reported as
// blocked rather than as a blank screenshot.
//
// A refused plain-http request gets a real 403 back, marked with X-Shotmatrix-Blocked
// and a sentence saying why, because that response is what the browser then renders.
export const BLOCKED_HEADER = 'x-shotmatrix-blocked';
const BLOCKED_PAGE = '<!doctype html><title>Blocked</title><p style="font:16px/1.5 system-ui;margin:2rem">Shot Matrix blocked this request: it leads to a private network address or a port other than 80 and 443.</p>';

export async function startProxy({ log = () => {}, onBlock = () => {} } = {}) {
  const block = (reason, host) => { log('blocked', reason, host); onBlock(reason, host); };
  const refuseHttp = (res, reason, host) => {
    block(reason, host);
    res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(BLOCKED_PAGE), [BLOCKED_HEADER]: reason });
    res.end(BLOCKED_PAGE);
  };
  const server = http.createServer();
  server.maxConnections = 512;
  // Tunnels leave the HTTP server's bookkeeping once they are CONNECTed, so close() would
  // wait on them forever. They are tracked here and cut when the proxy closes.
  const tunnels = new Set();
  const track = (sock) => { tunnels.add(sock); sock.once('close', () => tunnels.delete(sock)); };

  // HTTPS, and WebSockets, which browsers tunnel with CONNECT too.
  server.on('connect', async (req, client, head) => {
    client.on('error', () => {});
    const target = parseAuthority(req.url);
    if (!target) return refuse(client, 400, 'Bad Request');
    if (!ALLOWED_PORTS.has(target.port)) {
      block(`port ${target.port}`, target.host);
      return refuse(client, 403, 'Forbidden');
    }
    let addr;
    try { addr = await resolvePublic(target.host); } catch (err) {
      block(err.reason, target.host);
      return refuse(client, 403, 'Forbidden');
    }
    if (client.destroyed) return;
    const upstream = net.connect({ host: addr.address, port: target.port, family: addr.family });
    track(client);
    track(upstream);
    let open = false;
    upstream.setTimeout(IDLE_MS, () => upstream.destroy());
    client.setTimeout(IDLE_MS, () => client.destroy());
    upstream.once('connect', () => {
      open = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => { if (open) client.destroy(); else refuse(client, 502, 'Bad Gateway'); });
    upstream.on('close', () => client.destroy());
    client.on('close', () => upstream.destroy());
  });

  // Plain http://, which arrives in absolute form: GET http://host/path HTTP/1.1
  server.on('request', async (req, res) => {
    let u;
    try { u = new URL(req.url); } catch { res.writeHead(400).end(); return; }
    if (u.protocol !== 'http:') { res.writeHead(400).end(); return; }
    const port = u.port ? Number(u.port) : 80;
    if (!ALLOWED_PORTS.has(port)) return refuseHttp(res, `port ${port}`, u.hostname);
    let addr;
    try { addr = await resolvePublic(u.hostname); } catch (err) {
      return refuseHttp(res, err.reason, u.hostname);
    }
    const headers = { ...req.headers };
    for (const h of HOP_BY_HOP) delete headers[h];
    const upstream = http.request({
      host: addr.address,
      family: addr.family,
      port,
      method: req.method,
      path: `${u.pathname}${u.search}`,
      headers,
      setHost: false, // keep the Host header the browser sent, not the bare IP
    });
    upstream.setTimeout(IDLE_MS, () => upstream.destroy(new Error('idle')));
    upstream.on('response', (up) => {
      const out = { ...up.headers };
      for (const h of HOP_BY_HOP) delete out[h];
      res.writeHead(up.statusCode || 502, out);
      up.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
    req.pipe(upstream);
  });

  // An absolute-form WebSocket upgrade. Browsers use CONNECT for these; anything else
  // asking is not one of our browsers.
  server.on('upgrade', (req, socket) => refuse(socket, 403, 'Forbidden'));
  server.on('clientError', (err, socket) => socket.destroy());

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
      for (const sock of tunnels) sock.destroy();
    }),
  };
}
