#!/usr/bin/env node
// End-to-end check of a running service, from outside it: solve the proof of work, start
// a run, follow it to the end, then fetch a screenshot and the zip.
//
//   node scripts/smoke.mjs https://example.com
//   node scripts/smoke.mjs --api https://www.skylanex.com/api/shotmatrix --engines webkit --viewports phone-390 https://example.com
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
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url, engines, viewports, token: challenge.token, nonce: String(nonce) }),
}));
console.log(`POST /jobs → ${started.status}`, started.body);
if (!started.body.id) process.exit(1);

let job;
let last = '';
for (;;) {
  job = (await json(await fetch(`${api}/jobs/${started.body.id}`))).body;
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
const first = job.cells.find((c) => c.full);
if (first) {
  const img = await fetch(`${api}/runs/${job.id}/${first.full}`);
  console.log(`GET ${first.full} → ${img.status} ${img.headers.get('content-type')} ${img.headers.get('content-length')} bytes`);
  const zip = await fetch(`${api}/runs/${job.id}/zip`, { method: 'HEAD' });
  console.log(`HEAD zip → ${zip.status} ${zip.headers.get('content-length')} bytes`);
}
console.log(`total ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(job.state === 'done' && job.cells.every((c) => c.state === 'done') ? 0 : 1);
