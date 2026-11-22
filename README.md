# Live output speed

A `conversation.composer.dock` entry that shows how fast the newest answer is
being written, in tokens per second — a permanent reading, not a guest that
appears and disappears.

## Where it shows up

Directly under the composer, after the shipped `activity` and `usage` pills
(entry id `live-speed`, order `2`).

It is always mounted, and what it shows follows the state of the stream:

| State | Reading | Look |
| --- | --- | --- |
| Tokens arriving | live 2-second average, ~5 updates a second | the theme's blue accent, slow pulse on the dot |
| Tokens paused (0.6 s+) | last measured figure, frozen | resting label colour, dimmed |
| Answer settled, next one not started | that answer's own decode rate | resting label colour |
| Page reloaded mid-session | newest settled answer's decode rate, read from the log | resting label colour |
| Brand-new Session, no answer yet | `—` | resting label colour |

Because the figure survives pauses, answer boundaries and Turns, one turn's
streaming never blinks the row in and out of existence, and the reserved width
means no reflow when the digits change.

## How the number is made

Everything is folded in the browser from the Session event window the open
conversation already receives:

- **While tokens arrive** — one non-empty `text-delta`, `reasoning-delta`, or
  `tool-call-delta` counts as one token; the rate averages the last two seconds
  and is not stated until four tokens are inside that window.
- **After the answer settles** — that message's own rate, output tokens over the
  span from its first streamed token to the committed message, which is how the
  host computes the same figure.
- **After a reload** — the newest settled message in the loaded window is read
  once on mount, so the reading is there before the next token arrives.

It makes no model request, reads no file, and sends no data anywhere.

## What it measures, exactly

The rate covers the whole generated stream, **including reasoning**, because
reasoning is produced at the same speed by the same stream. That means the number
will not match a reader's impression of "answer length" while a long reasoning
phase runs — the hover title states the scope for that reason.

The digits are hidden from assistive technology (they would otherwise be
announced five times a second); the entry carries one stable accessible name
instead.

## What it does not replace

The shipped `activity` pill reports the whole-session average decode speed and
finished-turn timing. This pill exists because that average is a post-hoc
figure for settled turns, not a live gauge, and because it disappears from the
row when there is nothing to average. Both can be on screen; turn this bundle off
in **Plugins** to remove only this reading.

## Requirements and limits

- The Session must already be open in this tab — the pill reads its live window.
- Before this page has seen a token, the figure comes from the newest settled
  message the loaded history window still contains; a Session whose history was
  paged past that message shows `—` until the next answer.
- A provider that packs several tokens into one delta reads low by the packing
  factor. Nothing in the delta reports the true token count, so this remains an
  estimate for such providers rather than a measured value.

## Tuning

Constants at the top of `client.js`: `WINDOW_MS` (averaging span), `TICK_MS`
(refresh cadence), `STALE_MS` (pause that dims the figure), `MIN_TOKENS` (fewest
samples that may state a rate).

## Adding neighbours

The dock is a list slot: register another entry with your own `id` and an
`order` above `2` to sit to the right of this reading.
