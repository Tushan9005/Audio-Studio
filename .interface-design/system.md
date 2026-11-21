# Audio Studio design system

Read this before changing anything in `static/`. Tokens live on `:root` in `static/app.css`.
Use them instead of writing new hex values.

## Direction
- **Who:** Tushan, a singer-guitarist. He isn't technical and works in his room after recording a cover on his phone.
  He trims, practises, polishes and splits songs. Plain words, one obvious next step.
- **Feel:** a home studio at night. Dark walnut, felt, and one amber VU-meter glow. It should feel calm and warm,
  never a code editor (not GitHub blue-grey).
- **Focal point:** the waveform/player. Every tab serves it. Nothing else may out-shout it.
- **Signature:** the tape-splice trimmer. Amber bracket handles with grip tabs, the cut parts dimmed like
  masked tape, and times shown as monospace tape counters.
- **Offline:** no web fonts and no CDNs. Everything is vendored or system.

## Colour (one hue family, only lightness changes)
| Token | Value | Use |
|---|---|---|
| `--room` | `#13100d` | page background; also the sidebar (separated only by a hairline) |
| `--desk` | `#191511` | player, sticky command bars, modals |
| `--rack` | `#1f1a15` | cards |
| `--rack-hi` | `#28221c` | secondary buttons, hover, chips (selected) |
| `--inset` | `#0d0b09` | inputs, counters, stats, waveform well: anything that *receives* content |
| `--wire` / `-2` / `-3` | `rgba(255,232,205,.07 / .12 / .22)` | hairlines: standard / controls / hover-emphasis |
| `--ink` `--ink-2` `--ink-3` `--ink-4` | `#f3ece2 #c8bbaa #94887a #675d53` | primary / supporting / labels and meta / faint |
| `--glow` `--glow-hi` | `#f0a23b #f8b957` | **the only accent**: primary action, playhead, progress, trim handles, selected tab and file |
| `--glow-ink` | `#1c1306` | text on amber |
| `--glow-wash` `--glow-line` | amber at 11% / 45% | selected backgrounds / tags |
| `--live` `--rec` `--cue` `--photo` | `#67c48a #e8634f #86b4dc #a9c78f` | meaning only: in tune or preview on / recording, error, delete / video / photo |

Rules: about 90% of the screen is neutral. Amber means "act here" or "this is selected" and is never used as decoration.
No gradients for decoration.

## Type
- `--sans`: Segoe UI Variable Text. `--display`: Segoe UI Variable Display (headings, tuner note).
  `--mono`: Cascadia Mono, then Consolas. Use mono for **every time, counter, dB, LUFS or BPM value**.
- Scale from 14 px body: 11 (eyebrow labels, uppercase, +.08em tracking, 600) · 12.5 (notes, labels) · 14 (body,
  tabs) · 15 (card titles, 600) · 17 (Trim title) · 22 (file name, 650, −.015em) · 26 (empty-state heading) · 88 (tuner note).
- Hierarchy comes from weight and ink level first, size second. Use tabular-nums on anything that changes.

## Space, shape, depth
- 4 px grid. Card padding 16. Gaps: 2 (list rows), 8 (button groups), 12 (cards), 16 (sections), 24 (tab bar margin).
- Radius: `--r-sm` 7 (buttons, inputs) · `--r-md` 10 (counters, list rows, wells) · 12 (cards) · `--r-lg` 14 (player, command bar) · 18 (modal).
- Depth is **tonal surfaces plus hairline borders only**. No drop shadows on cards. Shadows are allowed only on floating
  things (toast, trim grips). Accents on a side use `box-shadow: inset 3px 0 0 <colour>` (toast, layer rows),
  never thick borders.

## Components (measurements)
- **Button** 36 h · 0 14 px · `--r-sm` · 13.5/600 · `--rack-hi` + `--wire-2`. `.primary` amber with `--glow-ink` text.
  `.ghost` transparent. `.small` 30 h. `.big` 42 h. `.round` play 44 circle. `:active` scale .97. Disabled 40% opacity.
  Inside cards, buttons sit at natural width (`align-self:flex-start`) and only stretch below 560 px.
- **Input/select** 36 h · `--inset` · `--wire-2` border, `--wire-3` on hover · weight 400. Number inputs use mono.
- **Card** `--rack` · 1 px `--wire` · 12 radius · 16 padding · 12 gap · title 15/600.
  Effects cards use uppercase 13 px titles in `--ink-2`.
- **Tabs** text only, 14/600 `--ink-3`. Selected is `--ink` with a 2 px amber underline inset 10 px from each side.
- **Segmented filter** (`.chips`): `--inset` track, 3 px padding. The selected segment is `--rack-hi` with a `--wire-2` ring.
- **Library row** 32 px icon tile (amber for audio, `--cue` for video, `--photo` for photos). Selected row has a
  `--glow-wash` background plus a 3 px amber tab on the sidebar edge.
- **Counter** (Trim panel, stats) `--inset` well · 11 px uppercase key · 26 px mono value. The "Keeps" counter has a
  dashed outline and an amber value. It turns `--ink-3` when the whole file is kept.
- **Trim handles** come from wavesurfer's shadow parts: `#wave ::part(region-handle-left|right)` with an 18 px hit area,
  a 3 px amber edge line, and a 13×36 grip tab with grooves, all *inside* the region so they're never clipped at the file edges.
  Dim outside with `::part(region){box-shadow:0 0 0 30000px rgba(13,11,9,.62)}`. Keep `pointer-events:none` on the region
  body so seek and drag-select still work.
- **Segmented choice** (`.seg`, e.g. "Singing + guitar together / Only my voice"): same as the library filter. An `--inset`
  track, and the checked option is `--rack-hi` with a `--wire-2` ring. Radios are visually hidden, but focus still shows.
- **Preview command bar** (Effects, Tune, Vocal layers): eyebrow + title + live status line · quick choices · actions in
  the order *Hear original · ▶ Live preview · primary save/render*. A running preview turns green (`--live`) and reads
  "■ Stop preview". The status line starts with LIVE / ORIGINAL.
- **Pitch graph** (Tune): an `--inset` well 240 px high. Lanes for the key's notes are `--wire` lines, with the key note in amber
  at 28%. Labels use mono 10 px `--ink-4`. Sung pitch is a 1.4 px line in `--ink-2` at 45%; tuned pitch is a 2 px `--glow` line.
  The playhead is 1.5 px `--glow-hi`. "Notes in tune" shows before (mono `--ink-2`) → after (mono `--glow-hi`).
- **Layer row**: one line per layer. Fixed widths: name 118, voice 176, source 160, numbers 74. Inset 3 px amber accent
  (`--cue` for the guitar/backing row). Muted or not-soloed rows drop to 55% opacity.
- **Sound card** (`.sound-tile`, Effects gallery): a button on `--inset` with a `--wire` border and 10 radius, 12/14 padding,
  name 14/600, "best for" 12 `--ink-2`, settings line 11 mono `--ink-4` pinned to the bottom. Chosen: `--glow` border, inset
  ring and `--glow-wash` background. Suggested: a small amber-outline pill badge top right. Grid `minmax(210px, 1fr)`, 8 gap.
- **Toast** `--rack-hi`, inset 3 px `--live` (or `--rec` for errors), fades up 6 px in 220 ms.
- **Modal** (tuner) `--desk`, 18 radius, scale .97→1 in 200 ms.

## Motion
150 ms colour transitions, 120 ms press. Easing `--ease` = `cubic-bezier(.23,1,.32,1)`. Animate only opacity and
transform. Never `transition: all`. `prefers-reduced-motion` switches all of it off.

## Copy
Plain, friendly words for someone who isn't technical ("Keep only this part", "Hear original"). Say what will happen and
that the original is never changed. Don't use jargon without a plain explanation beside it.

## Checks before shipping UI
Test in a separate copy of the app (copy `app/` and `static/` to a temp folder, run it with `STUDIO_PORT=8799`),
never in the owner's workspace. Screenshot at 1440 and about 760 px wide. Make sure there are no console errors, the
waveform stays the focal point, and amber appears only on actions or selection.
