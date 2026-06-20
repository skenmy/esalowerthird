# esalowerthird

Browser-source overlay system for ESA (European Speedrunner Assembly)
marathon streams. Four surfaces, one tiny WebSocket relay:

- **`/source.html`** — the OBS browser source. Transparent background,
  renders animated lower-thirds (runner names, Tiltify donation totals,
  schedule rail, fun tools like wheels / counters / quotes) in the
  ESA "Cube System" skin. Add `?theme=mono` for the graphite/blue
  variant, `?logo=<url>` to swap the cube logo. Listen only — never
  sends commands.
- **`/control.html`** — the operator control panel ("Studio Control").
  Sends commands over WebSocket to show / hide overlays, manage presets,
  queue runners, browse live Tiltify data, trigger the fun tools, and
  drive the host confidence monitor (studio state, feature-large pushes,
  producer messages, and a Program / Both / Confidence send-target
  selector). Includes live Program + Host preview iframes. Heavy
  single-file app.
- **`/confidence.html`** — the host confidence monitor for studio hosts
  during intermissions. Always-on board (live total, up next, bid war,
  studio state, producer banner) that surfaces what viewers see large so
  hosts can react. Listen only (`?scene=confidence`); self-scales to any
  1920×1080 display.
- **`/index.html`** — standalone demo (no WebSocket, keyboard-driven).
  Useful for designing overlays without the relay running.

Live at **<https://lowerthird.skenmy.com>** — `/control.html` is gated
behind a Twitch sign-in via [tools.skenmy.com](https://tools.skenmy.com);
`/source.html` and `/confidence.html` are public so OBS / the host
monitor can hit them without credentials.

## What the relay does

`relay.js` is a single ~600-line Node script. It:

1. Serves the three HTML files.
2. Hosts a WebSocket relay — broadcasts any message a client sends to
   every other connected client. Designed for tiny operator-team setups;
   the protocol is just JSON `{ type, … }`. Reads stay open; set
   `RELAY_TOKEN` to gate *writes* (see [Auth](#auth)) so a public relay
   can't be hijacked.
3. Polls **Tiltify** every 15 seconds for the configured campaign:
   donations, milestones, targets, polls, donation matches. Supports
   both `campaigns/<id>` and `team_campaigns/<id>` — for team campaigns
   it walks `supporting_campaigns` to merge per-sub-campaign incentives.
4. Polls **Horaro** every 5 minutes for the configured schedule and
   broadcasts the upcoming + last-three runs.
5. Handles **`src_lookup`** and **`twitch_lookup`** messages from the
   control panel — quick PB / follower counts when prepping the
   broadcast.

## WebSocket protocol

Every message is a JSON object with a `type` field. The relay forwards
every non-special message to every other client; everything below is
either a server-originated broadcast or a request the relay handles.

| type | direction | payload |
|---|---|---|
| `update` | control → source | `{ scene, … }` (per-scene template, see source.html) |
| `hide` | control → source | `{ scene }` |
| `tiltify_show` / `tiltify_hide` | control → source | `{}` |
| `tiltify_data` | server → all | `{ campaign, donations, targets, polls, milestones, donationMatches, … }` (every 15s) |
| `schedule_show` / `schedule_hide` | control → source | `{}` |
| `schedule_data` | server → all | `{ schedule, upcoming, previous }` (every 5m) |
| `src_lookup` | control → server | `{ username }` |
| `src_result` | server → control | `{ username, gamesRun, totalPBs, worldRecords }` |
| `twitch_lookup` | control → server | `{ username }` |
| `twitch_result` | server → control | `{ username, followers, broadcasterType }` |
| `confidence_state` | control → confidence | `{ state: clear\|standby\|air\|recording\|wrap }` |
| `confidence_feature` | control → confidence | `{ feature: total\|incentive\|bidwar\|schedule\|none, … }` |
| `producer_msg` | control → confidence | `{ text, level: info\|urgent, active }` |
| `ping` / `pong` | both | `{}` (server pings every 30s) |
| `clients` | server → all | `{ count }` |
| `remote_cmd` | server → control | `{ cmd: go\|hide\|total }` (a Companion deck press, see [Companion](#bitfocus-companion)) |

The relay caches the last `confidence_state` / `confidence_feature` /
`producer_msg` and replays them to clients that connect later, so a host
monitor opened mid-show still syncs. When the control panel's send target
is **Both** or **Confidence**, showing the donation total / target / poll
/ schedule on Program also emits the matching `confidence_feature` so the
host monitor features it large — runner cards never mirror.

Scene filtering: `source.html?scene=<name>` makes that instance only
react to messages with `scene === <name>`. `confidence.html` defaults to
`scene=confidence`.

### Program preview picker

The control panel's **Program** preview pane has a dropdown to choose what
it shows:

- **Overlay — live (unfiltered)** — `source.html` with no scene filter.
  Reacts to every overlay message regardless of scene, so it mirrors
  Together-mode sends (or, in Separate mode, whichever scene was sent
  last). A single overlay only ever renders one thing — it does **not**
  composite all scenes.
- **Overlay — Scene A … G** — `source.html?scene=<a…g>`, previewing one
  specific Separate-mode scene.
- **Program (NDI)** — *power-user option.* Shows the real composited
  Program instead of the overlay. A browser can't read NDI directly, so
  this points the iframe at a **bridge URL** you set via the gear icon
  (stored in `localStorage['esa-lt-ndi-url']`). The bridge must convert
  NDI to something a browser can play and be served over **HTTPS** (the
  panel is HTTPS, so a plain-`http://` viewer is blocked as mixed
  content). Two common bridges: a **VDO.Ninja** `?view=<id>` URL
  (HTTPS-hosted, WebRTC P2P on your LAN), or a self-hosted **MediaMTX**
  WebRTC/WHEP endpoint behind a TLS reverse proxy. Expect ~0.2–0.5 s of
  WebRTC latency, so treat it as a confidence monitor, not a
  frame-accurate reference.

  For most setups it's simpler to **skip embedding** and watch the real
  Program in a native NDI viewer (NDI Studio Monitor, or an OBS windowed
  projector) beside the panel — zero transcode, zero TLS, zero latency.
  The NDI option exists for operators who specifically want it in-tab.

## Conventions in `source.html` / `control.html`

- **No build step.** Vanilla HTML + CSS + JS. Edit and deploy.
- **XSS safety.** Always use `escHtml()` for strings interpolated into
  HTML.
- **Animation pattern.** Show = `0.6s cubic-bezier(0.16, 1, 0.3, 1)`;
  hide = `0.4s cubic-bezier(0.7, 0, 0.84, 0)`. Text elements use
  `textReveal` / `textHide` keyframes with a `--delay` CSS custom
  property for stagger.
- **Tiltify bar** = `.tiltify-bar` → `.logo-container + .tiltify-content`
  → `.tiltify-stagger` children, each with their own `--delay`.
- **localStorage keys** are `esa-lt-*`.
- **Fun tools** live under `#funToolsSection`, panel IDs `ftPanel*`,
  tab data attributes `ft-*`.

## Env

All optional — the relay degrades gracefully when a section is unset.

| var | notes |
|---|---|
| `RELAY_PORT` | default `8081` |
| `STATIC_DIR` | default `__dirname`. Set to `disabled` to opt out of file serving. |
| `TILTIFY_CLIENT_ID` / `TILTIFY_CLIENT_SECRET` | OAuth client credentials (Tiltify dashboard → Apps). |
| `TILTIFY_CAMPAIGN_ID` | the campaign UUID. |
| `TILTIFY_CAMPAIGN_TYPE` | `team_campaigns` (default) or `campaigns`. |
| `HORARO_SCHEDULE` | e.g. `esa/2026-winter1` (event-slug/schedule-slug). |
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | optional — enables `twitch_lookup`. |
| `RELAY_TOKEN` | optional shared secret. When set, `/ws` writes need Caddy auth or `?token=`, and `/api/*` needs the token (see [Auth](#auth)). Unset = fully open. |

## HTTP API

The relay serves a small HTTP surface on the same port (handy for
Bitfocus Companion, scripts, health probes). All `/api/*` routes require
the token when `RELAY_TOKEN` is set; `/healthz` and the static files stay
open.

| route | does |
|---|---|
| `POST /api/send` | broadcast the JSON body to every WS client (arbitrary `{ type, … }`). |
| `GET /api/hide` | hide every overlay (names, tiltify, schedule, wheel, image) + clear the host feature. |
| `GET /api/cmd/<go\|hide\|total>` | fire a Companion deck press — relayed to `control.html` as `remote_cmd`. |
| `GET /api/studio/<clear\|standby\|air\|recording\|wrap>` | set the host-monitor studio state directly (broadcasts `confidence_state`). |
| `GET /api/state` | `{ ok, names, total, studio }` — current overlay state, for Companion button feedback. |
| `GET /healthz` | `ok` (container probe, always open). |

## Auth

The relay separates **reading** the feed from **writing** to the overlay,
so the public-facing parts stay open while injection is locked down.

- **Reads are always open.** `source.html` / `confidence.html` connect to
  `/ws` with no credential and just receive — an OBS browser source can't
  do an interactive login, so this has to work. They never need a token.
- **Writes need to be trusted.** A WS connection may send overlay-mutating
  messages (and trigger `src_lookup` / `twitch_lookup`) only if it is
  either:
  - **Twitch-authed via Caddy** — the control panel connects on `/adminws`,
    which the edge gates with the same `forward_auth` as `control.html` and
    stamps with `X-Forwarded-User`. The relay trusts that header. So the
    operator's existing Twitch login is the credential — no separate token.
  - **token-bearing** — a `?token=<secret>` on the WS URL (for scripts /
    machine writers without the Caddy edge).
- **`/api/*` needs the token** — `POST /api/send`, `GET /api/hide`,
  `/api/cmd/*`, `/api/state`. Pass it as `?token=`, an `X-Relay-Token`
  header, or `Authorization: Bearer <secret>`. This is what Bitfocus
  Companion uses.

Set `RELAY_TOKEN=<secret>` to turn all of this on; leave it unset and the
relay is fully open (fine when nothing is public yet, or something else
fronts auth). For the trust-by-header path to be safe the edge **must
strip client-supplied `X-Forwarded-User` on the open route** — the
`lowerthird` Caddy fragment in `skenmy-vps` does this. The token is never
committed; it lives in `/opt/skenmy-vps/.env` with the other secrets.

## Bitfocus Companion

The deck acts as a **remote keyboard for the open control panel** — it
fires the same actions as the operator's keyboard, using whatever queue
the operator has built in `control.html`. Use Companion's built-in
**Generic HTTP** module.

**Actions** (one HTTP GET per button; append `?token=…` if `RELAY_TOKEN`
is set):

| button | request |
|---|---|
| Go Live (Enter) | `GET http://<relay>/api/cmd/go` |
| Hide (Esc) | `GET http://<relay>/api/cmd/hide` |
| Show donation total | `GET http://<relay>/api/cmd/total` |
| Studio state | `GET http://<relay>/api/studio/<clear\|standby\|air\|recording\|wrap>` |

The Go Live / Hide / Show-total buttons drive the open control panel (its
queue). The studio-state buttons hit the relay directly — they work even
if the control panel isn't open, and one button per state (Clear, Standby,
On Air, Recording, Wrap) is the usual layout.

**Feedback** (light the active button):

1. In the Generic HTTP connection config, add **Variables** that poll
   `http://<relay>/api/state` (e.g. every 500 ms): `names` ← JSONPath
   `$.names`, `total` ← `$.total`, `studio` ← `$.studio`.
2. On each button add the internal **Variable: check value** feedback and
   set the button background when it matches:
   - Go Live / Hide → `$(generic-http:names)` equals `true` (green).
   - Show total → `$(generic-http:total)` equals `true` (green).
   - Each studio button → `$(generic-http:studio)` equals its own state
     (e.g. the On Air button lights when `studio` = `air`).

## Local dev

```sh
# static files only
./serve.sh                       # http://localhost:8080

# relay (control + source still loaded via http://localhost:8081/)
RELAY_PORT=8081 node relay.js
```

OBS browser source URL: `http://localhost:8081/source.html`
Control: `http://localhost:8081/control.html`

## Deploy

Standard skenmy-vps pattern. CI builds + pushes
`ghcr.io/skenmy/esalowerthird`; the skenmy-vps deploy then pulls and
restarts. Secrets live in `/opt/skenmy-vps/.env` on the box — never in
this repo (the old `esalowerthird.service` systemd unit is `.gitignore`'d
for exactly this reason).
