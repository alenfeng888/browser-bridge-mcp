"""Prove the server's WS accept path works, and probe which host forms connect."""
import asyncio
import json

import websockets


async def one(host):
    try:
        async with websockets.connect(f"ws://{host}:8765", timeout=5) as ws:
            await ws.send(json.dumps({"id": 1, "cmd": "ping"}))
            raw = await asyncio.wait_for(ws.recv(), timeout=8)
            print(host, "CONNECT OK ->", raw[:160])
    except Exception as e:  # noqa: BLE001
        print(host, "FAIL", repr(e))


async def main():
    for h in ("127.0.0.1", "localhost"):
        await one(h)


asyncio.run(main())
