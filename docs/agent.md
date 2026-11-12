# Jet, the operator: agent loop, world model, comms (branch `jet-agent`)

The step past call-and-response: a conversational memory, tools, and a small world model built
from what the glasses capture, presented as two modes: **Assistant** (the conversation; it
replaced the one-shot push-to-talk mode of that name) and **Scan** (the world model), next to
Describe, which it is meant to replace once it earns it. This file is the design and the module
contracts; `docs/jet-app.md` remains the law for how jet-app code is shaped (modules own models,
modes/screens are subscribing views, extension = `provides` + arrays-of-type).

The fiction (kept implicit everywhere, as before): the glasses are not smart. "Jet" is a remote
operator on a radio link who can see through the camera, look things up, and send things to the
display. Latency is radio latency.

## Spike results (2026-11-10, from the Mac against llama-swap, real 640x480 Jet frame)

| question | result |
|---|---|
| Is a Qwen fast/bright enough for interactive tool use? | **Yes, `qwen-vision`** (Qwen3.6-35B-A3B, 32k ctx / 4 slots = 8k per slot, tools + vision). Streaming tool loop: first token 190-900 ms, a whole step 0.3-2.9 s, 53 tok/s, prompt 600 tok/s. Tool calls were well-formed in every step of two 5-turn conversations (look, web_search, shell, show), including self-correcting a failed shell command. |
| Does prefix caching hold across turns? | Yes: `cache_n` covered all but the newest ~25 tokens every turn as long as history is append-only. Rule that follows: **never edit the middle of the history; volatile context rides on the newest user message.** |
| Can a tool result carry an image? | Yes: `role: tool` content as `[{type: text}, {type: image_url}]` works; follow-up questions about details of the photo are answered from it two turns later with no new photo. A 640x480 frame is 392 tokens. |
| Bounding boxes? | Yes, both models: `bbox_2d` as `[x1, y1, x2, y2]` **normalised 0..1000**, good enough to crop (meter, spools, pliers, probes all landed). qwen-vision: 17 s for 8 objects with a sentence each (535 tokens) — so the scan prompt must be terse. JSON is the wrong carrier: the model indents it whatever it is told (~75 tokens an object). Asked for `name \| kind \| x1,y1,x2,y2 \| note` lines it returns a scene line and six objects in ~230 tokens, 5 s. |
| `qwen-27b` instead? | Same quality class, 22 tok/s, and llama-swap **evicts it when qwen-vision loads** (and vice versa). One model for chat + vision + scan means no swap thrash, and the 4 slots let a background job (scan, compaction) run beside a turn. So everything here uses one model: `qwen-vision`. |
| Web tools | SearXNG (`/search?format=json`) and Firecrawl (`/v2/scrape`) answer from the Mac. **Not verified from the Jet**: the IoT VLAN is whitelist-only towards the main VLAN, and SearXNG's certificate did not verify from the Mac (`-k` was needed). |

Things the spike showed that the harness must handle: a model step may carry text *and* a tool
call (speak the text, run the tool); after a display-only tool (`show`) the model tends to add a
second throwaway line ("Keep me posted") — so such tools are `silent`: their result never
triggers another model step when the step already produced speech. The model over-uses `show`
unless told what it is for.

## Architecture

```
            voice (mic, ASR, TTS, turn state)          sensors / gps / power
                 │  responder.respond(text)                  │
                 ▼                                           ▼
   operator ── agent ──────── tools[] (provides: 'Tool') ── status, shell, web_search, web_read,
  (the glue)    │  context[] (provides: 'ContextSource')     remember, look, sightings, show
      │         │                         ▲       ▲   ▲
      │         └ memory (history, notes) │       │   │
      ▼                                 world ◄─ scanner ◄─ camera
     feed  ◄───────────── show ───────────┘
      ▲                                   ▲
      └──────── views: Assistant mode (the thread), Scan mode (cards, detail) ──┘
```

Models (modules, `src/modules/`): `camera`, `world`, `scanner`, `feed`, `agent`, `operator`.
Views (`src/modes/assistant/`, `src/modes/scan/`): two modes. Nothing in a view holds model state.

### `llm` (extended)

`chat({messages, tools?, model?, maxTokens?, temperature?, onToken?, signal?})` →
`{content, toolCalls: [{id, name, args}], usage: {prompt, completion, cached}}`. Streams
(`onToken` gets content deltas only), accumulates `delta.tool_calls` by index, `args` is the
parsed object (`{}` on empty, and a parse failure is reported as `args: null, raw`). Sends the
same thinking switches as `chatStream`, plus `stream_options: {include_usage: true}`; `usage`
comes from the final chunk (`usage.prompt_tokens`, `timings.cache_n`). `chatStream` stays for
voice's built-in one-shot responder and Describe.

### `agent` — the loop, the history, the memory

```js
agent.ask(text, { onToken, signal }) → Promise<{ text, steps, usage }>
agent.reset()                      // forget the conversation (notes stay)
agent.history                      // read-only view, for tests and debugging
// events: 'tool' { name, args, phase: 'start' | 'end', ms?, error? }
```

- **Loop**: push the user message (with the volatile context block, below), call `llm.chat`
  with the tools; execute tool calls sequentially; push results; repeat up to `maxSteps` (6).
  Content deltas of every step go to `onToken` (a step's text is separated from the next by a
  space). If every tool called in a step is `silent` and the step produced text, the turn ends
  there. One turn at a time: a second `ask` while one runs rejects (`busy`); `signal` aborts the
  model call and the running tool, and the partial turn is recorded as interrupted.
- **Tool** (abstract type `Tool`, `tools` is an array-of-type property, order = config order):
  `{ name, description, parameters /* JSON schema */, run(args, {signal}) → string | {text, image?: Buffer /* jpeg */}, silent?: boolean }`.
  A throw becomes the tool result `error: <message>` (the model sees it and may retry). Results
  are capped (`toolResultChars`, 2500).
- **ContextSource** (abstract type, `context` array-of-type): `{ id, context() → string | null }`.
  The agent joins the non-null lines under a `[context]` header **after** the words of the newest
  user message — time, mood, what is in view. (In front of them the model took the block for the
  start of the conversation and opened its reply with a copy of it.) History keeps each block as
  it was (it was true then); it is never rewritten, so the prefix cache survives.
- **System prompt** = `persona` (config) + a fixed harness paragraph (spoken replies, when to
  use `show`, never narrate tool use) + the notes. Changes only when a note is added.
- **Context management**, in this order of preference:
  1. *Images age out*: only the newest `keepImages` (2) tool-result images stay; an older one is
     replaced by `[photo, no longer attached]` **at compaction time only** (not mid-conversation:
     that would break the cache on every look).
  2. *Compaction*: when the last `usage.prompt` exceeds `compactAt` (5000 of the 8192 a slot
     has), then **after the turn has ended**, the oldest turns (up to a user-message boundary,
     leaving the newest `keepTurns` (3) intact) are summarised by one background `llm.chat` call
     (no tools, ~150 tokens out, runs in another server slot) into a single
     `Earlier on this call: ...` message that replaces them. If a turn starts meanwhile the
     compaction result is still applied when it lands (it only replaces a prefix that has not
     changed). At most one compaction in flight; a failure is logged and retried after the next
     turn. Hard stop: if `usage.prompt` passes `hardLimit` (7000) the oldest turns are dropped
     without a summary before the next call.
  3. *A new call*: when the newest message is older than `callGapS` (1800), the next `ask`
     first folds the whole conversation into the summary (same call as compaction, awaited,
     bounded by a timeout — on failure the old turns are just dropped). The fiction: a new call.
- **Memory** (its own module, `agent-memory`, because the `remember` tool and the mood need it
  too): `agent.agentMemory.dir` (`/android-data/mainline/agent`) holds `conversation.json` (messages with
  images stripped to a placeholder, summary, timestamps; written after each turn, atomically)
  and `notes.json` (what the `remember` tool saved: `[{t, text}]`, capped at `maxNotes` 40,
  oldest dropped). Both survive a restart.
- **Mood** (a `ContextSource` owned by the agent module): facts, not adjectives — how long the
  call has been running, how many asks in the last ten minutes, and what the operator was in the
  middle of when this call came in (a random pick from `mood.activities`, re-rolled per call).
  The persona text tells the model what to do with those facts.

Generic tools shipped with the agent (`src/modules/agent/tools/`), registered relative to it, so
their configuration nests: `agent.webSearchTool.base`, `agent.webReadTool.base`,
`agent.shellTool.user`, `agent.mood.activities`. A tool whose endpoint is not configured is not
offered to the model at all.

| tool | does |
|---|---|
| `web_search(query)` | SearXNG JSON (`base`, no default; `insecureTls` for a certificate that does not verify): top `results` (5) as title / url / snippet |
| `web_read(url)` | Firecrawl scrape (`base`, no default) → markdown, truncated (`maxChars` 3000) |
| `shell(command)` | `sh -c` on the device with a timeout (5 s) and an output cap, **as an unprivileged user** when jet-app is root (`setpriv --reuid nobody --regid nogroup --clear-groups`, `shell.user`); refuses if it is root and cannot drop. That is the sandbox: read access to `/proc` and `/sys`, no writes that matter |
| `status()` | battery, charge current, GPS fix/position, WiFi, uptime, temperature: read from the models (`power`, `gps`) and `/sys`, no shell needed for the common question |
| `remember(text)` | appends a note |

Added 2026-11-12, from rehearsing a conversation that ends in several lookups:

- **`wiki(query)`**: one MediaWiki API call (Wikipedia by default, `agent.wikiTool.base`): the
  best three articles with their opening lines, ~0.3 s. The first stop for any question of fact;
  `web_search` is for news and prices. Reason: the search service's engines get rate-limited or
  CAPTCHA'd (five of them at once during the rehearsal, the survivor returning junk), and the
  model then concluded things did not exist.
- **A turn cannot outgrow the slot.** One turn of three searches and two pages was 5,000 tokens
  and overran 8,192: the answer was cut mid-sentence and the next request was refused. Now:
  tool results are capped at 1,600 characters; past `stepLimit` (5,600 prompt tokens) or on the
  last allowed step the turn is told, in its last tool result, to answer with what it has
  (lookups it asks for instead are not run; `show` still is); when the turn is over its tool
  results are cut to their first 300 characters and the server's cache is re-primed with one
  background request; and the hard limit drops turns until the estimate fits.
- **Identity rules in the harness.** Naming a specific thing (a ship, a model) only from
  lettering that is large and sharp, from the partner, or from a lookup; which thing a number
  belongs to is never answered from memory (the model put WMSL-750 in three different ports).
  Still weak: it "reads" distant numbers with confidence (270 for 750) and looks those up.
  A correction from the partner is taken at once.
- **`place`** (ContextSource): the last good GPS fix named from an offline table of towns
  (GeoNames, cities over 15,000; `assets/places/`, CC BY 4.0) - "in or near Alameda, California,
  US (1.7 km from its centre); Oakland is 3.2 km away". The model cannot do this itself: given
  the coordinates of Coast Guard Island it named a hospital in San Francisco. The fix is kept
  after the receiver is off (GPS and WiFi share a radio) and across restarts.

### `camera`

`capture({w = 640, h = 480}) → {width, height, data /* RGBA */, t}` (jetd `S` + `uyvyToRgba`);
`jpeg(image, {quality, scale}) → Buffer`. Concurrent captures share one frame. Replaces the
snapshot code duplicated in Describe and the voice debug route (those callers move over as an
incremental cleanup, not on day one).

### `world` — the world model

The record is a **log of sightings**; entities are an index over it. A sighting is one analysed
frame: `{id, t, where?, scene, entityIds}`. Keeping the frame-level record (and its `scene`
line) is the hedge against the entity model being too dumb: place recognition by
colour/object/pattern similarity wants frames and co-occurrence, and those are here from day one
without committing to a design for them.

```js
world.observe({ t, image, where?, scene?, items: [{ name, kind, box /* 0..1000 */, note }] }) → entity[]
world.entities()            // recency-sorted, expired ones gone
world.get(id)  world.find(text)  world.pin(id, on)  world.forget(id)  world.note(id, text, source)
world.thumb(id) → {width, height, data /* RGBA */} | null
// entity: { id: 'e12', name, kind, firstSeen, lastSeen, seen, pinned, where?, claims: [{t, text, source}] }
// events: 'change'
```

- **Association is deliberately naive**: same normalised name (or one name containing the
  other, where the contained one is two words or more: a one-word name is a category) and same
  kind = same entity. The scanner passes the known names to the model and asks
  it to reuse them, which does most of the work. A wrong merge or a duplicate is fine: a record
  is a timestamped log of *claims*, not ground truth.
- A new `note` that is not already the latest claim is appended (`maxClaims` 20). The thumbnail
  is the bbox crop of the newest sighting (padded 8 %, scaled to fit `thumbW`x`thumbH` 96x72),
  kept as a JPEG under `dir/thumbs`.
- **Observations are the evidence** (since 2026-11-11). Beside the readable `claims` each entity
  keeps its last `maxCrops` (4) observations, the largest crop always among them:
  `{id: 'o17', t, name, kind, note, area, checked?}` — the model's own name and words, and the
  crop it was said of (`dir/crops/o17.jpg`, fitted to 320x240, never enlarged; `world.crop(id)`).
  An entity is a hypothesis over them and can be revised: `merge(from, into)` (the other name
  becomes an alias), `split(obs)` (the observation becomes an entity of its own, under the name
  it was observed by), `mark(obs, verdict)`, `observation(id)`. `observe` emits `observed`
  `{t, entries: [{obs, entity, created}]}`.
- A name with a model number that no claim quotes as read (the scan prompt asks for readable
  text in "double quotes" and forbids guessed brands/models) is flagged on the context line:
  `Weller WLC100 (model number is a guess) [e9]`, and the line itself says the names may be wrong.
- **TTL**: an unpinned entity not seen for `ttlS` (1800) expires; pinned ones stay. `maxEntities`
  (60) bounds it. `dir` (`/android-data/mainline/world`): `world.json` + thumbs, debounced writes.
- `where` is the GPS fix at observation time when there is a good one (the scanner supplies it).
- The world is a `ContextSource`: `In view lately: multimeter [e7] (2.210 kΩ), solder spool [e6], ...`
  — the newest few, one line. Detail is behind the `sightings` tool.

### `scanner`

```js
scanner.active   scanner.state   // 'off' | 'idle' | 'looking'
scanner.start()  scanner.stop()  scanner.toggle()
scanner.scanOnce({ image? }) → Promise<entity[]>     // also what the `look` tool calls
// events: 'state', 'scan' { entities, ms }
```

While active: one scan at once; the next is triggered by a new-view event (`sensors` `view`) or
`intervalS` (10) after the last finished, never sooner than `minGapMs` (3000); stops itself
after `maxScanS` (180) so a forgotten scan cannot hold the model forever. A scan = capture →
JPEG → one vision call (`scanner.model`, the terse line-format prompt with the known names) →
parse (tolerant: the lines, or JSON with code fences, `bbox_2d`/`box`, `label`/`name`, cut off
at the token limit) → `world.observe`. Failures are logged and counted, never thrown at a view.
`start()`/`stop()` are the scanning switch, so the container's start hook is `attach`
(`lifecycleStart`). When the model reuses a known name the scanner keeps the kind on record: the
model re-words kinds between scans, and the world's name-and-kind rule would split the entity.

Tools provided here: `look()` (capture; returns the photo to the model as an image and starts a
`scanOnce` on the same frame in the background, so asking about something also files it) and
`sightings(query?)` (no query: the recent list; with one: matching entities with their claims,
age, pinned, location).

### `curator` — background sanity checks

The world files an observation by its name at once (the glass wants an answer now); the curator
goes back over those decisions with the pixels. For an observation it builds **one picture**,
the observation's crop LEFT and a candidate entity's crop RIGHT, and asks: the very same
physical object — SAME, DIFFERENT or UNSURE? Up to `maxCandidates` (3) such questions, the
entity it was filed under first, stopping at the first SAME. Then: filed right → nothing;
another entity is the same → the observation moves there (`merged` when it was the entity's
only one, the names kept as aliases); its own entity is DIFFERENT and no other is the same →
`split`; UNSURE about its own entity → left alone. The outcome is recorded on the observation
and it is never asked about again.

- *Why one composite picture*: with separate images ("which of pictures 1-3 is X") qwen-vision
  mixed the pictures up — 3 of 6 right on real crops, with reasons taken from the wrong image.
  As two halves of one picture: 10 of 10, ~195 prompt tokens, 0.7-2 s a question.
- *Why crops had to grow first*: at the old 96x72 thumbnails the verdicts were near chance and
  the reasons hallucinated ("a cat on a bed"). Crops under `minArea` (4800 px) are not evidence.
- *Order = temporal coherence.* Consecutive frames mostly show the same things. Most doubtful
  first: an observation that joined an entity **not** in the frames of the last `recentS` (120 s)
  — you looked away and back, or a name was reused for something else; then a brand-new entity
  (a known thing under a new name?); last, what joined the current set (the audit).
- *Candidates*: the entity it is filed under (if that has other evidence), then others scored by
  same kind, shared name words (aliases included) and having been seen with this frame's
  entities before; never anything seen in the same frame — one frame does not show a thing twice.
- One check at a time, `perMinute` (6) at most; `apply: false` only logs what it would do. Every
  check is one `curator: check` log line (`asked`, `action`, `why`).

Not yet: roll-up/rename of an entity from its observations, the closer look that reads a label,
`near` counts as stored structure and places (the candidate scoring computes co-occurrence from
the sightings log on demand, which is the crude version).

### `feed` — what Jet sent, what was said

```js
feed.post({ kind, title?, body?, image?, entity? }) → item     // kind: 'heard' | 'said' | 'card'
feed.items   feed.get(id)                                       // oldest first; events: 'post'
```
A ring of `maxItems` (100), persisted (`dir`), images as JPEG. The `show({title, body, entity?})`
tool posts a `card` (with the entity's thumbnail when one is named); it is `silent`.

### `operator` — the glue between voice and agent

Implements the voice **responder** contract and owns the turn-level policy:

```js
operator.respond(text, { onToken, signal, wake, heard }) → Promise<string>   // voice calls this
operator.talk()   operator.cancel()   operator.replay(feedItemId) → boolean  // views call these
```

- **The record**: `heard` (with the captured audio) and `said` go to the feed; when the answer has
  been spoken its audio is attached to the `said` item (voice `spoken` event; stored 24 kHz
  mono); the picture a tool looked at is posted as a `photo`. `replay` plays an item's clip.
- **Which picture a question is about** is fixed, not left to timing: if the wearer has an entity
  selected (`world.focus()`, set by the Scan mode's selection) the context says so and `look`
  with `item` returns that entity's best recorded crop; otherwise a frame is taken as the
  question arrives (`camera.hold()`) and `look` returns *that* frame, not whatever the camera
  sees seconds later. Whether the question concerns the view at all stays the model's decision:
  the held frame is used only if it calls `look`. `look item e7` also serves "the mug I saw a
  minute ago" from any screen.
- **Fillers**: a tool starting gets its phrase (`look` → "Let me see.", `web_*` → "Looking it
  up."), and a `wait` phrase follows every `fillEveryMs` (6 s) while it runs. They go through
  `voice.fill`, which slips the clip into the answer's speech queue in order (after the sentence
  the model has just finished, never over one), at most one per `fillGapMs`, never the same clip
  twice in a turn.
- With `operator.wake` (default on) it claims wake-word questions, so "heya jet, ..." from any
  mode reaches the agent; spoken commands (`actions`) are still tried first. **No screen
  changes for a question**: the conversation belongs to no mode (the models — `feed`, `world`,
  `agent` — are container singletons), so it is the same from Status, the map or the Scan
  mode; the status strip shows the turn's state.

`voice` changes that make this possible:
- `startTurn({responder})`, `claimWake(responder)`; the session's answer stage calls
  `responder.respond` (the built-in one-shot chat is the default: it answers when no responder is given or claimed);
  `question` events carry which responder took the turn.
- **A wake turn has two phases.** jetd's VAD ends the wake capture at the first pause, ~1.1 s in
  (measured: every wake capture on 2026-11-11), i.e. right after "heya jet". That first capture
  is only asked: a spoken command ("heya jet, run doom" in one breath)? a sentence that kept
  going (≥ `wakeLongS` 2.5 s and three words)? Otherwise it was just the call: a `pickup` phrase
  answers ("Go ahead.", "What do you need?"), and when it has played the mic opens for the
  question (`session` `more`: same turn, empty buffer).
- **Endpointing by transcript**: a capture also ends when `endpointPartials` (2) partial
  transcripts in a row repeat the one before; the energy VAD ran a 2 s question to the 8 s limit
  in a noisy room.
- `fill(set)`, `playAudio(clip)`, event `spoken {turn, responder, rate, channels, pcm}`.

### The modes: Assistant (`assistant`) and Scan (`scan`)

Two top-level modes in the switcher (Assistant first), each a module with its models injected,
subscribing only while it shows. Both draw in `panel(s)` (`ui/style.js`): from the status strip
down to the hint line.

The pad's tap is the front button on this device (`input.tapCode` 28 is also Enter), so there
is one button, and it never navigates into something: swipes select, open and close.

**Assistant** (`src/modes/assistant/`; spoken "radio", "jet", "comms"): the conversation, drawn
as a message thread (`ui/chat.js`): the wearer's words and photos right, Jet's words and cards
left, coloured by speaker, a loudspeaker mark where a clip is stored. It follows the newest
until a swipe selects.

| where | front (= tap) | swipe up/down | swipe right | swipe left | rear |
|---|---|---|---|---|---|
| thread, following | `operator.talk()` | select | - | - | not consumed (switcher) |
| thread, a message selected | open + replay | select | open + replay | - | unselect (follow the newest) |
| open message | replay again | scroll | - | close | close (selection stays) |
| a turn running (anywhere) | `operator.talk()`: end the capture / barge in | as above | as above | as above | `operator.cancel()` |

Open = the whole text, the picture as large as the panel allows, and the stored audio once
(`operator.replay(id)`; an item without a clip is the operator's to refuse). A running turn is
the pending bubbles under the thread (listening and the partial transcript right; thinking,
then the answer as it streams, left) until the feed holds its `heard` and `said`. Leaving the
mode cancels nothing. A wake-word question that no responder took (`operator.wake` off: voice's
one-shot chat answers) is the one thing that raises the mode: that turn is never filed, so its
transcript and answer stay as the pending bubbles, idle too, until the next turn.

**Scan** (`src/modes/scan/`; spoken "scan", "scanner"): the world as entity cards (crop, name,
kind, newest claim, age), most recently seen first. While scanning the viewfinder runs in the
top right corner and the cards re-sort beside it as sightings land; off, they are the
full-width review list and none of the following is drawn.

The column under the viewfinder shows what the scanner is doing, in pictures rather than words:
- **The viewfinder's 2 px border is the readiness to capture.** Grey while no capture can happen
  (`scanner.state === 'looking'`: the last frame is still being analysed, or nothing is armed);
  otherwise a grey track filling green clockwise from the top left, `(now - due.from) /
  (due.at - due.from)` of `scanner.due`, full at the capture. The mode's `readiness` getter is
  that 0..1 (null: no capture now) - by the clock today, the place for a head-turn angle later.
- **The frame being analysed** (`scanner.frame`, already 120x90: blitted 1:1) slides out from
  under the viewfinder into the slot below it (~300 ms), then a yellow quarter of its border
  circles it (1.2 s a lap) under the caption `analyzing`, until `frame` goes null and the slot
  clears. The caption is otherwise the count (`12 logged`). The strip says `scanning` /
  `analyzing`.
- **Animation**: a timer of the view's own (`frameMs` 110, ~9 fps) asks for repaints only while
  the mode is showing, scanning, not under the menu or behind a detail, and something moves
  (a frame in the slot, or a border not yet full); it stops itself when the border is full.
  Nothing is ever drawn inside the viewfinder rectangle. The border geometry is `ui/ring.js`:
  `ring(rect, thick, from, to)` → the rectangles of that span of a border, clockwise from the
  top left, in fractions of a lap (a span past 1 wraps).

| where | front (= tap) | swipe up/down | swipe right | swipe left | rear |
|---|---|---|---|---|---|
| list, nothing selected | `scanner.toggle()` | select | - | - | not consumed (switcher) |
| list, an entity selected | `scanner.toggle()` | select | open the detail | - | unselect |
| detail | pin / unpin (`world.pin`) | scroll | - | close | close (selection stays) |

The detail: larger crop, pinned, first/last seen, where, the claims newest first. It can be
opened while scanning (the scan goes on, the viewfinder is off until it closes). The selection
(or the open entity) is published as `world.focus`: a question asked while something is
selected is about that; leaving the mode clears it and stops the scan and the camera.

Shared drawing: `ui/list.js` (selection and scroll window), `ui/chat.js` (`ChatList`: the
bubbles), `ui/cards.js` (`CardList`: tiles with thumbnail, title, lines, badge; `DetailView`:
the opened item, used by both modes).

## Milestones

| | what | state |
|---|---|---|
| M0 | Spikes: tool loop, cache, image tool results, bbox | **done** (above) |
| M1 | `llm.chat`, `agent` (loop, history, compaction, notes, mood), generic tools | **done**, unit-tested |
| M2 | `camera`, `world`, `scanner`, `look`/`sightings` | **done**, unit-tested |
| M3 | `feed`, cards, the modes (first as one two-tab Comms mode, since split into Assistant and Scan), `show` | **done**, unit-tested |
| M4 | `operator`, voice responder seam, wiring, `/ask` debug route, end-to-end on the Mac against fake-jetd with a real frame | **done** (below) |
| M5 | On the device: latency with real ASR/TTS, network whitelist for search, `setpriv`, JPEG encode time at 640x480, persona tuning with rg's prompt, fillers that match the fiction (pickup lines, generated in the background) | needs the Jet + rg |
| M6 | Retire Describe (the one-shot Assistant is gone: the conversation took its name); `actions` exposed as a tool; entity refinement (a second look at a crop on demand); QR/barcode decoder feeding `world` | later |
| M7 | Richer sends: `z-image` pictures as cards, animated; remembrance-agent style proactive recall from `world` + notes; place signatures from the sighting log | later |

### What M4 showed (2026-11-11, the whole app on the Mac, `out.png` as the camera)

A nine-turn conversation through `POST /ask`, one model, no swap: "analyze this" (look, 3.8 s),
"what does the big number say" (answered from the photo already in context, 0.6 s), "is that
brand any good, look it up" (web_search, 6.3 s of which 3.9 s SearXNG), battery and temperature
(status, 1.6 s), "remember that..." (remember, 1.3 s), "what was the first thing I asked"
(0.7-2.8 s), "what have you logged on my bench" (sightings, 3.4 s), "put the colour code on my
display" (show, 2.6 s). The look filed five entities with crops in the background (9 s, a
second slot) while the conversation went on. Prompt 3.3k tokens after six turns, cache hits on
all but the newest tokens. Then by button: the channel, an opened item, scan (six entities in
5.6 s), review, an entity detail.

Seen on the way, still open:
- The model's *content* is a 35B-A3B's: it read the meter's brand as "FIRST 2200" at 640x480
  and gave the colour bands of a 1.2k for a 2.2k. The loop is sound; the answers want checking.
- A scan returns more lines than `maxItems` asks for (nine once); the cap is applied after.
- The first turn after `callGapS` waits for the fold of the old call (bounded, 8 s).
- `status` imports `readNetwork` from `src/modes/system/network.js`: that file belongs in `lib`.
- Two timing-based tests (`voice` phrase bank, `wear`) fail about one full-suite run in three
  now that more test files run in parallel; each passes alone. Pre-existing sleeps, not new code.

### First morning on the device (2026-11-11)

- *"The camera is inaccessible"* with a working camera: memory poisoning. The night's test ran
  on a camera-less boot (boot guard, safe level 2); those turns were folded into the "earlier
  call" summary, and the model then believed the camera dead and never called `look`. The
  summariser is now told to leave equipment state out, and the harness that a tool which failed
  before is to be tried again. General rule: **transient device state must not reach memory.**
- *World-model merges* ("Make Magazine" absorbing a mug with the Make logo; "Box", "Text",
  "Paper", "White cloth" as catch-alls with 12-20 sightings each): the prompt's "reuse the known
  name" was read as "reuse it for anything related", one-word names matched every name that
  contained them, and bare text was listed as an object. The prompt now asks for two-to-four
  word distinguishing names, physical objects only, reuse only for the very same object, and
  the world no longer merges on a one-word name. Not solved: the thumbnail is still replaced by
  the newest crop, so a wrong merge overwrites the picture; and there is no appearance check.
  Candidates, in order of cost: keep the crop with each claim (makes merges visible and gives
  data to tune anything further); a coarse colour signature per crop as a merge veto.
- *Turns failing* ("socket hang up", `EAI_AGAIN`, ASR timeouts): the link, not the agent. WiFi
  was at -84 dBm, MCS 0, 529 failed transmissions in 19 minutes; scans took 7-13 s (5 s from the
  Mac) and one took 55 s. `llm` requests now retry once when the connection fails before any
  reply. A 20 s ASR timeout on a dead link is still 20 s of silence.
- "Run analysis" was transcribed as "Run an elephant." and went to the agent as a question.

### Running it without the Jet

```sh
cd device/jet-app
node test/fake-jetd.js 7790 ../../out.png &          # camera = that PNG; buttons on :7791
JET_DEVICE_LINK_PORT=7790 JET_DEVICE_LINK_HOST=127.0.0.1 JET_SURFACE_DEVICE=/tmp/fb0 \
  JET_VOICE_DEBUG_PORT=7781 JET_VOICE_WAKE=false JET_DEVICE_CONFIG=/tmp/jet-dev.json npm start
curl -X POST localhost:7781/ask -d '{"text": "analyze this"}'      # a turn without the mic
curl localhost:7791/right; curl localhost:7791/front               # buttons: front rear up down left right
```
`/tmp/jet-dev.json` needs the state directories somewhere writable (`world.dir`, `feed.dir`,
`agent.agentMemory.dir`), the System calibration files (or the first-use wizard starts; see
`docs/jet-app.md` "Running"), and the web tools' `base`. `/tmp/fb0` is the panel as raw RGB565.

### On the device

The per-device layer (`/android-data/mainline/jet-app.json`) needs, beside `llm.base`:
```json
{ "agent": { "webSearchTool": { "base": "https://<searxng>", "insecureTls": true },
             "webReadTool":   { "base": "https://<firecrawl>" },
             "persona": "..." } }
```
Without the `base` keys the web tools are simply not offered. `operator.wake: false` hands
wake-word questions back to voice's one-shot chat; the Assistant mode raises itself to show them.

## Work to do (as of 2026-11-11)

In order; the first is a blocker for anything that starts the camera.

1. ~~Camera memory corruption~~ **fixed and flashed 2026-11-11** (`docs/open-questions.md`): the
   first frame of every stream was the sensor's 1280x720 default written into a 640x480 buffer.
   Left over: jetd serves a snapshot from frame 0 of a stream (black: skip ~6 frames and
   ERROR-flagged buffers, as `cam_snapshot` does); jetd's `play_close` deadlock when a client
   dies mid-playback; cap `scaling_max_freq` at 800000.
2. **Roll-up / rename**: an entity's observations (crops + notes, errors included) condensed
   into a name, a summary and a confidence; "soldering station (model unread)" is a legal name.
   Text-only roll-ups launder the majority error, so it works from the crops.
3. **The closer look, at full resolution.** The camera does 1280x960; scans use 640x480 because a
   frame costs ~390 tokens and a 0.6 MB upload over a weak link. Two shapes were discussed:
   scan small then re-send the whole frame large (4x the pixels and tokens every time, mostly
   for nothing), or keep the full frame on the device for the length of a scan and cut the
   **boxes** out of it at full resolution - only for an item whose note quotes text, whose name
   has an unread model number, or that the wearer selected - and ask just "what is printed on
   this?". The second is the plan: it spends pixels where the first pass saw something to read,
   costs ~100-200 tokens an item, and is what would have read "WESD51". Cost on the device: a
   1280x960 capture is 2.4 MB of UYVY per scan to convert and hold (measure on the A9 before
   committing to it); the ISS buffers are already sized for it. The closer look is also where
   exposure belongs: a detail shot of something small and bright wants a metered manual
   exposure with the gain pulled down (three ioctls on the sensor subdevs, no kernel change).
   **Measured on a lens barrel (2026-11-11), which tempers all of the above**: lettering ~5 px
   high at 640x480, ~10 px at 1280x960 (jetd now delivers `S 1280 960`, ~0.7 s), desk light, AE
   at its ceiling (984 lines, gain 256). Tight crops of the lettering came back UNREADABLE at
   640, at 1280, and at 1280 with the gain halved and quartered: the letters are soft at every
   setting - focus distance and noise, not pixel count or clipping. Shown the whole frame instead,
   the model "read" `AF MICRO NIKKOR 60mm 1:2.8 D` from one and `50mm f2.8D` from another: the
   brand line is in the pixels, the numbers are what such lenses usually say. Two rules follow.
   A read must be asked of a tight crop with nothing around it to guess from, and `UNREADABLE`
   must be a legal answer. And full resolution only pays where the optics resolve the text:
   test at other distances and in better light before building on it.
4. **`near` counts and places** from the sighting log; the curator's candidate scoring computes
   co-occurrence on demand today.
5. **Voice on the device, unverified**: the two-phase wake turn, fillers between sentences,
   replay; the model answered a battery question without calling `status` (a one-line device
   fact in the context would remove the temptation); "run analysis" still mis-heard as other
   words by the ASR; the time in the context is UTC.
6. **Retire Describe** (the one-shot Assistant is done); `actions` as a tool; z-image picture cards.

## Risks, as they stand after the spikes

- *Model too slow/dumb for tools*: retired for qwen-vision at this tool count. Watch: 8k per
  slot is tight (a web_read is 1k, a photo 400) — compaction is not optional.
- *Background work thrashing the server*: one model, four slots; scan and compaction are single
  flight and rate-limited; nothing here loads a second LLM. The TTS clone and ASR are separate
  small models and were resident alongside during the spike.
- *Harness as a bottomless pit*: scope is fixed above — no plugins beyond `Tool`/`ContextSource`,
  no sub-agents, no planning, no streaming tool output. `agent/index.js` should stay readable in
  one sitting.
- *World model too dumb*: sightings-first log + claims-not-truth entities; nothing downstream
  depends on entities being right.
- *Unknown until the device is back*: reachability of SearXNG/Firecrawl from the IoT VLAN, the
  certificate, `setpriv` in the rootfs, total voice-to-voice latency (the LLM is now the small
  part: ASR ~0.5 s + first sentence of the clone voice 1.3-1.7 s dominate).
