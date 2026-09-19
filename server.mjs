#!/usr/bin/env node
// server.mjs — Shot Matrix as a web service, for the free tool on skylanex.com.
//
//   node server.mjs              (in prod: the Docker container, under systemd)
//
// The same matrix as the terminal tool, rendered by the same code (lib/matrix.mjs), with
// the four things a public version needs on top:
//
//   1. The browsers only ever reach the public internet — lib/guard.mjs.
//   2. Every run belongs to a signed-in account. nginx asks phansora's app whether the
//      visitor is signed in (auth_request) and passes the account id as X-Shotmatrix-User;
//      nothing but nginx can reach this port, and nginx overwrites whatever a visitor sent.
//      A run is visible to the account that started it and to no one else.
//   3. Starting a run costs the caller a proof of work — lib/pow.mjs.
//   4. Hard limits on everything a caller could otherwise turn into load: one run at a
//      time across the whole service, one per account, hourly and daily allowances per
//      account AND per address, a short queue, a deadline per page and per run, and a
//      height cap on full-page shots.
//
// nginx sits in front and adds its own request-rate limits, so a flood is turned away
// before it reaches Node — the rules are in skylanex.com's vhost on the prod box,
// /etc/nginx/conf.d/skylanex.com.conf. Everything is served under BASE_PATH so the paths
// here are the public ones, and nginx passes them through unchanged.
//
// API (all under BASE_PATH, default /api/shotmatrix):
//   GET  /health                 liveness, and how busy it is
//   GET  /challenge              a proof-of-work challenge
//   POST /jobs                   { url, engines, viewports, token, nonce } → { id }
//   GET  /jobs/:id               progress, and a summary of what each cell found
//   GET  /runs/:id/zip           every screenshot of a finished run, as one download
//
// NOTHING IS KEPT. The screenshots exist only in DATA_DIR, which in prod is a tmpfs — RAM,
// never the disk — and only until they are handed over: the zip is a one-time download,
// and the run is deleted the moment it has been sent in full. A run nobody downloads is
// deleted RUN_TTL_MIN (10) minutes after it finishes, and nothing outlives a restart.

import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdir, rm, stat, writeFile, statfs } from 'node:fs/promises';
import { ENGINES, VIEWPORTS, shootOne } from './lib/matrix.mjs';
import { parseTarget, resolvePublic, startProxy, guardContext, BLOCKED_HEADER } from './lib/guard.mjs';
import { createPow } from './lib/pow.mjs';
import { zipSize, writeZip } from './lib/zip.mjs';

// ── configuration ───────────────────────────────────────────────────────────
const env = process.env;
const num = (v, fallback) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback);
const CONFIG = {
  host: env.HOST || '127.0.0.1',
  port: num(env.PORT, 4700),
  base: (env.BASE_PATH || '/api/shotmatrix').replace(/\/+$/, ''),
  dataDir: env.DATA_DIR || path.join(os.tmpdir(), 'shotmatrix'),
  // Only honour X-Real-IP when nginx is the only thing that can reach this port — in
  // prod it is published on 127.0.0.1 alone. Off, every caller is the socket's address.
  trustProxy: env.TRUST_PROXY === '1',
  powBits: num(env.POW_BITS, 16),
  queueMax: num(env.QUEUE_MAX, 6),
  // Off only for local work without nginx in front: everyone is then one 'local' account.
  requireLogin: env.REQUIRE_LOGIN !== '0',
  perIpHour: num(env.PER_IP_HOUR, 6),
  perIpDay: num(env.PER_IP_DAY, 20),
  perUserHour: num(env.PER_USER_HOUR, 6),
  perUserDay: num(env.PER_USER_DAY, 20),
  runTtlMs: num(env.RUN_TTL_MIN, 10) * 60_000,
  reuseMs: num(env.REUSE_MIN, 10) * 60_000,
  navTimeoutMs: num(env.NAV_TIMEOUT_S, 25) * 1000,
  cellTimeoutMs: num(env.CELL_TIMEOUT_S, 60) * 1000,
  jobDeadlineMs: num(env.JOB_DEADLINE_S, 300) * 1000,
  maxHeight: num(env.MAX_HEIGHT, 10000),
  maxWidth: num(env.MAX_WIDTH, 4096),
  minFreeBytes: num(env.MIN_FREE_MB, 2048) * 1024 * 1024,
};
const RUNS = path.join(CONFIG.dataDir, 'runs');
const ENGINE_KEYS = Object.keys(ENGINES);
const VIEWPORT_KEYS = VIEWPORTS.map((v) => v.key);

// ── logging ─────────────────────────────────────────────────────────────────
// One line per event, to stdout, which journald keeps. No full URLs (a staging link can
// carry a token) and no raw IPs — nginx's access log already has those for anyone who
// needs to trace abuse, and this log does not need to be a second copy.
const ipSalt = crypto.randomBytes(8);
const ipTag = (ip) => crypto.createHash('sha256').update(ipSalt).update(ip).digest('hex').slice(0, 8);
const log = (...parts) => console.log(new Date().toISOString(), ...parts);

// ── state ───────────────────────────────────────────────────────────────────
const jobs = new Map(); // id → job
const waiting = []; // job ids, first in first out
let active = null;
const starts = new Map(); // 'ip:…' / 'user:…' → timestamps of runs it started, for the allowances

const pow = createPow({ bits: CONFIG.powBits });

const newId = () => crypto.randomBytes(16).toString('base64url'); // 22 chars
const runDir = (id) => path.join(RUNS, id);

// ── HTTP plumbing ───────────────────────────────────────────────────────────
const COMMON_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function send(res, status, body, headers = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    ...COMMON_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(json);
}

function clientIp(req) {
  if (CONFIG.trustProxy) {
    // nginx overwrites this header with the connecting address, so a visitor cannot set
    // it — but every allowance keys on it, so it is also checked to be an address.
    const real = String(req.headers['x-real-ip'] || '').trim();
    if (net.isIP(real)) return real;
  }
  return req.socket.remoteAddress || 'unknown';
}

// The signed-in account, as nginx vouched for it — or null. An id is digits and nothing
// else, so a header that is anything more is not one nginx wrote.
function userOf(req) {
  const user = String(req.headers['x-shotmatrix-user'] || '').trim();
  if (/^\d{1,19}$/.test(user)) return user;
  return CONFIG.requireLogin ? null : 'local';
}

// A run, if it is the caller's. Someone else's run answers exactly as a missing one does,
// so an id tells a stranger nothing — not even that it exists.
function ownJob(req, id) {
  const job = jobs.get(id);
  return job && job.user === userOf(req) ? job : null;
}

// The run and its files, gone. Called once the zip has been handed over, when a run fails
// with nothing to hand over, and by the sweep for runs nobody came back for.
async function forget(id, why) {
  const job = jobs.get(id);
  jobs.delete(id);
  await rm(runDir(id), { recursive: true, force: true }).catch(() => {});
  if (job) log('deleted', id, why);
}

async function readJson(req, limit = 8192) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// A known, non-empty subset in canonical order — or null.
function pickList(value, known) {
  if (value === undefined) return known.slice();
  if (!Array.isArray(value) || value.length > known.length) return null;
  const set = new Set(value.filter((v) => typeof v === 'string'));
  if ([...set].some((v) => !known.includes(v))) return null;
  const list = known.filter((k) => set.has(k));
  return list.length ? list : null;
}

// ── allowances ──────────────────────────────────────────────────────────────
// Counted twice — per account, and per address — and the first one spent answers. The
// account is the real unit now that every run has one; the address still counts because
// making a second account is free and a script can make twenty.
function allowance(key, perHour, perDay, now = Date.now()) {
  const times = (starts.get(key) || []).filter((t) => now - t < 86_400_000);
  starts.set(key, times);
  const lastHour = times.filter((t) => now - t < 3_600_000);
  if (lastHour.length >= perHour) {
    const wait = Math.ceil((lastHour[0] + 3_600_000 - now) / 60_000);
    return { message: `That’s ${perHour} runs this hour — the limit that keeps this free for everyone. Try again in ${wait} minute${wait === 1 ? '' : 's'}.`, retryAfter: wait * 60 };
  }
  if (times.length >= perDay) {
    const wait = Math.ceil((times[0] + 86_400_000 - now) / 3_600_000);
    return { message: `That’s ${perDay} runs today, which is the daily limit. It resets in about ${wait} hour${wait === 1 ? '' : 's'}.`, retryAfter: wait * 3600 };
  }
  return null;
}

async function diskIsLow() {
  try {
    const s = await statfs(CONFIG.dataDir);
    return s.bavail * s.bsize < CONFIG.minFreeBytes;
  } catch { return false; }
}

// ── routes ──────────────────────────────────────────────────────────────────
const GONE = 'That run is gone. Screenshots are deleted once they’re downloaded, or 10 minutes after the run finishes.';

async function route(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (!pathname.startsWith(`${CONFIG.base}/`)) return send(res, 404, { error: 'Not found.' });
  const p = pathname.slice(CONFIG.base.length);
  const get = req.method === 'GET' || req.method === 'HEAD';
  let m;

  if (get && p === '/health') {
    return send(res, 200, { ok: true, running: Boolean(active), queued: waiting.length });
  }
  if (get && p === '/challenge') {
    const { token, salt, bits } = pow.issue();
    return send(res, 200, { token, salt, bits });
  }
  // Everything past here is a run, and a run needs an account.
  if (!userOf(req)) return send(res, 401, { error: 'Log in to use Shot Matrix.', code: 'login' });

  if (req.method === 'POST' && p === '/jobs') return createJob(req, res);
  if (get && (m = /^\/jobs\/([\w-]{22})$/.exec(p))) {
    const job = ownJob(req, m[1]);
    if (!job) return send(res, 404, { error: GONE, code: 'gone' });
    return send(res, 200, publicJob(job));
  }
  if (get && (m = /^\/runs\/([\w-]{22})\/zip$/.exec(p))) return sendZip(req, res, m[1]);
  return send(res, 404, { error: 'Not found.' });
}

async function createJob(req, res) {
  const ip = clientIp(req);
  const user = userOf(req);
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    return send(res, 415, { error: 'Send the request as JSON.' });
  }
  let body;
  try { body = await readJson(req); } catch { return send(res, 400, { error: 'Couldn’t read that request.' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return send(res, 400, { error: 'Couldn’t read that request.' });

  // The honeypot field on the form. A person never sees it; a form-filling bot fills
  // every field it finds. Refused with the same words as any malformed request, so it
  // teaches the bot nothing.
  if (body.website) return send(res, 400, { error: 'Couldn’t read that request.' });

  // Cheap checks first, so a typo does not spend the visitor's proof of work.
  let target;
  try { target = parseTarget(body.url); } catch (err) {
    return send(res, 400, { error: err.message, code: 'url' });
  }
  const engines = pickList(body.engines, ENGINE_KEYS);
  const viewports = pickList(body.viewports, VIEWPORT_KEYS);
  if (!engines) return send(res, 400, { error: 'Pick at least one browser.', code: 'engines' });
  if (!viewports) return send(res, 400, { error: 'Pick at least one screen size.', code: 'viewports' });

  const powError = pow.verify(body.token, body.nonce);
  if (powError) {
    return send(res, 403, {
      error: 'The anti-spam check didn’t go through. Try again.',
      code: 'pow',
      reason: powError,
    });
  }

  // The same account asking for the same page and matrix again, while its last run of it
  // is still waiting to be downloaded: hand back that run rather than render it twice.
  // Only ever their OWN run — handing one account's run to another would show them that
  // somebody captured that exact address, which matters when the address carries a token.
  const key = `${target.url}|${engines}|${viewports}`;
  const now = Date.now();
  for (const job of jobs.values()) {
    if (job.key === key && job.user === user && job.state !== 'failed' && now - job.createdAt < CONFIG.reuseMs) {
      return send(res, 200, { id: job.id, reused: true });
    }
  }

  // One at a time per account. The id comes back so the page can reattach to it.
  for (const job of jobs.values()) {
    if (job.user === user && (job.state === 'queued' || job.state === 'running')) {
      return send(res, 429, { error: 'You already have a run going — it’s below.', code: 'yours', id: job.id });
    }
  }

  const over = allowance(`user:${user}`, CONFIG.perUserHour, CONFIG.perUserDay, now)
    || allowance(`ip:${ip}`, CONFIG.perIpHour, CONFIG.perIpDay, now);
  if (over) return send(res, 429, { error: over.message, code: 'allowance' }, { 'Retry-After': String(over.retryAfter) });

  if (waiting.length >= CONFIG.queueMax || await diskIsLow()) {
    return send(res, 503, { error: 'Shot Matrix is busy right now. Try again in a few minutes.', code: 'busy' }, { 'Retry-After': '120' });
  }

  // The proxy checks every connection the browsers make; this asks the same question once
  // up front, so an address that leads nowhere public is refused in words, not as a matrix
  // of twenty-four failed cells.
  try { await resolvePublic(target.host); } catch (err) {
    return send(res, 400, { error: err.message, code: 'url' });
  }

  const job = {
    id: newId(),
    key,
    ip,
    user,
    url: target.url,
    host: target.host,
    engines,
    viewports,
    state: 'queued',
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    error: null,
    cells: viewports.flatMap((viewport) => engines.map((engine) => ({ engine, viewport, state: 'queued' }))),
  };
  jobs.set(job.id, job);
  waiting.push(job.id);
  starts.get(`user:${user}`).push(now);
  starts.get(`ip:${ip}`).push(now);
  log('queued', job.id, job.host, `${engines.length}x${viewports.length}`, `user:${user}`, `ip:${ipTag(ip)}`, `ahead:${waiting.length - 1 + (active ? 1 : 0)}`);
  pump();
  return send(res, 202, { id: job.id, reused: false });
}

function publicJob(job) {
  const position = job.state === 'queued' ? waiting.indexOf(job.id) + 1 + (active ? 1 : 0) : 0;
  return {
    id: job.id,
    url: job.url,
    host: job.host,
    state: job.state,
    ahead: Math.max(0, position - 1),
    engines: job.engines,
    viewports: job.viewports,
    total: job.cells.length,
    done: job.cells.filter((c) => c.state !== 'queued' && c.state !== 'running').length,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    expiresAt: job.finishedAt ? job.finishedAt + CONFIG.runTtlMs : null,
    maxHeight: CONFIG.maxHeight,
    cells: job.cells.map((c) => publicCell(c)),
  };
}

// The status code has its own field, and the page its own badge for it, so it is left
// out of the problem list here. report.json in the zip keeps everything.
function publicCell(c) {
  const problems = (c.problems || []).filter((p) => !/^HTTP \d{3}$/.test(p));
  return {
    engine: c.engine,
    viewport: c.viewport,
    state: c.state,
    status: c.status ?? null,
    width: c.size?.w ?? null,
    height: c.size?.h ?? null,
    overflows: Boolean(c.size?.overflows),
    truncated: Boolean(c.truncated),
    problems: problems.length,
    problemList: problems.slice(0, 6),
    error: c.error || null,
  };
}

async function sendZip(req, res, id) {
  const job = ownJob(req, id);
  if (!job) return send(res, 404, { error: GONE, code: 'gone' });
  if (job.state !== 'done') return send(res, 409, { error: 'That run hasn’t finished yet.' });
  const folder = `shotmatrix-${job.host}`;
  const entries = [];
  for (const c of job.cells) {
    for (const name of [c.fold, c.full]) {
      if (!name) continue;
      try {
        const info = await stat(path.join(runDir(id), name));
        entries.push({ name: `${folder}/${name}`, path: path.join(runDir(id), name), size: info.size });
      } catch { /* swept, or never written */ }
    }
  }
  try {
    const info = await stat(path.join(runDir(id), 'report.json'));
    entries.push({ name: `${folder}/report.json`, path: path.join(runDir(id), 'report.json'), size: info.size });
  } catch { /* no report */ }
  if (!entries.length) return send(res, 404, { error: 'Nothing in that run to download.' });

  res.writeHead(200, {
    ...COMMON_HEADERS,
    'Content-Type': 'application/zip',
    'Content-Length': zipSize(entries),
    'Cache-Control': 'private, no-store',
    'Content-Disposition': `attachment; filename="${folder}.zip"`,
  });
  if (req.method === 'HEAD') return res.end();
  // Handed over in full, then gone: the zip is the only copy there is, and it is theirs.
  // 'finish' means every byte left for the visitor (nginx does not buffer this route); a
  // download cut off part-way leaves the run in place to try again until it expires.
  res.once('finish', () => { forget(id, 'downloaded'); });
  const aborter = new AbortController();
  res.once('close', () => { if (!res.writableFinished) aborter.abort(); });
  try {
    await writeZip(res, entries, new Date(job.finishedAt || Date.now()), aborter.signal);
    res.end();
  } catch (err) {
    log('zip failed', id, err.message);
    res.destroy();
  }
}

// ── rendering ───────────────────────────────────────────────────────────────
// Every browser is launched pointing at the guard proxy, with the few engine switches
// that would otherwise let a page go around it: QUIC is UDP and cannot be proxied, and
// WebRTC opens UDP straight to whatever address a page names.
function launchOptions(engineKey, proxyServer) {
  const base = { proxy: { server: proxyServer }, timeout: 30000 };
  if (engineKey === 'chromium') {
    return { ...base, args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] };
  }
  if (engineKey === 'firefox') {
    return {
      ...base,
      firefoxUserPrefs: {
        // Firefox otherwise talks to localhost directly, around any proxy.
        'network.proxy.allow_hijacking_localhost': true,
        'media.peerconnection.enabled': false,
        'network.http.http3.enable': false,
        'network.dns.disablePrefetch': true,
        'network.prefetch-next': false,
      },
    };
  }
  return base;
}

// Playwright's errors are for developers. The page gets one of these instead; the log
// keeps the original.
function friendly(message) {
  if (!message) return null;
  if (/timed out|Timeout \d+ms exceeded/i.test(message)) return 'Timed out waiting for the page.';
  if (/NAME_NOT_RESOLVED|UNKNOWN_HOST|Could not resolve/i.test(message)) return 'Couldn’t find that site.';
  if (message === 'blocked') return 'Blocked: the page led to a private address, which this tool won’t visit.';
  if (/TUNNEL_CONNECTION_FAILED|BLOCKED_BY_CLIENT|blockedbyclient|PROXY/i.test(message)) return 'Blocked: the page led somewhere this tool won’t go.';
  if (/CONNECTION_REFUSED|ECONNREFUSED|Could not connect/i.test(message)) return 'The site refused the connection.';
  if (/CERT|SSL|certificate|SEC_ERROR|INADEQUATE_SECURITY/i.test(message)) return 'The site’s HTTPS certificate wasn’t accepted.';
  if (/launch|Executable doesn't exist/i.test(message)) return 'That browser is unavailable right now.';
  return 'The page couldn’t be captured.';
}

async function launch(engineKey, proxyServer) {
  return ENGINES[engineKey].launcher.launch(launchOptions(engineKey, proxyServer));
}

const TRANSIENT = /timed out|Timeout \d+ms exceeded|CONNECTION_RESET|EMPTY_RESPONSE|NET_RESET|NET_INTERRUPT|ECONNRESET|socket hang up/i;

// One cell, under its own deadline: the smaller of the per-page budget and whatever the
// run has left.
//
// `seen` is this engine's tally of proxy refusals, and a cell whose page was refused is
// reported as blocked. Two signs, because engines take a refusal differently: Chromium
// and WebKit render the proxy's 403 (so the page's own response carries the header), and
// Firefox swaps in an error page of its own that cannot be captured at all.
async function shoot(browser, engineKey, vp, url, dir, deadline, seen) {
  const aborter = new AbortController();
  const budget = Math.max(5000, Math.min(CONFIG.cellTimeoutMs, deadline - Date.now()));
  const timer = setTimeout(() => aborter.abort(), budget);
  const blocksBefore = seen.blocks;
  let pageBlocked = false;
  const blocked = (r) => ({ ...r, ok: false, files: [], error: 'blocked' });
  try {
    const r = await shootOne(browser, engineKey, vp, {
      url,
      outDir: dir,
      scheme: 'light',
      fullPage: true,
      fold: true,
      dismiss: null,
      timeout: CONFIG.navTimeoutMs,
      settle: 800,
      dpr: 1,
      waitUntil: 'domcontentloaded',
      loadWait: 8000,
      idleWait: 4000,
      maxScroll: CONFIG.maxHeight,
      maxHeight: CONFIG.maxHeight,
      maxWidth: CONFIG.maxWidth,
      foldFormat: 'jpeg',
      contextOptions: { serviceWorkers: 'block', acceptDownloads: false },
      prepareContext: async (ctx) => {
        await guardContext(ctx);
        ctx.on('response', (res) => {
          try {
            if (res.headers()[BLOCKED_HEADER] && !res.frame().parentFrame()) pageBlocked = true;
          } catch { /* a response from a frame already gone */ }
        });
      },
      signal: aborter.signal,
    });
    if (pageBlocked || (!r.ok && seen.blocks > blocksBefore)) return blocked(r);
    return r;
  } catch (err) {
    return { ok: false, files: [], error: err.message, problems: [] };
  } finally {
    clearTimeout(timer);
  }
}

async function runEngine(job, engineKey, dir, deadline) {
  const cells = job.cells.filter((c) => c.engine === engineKey);
  // This engine's own proxy, so its refusals are its own (see shoot()).
  const seen = { blocks: 0 };
  const proxy = await startProxy({
    log: (what, why, host) => log(what, why, host, engineKey, job.id),
    onBlock: () => { seen.blocks += 1; },
  });
  let browser;
  try { browser = await launch(engineKey, proxy.server); } catch (err) {
    log('launch failed', engineKey, err.message.split('\n')[0]);
    for (const c of cells) Object.assign(c, { state: 'failed', error: 'That browser is unavailable right now.' });
    await proxy.close();
    return;
  }
  try {
    for (const cell of cells) {
      if (Date.now() > deadline) {
        Object.assign(cell, { state: 'skipped', error: 'Skipped: the run hit its time limit.' });
        continue;
      }
      if (!browser.isConnected()) {
        // A crashed browser takes every later cell with it unless it is replaced.
        try { browser = await launch(engineKey, proxy.server); } catch {
          Object.assign(cell, { state: 'failed', error: 'That browser is unavailable right now.' });
          continue;
        }
      }
      cell.state = 'running';
      const vp = VIEWPORTS.find((v) => v.key === cell.viewport);
      const started = Date.now();
      let r = await shoot(browser, engineKey, vp, job.url, dir, deadline, seen);
      // One more try for a cell that timed out or lost its connection — but only once some
      // other cell has rendered, which says the site is up and this was a blip. A site
      // that is down times out everywhere, and retrying it would only double the wait.
      if (!r.ok && TRANSIENT.test(r.error) && deadline - Date.now() > 20_000
        && job.cells.some((c) => c.state === 'done')) {
        log('retrying', job.id, engineKey, vp.key);
        r = await shoot(browser, engineKey, vp, job.url, dir, deadline, seen);
      }
      const names = r.files.map((f) => path.basename(f));
      Object.assign(cell, {
        state: r.ok ? 'done' : 'failed',
        fold: names.find((n) => n.endsWith('__fold.jpg')) || null,
        full: names.find((n) => n.endsWith('__full.png')) || null,
        status: r.status ?? null,
        size: r.size ?? null,
        truncated: Boolean(r.truncated),
        problems: r.problems || [],
        error: r.ok ? null : friendly(r.error),
        ms: Date.now() - started,
      });
      if (!r.ok) log('cell failed', job.id, engineKey, vp.key, String(r.error).split('\n')[0].slice(0, 200));
    }
  } finally {
    await browser.close().catch(() => {});
    await proxy.close();
  }
}

async function runJob(job) {
  job.state = 'running';
  job.startedAt = Date.now();
  const dir = runDir(job.id);
  await mkdir(dir, { recursive: true });
  const deadline = job.startedAt + CONFIG.jobDeadlineMs;
  // The engines run side by side, each in its own browser, and the viewports one after
  // another within each. Three browsers at once is the memory the container is sized
  // for; more would buy speed with the box's headroom.
  await Promise.all(job.engines.map((engineKey) => runEngine(job, engineKey, dir, deadline)));
  job.state = job.cells.some((c) => c.state === 'done') ? 'done' : 'failed';
  if (job.state === 'failed') {
    job.error = job.cells.find((c) => c.error)?.error || 'The page couldn’t be captured.';
  }
  await writeFile(path.join(dir, 'report.json'), JSON.stringify({
    url: job.url,
    when: new Date(job.startedAt).toISOString(),
    rows: job.cells.map((c) => ({
      engine: c.engine, viewport: c.viewport, ok: c.state === 'done', status: c.status ?? null,
      size: c.size ?? null, truncated: Boolean(c.truncated), error: c.error || null,
      problems: c.problems || [], files: [c.fold, c.full].filter(Boolean),
    })),
  }, null, 2));
}

function pump() {
  if (active || !waiting.length) return;
  const job = jobs.get(waiting.shift());
  if (!job) { pump(); return; }
  active = job;
  runJob(job)
    .catch((err) => {
      log('run failed', job.id, err.message);
      job.state = 'failed';
      job.error = 'Something went wrong on our side. Try again.';
    })
    .finally(() => {
      job.finishedAt = Date.now();
      const ok = job.cells.filter((c) => c.state === 'done').length;
      log('finished', job.id, job.host, job.state, `${ok}/${job.cells.length}`, `${((job.finishedAt - job.startedAt) / 1000).toFixed(1)}s`);
      // Nothing rendered means nothing to download; the record stays for the page to read
      // why, and the sweep takes it with the rest.
      if (job.state === 'failed') rm(runDir(job.id), { recursive: true, force: true }).catch(() => {});
      active = null;
      setImmediate(pump);
    });
}

// ── housekeeping ────────────────────────────────────────────────────────────
async function sweep() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > CONFIG.runTtlMs) await forget(id, 'expired');
  }
  for (const [key, times] of starts) {
    const recent = times.filter((t) => now - t < 86_400_000);
    if (recent.length) starts.set(key, recent); else starts.delete(key);
  }
  pow.prune(now);
}

// ── start ───────────────────────────────────────────────────────────────────
async function main() {
  // Anything on disk belongs to a previous process whose job list is gone, so none of it
  // can be reached any more.
  await rm(RUNS, { recursive: true, force: true });
  await mkdir(RUNS, { recursive: true });

  const server = http.createServer((req, res) => {
    route(req, res).catch((err) => {
      log('error', req.method, req.url.split('?')[0], err.stack || err.message);
      if (!res.headersSent) send(res, 500, { error: 'Something went wrong on our side.' });
      else res.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.listen(CONFIG.port, CONFIG.host, () => {
    log(`shotmatrix listening on http://${CONFIG.host}:${CONFIG.port}${CONFIG.base}/ (pow ${CONFIG.powBits} bits)`);
  });
  setInterval(() => { sweep().catch((err) => log('sweep failed', err.message)); }, 60_000).unref();

  const stop = (signal) => {
    log(`${signal}: stopping`);
    server.close();
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((err) => { console.error(err); process.exit(1); });
