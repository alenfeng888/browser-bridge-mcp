"""End-to-end self test of the native-messaging half, with a fake extension.

Stands in for the browser: speaks Chrome's length-prefixed frames on the
host's stdin/stdout, answers commands from serve.py, and then drives the real
CLI (`serve.py list`) to prove the whole round trip works.

    serve.py CLI -> 8766 -> serve.py -> 8765 -> host.py -> [this fake ext]

Usage:  python selftest_e2e.py        (serve.py must already be running)
"""
import json
import os
import socket
import struct
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable

FAKE_TABS = [
    {"id": 101, "title": "SIM tab one", "url": "https://example.com/1",
     "active": True, "windowId": 1},
    {"id": 102, "title": "SIM tab two", "url": "https://example.com/2",
     "active": False, "windowId": 1},
]


def read_exact(f, n):
    buf = b""
    while len(buf) < n:
        chunk = f.read(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def read_frame(f):
    hdr = read_exact(f, 4)
    if hdr is None:
        return None
    n = struct.unpack("<I", hdr)[0]
    body = read_exact(f, n)
    if body is None:
        return None
    return body


def write_frame(f, obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    f.write(struct.pack("<I", len(data)) + data)
    f.flush()


def main():
    host = subprocess.Popen(
        "native-host.bat", shell=True, cwd=HERE,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    time.sleep(2.0)
    print("[fake ext] host launched, poll =", host.poll(), flush=True)
    if host.poll() is not None:
        print("HOST DIED at startup; stderr:")
        print(host.stderr.read(2000).decode("utf-8", "replace"), flush=True)
        return 1

    answered = []

    def fake_ext_loop():
        """Answer commands arriving from the router, like the extension would."""
        while True:
            try:
                body = read_frame(host.stdout)
            except Exception:
                return
            if body is None:
                return
            try:
                msg = json.loads(body.decode("utf-8"))
            except Exception:
                return
            cmd = msg.get("cmd")
            answered.append(cmd)
            print(f"[fake ext] <- {cmd} {json.dumps(msg.get('arg', {}), ensure_ascii=False)}",
                  flush=True)
            try:
                if cmd == "list_tabs":
                    write_frame(host.stdin, {"id": msg["id"], "result": FAKE_TABS})
                else:
                    write_frame(host.stdin, {"id": msg["id"], "error": f"unsupported: {cmd}"})
            except Exception:
                return

    threading.Thread(target=fake_ext_loop, daemon=True).start()
    time.sleep(0.3)

    # Drive the router exactly like `serve.py list` does, over the CLI port.
    reply = None
    try:
        s = socket.create_connection(("127.0.0.1", 8766), timeout=25)
        s.sendall((json.dumps({"cmd": "list_tabs", "arg": {}, "timeout": 20}) + "\n").encode("utf-8"))
        buf = b""
        while not buf.endswith(b"\n"):
            chunk = s.recv(1 << 20)
            if not chunk:
                break
            buf += chunk
        s.close()
        reply = json.loads(buf.decode("utf-8"))
    except Exception as e:
        reply = {"ok": False, "error": f"cli: {e}"}

    print("--- router reply ---", flush=True)
    print(json.dumps(reply, ensure_ascii=False)[:1200], flush=True)

    try:
        host.stdin.close()
    except Exception:
        pass
    time.sleep(0.4)
    try:
        host.terminate()
    except Exception:
        pass

    ok = bool(reply.get("ok")) and any(
        t.get("title") == "SIM tab one" for t in (reply.get("result") or [])
    )
    print("=== E2E", "PASS" if ok else "FAIL", "===", flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
