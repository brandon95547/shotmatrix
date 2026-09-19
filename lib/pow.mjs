// A proof-of-work toll on starting a run: the visitor's browser finds a number whose
// hash starts with 16 zero bits (~65k SHA-256 attempts on average), and the server
// spends one hash checking it.
//
// 16 bits, not more, because of the browsers that run JavaScript with the JIT off —
// Edge's enhanced security mode, iOS Lockdown Mode, some embedded browsers. They hash
// about fifty times slower: 16 bits is ~4 seconds for them and ~60ms for everyone else,
// where 18 bits was ~15 seconds. Against an attacker hashing in native code the
// difference is a few milliseconds either way, so the extra bits bought nothing.
//
// Chosen over a CAPTCHA service because it needs no account, no third-party script, and
// no cookie banner, and a person never sees it — the page starts solving as soon as they
// focus the address field, so it is done before they have finished pasting. What it buys:
//
//   - a run cannot be started without executing JavaScript and implementing the
//     challenge, which filters out the scripted curl loops and form-spam bots that make
//     up most junk traffic.
//
// It is not a wall against a determined attacker with native code — nothing client-side
// is. The limits in server.mjs are what cap the damage; this makes reaching them
// expensive and dull.
//
// The challenge is stateless until it is spent: an HMAC-signed token carrying its own
// salt, difficulty and expiry, so issuing one costs nothing to store. Spending one
// records the salt until the token would have expired anyway, so each is good once.

import crypto from 'node:crypto';

export function leadingZeroBits(buf) {
  let n = 0;
  for (const byte of buf) {
    if (byte === 0) { n += 8; continue; }
    return n + Math.clz32(byte) - 24;
  }
  return n;
}

export function createPow({ secret = crypto.randomBytes(32), bits = 16, ttlMs = 10 * 60_000 } = {}) {
  const spent = new Map(); // salt → when its token expires
  const sign = (payload) => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

  function issue() {
    const salt = crypto.randomBytes(16).toString('hex');
    const expires = Date.now() + ttlMs;
    const payload = `${salt}.${bits}.${expires}`;
    return { token: `${payload}.${sign(payload)}`, salt, bits, expires };
  }

  // null when the token and nonce are good (and the token is now spent); otherwise the
  // reason, which the caller turns into words.
  function verify(token, nonce) {
    if (typeof token !== 'string' || token.length > 256) return 'malformed';
    const parts = token.split('.');
    if (parts.length !== 4) return 'malformed';
    const [salt, b, exp, sig] = parts;
    const want = Buffer.from(sign(`${salt}.${b}.${exp}`));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return 'forged';
    if (Date.now() > Number(exp)) return 'expired';
    if (spent.has(salt)) return 'spent';
    const n = String(nonce ?? '');
    if (!/^\d{1,15}$/.test(n)) return 'malformed';
    const digest = crypto.createHash('sha256').update(`${salt}:${n}`).digest();
    if (leadingZeroBits(digest) < Number(b)) return 'unsolved';
    spent.set(salt, Number(exp));
    return null;
  }

  function prune(now = Date.now()) {
    for (const [salt, exp] of spent) if (exp < now) spent.delete(salt);
  }

  return { issue, verify, prune, bits };
}
