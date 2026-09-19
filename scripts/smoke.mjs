#!/usr/bin/env node
// End-to-end check of a running service, from outside it: solve the proof of work, start
// a run, follow it to the end, then fetch a screenshot and the zip.
//
//   node scripts/smoke.mjs --user 1 https://example.com
//   node scripts/smoke.mjs --api http://127.0.0.1:4700/api/shotmatrix --user 1 --engines webkit --viewports phone-390 https://example.com
//
// Straight at the service, not through nginx: a run needs an account, which nginx vouches
// for from a signed-in session. Here --user stands in for it (any digits; skip it when the
// server runs with REQUIRE_LOGIN=0). The zip is downloaded, so the run is gone afterwards.
//
// Exits non-zero if the run fails or any cell does.
import crypto from 'node:crypto';
import { leadingZeroBits } from '../lib/pow.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args.splice(i, 2)[1];
};
const api = opt('api', 'http://127.0.0.1:4700/api/shotmatrix').replace(/\/+$/, '');
const engines = opt('engines', null)?.split(',');
const viewports = opt('viewports', null)?.split(',');
const user = opt('user', null);
const as = user ? { 'x-shotmatrix-user': user } : {};
const url = args[0] || 'https://example.com';

async function json(res) {
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

const t0 = Date.now();
const challenge = (await json(await fetch(`${api}/challenge`))).body;
let nonce = 0;
while (leadingZeroBits(crypto.createHash('sha256').update(`${challenge.salt}:${nonce}`).digest()) < challenge.bits) nonce += 1;
console.log(`pow: ${challenge.bits} bits, nonce ${nonce}, ${Date.now() - t0}ms`);

const started = await json(await fetch(`${api}/jobs`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...as },
  body: JSON.stringify({ url, engines, viewports, token: challenge.token, nonce: String(nonce) }),
}));
console.log(`POST /jobs → ${started.status}`, started.body);
if (!started.body.id) process.exit(1);

let job;
let last = '';
for (;;) {
  job = (await json(await fetch(`${api}/jobs/${started.body.id}`, { headers: as }))).body;
  const line = `${job.state} ${job.done}/${job.total}${job.state === 'queued' ? ` (${job.ahead} ahead)` : ''}`;
  if (line !== last) console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${line}`);
  last = line;
  if (job.state === 'done' || job.state === 'failed') break;
  await new Promise((r) => setTimeout(r, 1000));
}

for (const c of job.cells) {
  const flags = [c.overflows && 'scrolls sideways', c.truncated && 'cut', c.problems && `${c.problems} problem(s)`].filter(Boolean).join(', ');
  console.log(`  ${c.state.padEnd(7)} ${c.engine.padEnd(8)} ${c.viewport.padEnd(17)} ${c.width ?? '-'}×${c.height ?? '-'} ${c.error || ''} ${flags}`);
}
if (job.state === 'done') {
  const zip = await fetch(`${api}/runs/${job.id}/zip`, { headers: as });
  const bytes = (await zip.arrayBuffer()).byteLength;
  console.log(`GET zip → ${zip.status} ${bytes} bytes (${zip.headers.get('content-length')} announced)`);
  const after = await fetch(`${api}/jobs/${job.id}`, { headers: as });
  console.log(`GET run after the download → ${after.status} (gone, as it should be)`);
}
console.log(`total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(job.state === 'done' && job.cells.every((c) => c.state === 'done') ? 0 : 1);
