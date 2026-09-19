// The matrix itself: which engines, which viewports, and how one cell of it is rendered.
//
// Shared by the terminal tool (shot.mjs) and the web service (server.mjs), so a page
// shot from either comes out of the same code. The CLI calls shootOne() with nothing but
// its own flags and gets exactly the behaviour it always had; every option the service
// needs on top has a default that leaves the CLI untouched.
//
// WHAT "ALL MAJOR BROWSERS" HONESTLY MEANS HERE. There are only three engines worth
// testing, and every browser you can name is one of them:
//
//   Chromium  →  Chrome, Edge, Opera, Brave, Samsung Internet, Android WebView
//   Firefox   →  Firefox, and nothing else
//   WebKit    →  Safari on macOS, and EVERY browser on iOS — Chrome and Firefox on an
//                iPhone are WebKit with a different toolbar, because Apple requires it
//
// So a Chromium shot at phone width IS Chrome on Android, and a WebKit shot at phone
// width IS Safari on iPhone — and also Chrome on iPhone. The cells that are not real
// products (Firefox at iPhone width) are still worth having: they tell you whether a
// layout is width-driven or engine-driven, which is the first thing you want to know
// when only one of them looks wrong.

import { chromium, firefox, webkit } from 'playwright';
import path from 'node:path';

// ── the matrix ──────────────────────────────────────────────────────────────
export const ENGINES = {
  chromium: { launcher: chromium, label: 'Chromium', stands_for: 'Chrome · Edge · Brave · Android' },
  firefox: { launcher: firefox, label: 'Firefox', stands_for: 'Firefox' },
  webkit: { launcher: webkit, label: 'WebKit', stands_for: 'Safari · every iOS browser' },
};

// Sizes people actually have, not a tidy series. The phone widths are the three that
// between them cover most of the market; 360 is the narrow Android floor that breaks
// layouts, and it is the one worth looking at first.
//
// skylanex.com's Shot Matrix page draws its size picker from a copy of this list
// (src/pages/shotmatrix.mjs in that repo). The service refuses a key it does not know,
// so the two cannot silently disagree — but a size added here needs adding there too.
export const VIEWPORTS = [
  { key: 'desktop-1920', label: 'Desktop 1920', width: 1920, height: 1080, dpr: 1, mobile: false },
  { key: 'laptop-1440', label: 'Laptop 1440', width: 1440, height: 900, dpr: 2, mobile: false },
  { key: 'laptop-1280', label: 'Laptop 1280', width: 1280, height: 800, dpr: 2, mobile: false },
  { key: 'tablet-landscape', label: 'Tablet landscape 1024', width: 1024, height: 768, dpr: 2, mobile: true },
  { key: 'tablet-portrait', label: 'Tablet portrait 820', width: 820, height: 1180, dpr: 2, mobile: true },
  { key: 'phone-large', label: 'Phone large 430', width: 430, height: 932, dpr: 3, mobile: true },
  { key: 'phone-390', label: 'Phone 390', width: 390, height: 844, dpr: 3, mobile: true },
  { key: 'phone-small', label: 'Phone small 360', width: 360, height: 740, dpr: 3, mobile: true },
];

// A phone-shaped context needs a phone user agent as well as a phone viewport: plenty of
// sites branch on the UA string for their menu, and a desktop UA at 390px is a case that
// exists nowhere in the world. Firefox is absent because Playwright cannot emulate mobile
// in it at all — see the note where these are applied.
export const MOBILE_UA = {
  chromium: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36',
  webkit: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
};

// ── page preparation ────────────────────────────────────────────────────────
// A screenshot is only useful if it is the same picture twice. Three things stop that:
// fonts arriving late, images that only load when scrolled to, and anything animated.
//
// `maxScroll` bounds the walk. An infinite-scroll page grows as it is walked, so an
// unbounded loop never reaches the bottom; the CLI leaves it unbounded as it always
// was, and the service caps it at the height it will actually photograph.
export async function settlePage(page, { settle, dismiss, maxScroll = Infinity }) {
  if (dismiss) {
    // Explicit and opt-in. Nothing is auto-clicked: a script that presses buttons on a
    // page by guesswork will eventually press the wrong one.
    try { await page.locator(dismiss).first().click({ timeout: 3000 }); } catch { /* not there */ }
  }

  // Walk the page so lazy images and scroll-triggered sections actually load, then come
  // back. Stepped rather than jumped, because an IntersectionObserver that never sees an
  // element intersect will never fire.
  //
  // Every scroll is `behavior: 'instant'`, which overrides the page's own CSS. A site with
  // `scroll-behavior: smooth` on <html> (skylanex.com has it) otherwise turns each
  // scrollTo into an animation, and the trip back to the top was still easing when the
  // shutter fired: Firefox's "above the fold" shot came out half-way down the page. The
  // position is then checked, not assumed.
  await page.evaluate(async (limit) => {
    const to = (y) => window.scrollTo({ top: y, left: 0, behavior: 'instant' });
    const step = Math.round(window.innerHeight * 0.8);
    const height = () => (document.body || document.documentElement).scrollHeight;
    for (let y = 0; y < height() && y < limit; y += step) {
      to(y);
      await new Promise((r) => setTimeout(r, 90));
    }
    to(0);
    await new Promise((r) => setTimeout(r, 150));
    for (let i = 0; i < 20 && window.scrollY !== 0; i += 1) {
      to(0);
      await new Promise((r) => setTimeout(r, 50));
    }
  }, Number.isFinite(maxScroll) ? maxScroll : Number.MAX_SAFE_INTEGER);

  // Fonts, because a shot taken mid-swap shows the fallback face and every text metric
  // in it is wrong.
  try { await page.evaluate(() => document.fonts?.ready); } catch { /* no font API */ }

  // Freeze motion LAST, so anything that had to animate in has already done so. Without
  // this, two runs of the same page differ by wherever the carousel happened to be.
  await page.addStyleTag({
    content: `*, *::before, *::after {
      animation-play-state: paused !important;
      animation-delay: -1ms !important;
      animation-duration: 1ms !important;
      transition-duration: 0ms !important;
      transition-delay: 0ms !important;
      scroll-behavior: auto !important;
      caret-color: transparent !important;
    }`,
  });

  if (settle) await page.waitForTimeout(settle);
}

// ── one cell of the matrix ──────────────────────────────────────────────────
//
// Everything after `settle` is for the web service, and every default is what the CLI
// has always done:
//
//   dpr             device scale factor. The service renders at 1x: the layout is the
//                   same in CSS pixels, and a 3x full-page phone shot is a 30MB PNG that
//                   Chromium cannot even paint past 16,384 device pixels.
//   waitUntil       'load' for the CLI. The service navigates on 'domcontentloaded' and
//                   then gives 'load' a bounded wait, because a public tool meets sites
//                   whose last tracker never finishes, and a page that has rendered is
//                   worth photographing.
//   loadWait        that bounded wait, in ms (only used when waitUntil is not 'load').
//   idleWait        how long 'networkidle' gets as a nudge.
//   maxScroll       see settlePage().
//   maxHeight       full-page shots taller than this are cut at it; `truncated` says so.
//   maxWidth        and wider than this, cut at it. A page only gets that wide by
//                   accident or on purpose, and neither is worth a 50,000px screenshot.
//   foldFormat      'png' or 'jpeg'. The service's fold is a thumbnail, and a JPEG of it
//                   is a quarter of the bytes.
//   contextOptions  merged into newContext() — the service blocks service workers and
//                   downloads there.
//   prepareContext  async (ctx) => {} before the page opens — the service's request
//                   guard is installed here.
//   signal          an AbortSignal. Aborting closes the context, which fails whatever
//                   Playwright call is in flight, so a hung cell ends as a failed cell.
export async function shootOne(browser, engineKey, vp, {
  url, outDir, scheme, fullPage, fold, dismiss, timeout, settle,
  dpr = vp.dpr,
  waitUntil = 'load',
  loadWait = 10000,
  idleWait = 8000,
  maxScroll = Infinity,
  maxHeight = Infinity,
  maxWidth = Infinity,
  foldFormat = 'png',
  contextOptions = {},
  prepareContext = null,
  signal = null,
}) {
  // isMobile and hasTouch throw on Firefox — Playwright does not implement mobile
  // emulation there. Firefox still gets the WIDTH, which is what most responsive CSS
  // actually keys on, so the cell is worth having; it just cannot tell you about
  // hover-vs-touch behaviour.
  const canEmulateMobile = engineKey !== 'firefox';
  const files = [];
  const problems = [];
  if (signal?.aborted) return { ok: false, files, error: 'timed out', problems };

  // Opening the context and the page is INSIDE the try, and that is not defensive habit —
  // it is what this got wrong first time out. A WebKit/Playwright protocol mismatch threw
  // at newPage(), and because that line sat outside the guard it took down a run that had
  // already produced sixteen good screenshots. A cell that cannot render is one failed
  // cell, reported in the sheet; it is never the whole matrix.
  let ctx;
  let page;
  const abort = () => { ctx?.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: dpr,
      colorScheme: scheme,
      reducedMotion: 'reduce',
      ...(vp.mobile && canEmulateMobile
        ? { isMobile: true, hasTouch: true, userAgent: MOBILE_UA[engineKey] }
        : {}),
      ...contextOptions,
    });
    if (signal?.aborted) throw new Error('timed out');
    if (prepareContext) await prepareContext(ctx);
    page = await ctx.newPage();
  } catch (err) {
    signal?.removeEventListener('abort', abort);
    await ctx?.close().catch(() => {});
    return { ok: false, files, error: signal?.aborted ? 'timed out' : `context: ${err.message.split('\n')[0]}`, problems };
  }

  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
  page.on('requestfailed', (req) => {
    // Not every failed request matters, but a missing stylesheet or image is exactly the
    // kind of thing a screenshot is taken to catch, and it is invisible in the picture.
    const kind = req.resourceType();
    if (kind === 'stylesheet' || kind === 'image' || kind === 'font' || kind === 'script') {
      problems.push(`${kind} failed: ${req.url().slice(0, 120)}`);
    }
  });

  try {
    const res = await page.goto(url, { waitUntil, timeout });
    const status = res?.status() ?? 0;
    if (status >= 400) problems.push(`HTTP ${status}`);
    if (waitUntil !== 'load') await page.waitForLoadState('load', { timeout: loadWait }).catch(() => {});
    // 'networkidle' as a NUDGE, not a requirement: a site with a poll or a live chat
    // widget never goes idle, and waiting for it would hang every run.
    await page.waitForLoadState('networkidle', { timeout: idleWait }).catch(() => {});
    await settlePage(page, { settle, dismiss, maxScroll });

    const base = `${vp.key}__${engineKey}${scheme === 'dark' ? '__dark' : ''}`;
    if (fold) {
      const jpeg = foldFormat === 'jpeg';
      const f = path.join(outDir, `${base}__fold.${jpeg ? 'jpg' : 'png'}`);
      await page.screenshot({ path: f, fullPage: false, ...(jpeg ? { type: 'jpeg', quality: 80 } : {}) });
      files.push(f);
    }
    let truncated = false;
    if (fullPage) {
      const f = path.join(outDir, `${base}__full.png`);
      let clip;
      if (Number.isFinite(maxHeight) || Number.isFinite(maxWidth)) {
        const doc = await page.evaluate(() => ({
          w: document.documentElement.scrollWidth,
          h: (document.body || document.documentElement).scrollHeight,
        }));
        if (doc.h > maxHeight || doc.w > maxWidth) {
          clip = { x: 0, y: 0, width: Math.min(Math.max(doc.w, vp.width), maxWidth), height: Math.min(doc.h, maxHeight) };
          truncated = doc.h > maxHeight;
        }
      }
      await page.screenshot({ path: f, fullPage: true, ...(clip ? { clip } : {}) });
      files.push(f);
    }
    const size = await page.evaluate(() => ({
      w: document.documentElement.scrollWidth,
      h: document.documentElement.scrollHeight,
      overflows: document.documentElement.scrollWidth > window.innerWidth + 1,
    }));
    return { ok: true, files, status, size, truncated, problems };
  } catch (err) {
    return { ok: false, files, error: signal?.aborted ? 'timed out' : err.message, problems };
  } finally {
    signal?.removeEventListener('abort', abort);
    await ctx.close().catch(() => {});
  }
}
