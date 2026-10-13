"""Native messaging host: Edge <-> our router (serve.py).

Edge spawns this per chrome.runtime.connectNative('ext_bridge').
stdin/stdout carry length-prefixed JSON frames (Chrome's native messaging
wire format); we bridge them to the router over TCP 127.0.0.1:8765.

Must be full duplex: the router pushes commands down to the browser at any
time, so we cannot simply block on stdin. One thread pumps stdin -> socket,
the main thread pumps socket -> stdout.
"""
import json
import os
import socket
import struct
import sys
import threading

HOST, PORT = "127.0.0.1", 8765
MAX_FRAME = 8 * 1024 * 1024


def read_frame():
    """Read one length-prefixed frame from Chrome. None = EOF."""
    hdr = sys.stdin.buffer.read(4)
    if len(hdr) < 4:
        return None
    n = struct.unpack("<I", hdr)[0]
    if n > MAX_FRAME:
        return None
    body = b""
    while len(body) < n:
        chunk = sys.stdin.buffer.read(n - len(body))
        if not chunk:
            return None
        body += chunk
    return body


def write_frame(obj):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def recv_exact(sock, n):
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def send_line(sock, data):
    """Router protocol is length-prefixed, same as Chrome's native frames."""
    sock.sendall(struct.pack("<I", len(data)) + data)


def pump_stdin(sock, stop):
    """Chrome -> router."""
    try:
        while not stop.is_set():
            raw = read_frame()
            if raw is None:
                break
            try:
                msg = json.loads(raw.decode("utf-8"))
            except Exception:
                continue
            send_line(sock, json.dumps(msg, ensure_ascii=False).encode("utf-8"))
    except Exception:
        pass
    finally:
        stop.set()
        try:
            sock.shutdown(socket.SHUT_WR)
        except Exception:
            pass


def load_token():
    tok = os.environ.get("EXT_BRIDGE_TOKEN", "").strip()
    if tok:
        return tok
    try:
        with open(os.path.join(os.path.expanduser("~"), ".ext_bridge_token"),
                  encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def main():
    token = load_token()
    if not token:
        sys.stderr.write("no bridge token (~/.ext_bridge_token / EXT_BRIDGE_TOKEN)\n")
        sys.stderr.flush()
        return 2
    port = int(os.environ.get("EXT_BRIDGE_NATIVE_PORT", PORT))
    try:
        sock = socket.create_connection((HOST, port), timeout=5)
    except Exception as e:
        sys.stderr.write("router unreachable on %s:%d (%s)\n" % (HOST, port, e))
        sys.stderr.flush()
        return 2
    # Handshake: the router gates the browser behind this token.
    send_line(sock, json.dumps({"__hello__": {"token": token}}).encode("utf-8"))
    sock.settimeout(None)
    stop = threading.Event()

    t = threading.Thread(target=pump_stdin, args=(sock, stop), daemon=True)
    t.start()

    try:
        while not stop.is_set():
            try:
                hdr = recv_exact(sock, 4)
            except Exception:
                break
            if hdr is None:
                break
            n = struct.unpack("<I", hdr)[0]
            if n > MAX_FRAME:
                break
            body = recv_exact(sock, n)
            if body is None:
                break
            try:
                reply = json.loads(body.decode("utf-8"))
            except Exception:
                continue
            write_frame(reply)
    finally:
        stop.set()
        try:
            sock.close()
        except Exception:
            pass

    # os._exit: the stdin pump is a daemon thread and would otherwise deadlock
    # against the interpreter shutdown while holding the stdin buffer lock.
    try:
        sys.stdout.buffer.flush()
    except Exception:
        pass
    os._exit(0)


if __name__ == "__main__":
    main()
