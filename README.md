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
   every other connected client. Designed for tiny operator-team setups,
   not for the public internet, so the protocol is just JSON `{ type, … }`
   with no auth (auth lives at the Caddy edge).
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
