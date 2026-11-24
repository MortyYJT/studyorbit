# Colours

StudyOrbit uses the colours of the Codex desktop app (OpenAI's ChatGPT/Codex app for macOS), light and dark. This page records where every value comes from, the measured contrast of each place a colour is used, the values that were not copied because they were too faint, and how far apart the six weight colours are. The tokens are in `web/src/style.css`; `test/palette.test.ts` holds them to the numbers below.

## Where the values come from

The values were computed from the installed app (`com.openai.codex` 26.1117.41037, build 29803, default "codex" appearance, no account accent), on 2026-11-24. They were not read off a screenshot and not written from memory.

1. The app's semantic colours are not fixed in its stylesheet. Its theme code (module `qBrZ` in `app.asar`, called through `ncZO`) derives 89 variables from four inputs. With the app's own defaults (light: surface `#ffffff`, ink `#1a1c1f`, contrast 45; dark: surface `#181818`, ink `#ffffff`, contrast 60) that code was run unchanged in Node.
2. The app's main stylesheet (1.5 MB) and those 89 variables were loaded into headless Chromium on a root element carrying the attributes the app sets (`data-codex-window-type="electron"`, `data-codex-os="darwin"`, `data-theme`, `data-appearance-preset="codex"`).
3. Every custom property that resolves to a colour was read with `getComputedStyle`: 1,027 in light and 1,026 in dark.

The same extraction had been done once before, for another project, on the same app version. Its recorded surface, text, border and focus values and the colour-difference figures of its eight line colours were reproduced first, as a check on the method, before anything new was taken.

The scripts and the full dump are kept outside the repository, because they read a local application bundle.

## Tokens

Each token is written once as `light-dark(light, dark)`. Translucent values are laid over whatever surface they sit on, as in Codex, and they never stack: a place is a surface, or a surface with one fill on it. A press therefore shows the hover fill, and a control inside a filled area brings its own ground or takes no fill.

| Token | Used for | Light | Dark | Codex variable |
| --- | --- | --- | --- | --- |
| `--sidebar` | Sidebar, phone top bar and menu sheet | `#f6f6f6` | `#141414` | `--color-token-side-bar-background` |
| `--ground` | Workspace | `#ffffff` | `#181818` | `--color-surface` |
| `--surface` | Cards and panels on the workspace | `#ffffff` | `#181818` | `--color-surface-card` |
| `--float` | Dialogs, the drawer, menus | `#ffffff` | `#282828` | `--color-surface-card` / `--color-surface-tertiary` (what Codex's settings dialog uses) |
| `--field` | Inputs and selects | `#ffffff` | `#2d2d2d` | `--color-background-control-opaque` |
| `--raised` | Quiet fill that stays: plan blocks, the deadline band, the weight strip | ink 4.7% | white 5.1% | `--color-background-secondary-soft` |
| `--hover` | Hovered and pressed rows and buttons | ink 5.5% | white 7.8% | `--color-token-list-hover-background` |
| `--active` | Current row, the segmented track, a hovered plan block | ink 12% | `#dfdfdf` 16% | `--color-background-secondary-ghost-active` |
| `--rule` | Row separators, the sidebar edge | ink 7.8% | white 8.2% | `--color-token-border-default` |
| `--border` | Card, dialog and button outlines | ink 11.8% | white 15.7% | `--color-token-border-heavy` |
| `--border-strong` | Edge of a field, dashed edge of a manual task | ink 50% | `#dfdfdf` 50% | `--input-outline-border-color-focus` |
| `--text` | Text | `#1a1c1f` | `#dfdfdf` | `--color-text` |
| `--muted` | Secondary text | `#606164` | `#bcbcbc` | `--app-color-text-foreground-secondary` over the workspace |
| `--faint` | Placeholders, "No plan", days outside the month | `#6a6b6d` | `#999999` | `--color-text-secondary` over the workspace |
| `--accent`, `--accent-hover`, `--on-accent` | Primary button, today, the earned arc, progress, the avatar, the toast | `#1a1c1f`, `#303030`, `#ffffff` | `#dfdfdf`, `#ededed`, `#2d2d2d` | `--color-background-primary-solid`, `…-solid-hover`, `--color-text-primary-solid` |
| `--focus` | Focus ring | `#0169cc` | `#0285ff` | `--color-token-focus-border` |
| `--selection` | Selected text | `#e0f0ff` | `#0f2e4a` | `--color-background-text-selection` |
| `--signal` | The alert dot, the "No source" and conflict marks | `#ba2623` | `#ff6764` | `--color-text-danger-soft` / `--app-color-text-error` |
| `--track` | Unfilled part of the ring and the weight bar | `#dfdfdf` | `#414141` | `--slider-track-color` |
| `--weight-0` … `--weight-5` | The groups of the weight bar | see below | see below | see below |
| `--tint` | The optional gradient background | `#e5f2ff` at 60% | `#0d273f` at 60% | `--app-color-background-accent`, weakened (see below) |
| `--scrim` | Behind dialogs and the drawer | black 30.2% | black 50.2% | `--modal-backdrop-background` |

Ink is `#1a1c1f` (`rgb(26 28 31)`). On macOS the Codex sidebar is translucent over the system's window material, so its colour changes with the wallpaper; a web page cannot do that, and the sidebar here is the opaque token.

## Codex values that were not copied

Text under 4.5:1, and marks or edges under 3:1, did not take Codex's value. Each row gives the nearest value from Codex itself that passes.

| Role | Codex value | Ratio | Used instead | Ratio |
| --- | --- | --- | --- | --- |
| Placeholder and other faint text, light | `--color-text-tertiary`, `#8e8f90` on white | 3.24 | `--color-text-secondary`, `#6a6b6d` | 5.33 |
| Placeholder in a field, dark | `--color-text-tertiary`, `#969696` on `#2d2d2d` | 4.63 (passes) | `--color-text-secondary`, `#999999`, to keep one faint tone in both modes | 4.83 |
| Secondary text on the current sidebar row, light | `--color-text-secondary`, `#6a6b6d` on `#dcdcdc` | 3.88 | `--app-color-text-foreground-secondary`, `#606164`, for all secondary text | 4.51 |
| Secondary text on the current sidebar row, dark | `--color-text-secondary`, `#999999` on `#343434` | 4.34 | `--app-color-text-foreground-secondary`, `#bcbcbc` | 6.51 |
| Secondary text on the segmented track inside a dialog, dark | `--color-text-secondary`, `#999999` on `#454545` | 3.35 | `--app-color-text-foreground-secondary`, `#bcbcbc` | 5.03 |
| Alert text, dark | `--color-text-danger`, `#e02e2a` on `#181818` | 3.88 | `--app-color-text-error`, `#ff6764` | 6.24 |
| Alert text on the weight strip and on a hovered row, dark | `--color-text-danger-soft`, `#fa423e` on `#242424` and `#2a2a2a` | 4.38 and 4.04 | `--app-color-text-error`, `#ff6764` | 5.47 and 5.04 |
| Edge of a field, light | `--color-token-input-border`, ink 11.8% over the white field | 1.27 | `--input-outline-border-color-focus`, ink 50% | 3.30 |
| Edge of a field, dark | `--color-token-input-border`, white 15.7% over the `#2d2d2d` field: against the workspace, a dialog, the inside of the field | 2.13, 1.77, 1.65 | `--input-outline-border-color-focus`, `#dfdfdf` 50% | 4.88, 4.05, 3.78 |
| Gradient background, light | `--app-color-background-accent`, `#e5f2ff`, at full strength: a field's edge against it | 2.91 | the same colour at 60% over the workspace, `#eff7ff` | 3.06 |
| Green weight colour, light | `--color-chart-green`, `#04b84c` on the strip | 2.40 | `--green-500`, `#00a240` | 3.07 |
| Yellow weight colour, light | `--color-chart-yellow`, `#ffc300` on the strip | 1.47 | `--yellow-800`, `#6e5400` | 6.53 |
| Unfilled part of the ring | `--color-chart-empty`, `#f3f3f3` on white and `#303030` on `#181818` | 1.11 and 1.35 | `--slider-track-color`, `#dfdfdf` and `#414141` | 1.33 and 1.74 |

Two things here were decided for reasons other than a failing ratio. Codex's orange and red chart colours are left out of the weight bar because orange and red would read as alerts next to the one alert red. And the unfilled part of the ring is still under 3:1 on purpose: it is the absence of a mark. The earned arc is 12.81:1 against it in light and 7.66:1 in dark, and the figure in the middle of the ring says the same thing in text.

Codex's link blue (`--color-token-text-link-foreground`, `#339cff`, 2.86:1 on white) is not used either; links stay underlined ink, as before.

One contrast fault that had nothing to do with Codex was fixed on the way: past days in the week view were dimmed with `opacity: .55`, which put the day's heading at 4.17:1 in light and "No plan" at 2.23:1 in light and 2.58:1 in dark. A past day now steps back by tone: its heading is `--muted` (6.19 and 9.35) and "No plan" is the same `--faint` as on any other day (5.33 and 6.23). A past day holds nothing else, because the plan is laid out from today on.

## Measured contrast

WCAG 2 contrast of every pairing the stylesheet produces, computed from the tokens (`test/palette-tokens.ts` lists the pairs; `test/palette.test.ts` fails when one drops under its floor). A translucent layer is composited over the surface below it first. A border is painted over its own element's background, so a field's edge is composited over the field and then compared with what is outside the field and with its inside. The gradient background is measured where it is strongest. The same test checks the rules that keep fills from stacking, so the list of surfaces is complete.

| What | Token on surface | Floor | Light | Dark |
| --- | --- | --- | --- | --- |
| Text on sidebar | `--text` on `--sidebar` | 4.5 | 15.80 | 13.82 |
| Text on sidebar, hovered row | `--text` on `--sidebar` + `--hover` | 4.5 | 14.19 | 11.31 |
| Text on sidebar, current row | `--text` on `--sidebar` + `--active` | 4.5 | 12.43 | 9.28 |
| Text on workspace | `--text` on `--ground` | 4.5 | 17.08 | 13.32 |
| Text on workspace, quiet fill | `--text` on `--ground` + `--raised` | 4.5 | 15.57 | 11.68 |
| Text on workspace, hovered row | `--text` on `--ground` + `--hover` | 4.5 | 15.32 | 10.77 |
| Text on gradient background | `--text` on `--ground` + `--tint` | 4.5 | 15.82 | 12.27 |
| Text on gradient background, quiet fill | `--text` on `--ground` + `--tint` + `--raised` | 4.5 | 14.44 | 10.65 |
| Text on gradient background, hovered row | `--text` on `--ground` + `--tint` + `--hover` | 4.5 | 14.21 | 9.79 |
| Text on card | `--text` on `--surface` | 4.5 | 17.08 | 13.32 |
| Text on card, quiet fill | `--text` on `--surface` + `--raised` | 4.5 | 15.57 | 11.68 |
| Text on card, hovered row | `--text` on `--surface` + `--hover` | 4.5 | 15.32 | 10.77 |
| Text on card, current row or hovered plan block | `--text` on `--surface` + `--active` | 4.5 | 13.40 | 8.82 |
| Text on segmented track | `--text` on `--ground` + `--active` | 4.5 | 13.40 | 8.82 |
| Text on dialog | `--text` on `--float` | 4.5 | 17.08 | 11.06 |
| Text on dialog, quiet fill | `--text` on `--float` + `--raised` | 4.5 | 15.57 | 9.49 |
| Text on dialog, hovered row | `--text` on `--float` + `--hover` | 4.5 | 15.32 | 8.70 |
| Text on field | `--text` on `--field` | 4.5 | 17.08 | 10.33 |
| Muted text on sidebar | `--muted` on `--sidebar` | 4.5 | 5.73 | 9.70 |
| Muted text on sidebar, hovered row | `--muted` on `--sidebar` + `--hover` | 4.5 | 5.15 | 7.93 |
| Muted text on sidebar, current row | `--muted` on `--sidebar` + `--active` | 4.5 | 4.51 | 6.51 |
| Muted text on workspace | `--muted` on `--ground` | 4.5 | 6.19 | 9.35 |
| Muted text on workspace, quiet fill | `--muted` on `--ground` + `--raised` | 4.5 | 5.65 | 8.20 |
| Muted text on workspace, hovered row | `--muted` on `--ground` + `--hover` | 4.5 | 5.56 | 7.56 |
| Muted text on gradient background | `--muted` on `--ground` + `--tint` | 4.5 | 5.74 | 8.61 |
| Muted text on gradient background, quiet fill | `--muted` on `--ground` + `--tint` + `--raised` | 4.5 | 5.24 | 7.47 |
| Muted text on gradient background, hovered row | `--muted` on `--ground` + `--tint` + `--hover` | 4.5 | 5.15 | 6.87 |
| Muted text on card | `--muted` on `--surface` | 4.5 | 6.19 | 9.35 |
| Muted text on card, quiet fill | `--muted` on `--surface` + `--raised` | 4.5 | 5.65 | 8.20 |
| Muted text on card, hovered row | `--muted` on `--surface` + `--hover` | 4.5 | 5.56 | 7.56 |
| Muted text on card, current row or hovered plan block | `--muted` on `--surface` + `--active` | 4.5 | 4.86 | 6.19 |
| Muted text on segmented track | `--muted` on `--ground` + `--active` | 4.5 | 4.86 | 6.19 |
| Muted text on dialog | `--muted` on `--float` | 4.5 | 6.19 | 7.76 |
| Muted text on dialog, quiet fill | `--muted` on `--float` + `--raised` | 4.5 | 5.65 | 6.66 |
| Muted text on dialog, hovered row | `--muted` on `--float` + `--hover` | 4.5 | 5.56 | 6.10 |
| Muted text on field | `--muted` on `--field` | 4.5 | 6.19 | 7.25 |
| Faint text on card | `--faint` on `--surface` | 4.5 | 5.33 | 6.23 |
| Faint text on card, hovered row | `--faint` on `--surface` + `--hover` | 4.5 | 4.79 | 5.04 |
| Faint text on field | `--faint` on `--field` | 4.5 | 5.33 | 4.83 |
| Alert text on workspace | `--signal` on `--ground` | 4.5 | 6.20 | 6.24 |
| Alert text on workspace, quiet fill | `--signal` on `--ground` + `--raised` | 4.5 | 5.65 | 5.47 |
| Alert text on workspace, hovered row | `--signal` on `--ground` + `--hover` | 4.5 | 5.56 | 5.04 |
| Alert text on gradient background | `--signal` on `--ground` + `--tint` | 4.5 | 5.74 | 5.75 |
| Alert text on gradient background, quiet fill | `--signal` on `--ground` + `--tint` + `--raised` | 4.5 | 5.24 | 4.98 |
| Alert text on gradient background, hovered row | `--signal` on `--ground` + `--tint` + `--hover` | 4.5 | 5.16 | 4.58 |
| Alert text on card | `--signal` on `--surface` | 4.5 | 6.20 | 6.24 |
| Alert text on card, quiet fill | `--signal` on `--surface` + `--raised` | 4.5 | 5.65 | 5.47 |
| Alert text on card, hovered row | `--signal` on `--surface` + `--hover` | 4.5 | 5.56 | 5.04 |
| Alert text on dialog | `--signal` on `--float` | 4.5 | 6.20 | 5.18 |
| Text on the primary button, today's date and the toast | `--on-accent` on `--accent` | 4.5 | 17.08 | 10.33 |
| Text on the primary button, hovered or pressed | `--on-accent` on `--accent-hover` | 4.5 | 13.20 | 11.76 |
| Selected text | `--text` on `--selection` | 4.5 | 14.70 | 10.44 |
| Selected muted text | `--muted` on `--selection` | 4.5 | 5.33 | 7.32 |
| Alert dot on workspace | `--signal` on `--ground` | 3 | 6.20 | 6.24 |
| Alert dot on gradient background | `--signal` on `--ground` + `--tint` | 3 | 5.74 | 5.75 |
| Alert dot on card | `--signal` on `--surface` | 3 | 6.20 | 6.24 |
| Alert dot on card, quiet fill | `--signal` on `--surface` + `--raised` | 3 | 5.65 | 5.47 |
| Alert dot on card, hovered row | `--signal` on `--surface` + `--hover` | 3 | 5.56 | 5.04 |
| Alert dot on dialog | `--signal` on `--float` | 3 | 6.20 | 5.18 |
| Alert dot on dialog, quiet fill | `--signal` on `--float` + `--raised` | 3 | 5.65 | 4.44 |
| Alert dot on dialog, hovered row | `--signal` on `--float` + `--hover` | 3 | 5.56 | 4.07 |
| Earned arc, today marker, progress, deadline bar on card | `--accent` on `--surface` | 3 | 17.08 | 13.32 |
| Earned arc, today marker, progress, deadline bar on card, quiet fill | `--accent` on `--surface` + `--raised` | 3 | 15.57 | 11.68 |
| Earned arc, today marker, progress, deadline bar on dialog | `--accent` on `--float` | 3 | 17.08 | 11.06 |
| Earned arc against the rest of the ring | `--accent` on `--track` | 3 | 12.81 | 7.66 |
| Field edge on workspace | `--border-strong` over `--field`, against `--ground` | 3 | 3.30 | 4.88 |
| Field edge on gradient background | `--border-strong` over `--field`, against `--ground` + `--tint` | 3 | 3.06 | 4.49 |
| Field edge on card | `--border-strong` over `--field`, against `--surface` | 3 | 3.30 | 4.88 |
| Field edge on dialog | `--border-strong` over `--field`, against `--float` | 3 | 3.30 | 4.05 |
| Field edge against the inside of the field | `--border-strong` on `--field` | 3 | 3.30 | 3.78 |
| Dashed edge of a task added by hand, on card | `--border-strong` on `--surface` | 3 | 3.30 | 4.22 |
| Focus ring on sidebar | `--focus` on `--sidebar` | 3 | 4.99 | 5.09 |
| Focus ring on workspace | `--focus` on `--ground` | 3 | 5.39 | 4.91 |
| Focus ring on gradient background | `--focus` on `--ground` + `--tint` | 3 | 5.00 | 4.52 |
| Focus ring on card | `--focus` on `--surface` | 3 | 5.39 | 4.91 |
| Focus ring on dialog | `--focus` on `--float` | 3 | 5.39 | 4.07 |
| Focus ring on field | `--focus` on `--field` | 3 | 5.39 | 3.80 |
| Weight colour 1 on card | `--weight-0` on `--surface` | 3 | 3.62 | 3.64 |
| Weight colour 1 on card, quiet fill | `--weight-0` on `--surface` + `--raised` | 3 | 3.30 | 3.19 |
| Weight colour 2 on card | `--weight-1` on `--surface` | 3 | 7.60 | 10.53 |
| Weight colour 2 on card, quiet fill | `--weight-1` on `--surface` + `--raised` | 3 | 6.93 | 9.23 |
| Weight colour 3 on card | `--weight-2` on `--surface` | 3 | 7.27 | 8.59 |
| Weight colour 3 on card, quiet fill | `--weight-2` on `--surface` + `--raised` | 3 | 6.63 | 7.53 |
| Weight colour 4 on card | `--weight-3` on `--surface` | 3 | 3.36 | 3.77 |
| Weight colour 4 on card, quiet fill | `--weight-3` on `--surface` + `--raised` | 3 | 3.07 | 3.31 |
| Weight colour 5 on card | `--weight-4` on `--surface` | 3 | 3.74 | 4.55 |
| Weight colour 5 on card, quiet fill | `--weight-4` on `--surface` + `--raised` | 3 | 3.41 | 3.99 |
| Weight colour 6 on card | `--weight-5` on `--surface` | 3 | 7.16 | 11.04 |
| Weight colour 6 on card, quiet fill | `--weight-5` on `--surface` + `--raised` | 3 | 6.53 | 9.68 |
| Unfilled part of the ring on a card | `--track` on `--surface` | 1.3 | 1.33 | 1.74 |
| Unfilled part of the weight bar on the strip | `--track` on `--surface` + `--raised` | 1.2 | 1.22 | 1.52 |

## The six weight colours

The weight bar on the course page gives each assessment group one colour, and the legend under it prints the group's name beside the same colour. Before this change the six were steps of grey (ink mixed into the card at 100, 78, 60, 44, 30 and 18%): three of the six were under 3:1 on the strip in light and two in dark, and the two closest steps were 7.0 apart (CIEDE2000) in light and 9.1 in dark.

Codex has no set of six categorical colours with enough contrast in both modes, so each colour is a step of one of its scales or one of its chat accents: at least 3:1 on the strip, one hue family per slot, the same family in the same slot in both modes, and among those the set whose two closest colours are furthest apart. Slots are ordered to keep neighbours in the bar far apart, with blue first and the dark yellow last.

| Slot | Light | On strip | Codex variable | Dark | On strip | Codex variable |
| --- | --- | --- | --- | --- | --- | --- |
| 1 blue | `#0285ff` | 3.30 | `--color-chart-blue` | `#3566f0` | 3.19 | `--color-chat-accent-blue` |
| 2 teal | `#055f51` | 6.93 | `--color-text-chat-accent-green` | `#42dec2` | 9.23 | `--color-text-chat-accent-green` |
| 3 purple | `#6b3ab4` | 6.63 | `--purple-600` | `#c8a4fb` | 7.53 | `--color-text-chat-accent-purple` |
| 4 green | `#00a240` | 3.07 | `--green-500` | `#008635` | 3.31 | `--green-600` |
| 5 pink | `#e04c91` | 3.41 | `--pink-500` | `#f31c91` | 3.99 | `--brand-pink-500` |
| 6 yellow | `#6e5400` | 6.53 | `--yellow-800` | `#ffc300` | 9.68 | `--color-chart-yellow` |

The strip is `#f4f4f4` in light and `#242424` in dark (`--raised` over the card).

Smallest CIEDE2000 distance between any two of the six, and between neighbours in the bar. Colour-vision deficiency is simulated with Machado, Oliveira and Fernandes (2009) at full severity.

| | Normal vision | Deuteranopia | Protanopia |
| --- | --- | --- | --- |
| Light, any two | 28.4 | 16.3 | 15.0 |
| Light, neighbours | 38.2 | 19.8 | 31.6 |
| Dark, any two | 27.4 | 15.1 | 14.2 |
| Dark, neighbours | 41.8 | 19.2 | 31.4 |

The weight colour closest to the alert red is the pink: 26.4 away in light and 21.5 in dark. The closest to the ink is the teal: 27.8 in light and 25.3 in dark. As a rough guide, two colours under 10 apart can be mistaken for each other at a glance.

StudyOrbit has no colour per course. A course is told apart by its code, which is printed wherever the course appears (sidebar, plan blocks, deadlines, the "Needs you" list).

## Where colour carries meaning

| Place | Token | Check |
| --- | --- | --- |
| Earned arc of the grade ring and its legend swatch | `--accent` | 17.08 on the card in light, 13.32 in dark; 12.81 and 7.66 against the unfilled part |
| Weight bar segments and legend swatches | `--weight-0` … `--weight-5` | 3.07 or more on the strip in both modes |
| "Needs you" lines, sync errors, the result of a failed sync | `--signal` dot | 5.56 or more in light, 4.07 or more in dark, on every surface it appears on |
| "No source" and conflict marks (11px text with a border) | `--signal` | 5.16 or more in light, 4.58 or more in dark |
| Outline of the sync-conflict panel | `--signal` | same values as the dot |
| Deadline chip (a bar at its left edge), the exam tag's outline | `--text` | 15.57 or more in light, 11.68 or more in dark |
| Finished deadline | `--muted` text, struck through, bar in `--border-strong` | text 5.65 or more; the strike-through carries the state |
| Today in the week and month views | `--accent` line and date tile with `--on-accent` text | 17.08 and 10.33 for the date text |
| Task added by hand | dashed `--border-strong` outline | 3.30 in light, 4.22 in dark |

## Limits

- The fills that show state follow Codex and are under 3:1 against their surroundings: the current sidebar row (1.27:1 against the sidebar in light), a hovered row, the selected half of a segmented control. A press shows the same fill as a hover (buttons other than rows also shrink slightly); Codex's darker fill would put secondary and alert text under 4.5:1 on some surfaces. The current row is also set in a heavier weight and in `--text` where the others are `--muted`; the segmented control marks its selected half with `aria-pressed` and the same change of text colour.
- Button outlines use Codex's border (1.27:1 in light). A button is found by its label, which is at 4.5:1 or more; a field has no label inside it, which is why fields alone take the stronger edge.
- With an image background, text sits on panels that are 70 to 100% opaque over the picture, so its contrast depends on the picture. The table above covers the two backgrounds without a picture.
- `light-dark()` needs Chrome or Edge 123, Safari 17.5 or Firefox 120. The production build (`npm run build`) rewrites it for older browsers; the development server does not. In browsers whose `::backdrop` does not inherit custom properties (before Chrome 122, Safari 17.4 and Firefox 120) the shade behind a dialog is the light value, black at 30.2%, in both modes. No older browser was run.
- Contrast was computed from the tokens, and the pages were looked at in headless Chrome at 1440 and 390 wide. Safari and Firefox were not opened.
