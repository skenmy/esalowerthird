# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ESA Lower Third is a browser-based overlay system for speedrunning marathon streams (ESA - European Speedrunner Assembly). It consists of three main files with no build step, framework, or bundler.

## Architecture

- **`source.html`** — OBS browser source overlay. Transparent background, receives WebSocket messages and renders animated lower thirds (runner names, Tiltify donation data, schedule info, fun tools like wheels/counters/quotes). This is the display layer only — it never sends commands, only listens.
- **`control.html`** — Control panel UI. Sends WebSocket commands to show/hide overlays, manage presets, queue items, browse Tiltify data, and trigger fun tools. Heavy single-file app (~99KB).
- **`relay.js`** — Node.js WebSocket relay server. Broadcasts messages between control and source clients. Also polls Tiltify API (donations, targets, polls, milestones, matches), Horaro API (schedule), and handles Twitch/SRC user lookups.
- **`index.html`** — Standalone single-page demo (no WebSocket, local keyboard controls only). Not used in production.

## Key Conventions

- **No build step.** All files are vanilla HTML/CSS/JS. Edit and deploy directly.
- **XSS safety:** Always use `escHtml()` for user-supplied strings interpolated into HTML.
- **Animation pattern:** Show = 0.6s `cubic-bezier(0.16, 1, 0.3, 1)`, Hide = 0.4s `cubic-bezier(0.7, 0, 0.84, 0)`. Text elements use `textReveal`/`textHide` keyframes with `--delay` CSS custom property for stagger.
- **Tiltify bar pattern:** `.tiltify-bar` > `.logo-container` + `.tiltify-content` > `.tiltify-stagger` elements with `--delay` for staggered reveals.
- **localStorage keys** use `esa-lt-*` prefix.
- **Fun tools** use tab pattern: `#funToolsSection` container, panel IDs `ftPanel*`, tab data attributes `ft-*`.
- **WebSocket message protocol:** JSON objects with a `type` field. Control sends commands (`update`, `hide`, `tiltify_show`, `custom_show`, etc.), relay broadcasts to other clients. Source handles display.
- **Scene filtering:** `source.html` accepts `?scene=NAME` query param. Messages with a `scene` field only affect matching source instances.

## Development

```bash
# Local development (static file server only, no relay/Tiltify)
./serve.sh  # python3 http.server on port 8080

# Run relay server locally
RELAY_PORT=8081 node relay.js
```

Source URL for OBS: `http://localhost:8080/source.html`
Control panel: `http://localhost:8080/control.html`

## Deployment

Static files rsync to `root@89.167.17.202:/var/www/esalowerthird/`. Relay runs as systemd service `esalowerthird.service` at `/opt/esalowerthird/relay.js` on port 8081. Nginx proxies `/ws` to the relay. Domain: `lowerthird.skenmy.com`.

```bash
# Deploy static files (no service restart needed)
rsync -avz source.html control.html index.html root@89.167.17.202:/var/www/esalowerthird/

# Deploy relay changes (requires service restart)
rsync -avz relay.js package.json root@89.167.17.202:/opt/esalowerthird/
ssh root@89.167.17.202 'systemctl restart esalowerthird'
```

## Environment Variables (relay.js)

- `RELAY_PORT` (default 8081)
- `TILTIFY_CLIENT_ID`, `TILTIFY_CLIENT_SECRET`, `TILTIFY_CAMPAIGN_ID`, `TILTIFY_CAMPAIGN_TYPE` (`campaigns` or `team_campaigns`)
- `HORARO_SCHEDULE` (e.g. `esa/2026-winter1`)
- `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`
