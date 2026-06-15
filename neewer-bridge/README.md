# NEEWER RGB1 ↔ Studio Control bridge

A small standalone agent that makes a **NEEWER RGB1 stick light** show the same
colour as the Studio Control **state indicator** (Clear / Standby / On Air /
Recording / Wrap Up).

## How it fits in

Nothing in the web app or relay changes. The studio state already travels over
the relay as `confidence_state` WebSocket messages (that's what drives the host
monitor). This bridge is just **another WebSocket client**: it runs on a machine
near the light, listens for `confidence_state`, and writes the matching colour to
the RGB1 over Bluetooth LE.

```
control.html ──confidence_state──▶ relay ──▶ confidence.html (on-screen indicator)
                                      └──────▶ neewer_bridge.py ──BLE──▶ RGB1 light
```

The colour map is derived from the **same hex values** as the on-screen
indicator, so they always match:

| State | Colour | Light |
|---|---|---|
| `clear` | grey | **off** |
| `standby` | `#4d7cff` | blue |
| `air` | `#ff4136` | red |
| `recording` | `#e11d48` | crimson |
| `wrap` | `#ffb02e` | amber |

## Run it

Run on a machine with Bluetooth that's near the light — a Raspberry Pi, Linux
box, or Windows PC works best (see the macOS note below).

```bash
cd neewer-bridge
pip install -r requirements.txt

# 1) find the light's MAC (turn the RGB1 on, in Bluetooth mode)
python neewer_bridge.py --discover
#   AA:BB:CC:DD:EE:FF   NW-20200015...

# 2) run the bridge
python neewer_bridge.py --mac AA:BB:CC:DD:EE:FF
```

By default it connects to the production relay
(`wss://lowerthird.skenmy.com/ws`). Override with `--relay` (or `RELAY_WS`),
e.g. `--relay ws://localhost:8081/ws` for local testing.

Other options: `--brightness 0-100` (default 100), `--scene <name>` (only react
to a specific scene), `--reverse-mac` (see below). All have env equivalents
(`LIGHT_MAC`, `LIGHT_BRIGHTNESS`, `LIGHT_SCENE`).

To keep it running, wrap it in a systemd unit / `pm2` / a login item on the
studio machine.

## Protocol notes

The RGB1 uses NEEWER's newer **"Infinity"** BLE framing, which embeds the light's
6-byte MAC in every packet. The builders in `neewer_bridge.py` are verified
against the known-good captures from the reverse-engineering handoff:

```
Power on:  78 8D 08 <MAC0..5> 81 01 <checksum>
HSI/RGB:   78 8F 0C <MAC0..5> 86 <hueLo hueHi sat bri 00> <checksum>
checksum = sum(all preceding bytes) & 0xFF        # write char 69400002-…
```

This is ported from the protocol documented by `keefo/NeewerLite` and
`taburineagle/NeewerLite-Python` (which ships an explicit RGB1 config).

### If it doesn't react

- **MAC byte order** — packets use the MAC as written. If the light ignores
  commands, try `--reverse-mac`.
- **Confirm the framing** — some firmware revisions may use the *legacy*
  (non-MAC) frames instead. Sniff the official NEEWER app once: Android
  Developer Options → "Enable Bluetooth HCI snoop log", drive the light, pull
  `btsnoop_hci.log`, open in Wireshark, filter ATT writes to `69400002`
  (`btatt.opcode == 0x52`), and compare against the bytes above.
- **macOS** — CoreBluetooth hides the real MAC behind a UUID, and the Infinity
  protocol needs the real MAC. Run the bridge on Linux/RPi/Windows, or find the
  MAC with nRF Connect and pass it via `--mac`.

> This is **untested against physical hardware** — it's built from the documented
> protocol (with checksums verified against the published captures). Validate
> against your unit before relying on it live, and tune `--reverse-mac` /
> brightness as needed.
