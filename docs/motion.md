# Motion

How the page moves when you switch pages, wait for data, open a dialog or change the theme; what was measured before the rules were written; and the same measurements after. The helpers are in `web/src/motion.ts`, the styles in the Motion section of `web/src/style.css`, and `test/motion.test.ts` holds both to the rules.

## The rules

| Moment | What happens | Time |
| --- | --- | --- |
| Page switch (week, Agent, a course, course to course) | The new page replaces the old one in the frame of the click and fades in from 40% opacity. Opacity only. Nothing animates out, and no row, column or number makes its own entrance. The page starts at its top. | 150 ms |
| Grade ring on a course page | The earned arc draws in. It is the one thing that performs on arrival; the figure inside the ring and every other number are final from the first frame. | 700 ms |
| Data that is not there yet | Its place is reserved. A placeholder (flat bars) is painted only if the wait passes 150 ms. Content that replaces a painted placeholder fades in; content that arrives sooner is painted as it is, with no placeholder before it and no fade. | 150 ms fade |
| Sidebar and tab indicator | One mark slides from the old item to the new one. | 250 ms |
| Dialogs | Fade and scale in from 97%; leave faster. | 250 ms in, 150 ms out |
| Assessment drawer | Slides in from the right over a fading scrim; leaves faster. | 250 ms in, 150 ms out |
| Phone menu | Fades in from 40% opacity. It closes at once, so the page chosen in it is not held up. | 150 ms |
| Folding rows (a parent assessment, the ungraded group, the edit form in the drawer) | The row opens over several frames and the rows below move with it. | 250 ms |
| Theme or background change | Every colour on the page fades to its new value together. | 250 ms |
| Hover, press, focus | Colour, and a 3% press on buttons that are not rows. | 150 ms |

Keyframes change opacity and transform only. No View Transition is used anywhere: while one runs, the browser shows a picture of the page and the page under it takes no clicks.

With `prefers-reduced-motion: reduce` every animation and transition is off and each end state applies at once. Placeholders and the busy state of the Refresh button still show, without a fade. The busy Refresh button is `aria-disabled` and ignores clicks, so keyboard focus stays on it. There is no motion setting in the app.

## What was wrong before

Measured on `origin/main` at 76abd01, before any change (method below; the full notes and raw output are kept outside the repository).

1. A page switch ran inside a View Transition. For about 290 ms its overlay took every pointer event. Three real clicks 40 ms apart (week, course 1, course 2, Agent) and the same three 120 ms apart both ended on course 1: the second and third click hit `<html>`.
2. The switch was late and doubled. The browser captured the old page first, the new page started at opacity 0 and the old one faded out over it, so for a few frames two pages were printed on top of each other. On the desktop the first frame came 33 to 65 ms after the click and the page was 90% visible at 117 to 175 ms.
3. Entrances were stacked on top of the transition. Opening a course ran 21 animations at once (the transition, a staggered rise of every assessment row, the weight segments growing, the arc drawing) while two figures counted up from 0, so the average and the graded weight showed numbers that were not the course's for 700 ms. The week page reran a seven-column stagger on every arrival and on every previous / next (about 450 ms each).
4. The course data lived in the week and course component, which was unmounted on the Agent page. Coming back fetched everything again with three requests in series. Until they answered, the sidebar said there were no courses, the week showed one deadline instead of four, and a course page said "Course unavailable or not selected". When the data landed, the "Needs you" list pushed the week grid down 209 px and the rows under it by up to 373 px.
5. The first load fetched the course reports three times: on mount; again because a sync-status effect counted its own first run as a change; and again because the component was keyed by time zone and remounted when the institution's zone replaced the browser's. Content arrived after 4.3 round trips.
6. Dialogs grew when their data arrived. Settings showed two "Loading…" lines and then jumped from 770 to 900 px tall, moving the rows below by 405 px in one frame. With a fast API the two lines flashed for 33 ms.
7. Refresh gave no sign of work in progress.
8. The theme change crossfaded the window in a View Transition while 103 controls ran their own colour transitions inside it. The crossfade itself was even; clicks were blocked for its length.
9. The phone menu appeared and disappeared in one frame.

The sliding indicator already worked (16 frames, ending exactly on the item) and was kept.

## What changed

- `go()` in `App.tsx` only sets the view. A layout effect scrolls to the top and calls `pageFade`, which cancels a fade still running before it starts the next.
- `LocalPlanning` stays mounted behind the Agent page and holds the course data for the whole visit; coming back reads it again in the background without clearing what is shown. Each page has its own React key, so one page's elements are not reused as another's.
- The first load reads the course reports once (twice when a sync is running at that moment, because a course may finish between the page's read and the first status read). The change log is read beside them; the corrections still wait for the reports, because the stored keys are migrated from them first. The week is recomputed when the time zone arrives instead of remounting the component, and nothing is drawn until the zone is known.
- "Loaded" is a state. Before it, the sidebar reserves one row for each selected course (the count is in `localStorage`), the page body shows the placeholder, and the settings line reads "2 selected" without the codes.
- Settings opens with its forms filled: the source settings are the ones the shell already read, the model settings are read once at start-up and kept for the visit, and the sync records are read when the owner menu opens. A fresh reply replaces a form unless it was edited meanwhile. A form that is still unknown shows a placeholder of the form's own height.
- "Edit courses" reserves one row for each course already selected and the Save button's place.
- The stagger of the week columns, the stagger of the assessment rows, the growing weight segments and the count-up are gone (`useCountUp` is deleted). The arc still draws.
- The theme and background change sets `data-theming` for 300 ms, during which every element transitions its colours over 250 ms. `::view-transition { pointer-events:none }` was tried first and did not help: the root is captured, and captured content is not hit-tested, so the click still went to `<html>`.
- One reduced-motion block replaces four scattered ones. `::details-content` has its own line in it, because the universal selector does not reach that pseudo-element; the first version of the block missed it and the geometry track showed the row still sliding for 15 frames.

## How it was measured

Each build ran as its own synthetic instance (two synthetic courses, a temporary home folder) under `node scripts/dev.mjs`, the way the app is normally run: Vite's dev server and React's development build. A throw-away headless Chrome drove it over the DevTools protocol with real mouse events, so hit-testing was the browser's own. The page clock was pinned to a Monday morning. The browser's time zone was not the institution's (Australia/Melbourne), which is the case the old build handled worst; the same-zone case is noted under the tables.

A script injected before the app recorded, without changing behaviour:

- Layout Instability entries (`PerformanceObserver`, type `layout-shift`). The table sums every entry after the click, including those the API marks `hadRecentInput`: it marks everything within 500 ms of an input, and a page switch is always that.
- The layout box of every element up to four levels under the main area, two under the sidebar body and two under an open dialog or the drawer, once per animation frame, from the offset chain, so transforms do not count. "Largest jump" is the largest move in one frame of an element that was already there. This catches what the API does not report; in one early run the API listed nothing for a first-load shift that this track measured at 373 px.
- The click event's timestamp, and per frame: the `requestAnimationFrame` timestamp, the opacity of the arriving page, dialog or drawer, the finite animations listed by `document.getAnimations()` for rendered content, and a signature of what the page showed (page, sidebar rows, deadlines, plan blocks, rows, loading lines, placeholders, open dialogs, theme).
- `longtask` and `long-animation-frame` entries, and every request to the local API.

Times are from the click. **First frame** is the first animation frame in which the destination is in the document and has opacity above 0 (and, in the old build, the View Transition was past its capture). **Data shown** is the first frame in which the destination shows its data. **Settled** is the last frame in which anything was still changing. Every request to `/api/local` was held in the browser for 0, 400 or 2000 ms.

## Before and after

`a → b` is `origin/main` → this change; a single value means no difference. "=" under "data shown" means the data was there in the first frame in both builds.

### Desktop 1440 × 900, API not delayed

| Moment | Layout shift (sum) | Largest jump (px) | Click → first frame (ms) | Click → data shown (ms) | Click → settled (ms) | Long tasks |
| --- | --- | --- | --- | --- | --- | --- |
| First load (reload) | 0.0998 → 0 | 373 → 0 | 58 → 62 | 108 → 78 | 524 → 78 | 0 |
| Week → Agent | 0 | 1 → 0 | 36 → 3 | = | 286 → 270 | 0 |
| Agent → week | 0.0998 → 0 | 373 → 0 | 42 → 7 | 59 → 7 | 459 → 257 | 0 |
| Week → course | 0.0273 → 0 | 1 → 0 | 62 → 3 | = | 745 → 753 | 0 |
| Course → course | 0.0014 → 0 | 19 → 0 | 40 → 15 | = | 573 → 265 | 0 |
| Course → week | 0 | 0 | 50 → 0 | = | 467 → 283 | 0 |
| Agent → course | 0 | 1 → 0 | 36 → 11 | = | 753 → 711 | 0 |
| Course tab → Revision | 0 | 0 | 10 → 0 | = | 277 → 267 | 0 |
| Course tab → Assessments | 0 | 1 → 0 | 12 → 10 | = | 445 → 260 | 0 |
| Fold a parent row open | 0.0327 | 79 | 29 → 24 | = | 263 → 257 | 0 |
| Fold it closed | 0.0311 | 69 | 10 → 5 | = | 260 → 255 | 0 |
| Drawer: open | 0 | 1 → 0 | 36 → 49 | = | 386 → 299 | 0 |
| Drawer: close | 0 | 0 | 16 → 11 | = | 182 → 194 | 0 |
| Week → month | 0.0060 | 243 | 11 → 10 | = | 178 → 177 | 0 |
| Month → week | 0.0060 | 243 | 15 → 11 | = | 448 → 161 | 0 |
| Next week | 0.0023 | 47 | 12 | = | 445 → 179 | 0 |
| Previous week | 0.0023 | 47 | 11 → 10 | = | 444 → 177 | 0 |
| Refresh | 0 | 0 | 5 → 1 | = | 172 → 151 | 0 |
| Owner menu: open | 0 | 0 | 1 → 12 | = | 151 → 179 | 0 |
| Settings: open | 0 | 405 → 0 | 33 → 52 | = | 267 → 302 | 0 |
| Theme → dark | 0 | 0 | 47 → 14 | = | 397 → 314 | 0 |
| Theme → light | 0 | 0 | 38 → 12 | = | 371 → 311 | 0 |
| Settings: close | 0 | 0 | 14 → 3 | = | 181 → 170 | 0 |
| Sync data: open | 0 | 0 | 24 → 27 | = | 274 → 260 | 0 |
| Sync data: close | 0 | 0 | 9 → 11 | = | 159 → 161 | 0 |
| Settings → Edit courses | 0 | 72 → 0 | 3 → 10 | 36 → 43 | 286 → 260 | 0 |
| Edit courses: close | 0 | 0 | 8 → 6 | = | 175 → 156 | 0 |

### Phone 390 × 844, API not delayed

| Moment | Layout shift (sum) | Largest jump (px) | Click → first frame (ms) | Click → data shown (ms) | Click → settled (ms) | Long tasks |
| --- | --- | --- | --- | --- | --- | --- |
| First load (reload) | 0.2096 → 0 | 891 → 0 | 47 → 39 | 97 → 73 | 514 → 73 | 0 |
| Phone menu: open | 0 | 0 | 6 → 5 | = | 172 → 155 | 0 |
| Phone menu: close | 0 | 0 | 1 → 2 | = | 1 → 2 | 0 |
| Week → Agent | 0 | 1 → 0 | 41 → 12 | = | 307 → 178 | 0 |
| Agent → week | 0.2109 → 0 | 891 → 0 | 34 → 0 | 50 → 0 | 450 → 183 | 0 |
| Week → course | 0.0517 → 0 | 0 | 77 → 11 | = | 777 → 744 | 0 |
| Course → course | 0.0166 → 0 | 46 → 0 | 48 → 10 | = | 581 → 177 | 0 |
| Course → week | 0 | 0 | 51 → 15 | = | 468 → 182 | 0 |
| Agent → course | 0 | 10 → 0 | 33 → 14 | = | 750 → 714 | 0 |
| Course tab → Revision | 0 | 0 | 1 → 11 | = | 285 → 278 | 0 |
| Course tab → Assessments | 0 | 0 | 3 | = | 437 → 253 | 0 |
| Fold a parent row open | 0.0679 | 79 | 31 → 23 | = | 265 → 256 | 0 |
| Fold it closed | 0.0647 → 0.0646 | 69 | 15 → 11 | = | 265 → 278 | 0 |
| Drawer: open | 0 | 1 → 0 | 30 → 29 | = | 380 → 279 | 0 |
| Drawer: close | 0 | 1 → 0 | 0 → 11 | = | 367 → 344 | 0 |
| Week → month | 0 | 436 | 11 → 16 | = | 178 → 183 | 0 |
| Month → week | 0 | 436 | 13 → 2 | = | 447 → 168 | 0 |
| Next week | 0 | 436 | 15 → 5 | = | 448 → 188 | 0 |
| Previous week | 0 | 436 | 11 → 2 | = | 444 → 152 | 0 |
| Refresh | 0 | 0 | 2 | = | 152 → 169 | 0 |
| Owner menu: open | 0 | 0 | 10 → 8 | = | 160 → 158 | 0 |
| Settings: open | 0 | 745 → 0 | 43 → 33 | = | 276 → 283 | 0 |
| Theme → dark | 0 | 0 | 41 → 4 | = | 391 → 304 | 0 |
| Theme → light | 0 | 0 | 37 → 4 | = | 370 → 304 | 0 |
| Settings: close | 0 | 0 | 12 → 5 | = | 162 → 172 | 0 |
| Sync data: open | 0 | 10 → 0 | 29 | = | 279 | 0 |
| Sync data: close | 0 | 0 | 3 → 11 | = | 353 → 361 | 0 |
| Settings → Edit courses | 0 | 80 → 8 | 9 → 2 | 43 → 35 | 276 → 285 | 0 |
| Edit courses: close | 0 | 0 | 7 → 16 | = | 157 → 166 | 0 |

### Moments that read data, each request held 400 ms (desktop)

| Moment | Layout shift (sum) | Largest jump (px) | Click → first frame (ms) | Click → data shown (ms) | Click → settled (ms) | Long tasks |
| --- | --- | --- | --- | --- | --- | --- |
| First load (reload) | 0.0998 → 0 | 373 → 0 | 52 → 33 | 1719 → 867 | 1719 → 1050 | 0 |
| Agent → week | 0.0998 → 0 | 373 → 0 | 33 → 3 | 1250 → 3 | 1250 → 286 | 0 |
| Agent → course | 0 | 1 → 0 | 38 → 3 | 1238 → 3 | 1954 → 736 | 0 |
| Course tab → Revision | 0 | 0 | 3 | = | 420 → 419 | 0 |
| Refresh | 0 | 0 | 1 → 2 | = | 168 → 1019 | 0 |
| Settings: open | 0.0568 → 0 | 405 → 0 | 41 | 424 → 41 | 424 → 291 | 0 |
| Sync data: open | 0 | 0 | 33 → 26 | 416 → 26 | 416 → 259 | 0 |
| Settings → Edit courses | 0.0150 → 0 | 72 → 0 | 16 → 13 | 432 → 429 | 432 → 579 | 0 |

### Moments that read data, each request held 400 ms (phone)

| Moment | Layout shift (sum) | Largest jump (px) | Click → first frame (ms) | Click → data shown (ms) | Click → settled (ms) | Long tasks |
| --- | --- | --- | --- | --- | --- | --- |
| First load (reload) | 0.2135 → 0 | 891 → 0 | 46 → 38 | 1713 → 871 | 1713 → 1038 | 0 |
| Agent → week | 0.2135 → 0 | 891 → 0 | 45 → 15 | 1278 → 15 | 1278 → 181 | 0 |
| Agent → course | 0 | 10 → 0 | 34 → 16 | 1234 → 16 | 1950 → 733 | 0 |
| Course tab → Revision | 0 | 0 | 7 → 4 | = | 424 → 421 | 0 |
| Refresh | 0 | 0 | 3 → 2 | = | 170 → 1035 | 0 |
| Settings: open | 0.9603 → 0 | 745 → 0 | 27 → 47 | 427 → 47 | 427 → 280 | 0 |
| Sync data: open | 0 | 10 → 0 | 25 → 37 | 408 → 37 | 408 → 287 | 0 |
| Settings → Edit courses | 0.0637 → 0.0064 | 80 → 8 | 0 → 10 | 434 → 443 | 434 → 610 | 0 |

### Moments that read data, each request held 2000 ms (desktop)

| Moment | Layout shift (sum) | Largest jump (px) | Click → first frame (ms) | Click → data shown (ms) | Click → settled (ms) | Long tasks |
| --- | --- | --- | --- | --- | --- | --- |
| First load (reload) | 0.0998 → 0 | 373 → 0 | 45 → 46 | 8111 → 4096 | 8111 → 4279 | 0 |
| Agent → week | 0.0998 → 0 | 373 → 0 | 33 → 2 | 6067 → 2 | 6067 → 269 | 0 |
| Agent → course | 0 | 1 → 0 | 35 → 12 | 6035 → 12 | 6768 → 729 | 0 |
| Course tab → Revision | 0 | 0 | 2 → 3 | = | 2019 → 2020 | 0 |
| Refresh | 0 | 0 | 7 → 9 | = | 173 → 4243 | 0 |
| Settings: open | 0.0568 → 0 | 405 → 0 | 29 → 59 | 2029 → 59 | 2029 → 293 | 0 |
| Sync data: open | 0 | 0 | 29 → 38 | 2012 → 38 | 2012 → 288 | 0 |
| Settings → Edit courses | 0.0150 → 0 | 72 → 0 | 1 | 2018 → 2034 | 2018 → 2201 | 0 |

### Interruption

| Build | Input | Clicks that reached their target | Ends on | Anything left running | Indicator |
| --- | --- | --- | --- | --- | --- |
| before | 3 clicks 40 ms apart | 1 of 3 | course (the first click) | none | on the current item |
| before | 3 clicks 120 ms apart | 1 of 3 | course (the first click) | none | on the current item |
| before | theme picked twice 60 ms apart, then a click 60 ms later | 0 of 1 (target `html`) | light (the last pick) | none | – |
| after | 3 clicks 40 ms apart | 3 of 3 | Agent (the last click) | none | on the current item |
| after | 3 clicks 120 ms apart | 3 of 3 | Agent (the last click) | none | on the current item |
| after | theme picked twice 60 ms apart, then a click 60 ms later | 1 of 1 (target `h2#panel-title`) | light (the last pick) | none | – |

Reading the tables:

- No long task (over 50 ms) and no long animation frame was recorded in any of these runs, old or new. (The earlier audit runs of the old build recorded a few long animation frames of up to 99 ms; with none in these runs, they are not held against it.) The longest gap between two frames was 50 ms in the old build (one frame over 34 ms, on the phone) and 33 ms in the new one. The most animations running at once, leaving the theme change aside, went from 21 to 8.
- Opening a course still settles at about 750 ms because the arc draws for 700 ms. Everything else on the page is final after the 150 ms fade.
- Refresh "settles" later because the wait is now shown: the button dims 150 ms after the click and comes back when the data has. Before, nothing on screen changed.
- Settings opens one or two frames later than before in most runs: it now renders both forms in its first frame instead of two loading lines.
- "Sync data: open" flatters the new build. The script lets the page go quiet between opening the owner menu and choosing the item, so the request that now starts when the menu opens had always answered. With the two clicks closer together than the request takes, the dialog shows its loading line after 150 ms, as the old build did at once.
- In the institution's own time zone (emulated), the old build's first load with 400 ms per request showed its data at 1307 ms instead of 1719 ms, because the remount by time zone does not happen there; the new build took 879 ms.
- The old build was run twice on the desktop with delayed requests (once for the audit). The layout-shift sums and jump sizes of the two runs agree, except one sum that differs in the fourth decimal.

## Reduced motion

`prefers-reduced-motion: reduce` was emulated in the same browser, in two ways.

The same script ran the moments again with 400 ms per request:

| Run | Moments | Moments with a running animation or transition (peak count) | Moments where layout moved over several frames | Moments where a loading state was painted |
| --- | --- | --- | --- | --- |
| before desktop +400 | 29 | none | agent→week (2 frames) | settings-open, syncdata-open |
| after desktop +400 | 29 | none | none | first-load, settings→edit-courses |
| after phone +400 | 31 | none | none | first-load, settings→edit-courses |

The old build was already clean here; its "agent→week" entry is the data arriving and moving the page in two separate frames, not an animation. The new one adds the placeholder at first load, which is a loading state and is painted without a fade. (The sync records were read ahead in the new build, so "Sync data" had nothing to wait for; see the note above.)

A second script walked 20 states on the desktop and 20 on the phone (loading, each page switch, a folding row, both tabs, the drawer opening and closing, month and week, Refresh while waiting, Settings, both theme changes, "Edit courses" while waiting and closing) and read the computed style of every element and of its `::before` and `::after` (71 to 410 per state), of each open dialog's `::backdrop` and of each `<details>`'s `::details-content`. In all 40 states every transition duration was 0, every animation name was `none`, and `document.getAnimations()` was empty right after the action. Placeholders were painted in four of them (the two loading states and the two "Edit courses" waits).

`test/motion.test.ts` covers the script side: under reduced motion `pageFade` and `drawArc` start nothing, `themeTransition` applies the change without marking the page, and `closeDialog` closes at once.

## What was left as it is

- Folding rows animate their height (`::details-content`, `block-size`), which is layout: 15 frames, the rows below move 69 to 79 px in total, no frame over 17 ms. The alternative is one jump of the same size.
- The indicators animate `width` and `height` as well as a transform. They are absolutely positioned, so nothing else is laid out again.
- Week ↔ month and previous / next change the height of the grid, so the task list under it moves (243 px and 47 px on the desktop). That is the content changing, not a load.
- "Sync data" still grows if its records arrive after the dialog is open, which now needs the request to take longer than the time between opening the owner menu and choosing the item. The number of records is not known in advance.
- "Edit courses" reserves the rows of the courses already selected. An account with more candidates than that still grows by the difference, and on the phone a course name that wraps makes a row 8 px taller than its placeholder.
- The Agent page's own animations (a new message rising in, the caret) were not touched; that page has since been replaced by DeepTutor's own interface in a frame, and the old one deleted.

## Limits

- Headless Chrome on one Mac, in the dev server with React's development build, with two synthetic courses. Frame times on a real screen, in Safari or Firefox, or with real courses were not measured.
- One run per configuration for the new build, two for the old. The millisecond figures move by a frame or two between runs (a frame is 16.7 ms).
- The sampling script itself runs every frame and adds main-thread work, the same for both builds.
- The API delay holds each request for a fixed time. It does not model a slow disk, a busy sync or a stalled connection.
- The theme `<select>` was driven by setting its value and dispatching `change`, because a native menu cannot be driven; everything else was a real click.
- How it looks was judged from screencast frame strips, kept outside the repository with the raw output. Screencast frames arrive two to four frames late, so the strips show what a frame looked like, not when it was painted. Nobody has watched the result on a real screen yet.
