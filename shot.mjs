#!/usr/bin/env node
// shotmatrix — cross-browser, cross-device screenshots of a URL, from the terminal.
//
//   node shot.mjs https://www.skylanex.com/
//
// Renders the page in three ENGINES (Chromium, Firefox, WebKit) at several VIEWPORTS
// (desktop through phone) and writes a PNG per combination plus an HTML contact sheet.
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
//
// These are Playwright's own builds, not the copies installed on this Mac. That is the
// point — they are pinned and reproducible — but it does mean the WebKit here is not
// byte-identical to the Safari in your dock, and on macOS 14 Playwright ships a frozen
// WebKit that no longer tracks Safari releases. Treat WebKit cells as "the engine says",
// not "Safari 18.4 says".

import { chromium, firefox, webkit } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// ── the matrix ──────────────────────────────────────────────────────────────
const ENGINES = {
  chromium: { launcher: chromium, label: 'Chromium', stands_for: 'Chrome · Edge · Brave · Android' },
  firefox: { launcher: firefox, label: 'Firefox', stands_for: 'Firefox' },
  webkit: { launcher: webkit, label: 'WebKit', stands_for: 'Safari · every iOS browser' },
};

// Sizes people actually have, not a tidy series. The phone widths are the three that
// between them cover most of the market; 360 is the narrow Android floor that breaks
// layouts, and it is the one worth looking at first.
const VIEWPORTS = [
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
const MOBILE_UA = {
  chromium: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36',
  webkit: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
};

// ── arguments ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    url: null,
    outDir: null,
    engines: Object.keys(ENGINES),
    viewports: VIEWPORTS.map((v) => v.key),
    scheme: 'light',
    fullPage: true,
    fold: true,
    dismiss: null,
    timeout: 45000,
    settle: 1200,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--out' || a === '-o') out.outDir = next();
    else if (a === '--browsers' || a === '--engines') out.engines = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--viewports' || a === '--devices') out.viewports = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--dark') out.scheme = 'dark';
    else if (a === '--both-schemes') out.scheme = 'both';
    else if (a === '--no-full') out.fullPage = false;
    else if (a === '--no-fold') out.fold = false;
    else if (a === '--dismiss') out.dismiss = next();
    else if (a === '--timeout') out.timeout = Number(next()) || out.timeout;
    else if (a === '--settle') out.settle = Number(next()) || 0;
    else if (a === '--help' || a === '-h') out.help = true;
    else rest.push(a);
  }
  out.url = rest[0] || null;
  return out;
}

const HELP = `
shotmatrix — cross-browser, cross-device screenshots from the terminal

  node shot.mjs <url> [options]

Options
  -o, --out <dir>        where to write (default ../screenshots/<host>/<timestamp>)
      --browsers <list>  chromium,firefox,webkit          (default: all three)
      --viewports <list> ${VIEWPORTS.map((v) => v.key).join(',')}
      --dark             render with prefers-color-scheme: dark
      --both-schemes     render light AND dark
      --no-full          skip the full-page shot
      --no-fold          skip the above-the-fold shot
      --dismiss <sel>    click this selector once loaded (a cookie banner, say)
      --timeout <ms>     per-page navigation budget (default 45000)
      --settle <ms>      extra wait after the page goes quiet (default 1200)

Examples
  node shot.mjs https://www.skylanex.com/
  node shot.mjs https://www.skylanex.com/ --browsers webkit --viewports phone-390
  node shot.mjs https://www.skylanex.com/ --both-schemes --dismiss "#cookie-accept"
`;

// ── page preparation ────────────────────────────────────────────────────────
// A screenshot is only useful if it is the same picture twice. Three things stop that:
// fonts arriving late, images that only load when scrolled to, and anything animated.
async function settlePage(page, { settle, dismiss }) {
  if (dismiss) {
    // Explicit and opt-in. Nothing is auto-clicked: a script that presses buttons on a
    // page by guesswork will eventually press the wrong one.
    try { await page.locator(dismiss).first().click({ timeout: 3000 }); } catch { /* not there */ }
  }

  // Walk the page so lazy images and scroll-triggered sections actually load, then come
  // back. Stepped rather than jumped, because an IntersectionObserver that never sees an
  // element intersect will never fire.
  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.8);
    for (let y = 0; y < document.body.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 90));
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 150));
  });

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
async function shootOne(browser, engineKey, vp, { url, outDir, scheme, fullPage, fold, dismiss, timeout, settle }) {
  // isMobile and hasTouch throw on Firefox — Playwright does not implement mobile
  // emulation there. Firefox still gets the WIDTH, which is what most responsive CSS
  // actually keys on, so the cell is worth having; it just cannot tell you about
  // hover-vs-touch behaviour.
  const canEmulateMobile = engineKey !== 'firefox';
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dpr,
    colorScheme: scheme,
    reducedMotion: 'reduce',
    ...(vp.mobile && canEmulateMobile
      ? { isMobile: true, hasTouch: true, userAgent: MOBILE_UA[engineKey] }
      : {}),
  });
  const page = await ctx.newPage();
  const files = [];
  const problems = [];
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
    const res = await page.goto(url, { waitUntil: 'load', timeout });
    const status = res?.status() ?? 0;
    if (status >= 400) problems.push(`HTTP ${status}`);
    // 'networkidle' as a NUDGE, not a requirement: a site with a poll or a live chat
    // widget never goes idle, and waiting for it would hang every run.
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await settlePage(page, { settle, dismiss });

    const base = `${vp.key}__${engineKey}${scheme === 'dark' ? '__dark' : ''}`;
    if (fold) {
      const f = path.join(outDir, `${base}__fold.png`);
      await page.screenshot({ path: f, fullPage: false });
      files.push(f);
    }
    if (fullPage) {
      const f = path.join(outDir, `${base}__full.png`);
      await page.screenshot({ path: f, fullPage: true });
      files.push(f);
    }
    const size = await page.evaluate(() => ({
      w: document.documentElement.scrollWidth,
      h: document.documentElement.scrollHeight,
      overflows: document.documentElement.scrollWidth > window.innerWidth + 1,
    }));
    return { ok: true, files, status, size, problems };
  } catch (err) {
    return { ok: false, files, error: err.message, problems };
  } finally {
    await ctx.close().catch(() => {});
  }
}

// ── contact sheet ───────────────────────────────────────────────────────────
// Twenty-four PNGs in a folder is not a thing anyone can compare. Grouped by VIEWPORT
// with the engines side by side, because the question being asked is almost always
// "does this width look the same in all three".
function contactSheet(url, when, rows, scheme) {
  const byViewport = new Map();
  for (const r of rows) {
    if (!byViewport.has(r.vp.key)) byViewport.set(r.vp.key, { vp: r.vp, cells: [] });
    byViewport.get(r.vp.key).cells.push(r);
  }
  const cell = (r) => {
    const shot = r.files.find((f) => f.endsWith('__fold.png')) || r.files[0];
    const name = shot ? path.basename(shot) : null;
    const full = r.files.find((f) => f.endsWith('__full.png'));
    const flags = [
      r.ok ? '' : `<span class="bad">failed: ${escapeHtml(r.error || '')}</span>`,
      r.size?.overflows ? '<span class="warn">scrolls sideways</span>' : '',
      r.problems?.length ? `<span class="warn">${r.problems.length} request/JS problem${r.problems.length === 1 ? '' : 's'}</span>` : '',
    ].filter(Boolean).join(' ');
    return `<figure>
      <div class="shot">${name ? `<a href="${name}"><img loading="lazy" src="${name}" alt=""></a>` : '<div class="none">no image</div>'}</div>
      <figcaption>
        <strong>${ENGINES[r.engine].label}</strong>
        <span class="dim">${ENGINES[r.engine].stands_for}</span>
        ${r.size ? `<span class="dim">page ${r.size.w}×${r.size.h}</span>` : ''}
        ${full ? `<a class="dim" href="${path.basename(full)}">full page ↗</a>` : ''}
        ${flags ? `<div class="flags">${flags}</div>` : ''}
      </figcaption>
    </figure>`;
  };
  const sections = [...byViewport.values()].map(({ vp, cells }) => `
    <section>
      <h2>${vp.label} <span class="dim">${vp.width}×${vp.height} @${vp.dpr}x${vp.mobile ? ' · touch' : ''}</span></h2>
      <div class="grid">${cells.map(cell).join('')}</div>
    </section>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(url)} — shotmatrix</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --dim:#666; --line:#e4e4e7; --card:#fafafa; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0c0d10; --fg:#f2f2f3; --dim:#9b9ba3; --line:#26272d; --card:#141519; } }
  body { margin:0; padding:24px; background:var(--bg); color:var(--fg);
         font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  header { border-bottom:1px solid var(--line); padding-bottom:16px; margin-bottom:8px; }
  h1 { font-size:17px; margin:0 0 4px; }
  h2 { font-size:14px; margin:28px 0 10px; font-weight:600; }
  a { color:inherit; }
  .dim { color:var(--dim); font-weight:400; }
  .grid { display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); }
  figure { margin:0; border:1px solid var(--line); border-radius:10px; overflow:hidden; background:var(--card); }
  .shot { background:var(--bg); }
  img { display:block; width:100%; height:auto; }
  .none { padding:40px; text-align:center; color:var(--dim); }
  figcaption { padding:8px 10px; display:flex; flex-wrap:wrap; gap:8px; align-items:baseline; border-top:1px solid var(--line); font-size:12px; }
  .flags { flex-basis:100%; display:flex; gap:8px; flex-wrap:wrap; }
  .warn { color:#a16207; } .bad { color:#b91c1c; }
  @media (prefers-color-scheme: dark) { .warn { color:#fbbf24; } .bad { color:#f87171; } }
</style></head><body>
<header>
  <h1>${escapeHtml(url)}</h1>
  <p class="dim">${rows.length} renders · ${escapeHtml(when)} · ${scheme === 'dark' ? 'dark scheme' : 'light scheme'}
     · Chromium stands for Chrome/Edge/Android, WebKit for Safari and every iOS browser</p>
</header>
${sections}
</body></html>`;
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.url) { console.log(HELP); process.exit(args.url ? 0 : 1); }

  let url;
  try { url = new URL(args.url).toString(); }
  catch { console.error(`Not a URL: ${args.url}`); process.exit(1); }

  const badEngine = args.engines.find((e) => !ENGINES[e]);
  if (badEngine) { console.error(`Unknown browser "${badEngine}". Pick from: ${Object.keys(ENGINES).join(', ')}`); process.exit(1); }
  const picked = args.viewports.map((k) => VIEWPORTS.find((v) => v.key === k)).filter(Boolean);
  if (!picked.length) { console.error(`No viewport matched. Pick from: ${VIEWPORTS.map((v) => v.key).join(', ')}`); process.exit(1); }

  const host = new URL(url).hostname.replace(/^www\./, '');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const schemes = args.scheme === 'both' ? ['light', 'dark'] : [args.scheme];
  const outDir = path.resolve(args.outDir || path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'screenshots', host, stamp));
  await mkdir(outDir, { recursive: true });

  const total = args.engines.length * picked.length * schemes.length;
  console.log(`shotmatrix → ${url}`);
  console.log(`  ${args.engines.length} engines × ${picked.length} viewports${schemes.length > 1 ? ' × 2 schemes' : ''} = ${total} renders`);
  console.log(`  → ${outDir}\n`);

  const rows = [];
  let done = 0;
  let failed = 0;
  for (const engineKey of args.engines) {
    const browser = await ENGINES[engineKey].launcher.launch();
    try {
      for (const scheme of schemes) {
        for (const vp of picked) {
          const started = Date.now();
          const r = await shootOne(browser, engineKey, vp, { ...args, url, outDir, scheme });
          done += 1;
          if (!r.ok) failed += 1;
          rows.push({ ...r, engine: engineKey, vp, scheme });
          const ms = Date.now() - started;
          const note = r.ok
            ? `${r.size.w}×${r.size.h}${r.size.overflows ? '  ⚠ scrolls sideways' : ''}${r.problems.length ? `  ⚠ ${r.problems.length} problem(s)` : ''}`
            : `FAILED ${r.error}`;
          console.log(`  [${String(done).padStart(2)}/${total}] ${engineKey.padEnd(8)} ${vp.key.padEnd(17)} ${String(ms).padStart(5)}ms  ${note}`);
        }
      }
    } finally {
      await browser.close().catch(() => {});
    }
  }

  // One sheet per scheme, since comparing light against dark side by side is a different
  // question from comparing engines against each other.
  for (const scheme of schemes) {
    const forScheme = rows.filter((r) => r.scheme === scheme);
    const name = schemes.length > 1 ? `index-${scheme}.html` : 'index.html';
    await writeFile(path.join(outDir, name), contactSheet(url, new Date().toLocaleString(), forScheme, scheme));
  }
  await writeFile(path.join(outDir, 'report.json'), JSON.stringify({
    url, when: new Date().toISOString(), outDir,
    rows: rows.map((r) => ({
      engine: r.engine, viewport: r.vp.key, scheme: r.scheme, ok: r.ok,
      status: r.status ?? null, size: r.size ?? null, error: r.error ?? null,
      problems: r.problems, files: r.files.map((f) => path.basename(f)),
    })),
  }, null, 2));

  const sideways = rows.filter((r) => r.size?.overflows);
  console.log(`\n  ${total - failed}/${total} rendered${failed ? `, ${failed} failed` : ''}`);
  if (sideways.length) {
    console.log(`  ⚠ horizontal scroll at: ${[...new Set(sideways.map((r) => `${r.vp.key}/${r.engine}`))].join(', ')}`);
  }
  console.log(`  contact sheet: ${path.join(outDir, schemes.length > 1 ? 'index-light.html' : 'index.html')}`);
  process.exit(failed === total ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
