import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { createPow, leadingZeroBits } from '../lib/pow.mjs';
import { zipSize, writeZip } from '../lib/zip.mjs';

function solve({ salt, bits }) {
  for (let n = 0; ; n += 1) {
    const d = crypto.createHash('sha256').update(`${salt}:${n}`).digest();
    if (leadingZeroBits(d) >= bits) return String(n);
  }
}

test('leadingZeroBits counts across bytes', () => {
  assert.equal(leadingZeroBits(Buffer.from([0x80])), 0);
  assert.equal(leadingZeroBits(Buffer.from([0x01])), 7);
  assert.equal(leadingZeroBits(Buffer.from([0x00, 0x00, 0x10])), 19);
  assert.equal(leadingZeroBits(Buffer.from([0, 0])), 16);
});

test('a solved challenge is good exactly once', () => {
  const pow = createPow({ bits: 10 });
  const c = pow.issue();
  const nonce = solve(c);
  assert.equal(pow.verify(c.token, nonce), null);
  assert.equal(pow.verify(c.token, nonce), 'spent');
});

test('forged, unsolved, expired and junk challenges are refused', () => {
  const pow = createPow({ bits: 12 });
  const c = pow.issue();
  const nonce = solve(c);
  // Lowering the difficulty in the token breaks its signature.
  const [salt, , exp, sig] = c.token.split('.');
  assert.equal(pow.verify(`${salt}.1.${exp}.${sig}`, nonce), 'forged');
  assert.equal(createPow({ bits: 12 }).verify(c.token, nonce), 'forged', 'another secret');
  let wrong = 0;
  while (leadingZeroBits(crypto.createHash('sha256').update(`${c.salt}:${wrong}`).digest()) >= 12) wrong += 1;
  assert.equal(pow.verify(c.token, String(wrong)), 'unsolved');
  for (const junk of [undefined, null, '', 'a.b.c', 42, {}, 'x'.repeat(300)]) assert.equal(pow.verify(junk, nonce), 'malformed');
  assert.equal(pow.verify(c.token, '-1'), 'malformed');
  const old = createPow({ bits: 4, ttlMs: -1 });
  const stale = old.issue();
  assert.equal(old.verify(stale.token, solve(stale)), 'expired');
});

test('the zip is a valid archive of exactly the predicted size', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'shotmatrix-zip-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = path.join(dir, 'a.png');
  const b = path.join(dir, 'b.jpg');
  await writeFile(a, crypto.randomBytes(200_000));
  await writeFile(b, Buffer.from('hello'));
  const entries = [
    { name: 'run/a.png', path: a, size: (await stat(a)).size },
    { name: 'run/b.jpg', path: b, size: (await stat(b)).size },
  ];
  const out = path.join(dir, 'out.zip');
  const stream = createWriteStream(out);
  await writeZip(stream, entries);
  stream.end();
  await once(stream, 'close');
  assert.equal((await stat(out)).size, zipSize(entries));
  const listing = execFileSync('unzip', ['-t', out]).toString();
  assert.match(listing, /No errors detected/);
  assert.equal(execFileSync('unzip', ['-p', out, 'run/b.jpg']).toString(), 'hello');
});
