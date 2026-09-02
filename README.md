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

**Two honest caveats.** These are Playwright's own pinned builds, not the browsers installed
on this Mac; that is what makes runs reproducible, but it means WebKit here is not
byte-identical to the Safari in your dock. And on macOS 14 Playwright ships a *frozen*
WebKit that no longer tracks Safari releases — read those cells as "the engine says", not
"Safari 18 says". Upgrading macOS gets you a current one.

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
