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
  producer messages, and a global **Mirror** toggle). Includes live
  Program + Host preview iframes. Heavy single-file app.
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
   the protocol is just JSON `{ type, … }`. Set `RELAY_TOKEN` to require a
   shared token on `/ws` and `/api/*` (see [Auth](#auth)) so a public
   relay can't be hijacked.
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
| `confidence_state` | control → confidence | `{ state: standby\|air\|wrap }` |
| `confidence_feature` | control → confidence | `{ feature: total\|incentive\|bidwar\|schedule\|none, … }` |
| `producer_msg` | control → confidence | `{ text, level: info\|urgent, active }` |
| `ping` / `pong` | both | `{}` (server pings every 30s) |
| `clients` | server → all | `{ count }` |
| `remote_cmd` | server → control | `{ cmd: go\|hide\|total }` (a Companion deck press, see [Companion](#bitfocus-companion)) |

The relay caches the last `confidence_state` / `confidence_feature` /
`producer_msg` and replays them to clients that connect later, so a host
monitor opened mid-show still syncs. With the control panel's **Mirror**
toggle on, showing the donation total / target / poll / schedule on
Program also emits the matching `confidence_feature` so the host monitor
features it large — runner cards never mirror.

Scene filtering: `source.html?scene=<name>` makes that instance only
react to messages with `scene === <name>`. `confidence.html` defaults to
`scene=confidence`.

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
| `RELAY_TOKEN` | optional shared secret. When set, `/ws` and `/api/*` require it (see [Auth](#auth)). Unset = open. |

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
| `GET /api/state` | `{ ok, names, total }` — current overlay state, for Companion button feedback. |
| `GET /healthz` | `ok` (container probe, always open). |

## Auth

Leave `RELAY_TOKEN` unset for a private/edge-gated relay (current ESA
setup: the control panel sits behind Twitch sign-in at the Caddy edge).

Set `RELAY_TOKEN=<secret>` before publishing the relay openly. Then:

- **WS clients** must connect with `?token=<secret>`. Open each HTML page
  once with `?token=…` appended (e.g. the OBS browser-source URL, the
  control panel) — it's saved to `localStorage` (`esa-lt-token`) and
  reused, so you only pass it the first time per machine/browser.
- **HTTP `/api/*`** accepts the token as `?token=`, an `X-Relay-Token`
  header, or `Authorization: Bearer <secret>`.

The token is never committed — it lives in `/opt/skenmy-vps/.env` like
the other secrets.

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

**Feedback** (red/green when something is on screen):

1. In the Generic HTTP connection config, add **Variables** that poll
   `http://<relay>/api/state` (e.g. every 500 ms): `names` ← JSONPath
   `$.names`, `total` ← JSONPath `$.total`.
2. On each button add the internal **Variable: check value** feedback
   comparing the matching variable to `true`; set the button background
   green when true (red/off otherwise).

So "Go Live" / "Hide" track `$(generic-http:names)` and "Show total"
tracks `$(generic-http:total)`.

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
