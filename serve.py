"""Edge extension bridge - Python half. Transport = Native Messaging.

The extension spawns our native host (host.py) via chrome.runtime.connectNative.
Edge feeds it length-prefixed JSON on stdin. No network, no port, no CDP, no CSP.

Two TCP listeners (used only by us, never by the browser):
  127.0.0.1:8765  <- native host subprocesses check in here
  127.0.0.1:8766  <- this script's CLI talks here (one JSON object per line)

Both ports are gated on the bridge token (~/.ext_bridge_token, override with
EXT_BRIDGE_TOKEN): CLI requests must carry it as "token"; a native host must
send {"__hello__": {"token": ...}} as its first frame. serve mode refuses to
start without a readable token (fail closed) - start the resident server once
(`node server.js`) or set the env var. Ports overridable via
EXT_BRIDGE_NATIVE_PORT / EXT_BRIDGE_CLI_PORT for isolated test instances.

Usage:
  python serve.py serve                 # start the router (run in background)
  python serve.py list                  # tabs in the user's real Edge
  python serve.py open <url>            # open tab, remember it
  python serve.py use <tabid-prefix>
  python serve.py text                  # innerText of the remembered tab
  python serve.py eval <js>
  python serve.py evalf <file.js>
  python serve.py shot <out.png>
  python serve.py cookies <domain>      # names only - values stripped in ext
  python serve.py navigate <url>
  python serve.py activate
  python serve.py close
  python serve.py focus_win
"""
import asyncio
import base64
import json
import os
import socket
import struct
import sys

HOST = "127.0.0.1"
NATIVE_PORT = int(os.environ.get("EXT_BRIDGE_NATIVE_PORT", "8765"))
CLI_PORT = int(os.environ.get("EXT_BRIDGE_CLI_PORT", "8766"))
LAST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "last_tab.json")


def load_token():
    """The shared local secret. Never auto-generated here: the resident
    server (server.js) owns generation, this process only consumes."""
    tok = os.environ.get("EXT_BRIDGE_TOKEN", "").strip()
    if tok:
        return tok
    try:
        with open(os.path.join(os.path.expanduser("~"), ".ext_bridge_token"),
                  encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


TOKEN = load_token()


class Hub:
    """One native-messaging connection from the extension's service worker."""

    def __init__(self):
        self.writer = None
        self.up = asyncio.Event()
        self.seq = 0
        self.waiters = {}

    async def accept_native(self, reader, writer):
        # Handshake gate: without the token you do not get the browser.
        try:
            hdr = await asyncio.wait_for(reader.readexactly(4), timeout=5)
            n = struct.unpack("<I", hdr)[0]
            if n > 1024 * 1024:
                raise ValueError("hello frame too large")
            hello = json.loads((await reader.readexactly(n)).decode("utf-8"))
            if str(hello.get("__hello__", {}).get("token", "")) != TOKEN:
                print("rejected 8765 client: bad hello token", flush=True)
                writer.close()
                return
        except Exception as e:  # noqa: BLE001
            print("rejected 8765 client: %s" % e, flush=True)
            try:
                writer.close()
            except Exception:
                pass
            return
        self.writer = writer
        self.up.set()
        print("extension native port up", flush=True)
        try:
            while True:
                hdr = await reader.readexactly(4)
                n = struct.unpack("<I", hdr)[0]
                if n > 8 * 1024 * 1024:
                    raise ValueError("frame too large: %d" % n)
                raw = await reader.readexactly(n)
                msg = json.loads(raw.decode("utf-8"))
                fut = self.waiters.pop(msg.get("id"), None)
                if fut and not fut.done():
                    fut.set_result(msg)
        except (asyncio.IncompleteReadError, ConnectionResetError,
                ValueError, json.JSONDecodeError):
            pass
        finally:
            if self.writer is writer:
                self.writer = None
                self.up.clear()
            print("extension native port down", flush=True)
            try:
                writer.close()
            except Exception:
                pass

    async def call_native(self, cmd, arg=None, timeout=35):
        try:
            await asyncio.wait_for(self.up.wait(), timeout=30)
        except asyncio.TimeoutError:
            raise RuntimeError("Extension not connected: is native messaging registered? (edge://extensions -> check 'Local Ext Bridge' is enabled)")
        if self.writer is None:
            raise RuntimeError("Extension disconnected; wait for it to reconnect (SW sleeps ~30s, retry)")
        self.seq += 1
        i = self.seq
        fut = asyncio.get_running_loop().create_future()
        self.waiters[i] = fut
        try:
            frame = json.dumps({"id": i, "cmd": cmd, "arg": arg or {}},
                               ensure_ascii=False).encode("utf-8")
            self.writer.write(struct.pack("<I", len(frame)) + frame)
            await self.writer.drain()
            m = await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            self.waiters.pop(i, None)
            raise RuntimeError("Extension not responding (SW may have just gone to sleep; retry once)")
        if "error" in m:
            raise RuntimeError("Extension error: " + m["error"])
        return m.get("result")

    async def cli_handler(self, reader, writer):
        try:
            data = await reader.read(1 << 20)
            req = json.loads(data.decode("utf-8"))
            if str(req.get("token", "")) != TOKEN:
                reply = {"ok": False, "error": "unauthorized: bad or missing token"}
            else:
                try:
                    res = await self.call_native(req["cmd"], req.get("arg"),
                                                 req.get("timeout", 35))
                    reply = {"ok": True, "result": res}
                except Exception as e:  # noqa: BLE001
                    reply = {"ok": False, "error": str(e)}
        except Exception as e:  # noqa: BLE001
            reply = {"ok": False, "error": "parse: " + str(e)}
        writer.write(json.dumps(reply, ensure_ascii=False).encode("utf-8") + b"\n")
        await writer.drain()
        try:
            await writer.wait_closed()
        except Exception:
            pass


hub = Hub()


async def serve_forever():
    nat = await asyncio.start_server(hub.accept_native, HOST, NATIVE_PORT)
    cli = await asyncio.start_server(hub.cli_handler, HOST, CLI_PORT)
    print(f"ext_bridge up: native 127.0.0.1:{NATIVE_PORT}  cli 127.0.0.1:{CLI_PORT}  (both token-gated)",
          flush=True)
    try:
        await asyncio.Future()
    finally:
        nat.close()
        cli.close()


# ---- CLI half ---------------------------------------------------------

def cli_call(cmd, arg=None, timeout=35):
    with socket.create_connection((HOST, CLI_PORT), timeout=timeout + 30) as s:
        s.sendall((json.dumps({"cmd": cmd, "arg": arg, "timeout": timeout,
                               "token": TOKEN},
                              ensure_ascii=False) + "\n").encode("utf-8"))
        buf = b""
        while not buf.endswith(b"\n"):
            chunk = s.recv(1 << 20)
            if not chunk:
                break
            buf += chunk
    r = json.loads(buf.decode("utf-8"))
    if not r.get("ok"):
        raise SystemExit("bridge error: " + r.get("error", "?"))
    return r["result"]


def read_last():
    try:
        with open(LAST, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def write_last(t):
    # read_last()/get_tab() expect the {"tab": ...} envelope
    with open(LAST, "w", encoding="utf-8") as f:
        json.dump({"tab": t}, f, ensure_ascii=False)


def get_tab():
    t = read_last().get("tab")
    if not t:
        raise SystemExit("No remembered tab: run list / open / use first")
    return t


def main():
    cmd = sys.argv[1]

    if cmd == "serve":
        if not TOKEN:
            raise SystemExit(
                "serve.py: no bridge token. Start the resident server once "
                "(node server.js) so it creates ~/.ext_bridge_token, or set "
                "EXT_BRIDGE_TOKEN. Refusing to run unauthenticated ports.")
        while True:
            try:
                asyncio.run(serve_forever())
            except Exception as e:  # noqa: BLE001
                print("server loop died:", e, flush=True)
            print("server restarting in 3s", flush=True)
            import time
            time.sleep(3)
        return

    if cmd == "list":
        for t in cli_call("list_tabs"):
            print(f"{t['id']:>6}  active={t.get('active')}  "
                  f"{(t.get('title') or '')[:38]:38} {(t.get('url') or '')[:110]}")
        return

    if cmd == "open":
        t = cli_call("open", {"url": sys.argv[2]})[0]
        write_last(t)
        print(json.dumps(t, ensure_ascii=False))
        return

    if cmd == "use":
        for t in cli_call("list_tabs"):
            if str(t["id"]).startswith(sys.argv[2]):
                write_last(t)
                print(json.dumps(t, ensure_ascii=False))
                return
        raise SystemExit("tab not found: " + sys.argv[2])

    if cmd == "cookies":
        rows = cli_call("cookies", {"domain": sys.argv[2]})
        print(json.dumps([{"name": x["name"], "domain": x["domain"]} for x in rows],
                         ensure_ascii=False, indent=1))
        return

    tab = get_tab()
    tid = tab["id"]

    if cmd == "text":
        print(cli_call("text", {"tabId": tid}).get("text", "")[:8000])
    elif cmd == "eval":
        v = cli_call("eval", {"tabId": tid, "expr": sys.argv[2]},
                     timeout=40).get("value")
        print(json.dumps(v, ensure_ascii=False)[:20000])
    elif cmd == "evalf":
        expr = open(sys.argv[2], encoding="utf-8").read()
        v = cli_call("eval", {"tabId": tid, "expr": expr},
                     timeout=40).get("value")
        print(json.dumps(v, ensure_ascii=False)[:20000])
    elif cmd == "shot":
        with open(sys.argv[2], "wb") as f:
            f.write(base64.b64decode(cli_call("shot", {"tabId": tid},
                                          timeout=40)["data"]))
        print("saved", sys.argv[2])
    elif cmd == "navigate":
        print(json.dumps(cli_call("navigate", {"tabId": tid, "url": sys.argv[2]})))
    elif cmd == "activate":
        print(json.dumps(cli_call("activate", {"tabId": tid})))
    elif cmd == "close":
        print(json.dumps(cli_call("close", {"tabId": tid})))
    elif cmd == "focus_win":
        print(json.dumps(cli_call("focus_win")))
    else:
        raise SystemExit("unknown cmd: " + cmd)


if __name__ == "__main__":
    main()
