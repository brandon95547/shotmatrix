# shotmatrix

Cross-browser, cross-device screenshots of any URL, from the terminal.

```bash
cd ~/sites/shotmatrix
node shot.mjs https://www.skylanex.com/
```

Writes one PNG per browser × viewport into `~/sites/screenshots/<host>/<timestamp>/`,
plus an `index.html` contact sheet that puts the three engines side by side at each width.
Open that first — twenty-four PNGs in a folder is not something anyone can compare.

## What "all major browsers" actually means

There are three rendering engines. Every browser you can name is one of them.

| Engine | What it stands for |
|---|---|
| **Chromium** | Chrome, Edge, Opera, Brave, Samsung Internet, Android WebView |
| **Firefox** | Firefox, and nothing else |
| **WebKit** | Safari on macOS, and **every** browser on iOS |

That last row is the one people get wrong. Chrome on an iPhone is WebKit with a different
toolbar, because Apple requires it. So a WebKit shot at phone width is Safari on iPhone
*and* Chrome on iPhone *and* Firefox on iPhone, all at once.

The cells that are not real products — Firefox at iPhone width, say — are still worth
having. They tell you whether a layout is width-driven or engine-driven, which is the first
thing you want to know when only one of them looks wrong.

**One honest caveat.** These are Playwright's own pinned builds, not the browsers installed
on this Mac. That is what makes runs reproducible, but it means WebKit here is not
byte-identical to the Safari in your dock — read those cells as "the engine says", not
"Safari says".

### Do not upgrade Playwright past 1.55.0 on macOS 14

Later versions stopped building WebKit for macOS 14 and fall back to a frozen
`webkit_mac14_special` build, while the client keeps speaking the newer protocol. They no
longer agree, and every WebKit page dies at `newPage()` with:

```
Protocol error (Page.overrideSetting): Unknown setting: PushAPIEnabled
```

That is a third of the matrix, and it fails *after* Chromium and Firefox have already
succeeded, so a run looks like it worked until you count the files. 1.55.0 ships a real
WebKit 26.0 matching current Safari, so the pin is not settling for something older — it is
the version that works here. Upgrading is safe again on macOS 15+; verify with
`--browsers webkit` before trusting it.

## Viewports

`desktop-1920` · `laptop-1440` · `laptop-1280` · `tablet-landscape` · `tablet-portrait` ·
`phone-large` (430) · `phone-390` · `phone-small` (360)

Real sizes rather than a tidy series. 360 is the narrow Android floor and it is the one
that breaks layouts, so look there first. Tablet and phone cells get touch emulation and a
matching mobile user agent — except in Firefox, which Playwright cannot put into mobile
mode at all. Firefox still gets the width, which is what most responsive CSS keys on.

## Options

```
-o, --out <dir>        where to write
    --browsers <list>  chromium,firefox,webkit
    --viewports <list> any of the keys above, comma separated
    --dark             render with prefers-color-scheme: dark
    --both-schemes     light AND dark, one contact sheet each
    --no-full          skip the full-page shot
    --no-fold          skip the above-the-fold shot
    --dismiss <sel>    click this selector once loaded (a cookie banner)
    --timeout <ms>     navigation budget, default 45000
    --settle <ms>      extra wait after the page goes quiet, default 1200
```

Nothing is auto-clicked. A script that presses buttons by guesswork eventually presses the
wrong one, so a consent banner needs `--dismiss` and a selector you chose.

## What it does to make shots comparable

A screenshot is only useful if it is the same picture twice. Three things stop that, and
each is handled before the shutter:

- **Lazy content.** The page is scrolled top to bottom in steps and back, so
  intersection-triggered images and sections actually load. Jumping to the bottom does not
  work: an observer that never sees an element intersect never fires.
- **Fonts.** Waits on `document.fonts.ready`. A shot taken mid-swap shows the fallback face
  and every text metric in it is wrong.
- **Motion.** Animations and transitions are frozen *last*, after anything that had to
  animate in has done so. Otherwise two runs differ by wherever the carousel happened to be.

## What it reports

Beyond the images, each run writes `report.json` and flags in the contact sheet:

- **Horizontal scroll** — the page is wider than the viewport. Usually one over-wide
  element, and it is the most common mobile layout bug there is.
- **Failed requests** — a stylesheet, font, script or image that did not load. Invisible in
  a screenshot and exactly what you took one to catch.
- **Page errors** — uncaught JavaScript.
- **HTTP status** — a 404 that still renders a pretty page.

## Requirements

Node 18+ and the browser engines, which are about 400 MB:

```bash
npm install
npx playwright install chromium firefox webkit
```

## The web service

`server.mjs` is the same matrix behind an HTTP API, for the free tool at
**https://www.skylanex.com/products/shot-matrix**. It renders with the same code as the
terminal tool (`lib/matrix.mjs`), with three additions a public version needs.

**The browsers only reach the public internet** (`lib/guard.mjs`). Every connection the
three engines make goes through a forward proxy inside the service, which resolves the
name itself, refuses it unless *every* address is public, and connects to that exact
address, so there is no second DNS answer to rebind. Only ports 80 and 443 are allowed.
This matters on the prod box: the Phansora API listens on `0.0.0.0:8000`, and without
the proxy a container could reach it through its bridge gateway. Redirects need no
special case, because the redirected request goes through the proxy too.

**Starting a run costs a proof of work** (`lib/pow.mjs`). The page solves a 16-bit
SHA-256 puzzle while the visitor pastes their address. That takes about 60ms in a
normal browser and about 4 seconds in one running JavaScript with the JIT off. There's
no account, no third-party script and nothing to click. It filters out anything that
doesn't run JavaScript. It won't stop a determined attacker; the limits below do that.

**Limits:**

- one run at a time across the whole service, and one per visitor
- 6 runs an hour and 20 a day per visitor
- a queue of 6
- 25s to load each page, 60s per cell, 5 minutes per run
- full-page shots cut at 10,000px
- runs deleted an hour after they finish

nginx adds request-rate limits in front, so a flood never reaches Node.

The service renders at 1x rather than each device's real pixel ratio. The layout is the
same in CSS pixels, and a 3x full-page phone shot is a 30 MB PNG that Chromium cannot
paint past 16,384 device pixels anyway. The terminal tool keeps the real ratios.

```bash
npm run serve                  # http://127.0.0.1:4700/api/shotmatrix/
npm run smoke -- https://example.com
npm test                       # guard, proof of work, zip
npm run test:browsers          # all three engines against a loopback server (slow)
```

Settings are environment variables, and the defaults are the prod values. `PORT`,
`HOST`, `BASE_PATH`, `DATA_DIR`, `TRUST_PROXY`, `POW_BITS`, `QUEUE_MAX`, `PER_IP_HOUR`,
`PER_IP_DAY`, `RUN_TTL_MIN`, `NAV_TIMEOUT_S`, `CELL_TIMEOUT_S`, `JOB_DEADLINE_S` and
`MAX_HEIGHT` are all read at the top of `server.mjs`.

In prod it runs in Docker, on Playwright's own image pinned to the same 1.55.0 as
`package.json`, under a systemd unit. See [deploy/README.md](deploy/README.md).
