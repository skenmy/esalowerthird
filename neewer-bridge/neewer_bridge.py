#!/usr/bin/env python3
"""
NEEWER RGB1 ↔ Studio Control bridge.

Subscribes to the relay's WebSocket, watches `confidence_state` messages (the
same ones that drive the host monitor's state indicator) and mirrors the colour
onto a NEEWER RGB1 stick light over Bluetooth LE — so the physical light shows
the same colour as the on-screen Studio State.

State → colour is derived from the SAME hex values as the web indicator, so they
always match:

    clear      → light off
    standby    → #4d7cff (blue)
    air        → #ff4136 (red)
    recording  → #e11d48 (crimson)
    wrap       → #ffb02e (amber)

The RGB1 uses NEEWER's newer "Infinity" BLE framing, which embeds the light's
6-byte MAC in every packet:

    HSI:    78 8F 0C <MAC0..5> 86 <hueLo hueHi sat bri 00> <checksum>
    Power:  78 8D 08 <MAC0..5> 81 <01=on|02=off>           <checksum>
    checksum = sum(all preceding bytes) & 0xFF

(Builders here are verified against the known-good captures in the protocol
handoff.)

Usage:
    pip install -r requirements.txt
    python neewer_bridge.py --discover                 # find your light's MAC
    python neewer_bridge.py --mac AA:BB:CC:DD:EE:FF     # run the bridge

Env vars (override with flags): RELAY_WS, LIGHT_MAC, LIGHT_BRIGHTNESS.

Notes / caveats:
  * On Linux / Raspberry Pi / Windows, BleakScanner returns the real MAC. On
    macOS, CoreBluetooth hides the MAC behind a UUID — the Infinity protocol
    needs the real MAC, so run the bridge on Linux/RPi/Windows, or find the MAC
    with nRF Connect and pass it via --mac.
  * MAC byte order in the packet is taken as written. If the light doesn't react,
    try --reverse-mac.
  * NEEWER BLE is known to be flaky over distance; this keeps a persistent
    connection and reconnects automatically.
"""

import argparse
import asyncio
import colorsys
import json
import os
import sys

from bleak import BleakClient, BleakScanner

WRITE_CHAR = "69400002-b5a3-f393-e0a9-e50e24dcca99"   # NeewerDeviceCtlCharacteristicUUID (write)

# Matches the Studio Control state indicator. 'clear' = light off.
STATE_HEX = {
    "standby":   "#4d7cff",
    "air":       "#ff4136",
    "recording": "#e11d48",
    "wrap":      "#ffb02e",
}


def hex_to_hsi(hex_color, brightness):
    """#rrggbb -> (hue 0-359, saturation 0-100, brightness 0-100)."""
    h = hex_color.lstrip("#")
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    hue, sat, _ = colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)
    return int(round(hue * 360)) % 360, int(round(sat * 100)), int(brightness)


def mac_bytes(mac, reverse=False):
    parts = [int(x, 16) for x in mac.replace("-", ":").split(":")]
    if len(parts) != 6:
        raise ValueError(f"MAC must be 6 bytes, got: {mac!r}")
    return parts[::-1] if reverse else parts


def _checksum(body):
    return sum(body) & 0xFF


def cmd_power(mac, on, reverse=False):
    body = [0x78, 0x8D, 0x08] + mac_bytes(mac, reverse) + [0x81, 0x01 if on else 0x02]
    return bytes(body + [_checksum(body)])


def cmd_hsi(mac, hue, sat, bri, reverse=False):
    params = [hue & 0xFF, (hue >> 8) & 0xFF, sat & 0xFF, bri & 0xFF, 0x00]
    body = [0x78, 0x8F, 6 + 1 + len(params)] + mac_bytes(mac, reverse) + [0x86] + params
    return bytes(body + [_checksum(body)])


# --- legacy (non-Infinity) frames, for the --probe fallback ---
def cmd_power_legacy(on):
    body = [0x78, 0x81, 0x01, 0x01 if on else 0x02]
    return bytes(body + [_checksum(body)])


def cmd_hsi_legacy(hue, sat, bri):
    body = [0x78, 0x86, 0x04, hue & 0xFF, (hue >> 8) & 0xFF, sat & 0xFF, bri & 0xFF]
    return bytes(body + [_checksum(body)])


def _hex(b):
    return " ".join(f"{x:02X}" for x in b)


async def probe(args):
    """Try candidate framings, watch the light, see which one turns it red."""
    target = args.connect or args.mac
    print(f"[ble] connecting {target} …")
    async with BleakClient(target) as client:
        print("[ble] connected\n")
        print("GATT characteristics:")
        for s in client.services:
            for c in s.characteristics:
                star = "  <-- write target" if c.uuid.lower() == WRITE_CHAR else ""
                print(f"  {c.uuid}  [{','.join(c.properties)}]{star}")
        print()

        mac = args.mac
        candidates = []
        if mac:
            candidates += [
                ("A  Infinity, MAC as-is, no-response",
                 [cmd_power(mac, True), cmd_hsi(mac, 0, 100, 100)], False),
                ("B  Infinity, MAC reversed, no-response",
                 [cmd_power(mac, True, True), cmd_hsi(mac, 0, 100, 100, True)], False),
                ("C  Infinity, MAC as-is, with-response",
                 [cmd_power(mac, True), cmd_hsi(mac, 0, 100, 100)], True),
                ("D  Infinity, MAC reversed, with-response",
                 [cmd_power(mac, True, True), cmd_hsi(mac, 0, 100, 100, True)], True),
            ]
        candidates += [
            ("E  Legacy (no MAC), no-response",
             [cmd_power_legacy(True), cmd_hsi_legacy(0, 100, 100)], False),
            ("F  Legacy (no MAC), with-response",
             [cmd_power_legacy(True), cmd_hsi_legacy(0, 100, 100)], True),
        ]
        print("Watch the light. Each candidate tries to make it BRIGHT RED for ~4s.\n")
        for label, pkts, resp in candidates:
            print(f"→ {label}")
            for p in pkts:
                print(f"     write {_hex(p)} (response={resp})")
                try:
                    await client.write_gatt_char(WRITE_CHAR, p, response=resp)
                except Exception as e:
                    print(f"     ! write failed: {e}")
                await asyncio.sleep(0.15)
            await asyncio.sleep(4)
        print("\nDone. Whichever letter turned it red → tell me, and that's the framing to lock in.")
        print("(B/D = add --reverse-mac to the normal run; C/D = needs with-response.)")


async def apply_state(client, args, state):
    """Write the colour for `state` to the connected light."""
    off = state == "clear" or state not in STATE_HEX
    if off:
        pkt = cmd_power(args.mac, False, args.reverse_mac) if args.infinity else cmd_power_legacy(False)
        await client.write_gatt_char(WRITE_CHAR, pkt, response=args.response)
        print(f"[light] {state} -> off")
        return
    hue, sat, bri = hex_to_hsi(STATE_HEX[state], args.brightness)
    if args.infinity:
        on, color = cmd_power(args.mac, True, args.reverse_mac), cmd_hsi(args.mac, hue, sat, bri, args.reverse_mac)
    else:
        on, color = cmd_power_legacy(True), cmd_hsi_legacy(hue, sat, bri)
    await client.write_gatt_char(WRITE_CHAR, on, response=args.response)
    await asyncio.sleep(0.05)
    await client.write_gatt_char(WRITE_CHAR, color, response=args.response)
    print(f"[light] {state} -> {STATE_HEX[state]} (H{hue} S{sat} B{bri})")


async def ws_task(args, queue):
    import websockets  # imported here so --discover works without it installed
    while True:
        try:
            async with websockets.connect(args.relay, ping_interval=None) as ws:
                print(f"[ws] connected {args.relay}")
                await ws.send(json.dumps({"type": "pong"}))
                async for raw in ws:
                    try:
                        data = json.loads(raw)
                    except Exception:
                        continue
                    if data.get("type") == "ping":
                        await ws.send(json.dumps({"type": "pong"}))
                    elif data.get("type") == "confidence_state":
                        scene = data.get("scene")
                        if not args.scene or scene in (None, args.scene):
                            await queue.put(data.get("state", "clear"))
        except Exception as e:
            print(f"[ws] disconnected ({e}); retrying in 2s")
        await asyncio.sleep(2)


async def ble_task(args, queue):
    last = None
    target = args.connect or args.mac
    while True:
        try:
            print(f"[ble] connecting {target} …")
            async with BleakClient(target) as client:
                print("[ble] connected")
                if last is not None:
                    await apply_state(client, args, last)
                while True:
                    state = await queue.get()
                    while not queue.empty():           # collapse to the most recent
                        state = queue.get_nowait()
                    last = state
                    await apply_state(client, args, state)
        except Exception as e:
            print(f"[ble] error ({e}); reconnecting in 3s")
        await asyncio.sleep(3)


async def discover():
    print("Scanning 8s for NEEWER lights …")
    devices = await BleakScanner.discover(timeout=8)
    found = False
    for d in devices:
        name = d.name or ""
        if "NEEWER" in name.upper() or name.upper().startswith("NW-"):
            found = True
            print(f"  {d.address}   {name}")
    if not found:
        print("  (none found — make sure the light is on and in Bluetooth mode)")


def main():
    p = argparse.ArgumentParser(description="Mirror Studio Control state colour to a NEEWER RGB1 over BLE.")
    p.add_argument("--relay", default=os.environ.get("RELAY_WS", "wss://lowerthird.skenmy.com/ws"),
                   help="relay WebSocket URL (default: %(default)s)")
    p.add_argument("--mac", default=os.environ.get("LIGHT_MAC"),
                   help="RGB1 BLE MAC address, e.g. AA:BB:CC:DD:EE:FF (env LIGHT_MAC). "
                        "On macOS this is the real MAC used in the packets (find it via nRF Connect).")
    p.add_argument("--connect", default=os.environ.get("LIGHT_CONNECT"),
                   help="address to connect to, if different from --mac. On macOS use the "
                        "CoreBluetooth UUID from --discover here; keep the real MAC in --mac.")
    p.add_argument("--brightness", type=int, default=int(os.environ.get("LIGHT_BRIGHTNESS", "1")),
                   help="light brightness 0-100 (default: %(default)s)")
    p.add_argument("--scene", default=os.environ.get("LIGHT_SCENE", ""),
                   help="only react to confidence_state for this scene (default: any)")
    p.add_argument("--infinity", action="store_true",
                   help="use the MAC-embedded Infinity frames instead of legacy (needs --mac)")
    p.add_argument("--response", action="store_true",
                   help="use BLE write-with-response (probe candidates C/D/F)")
    p.add_argument("--reverse-mac", action="store_true",
                   help="(--infinity only) reverse MAC byte order in packets")
    p.add_argument("--discover", action="store_true", help="scan for NEEWER lights and exit")
    p.add_argument("--probe", action="store_true",
                   help="try candidate framings (watch the light) + dump its characteristics, then exit")
    args = p.parse_args()

    if args.discover:
        asyncio.run(discover())
        return
    if not (args.mac or args.connect):
        p.error("need --mac (Linux/Win) or --connect (macOS UUID). Run --discover to find it.")
    if args.infinity and not args.mac:
        p.error("--infinity needs the real --mac to embed in packets.")
    if args.probe:
        asyncio.run(probe(args))
        return

    queue = asyncio.Queue()

    async def run():
        await asyncio.gather(ws_task(args, queue), ble_task(args, queue))

    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
