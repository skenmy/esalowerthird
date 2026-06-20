# CLAUDE.md

Guidance for Claude Code when working in this repo. README.md covers
user-facing setup, protocol table, and env vars — don't duplicate it
here. This file is for things that aren't obvious from the README.

## Shape of the codebase

Five hand-written files. No build step, no bundler, no framework.

- `relay.js` (~650 lines) — Node WebSocket relay. Also serves the static
  HTML files over plain HTTP (so the same port hosts `/ws`, the static
  files, `/healthz`, `/api/send`, `/api/hide`, `/api/cmd/<go|hide|total>`,
  `/api/studio/<clear|standby|air|recording|wrap>`, `/api/state`).
  `RELAY_TOKEN` (when set) makes `/ws` reads open but gates *writes* — a
  connection may mutate the overlay only if it carries a Caddy-injected
  `X-Forwarded-User` (control panel via the `/adminws` forward_auth path)
  or a valid `?token=`; `/api/*` always needs the token. `liveState`
  (names/total/studio) is inferred from relayed traffic so `/api/state`
  can drive Companion button feedback. Polls Tiltify (15s) and
  Horaro (5m); handles `src_lookup` / `twitch_lookup` itself rather
  than broadcasting. Caches the last `confidence_state` /
  `confidence_feature` / `producer_msg` and replays them to clients that
  connect later (so a host monitor opened mid-show still syncs).
- `source.html` (~2.2k lines) — OBS browser source. Listens only,
  never sends commands (except status pings). Dispatches incoming WS
  messages via a `switch` on `data.type`. Overlays use the "Cube System"
  skin driven by CSS variables; `?theme=mono` swaps the heritage
  purple/gold palette for graphite/blue.
- `control.html` (~3k lines) — operator panel ("Studio Control").
  Single-file app with presets, queues, Tiltify browser, fun-tools tabs,
  live Program/Host preview iframes, and a Confidence section (studio
  state, feature-large pushes, producer-message composer) plus a
  Program/Both/Confidence send-target selector. Heavy.
- `confidence.html` (~500 lines) — NEW host confidence monitor.
  Listen-only (`?scene=confidence`), self-scales its fixed 1920×1080
  stage to fit. Reads the same `tiltify_data` / `schedule_data` feeds for
  the always-on board (total, up next, bid war, studio state, producer
  banner) and surfaces a large feature takeover on `confidence_feature`.
- `index.html` (~330 lines) — standalone keyboard-driven demo, no
  WebSocket. Lives on for designing overlay states without a relay.

## Key entry points when editing

- New WS message type → add a `case` in `source.html` around line
  855 (the main dispatcher), then send it from `control.html`. Keep
  the `{ type, scene?, ... }` shape.
- New env var → top of `relay.js` (lines ~15-38). Pattern: read,
  derive an `*Enabled` flag, log "enabled/disabled" at startup.
- New Tiltify field → both `pollTiltify` (assembles the cache) and
  `broadcastTiltifyData` already covers it; consumers in
  `control.html` (around the `tiltify_data` handler) and `source.html`.
- New fun tool → add tab button + `ftPanel<Name>` in `control.html`
  (~line 1162), register in `panelMap` (~line 2298), wire WS message
  type in `source.html` switch.

## Conventions

- **No build step.** Vanilla HTML/CSS/JS. Edit, reload, deploy.
- **XSS safety.** Always wrap user-supplied strings in `escHtml()`
  before string-concatenating into HTML.
- **Animation timings.** Show = `0.6s cubic-bezier(0.16, 1, 0.3, 1)`;
  hide = `0.4s cubic-bezier(0.7, 0, 0.84, 0)`. Text reveals use
  `textReveal`/`textHide` keyframes with `--delay` CSS custom property
  for stagger.
- **Tiltify bar markup.** `.tiltify-bar` > `.logo-container` +
  `.tiltify-content` > `.tiltify-stagger` children with their own
  `--delay`.
- **localStorage prefix:** `esa-lt-*`. Used liberally in `control.html`
  for presets, queues, counters, quotes, image presets, etc.
- **Fun tools** live under `#funToolsSection`. Tab buttons use
  `data-tab="ft-<name>"`, panels use `id="ftPanel<Name>"`, and
  `panelMap` in `switchFunTab()` ties them together.
- **Scene filtering.** `source.html?scene=<name>` makes an instance
  only react to messages whose `scene` field matches. Used so multiple
  OBS sources can show different content from one control panel.
- **WebSocket URL.** Both clients derive it as
  `(wss|ws)://<location.host>/ws` — relay must be reachable on the same
  origin as the HTML (Caddy/nginx upstream in prod, relay's own static
  serving in dev/Docker).

## Message types (not in README)

The README table covers the public/documented protocol. The full set
dispatched by `source.html` also includes:

`custom_show`, `counter_show`/`_update`/`_hide`, `quote_show`,
`sleep_show`/`_hide`, `stat_card_show`, `wheel_show`/`_hide`,
`image_show`/`_hide`, `status` (sent by source on visibility change).

`remote_cmd { cmd: go|hide|total }` — Bitfocus Companion deck press,
emitted by the relay's `/api/cmd/*` endpoint and dispatched by
`control.html` (acts as a remote keyboard: `go`→`goLive()`,
`hide`→`hideAll()`, `total`→`tiltifyShowDisplay('total')`).

Companion can also set the studio state via `GET /api/studio/<state>`,
which broadcasts `confidence_state` directly (no control panel needed);
`control.html` listens for `confidence_state` and re-syncs its Studio
State buttons (`syncStudioStateUI`) so the panel stays in step.

Confidence-monitor messages (dispatched by `confidence.html`, sent by
`control.html`, cached + replayed by `relay.js`):
`confidence_state { state: clear|standby|air|recording|wrap }`,
`confidence_feature { feature: total|incentive|bidwar|schedule|none, ... }`,
`producer_msg { text, level: info|urgent, active }`. When the control
panel's send target is **Both** or **Confidence**, showing total / target /
poll / schedule on Program also emits the matching `confidence_feature`
(with the item index) so the host monitor features it large. Runner cards
never mirror.

Tiltify cache exposes nested types via `tiltify_data` payloads —
control.html has a sub-switch on item type around line 1097
(`totalizer`, `total`, `donation`, `target`, `milestone`, `poll`,
`matching`, `shame_clock`, `hype_meter`, `donation_train`).

## Running locally

```bash
# Static-only (no relay, no Tiltify) — python http.server on 8080
./serve.sh

# Relay (also serves the HTML on the same port, default 8081)
RELAY_PORT=8081 node relay.js
```

When running the relay, hit `http://localhost:8081/control.html` —
WebSocket connects to `/ws` on the same origin. `./serve.sh` is only
useful for pure HTML/CSS iteration; nothing dynamic works.

## Deployment

CI (`.github/workflows/ci.yml`) builds `ghcr.io/skenmy/esalowerthird`
on every push to `main` (and tags) and then dispatches `deploy.yml`
in the `skenmy-vps` repo with `service=esalowerthird, tag=sha-<short>`.
That repo pulls the image and restarts the container. Caddy on the VPS
terminates TLS at `lowerthird.skenmy.com` and proxies to the container.

- Image is `node:22-slim`, runs `node relay.js` on `8081`, serves the
  HTML files from `__dirname` (set `STATIC_DIR=disabled` to opt out
  when something else fronts the statics).
- Secrets live in `/opt/skenmy-vps/.env`, never in this repo.
  `esalowerthird.service` is the old systemd unit and is
  `.gitignore`'d (it still contains live credentials on disk).
- Control panel is gated behind Twitch sign-in at the edge (Caddy +
  `tools.skenmy.com`); the relay itself has no auth.

## Things easy to break

- Adding a non-`type` top-level field to a relayed message: the relay
  forwards anything that isn't `ping`/`pong`/`src_lookup`/
  `twitch_lookup` verbatim, but `source.html`'s switch only acts on
  `type`. Don't put dispatch logic anywhere else.
- Forgetting `escHtml()` on any new field used in a template string.
- Changing the campaign type — `team_campaigns` walks
  `supporting_campaigns` for incentives, `campaigns` reads them
  directly from the root. The merging logic in `pollTiltify` /
  `fetchIncentives` is the part to look at.
- Adding new static files: only `source.html`, `control.html`,
  `confidence.html`, `index.html` are in the `STATIC_FILES` allowlist in
  `relay.js`; the Dockerfile also `COPY`s exactly those four.
