#!/usr/bin/env node
// shotmatrix — cross-browser, cross-device screenshots of a URL, from the terminal.
//
//   node shot.mjs https://www.skylanex.com/
//
// Renders the page in three ENGINES (Chromium, Firefox, WebKit) at several VIEWPORTS
// (desktop through phone) and writes a PNG per combination plus an HTML contact sheet.
//
// What "all major browsers" honestly means, and the matrix itself, live in lib/matrix.mjs,
// which the web service (server.mjs) renders from too.
//
// These are Playwright's own builds, not the copies installed on this Mac. That is the
// point — they are pinned and reproducible — but it does mean the WebKit here is not
// byte-identical to the Safari in your dock. Treat WebKit cells as "the engine says", not
// "Safari says".
//
// PLAYWRIGHT IS PINNED TO 1.55.0 AND UPGRADING IT BREAKS WEBKIT ON macOS 14.
//
// From 1.56 or so, Playwright stopped building WebKit for macOS 14 and falls back to a
// frozen `webkit_mac14_special` build — while its client keeps talking the newer protocol.
// The two no longer agree, and every WebKit page dies at newPage() with
//
//   Protocol error (Page.overrideSetting): Unknown setting: PushAPIEnabled
//
// which is a third of the matrix gone. 1.55.0 ships a real WebKit 26.0, matching current
// Safari — so the pin is not settling for something older, it is the version that actually
// works here. Upgrading is safe again once this Mac is on macOS 15+; check by running the
// matrix with --browsers webkit before you trust it.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ENGINES, VIEWPORTS, shootOne } from './lib/matrix.mjs';

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
    let browser;
    try {
      browser = await ENGINES[engineKey].launcher.launch();
    } catch (err) {
      // An engine that will not start is an engine's worth of failed cells, recorded and
      // moved past — not the end of the run. Missing browser binaries land here, and the
      // message says which command fixes it.
      const why = err.message.split('\n')[0];
      for (const scheme of schemes) {
        for (const vp of picked) {
          done += 1;
          failed += 1;
          rows.push({ ok: false, files: [], error: `launch: ${why}`, problems: [], engine: engineKey, vp, scheme });
        }
      }
      console.log(`  ${engineKey}: could not launch — ${why}`);
      console.log('    (try: npx playwright install ' + engineKey + ')');
      continue;
    }
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
