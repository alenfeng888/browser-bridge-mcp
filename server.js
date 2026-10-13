#!/usr/bin/env node
/**
 * OpenCode Browser Bridge - MCP Server + WebSocket Relay
 *
 * Architecture:
 *   opencode <--stdio(JSON-RPC)--> this server <--WebSocket--> extension(Edge)
 *
 * Zero external dependencies. Handles MCP protocol over stdio and
 * a minimal WebSocket server for the browser extension.
 */

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');

// ── Access token ──────────────────────────────────────────────────────
//
// Without this anything on the machine (npm postinstall scripts, other
// extensions, any local process) could POST /tool and drive the browser:
// screenshot, read cookies, run arbitrary JS in a logged-in session.
// The token lives in the user's home dir, 0600, and both the resident
// server and the CLI read the same file.

const TOKEN_FILE = path.join(os.homedir(), '.ext_bridge_token');

function loadToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (t) return t;
  } catch {}
  const t = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(TOKEN_FILE, t, { mode: 0o600 });
  } catch (e) {
    console.error('[bridge] could not persist token:', e.message);
  }
  return t;
}

const BRIDGE_TOKEN = process.env.EXT_BRIDGE_TOKEN || loadToken();

// ── Extension origin allowlist ────────────────────────────────────────
//
// /extension/next and /extension/result cannot carry the token (a browser
// extension cannot read ~/.ext_bridge_token), so they are gated on the
// Origin header a chrome-extension:// fetch sends. Requests with no Origin
// at all are still allowed and logged, because not every browser version
// sends one - but a wrong Origin is rejected outright.

// Overridable via env so you can run an isolated second instance on another
// port/token for testing (see tests/). Defaults match the original install.
const EXPECTED_ORIGIN = process.env.EXT_BRIDGE_ORIGIN || '';
const seenOrigins = new Set();

// Second factor: a shared secret baked into the extension source. It is only
// a speed bump (anything local can read both files) but it stops drive-by
// callers that know the port and nothing else.
//
// It arms itself: until a request carrying the right secret has been seen,
// unauthenticated /extension/* calls are still honoured, so a not-yet-reloaded
// extension keeps working. The moment the reloaded extension checks in, the
// endpoint locks down for good.

const EXT_TOKEN_FILE = path.join(os.homedir(), '.ext_bridge_ext_token');
let EXT_TOKEN = process.env.EXT_BRIDGE_EXT_TOKEN || '';
if (!EXT_TOKEN) {
  try {
    EXT_TOKEN = fs.readFileSync(EXT_TOKEN_FILE, 'utf8').trim();
  } catch {
    console.error('[bridge] no ' + EXT_TOKEN_FILE + ' - /extension/* stays open');
  }
}
let extTokenSeen = false;

function extensionOriginOk(req) {
  const origin = req.headers['origin'];
  if (origin && !seenOrigins.has(origin)) {
    seenOrigins.add(origin);
    console.error(`[bridge] /extension/* origin seen: ${origin}`);
  }

  // Secret header wins; it is what the current extension sends.
  if (EXT_TOKEN && req.headers['x-bridge-ext'] === EXT_TOKEN) {
    if (!extTokenSeen) {
      extTokenSeen = true;
      console.error('[bridge] extension authenticated - /extension/* is now locked down');
    }
    return true;
  }

  // Not yet armed: let legacy (pre-reload) callers through, but say so.
  if (!extTokenSeen) return true;

  // Armed and this caller has no secret. Still allow the expected extension
  // origin in case a browser strips custom headers on these fetches.
  if (origin === EXPECTED_ORIGIN) {
    console.error('[bridge] /extension/* without secret but from our own origin - allowed');
    return true;
  }
  console.error(`[bridge] rejected /extension/* call (origin=${origin || 'none'})`);
  return false;
}

// ── Config ────────────────────────────────────────────────────────────

const WS_PORT = Number(process.env.EXT_BRIDGE_PORT || 18795);
const WS_HOST = '127.0.0.1';
// serve.py's CLI port. Primary route: MCP -> serve.py -> native host -> extension.
const CLI_PORT = Number(process.env.EXT_BRIDGE_CLI_PORT || 8766);
const CLI_HOST = '127.0.0.1';

// ── Minimal WebSocket Server ──────────────────────────────────────────

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAccept(key) {
  return crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
}

// Encode a text frame (server → client, no mask)
function encodeFrame(data) {
  const payload = Buffer.from(data, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

// Encode a close frame
function encodeClose() {
  return Buffer.from([0x88, 0x00]);
}

// Encode a pong frame
function encodePong(payload) {
  if (!payload || payload.length === 0) return Buffer.from([0x8A, 0x00]);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x8A, len]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x8A;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  }
  return Buffer.concat([header, payload]);
}

// Frame parser for client → server (masked frames)
class FrameParser {
  constructor(onMessage, onPing, onClose) {
    this.buffer = Buffer.alloc(0);
    this.onMessage = onMessage;
    this.onPing = onPing;
    this.onClose = onClose;
    this._fragChunks = null;
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this._parse();
  }

  _parse() {
    while (true) {
      const buf = this.buffer;
      if (buf.length < 2) return;

      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + len) return;

      let payload = buf.slice(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const mask = buf.slice(offset, offset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= mask[i % 4];
        }
      }

      this.buffer = buf.slice(offset + maskLen + len);

      if (opcode === 0x1 && fin) {
        // Text frame
        this.onMessage(payload.toString('utf8'));
      } else if (opcode === 0x1 && !fin) {
        // Start of a fragmented text message — buffer continuations
        this._fragChunks = [payload];
      } else if (opcode === 0x0) {
        // Continuation frame
        if (this._fragChunks) {
          this._fragChunks.push(payload);
          if (fin) {
            const full = Buffer.concat(this._fragChunks).toString('utf8');
            this._fragChunks = null;
            this.onMessage(full);
          }
        }
      } else if (opcode === 0x9) {
        // Ping
        this.onPing?.(payload);
      } else if (opcode === 0x8) {
        // Close
        this.onClose?.();
        return;
      }
      // Ignore other opcodes (binary, continuation, pong)
    }
  }
}

// ── Bridge (WebSocket ↔ command dispatch) ─────────────────────────────

class Bridge extends EventEmitter {
  constructor() {
    super();
    this.extensionSocket = null;
    this.msgId = 0;
    this.pending = new Map();
  }

  start() {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${WS_HOST}:${WS_PORT}`);
      try {
        await handleHttp(req, res, url);
      } catch (err) {
        console.error('[bridge] http error:', err.message);
        try {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        } catch {}
      }
    });

    server.on('upgrade', (req, socket) => {
      const key = req.headers['sec-websocket-key'];
      if (!key) {
        socket.destroy();
        return;
      }
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n` +
        '\r\n'
      );
      socket.setNoDelay(true);

      const parser = new FrameParser(
        (text) => this._onExtensionMessage(text),
        (payload) => socket.write(encodePong(payload)),
        () => {
          this.extensionSocket = null;
          this.emit('disconnect');
          socket.destroy();
        }
      );

      socket.on('data', (chunk) => parser.push(chunk));
      socket.on('error', () => {});
      socket.on('close', () => {
        this.extensionSocket = null;
        this.emit('disconnect');
      });

      // Only one extension socket at a time: offscreen reconnects in bursts
      // and stale sockets otherwise linger as half-dead writers.
      if (this.extensionSocket && this.extensionSocket !== socket) {
        try {
          this.extensionSocket.destroy();
        } catch {}
        console.error('[bridge] dropped stale extension socket');
      }

      this.extensionSocket = socket;
      this.lastPong = Date.now();
      this.emit('connect');
      // Log who is attaching: an unexpected chrome-extension:// origin here
      // means a stale copy of the extension is still installed somewhere.
      console.error(`[bridge] Extension connected origin=${req.headers.origin || 'none'} ua=${(req.headers['user-agent'] || '').slice(0, 60)}`);
    });

    server.on('error', (err) => {
      // Most common: a second opencode session already owns 18795.
      console.error(`[bridge] WS server error: ${err.code || err.message}`);
      if (err.code === 'EADDRINUSE') {
        console.error('[bridge] another instance already serves this port - exiting');
        process.exit(0);
      }
    });

    server.listen(WS_PORT, WS_HOST, () => {
      console.error(`[bridge] WebSocket server listening on ${WS_HOST}:${WS_PORT}`);
    });
  }

  _onExtensionMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg && msg.type === 'pong') {
      this.lastPong = Date.now();
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.ok) {
        resolve(msg.result);
      } else {
        reject(new Error(msg.error || 'Extension error'));
      }
    }
  }

  // Send command to extension, await response
  async call(method, params = {}) {
    if (!this.extensionSocket) {
      throw new Error('Extension not connected. Load the extension in Edge first.');
    }
    const id = ++this.msgId;
    const data = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      // Short timeout on purpose: a half-dead socket (offscreen reconnects in
      // bursts and can leave one behind) would otherwise burn 30s before we
      // fall through to the next route.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for extension response: ${method}`));
      }, 8000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.extensionSocket.write(encodeFrame(data));
    });
  }

  isConnected() {
    return this.extensionSocket !== null;
  }

  // Ping the extension and tear the socket down if it stops answering, so a
  // half-dead connection never masquerades as a healthy one.
  startHeartbeat() {
    if (this._hb) return;
    this._hb = setInterval(() => {
      if (!this.extensionSocket) return;
      const idle = Date.now() - (this.lastPong || 0);
      if (idle > 30000) {
        console.error(`[bridge] extension silent ${Math.round(idle / 1000)}s - dropping socket`);
        try {
          this.extensionSocket.destroy();
        } catch {}
        this.extensionSocket = null;
        this.emit('disconnect');
        return;
      }
      try {
        this.extensionSocket.write(encodeFrame(JSON.stringify({ type: 'ping' })));
      } catch {}
    }, 15000);
    if (this._hb.unref) this._hb.unref();
  }
}

// ── MCP Server (stdio JSON-RPC) ──────────────────────────────────────

const bridge = new Bridge();

const TOOLS = [
  {
    name: 'browser_list_tabs',
    description: 'List all open browser tabs across all windows.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate a tab to a URL.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID' },
        url: { type: 'string', description: 'URL to navigate to' },
      },
      required: ['tabId', 'url'],
    },
  },
  {
    name: 'browser_new_tab',
    description: 'Open a new tab with a URL.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_snapshot',
    description: 'Get a structured outline of visible interactive elements on the page (buttons, links, inputs, etc.) with refs for clicking/typing.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'browser_click',
    description: 'Click an element by CSS selector or ref from snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID' },
        selector: { type: 'string', description: 'CSS selector or ref (e.g. "e3" from snapshot)' },
      },
      required: ['tabId', 'selector'],
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into an input element.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID' },
        selector: { type: 'string', description: 'CSS selector for the input' },
        text: { type: 'string', description: 'Text to type' },
        clear: { type: 'boolean', description: 'Clear existing text first (default: true)' },
      },
      required: ['tabId', 'selector', 'text'],
    },
  },
  {
    name: 'browser_activate',
    description: 'Switch focus to a tab (activate it in its window). Required before screenshotting a background tab (browser_screenshot switches back automatically though).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'browser_click_real',
    description: 'Click with a REAL mouse event via CDP (isTrusted=true). Use when synthetic browser_click is silently ignored - antd5 modals, close buttons, anything listening for pointer sequences. Costs a brief "being debugged" infobar.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID' },
        selector: { type: 'string', description: 'CSS selector or ref (e.g. "e3" from snapshot)' },
      },
      required: ['tabId', 'selector'],
    },
  },
  {
    name: 'browser_type_real',
    description: 'Insert text into the focused element via CDP Input.insertText (works on web terminals like xterm/warp where browser_type cannot reach), optionally submitting with a real Enter. Click the target first so it has focus. Costs a brief infobar.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID' },
        text: { type: 'string', description: 'Text to insert' },
        submit: { type: 'boolean', description: 'Press Enter after inserting (default false)' },
      },
      required: ['tabId', 'text'],
    },
  },
  {
    name: 'browser_press_key',
    description: 'Send a REAL key press via CDP (isTrusted=true): Escape, Enter, Tab, Backspace, ArrowUp/Down/Left/Right. Esc is the standard way to dismiss antd modals that ignore synthetic clicks. Costs a brief "being debugged" infobar.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID' },
        key: { type: 'string', enum: ['Escape', 'Enter', 'Tab', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'], description: 'Key to press' },
      },
      required: ['tabId', 'key'],
    },
  },
  {
    name: 'browser_reload_self',
    description: 'Reload the bridge extension itself (equivalent of clicking reload on edge://extensions). The connection drops right after - treat that as success and retry in a few seconds.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the visible tab. Returns base64 PNG.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID (default: active tab)' },
      },
    },
  },
  {
    name: 'browser_eval',
    description: 'Execute arbitrary JavaScript in the page context and return the result.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID' },
        code: { type: 'string', description: 'JavaScript code to evaluate' },
        world: { type: 'string', enum: ['ISOLATED', 'MAIN'], description: 'JS world (default: ISOLATED)' },
      },
      required: ['tabId', 'code'],
    },
  },
  {
    name: 'browser_get_text',
    description: 'Get the visible text content of a page.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'browser_close_tab',
    description: 'Close a tab (default: the active tab).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID (default: active tab)' },
      },
    },
  },
  {
    name: 'k13_exec',
    // ★指令29号 R3（主审按需穿透的手术刀，非常驻巡检）
    description: 'Run a shell command on the ModelScope DSW instance through the existing kernel exec channel (13_exec.js). The workspace tab is auto-resolved by URL, so no tabId is needed and a browser restart cannot break it.',
    inputSchema: {
      type: 'object',
      properties: {
        cmd: { type: 'string', description: 'Shell command to run on the DSW instance' },
        waitMs: { type: 'number', description: 'How long to wait for output (default 90000)' },
      },
      required: ['cmd'],
    },
  },
  {
    name: 'browser_wait_for',
    description: 'Wait until a condition appears on the page, then return. Polls a CSP-safe ISOLATED-world probe every intervalMs (works on modelscope where MAIN-world eval dies). NEVER throws on timeout - returns {ok:false, timeout:true}. Probe kinds: text (default, visible text contains), selector (CSS selector visible), predicate (custom JS via MAIN-world eval - FAILS on strict-CSP pages like modelscope).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID' },
        text: { type: 'string', description: 'Text to wait for (probe kind: text)' },
        selector: { type: 'string', description: 'CSS selector to wait for (probe kind: selector)' },
        predicate: { type: 'string', description: 'Custom JS expression, truthy = matched (probe kind: predicate; NOT CSP-safe)' },
        timeoutMs: { type: 'number', description: 'Give up after this long (default 30000, max 120000)' },
        intervalMs: { type: 'number', description: 'Poll interval (default 500, min 200)' },
      },
      required: ['tabId'],
    },
  },
  {
    name: 'browser_click_by_uid',
    description: 'Click an element by its STABLE uid from browser_snapshot (survives DOM reflow, unlike eN refs). Resolves via fingerprint (id/name/data-testid/aria-label/text-hash+dom-path) across the WHOLE DOM - can reach terminal containers that the snapshot whitelist misses. Real CDP mouse event. Returns {ok:false,reason} instead of throwing when not found.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID' },
        uid: { type: 'string', description: 'uid from browser_snapshot (e.g. "id=submit" or "tx=1abc2@DIV:2/BUTTON:1")' },
      },
      required: ['tabId', 'uid'],
    },
  },
  {
    name: 'browser_type_by_uid',
    description: 'Type into an element by STABLE uid: first a REAL CDP click to give it focus (cures "typed:N but nothing landed" - no focus without a real click), then CDP Input.insertText, optionally a real Enter. Works on xterm/web terminals AND regular inputs.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID' },
        uid: { type: 'string', description: 'uid from browser_snapshot' },
        text: { type: 'string', description: 'Text to insert' },
        submit: { type: 'boolean', description: 'Press Enter after inserting (default false)' },
      },
      required: ['tabId', 'uid', 'text'],
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page or an element.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Target tab ID' },
        selector: { type: 'string', description: 'Element to scroll (default: page)' },
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction' },
        amount: { type: 'number', description: 'Pixels to scroll (default: 500)' },
      },
      required: ['tabId'],
    },
  },
];

// ── HTTP command queue ────────────────────────────────────────────────
//
// Same idea as atria-browser-bridge: the service worker polls
// /extension/next and posts back to /extension/result. Because commands sit
// in a server-side queue, a command issued while the worker is asleep is not
// lost - it is delivered the moment the worker wakes and polls again.

const pendingQueue = [];
const pendingResults = new Map();
const longPollWaiters = [];
const LONG_POLL_MS = 25000;
let queueSeq = 0;

function json(res, obj, extra) {
  res.writeHead(200, Object.assign({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  }, extra || {}));
  res.end(JSON.stringify(obj));
}

function wakeWaiters() {
  while (longPollWaiters.length && pendingQueue.length) {
    const waiter = longPollWaiters.shift();
    waiter.resolve(pendingQueue.shift());
  }
}

// A service worker restart replays the same clientId; drop that client's
// stale waiter instead of letting parked requests pile up.
function dropStaleWaiter(clientId) {
  for (let i = longPollWaiters.length - 1; i >= 0; i--) {
    if (longPollWaiters[i].clientId === clientId) {
      const [old] = longPollWaiters.splice(i, 1);
      old.resolve(null);
    }
  }
}

function enqueue(method, params, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const id = 'q' + ++queueSeq;
    const timer = setTimeout(() => {
      pendingResults.delete(id);
      reject(new Error(`queue timeout: ${method}`));
    }, timeoutMs);
    pendingResults.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
      timer,
    });
    pendingQueue.push({ id, method, params: params || {} });
    wakeWaiters();
  });
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-bridge-ext, x-bridge-token',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function handleHttp(req, res, url) {
  // Preflight. Extension fetches normally skip CORS entirely (host_permissions
  // covers 127.0.0.1), but the custom x-bridge-ext header makes some builds
  // ask first - answer, or the poll dies silently.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  if (url.pathname === '/health') {
    const stick = stickyRoute();
    json(res, {
      ok: true,
      name: 'opencode-browser-bridge',
      ws: bridge.isConnected(),
      pending: pendingQueue.length,
      waiters: longPollWaiters.length,
      sticky: stick || 'none',
      stickyAgeSec: stick ? Math.round((Date.now() - (lastSuccessAt[stick] || 0)) / 1000) : 0,
      extAuth: extTokenSeen,
    });
    return;
  }

  if (url.pathname === '/extension/next') {
    const clientId = url.searchParams.get('clientId') || 'anon';
    if (!extensionOriginOk(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'forbidden origin' }));
      return;
    }
    if (pendingQueue.length) {
      json(res, pendingQueue.shift(), CORS);
      return;
    }
    dropStaleWaiter(clientId);
    // long poll: hold the request until a command arrives
    const waiter = new Promise((resolve) => {
      let timer;
      const entry = {
        clientId,
        resolve: (cmd) => { clearTimeout(timer); resolve(cmd); },
      };
      timer = setTimeout(() => {
        const i = longPollWaiters.indexOf(entry);
        if (i !== -1) longPollWaiters.splice(i, 1);
        resolve(null);
      }, LONG_POLL_MS);
      longPollWaiters.push(entry);
    });
    waiter.then((cmd) => json(res, cmd || { empty: true }, CORS));
    return;
  }

  if (url.pathname === '/tool' && req.method === 'POST') {
    if (req.headers['x-bridge-token'] !== BRIDGE_TOKEN) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized: missing or bad x-bridge-token' }));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try {
        const { name, arguments: args } = JSON.parse(body);
        const result = await callTool(name, args || {});
        json(res, { ok: true, result });
      } catch (err) {
        json(res, { ok: false, error: err.message });
      }
    });
    return;
  }

  if (url.pathname === '/extension/result' && req.method === 'POST') {
    if (!extensionOriginOk(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'forbidden origin' }));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const msg = JSON.parse(body);
        const entry = pendingResults.get(msg.id);
        if (entry) {
          pendingResults.delete(msg.id);
          if (msg.error) entry.reject(new Error(msg.error));
          else entry.resolve(msg.result);
        }
      } catch {}
      json(res, { ok: true }, CORS);
    });
    return;
  }

  res.writeHead(426, { 'Content-Type': 'text/plain' });
  res.end('Upgrade Required');
}

// ── Router access ─────────────────────────────────────────────────────
//
// Primary: serve.py's CLI port (MCP -> serve.py -> native host -> extension).
// Fallback: an extension attached directly to our own WebSocket port, which
// still works when serve.py is not running.

function callCli(cmd, arg, timeoutMs = 35000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(CLI_PORT, CLI_HOST);
    let buf = '';
    let done = false;
    sock.setTimeout(timeoutMs + 5000);
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch {}
      fn(v);
    };
    sock.on('connect', () => {
      sock.write(JSON.stringify({ cmd, arg: arg || {}, timeout: timeoutMs / 1000 }) + '\n');
    });
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (!buf.includes('\n')) return;
      let reply;
      try {
        reply = JSON.parse(buf.trim());
      } catch {
        finish(reject, new Error('cli: bad json'));
        return;
      }
      if (reply.ok) finish(resolve, reply.result);
      else {
        const e = new Error(reply.error || 'cli error');
        e.cliReply = true;
        finish(reject, e);
      }
    });
    sock.on('timeout', () => finish(reject, new Error('cli timeout: ' + cmd)));
    sock.on('error', (e) => {
      const err = new Error(`cli unavailable (${e.code || e.message}) - is serve.py running?`);
      err.cliDown = true;
      finish(reject, err);
    });
    sock.on('close', () => {
      if (!done) { done = true; reject(new Error('cli closed: ' + cmd)); }
    });
  });
}

// Three routes. Queue first: it is served by the service worker polling over
// HTTP, which has proven steadier than the offscreen document's socket (that
// one reconnects in bursts and sometimes leaves a half-dead socket behind).
//   1. queue - HTTP long-poll, commands survive the worker sleeping
//   2. ws    - offscreen socket, lowest latency when it is healthy
//   3. cli   - serve.py over native messaging
let preferredRoute = 'queue';
// 会诊回1 Q6 P0-b（指令27授权）：sticky 的过期判据必须是"该路由**最近一次成功**的
// 时间"，而不是"被钉住的时间"。旧实现每次成功都刷新 preferredRouteAt，等于
// 路只要每 5 分钟成功过一次就永不过期——死路被永久优先。
const lastSuccessAt = { queue: 0, ws: 0, cli: 0 };

// A sticky route that never expires is worse than no sticky at all: once the
// worker sleeps or the socket dies we would keep paying the failed route's
// timeout on every single call, forever. Bound the preference by per-route
// last-success age.
const ROUTE_TTL_MS = 5 * 60 * 1000;

function stickyRoute() {
  if (!preferredRoute) return null;
  const last = lastSuccessAt[preferredRoute] || 0;
  if (!last || Date.now() - last > ROUTE_TTL_MS) return null;
  return preferredRoute;
}

async function call(method, params, cliCmd, cliArg) {
  const stick = stickyRoute();
  const baseOrder = stick === 'ws'
    ? ['ws', 'queue', 'cli']
    : stick === 'cli'
      ? ['cli', 'queue', 'ws']
      : ['queue', 'ws', 'cli'];

  // ws 死路清理（会诊回1 Q6 P0-b，指令27授权）：offscreen 已移除后 ws 只是
  // 常驻 extension socket。socket 不在就别让它占 order 位——白耗 8s 超时才
  // fall through。在就从 order 剔除，pin 的 ws 也一并降级回 queue。
  let order = baseOrder;
  if (order.includes('ws') && !bridge.isConnected()) {
    order = order.filter((r) => r !== 'ws');
    if (stick === 'ws') {
      console.error('[bridge] sticky ws is a dead path - demoting to queue');
      preferredRoute = 'queue';
    }
  }

  let lastErr;
  for (const route of order) {
    try {
      console.error(`[bridge] route=${route} ${method}${route === stick ? ' (sticky)' : ''}`);
      let r;
      if (route === 'ws') {
        if (!bridge.isConnected()) throw new Error('no ws client');
        r = await bridge.call(method, params);
        if (r && r.__error) throw new Error(r.__error);
      } else if (route === 'queue') {
        r = await enqueue(method, params, 8000);
      } else {
        r = await callCli(cliCmd, cliArg);
      }
      preferredRoute = route;
      lastSuccessAt[route] = Date.now();
      return r;
    } catch (err) {
      lastErr = err;
      console.error(`[bridge] ${route} failed: ${err.message}`);
      // The route we had pinned just failed — unpin it now instead of making
      // every later call burn the same timeout again.
      if (route === preferredRoute) {
        preferredRoute = 'queue';
        lastSuccessAt[route] = 0;
      }
    }
  }
  throw lastErr || new Error('all routes failed: ' + method);
}

// Both transports hand back slightly different envelopes; normalise.
function unwrap(r) {
  if (r && typeof r === 'object' && !Array.isArray(r) && 'value' in r) return r.value;
  return r;
}

// Resolve an omitted tabId to whatever the user is looking at right now.
async function resolveTabId(explicit) {
  if (explicit !== undefined && explicit !== null) return explicit;
  const tabs = await call('list_tabs', {}, 'list_tabs', {});
  const t = tabs.find((x) => x.active) || tabs[0];
  if (!t) throw new Error('no tabs open');
  return t.id;
}

// ── Tool Implementation ───────────────────────────────────────────────

// Input events only take effect on the VISIBLE tab (回执 v2 P1: background
// tabs return ok:true but the UI ignores synthetic and even CDP-real clicks
// and keys - the renderer throttles them). Wrap every input operation:
// switch to the target -> act -> switch back to what the user was reading.
async function withForeground(tabId, fn) {
  const tabs = await call('list_tabs', {}, 'list_tabs', {});
  const target = tabs.find((t) => t.id === tabId);
  if (!target) throw new Error(`tab not found: ${tabId}`);
  const prevActive = tabs.find((t) => t.active && t.windowId === target.windowId);
  const needSwitch = !target.active && prevActive && prevActive.id !== target.id;
  if (needSwitch) {
    await call('activate', { tabId }, 'activate', { tabId });
    // let the renderer actually come to the front before firing input
    await new Promise((r) => setTimeout(r, 350));
  }
  try {
    const result = await fn();
    return { result, switched: needSwitch };
  } finally {
    if (needSwitch) {
      try {
        await call('activate', { tabId: prevActive.id }, 'activate', { tabId: prevActive.id });
        await new Promise((r) => setTimeout(r, 300));
      } catch {}
    }
  }
}

async function callTool(name, args) {
  switch (name) {
    case 'browser_list_tabs': {
      const tabs = await call('list_tabs', {}, 'list_tabs', {});
      return tabs.map((t) => ({
        id: t.id,
        title: t.title,
        url: t.url,
        active: t.active,
        windowId: t.windowId,
      }));
    }

    case 'browser_navigate': {
      await call('navigate', { tabId: args.tabId, url: args.url },
        'navigate', { tabId: args.tabId, url: args.url });
      return { ok: true, url: args.url };
    }

    case 'browser_new_tab': {
      const r = await call('new_tab', { url: args.url }, 'open', { url: args.url });
      const tab = Array.isArray(r) ? r[0] : r;
      return { id: tab.id, title: tab.title, url: tab.url };
    }

    case 'browser_snapshot': {
      // Runs via the extension's snapshotInTab (func injection, ISOLATED) -
      // immune to page CSP, unlike the old string-eval route.
      const items = unwrap(await call('snapshot', { tabId: args.tabId },
        'snapshot', { tabId: args.tabId }));
      if (items && items.__error) throw new Error(items.__error);
      return items;
    }

    case 'browser_click': {
      const { result } = await withForeground(args.tabId, async () =>
        unwrap(await call('click', { tabId: args.tabId, selector: args.selector },
          'click', { tabId: args.tabId, selector: args.selector })));
      if (result && result.__error) throw new Error(result.__error);
      return result;
    }

    case 'browser_type': {
      const result = await call('type', { tabId: args.tabId, selector: args.selector, text: args.text, clear: args.clear },
        'type', { tabId: args.tabId, selector: args.selector, text: args.text, clear: args.clear });
      if (result && result.__error) throw new Error(result.__error);
      return result;
    }

    case 'browser_activate': {
      await call('activate', { tabId: args.tabId }, 'activate', { tabId: args.tabId });
      return { ok: true, tabId: args.tabId };
    }

    case 'browser_click_real': {
      const { result } = await withForeground(args.tabId, async () =>
        await call('click_real', { tabId: args.tabId, selector: args.selector },
          'click_real', { tabId: args.tabId, selector: args.selector }));
      if (result && result.__error) throw new Error(result.__error);
      return result;
    }

    case 'browser_press_key': {
      const { result } = await withForeground(args.tabId, async () =>
        await call('key', { tabId: args.tabId, key: args.key },
          'key', { tabId: args.tabId, key: args.key }));
      if (result && result.__error) throw new Error(result.__error);
      return result;
    }

    case 'browser_type_real': {
      const { result } = await withForeground(args.tabId, async () =>
        await call('type_real', { tabId: args.tabId, text: args.text, submit: args.submit },
          'type_real', { tabId: args.tabId, text: args.text, submit: args.submit }));
      if (result && result.__error) throw new Error(result.__error);
      return result;
    }

    case 'browser_reload_self': {
      // The extension kills itself ~200ms after replying; the queue/NM
      // connection drops as a side effect. That drop is SUCCESS here.
      const r = await call('reload_self', {}, 'reload_self', {});
      return { ok: true, ...(r || {}) };
    }

    case 'browser_screenshot': {
      // captureVisibleTab can ONLY capture the currently visible tab of a
      // window (two different tabIds used to yield an identical SHA256).
      // withForeground switches to the target, we shoot, it switches back.
      const { result: r, switched } = await withForeground(args.tabId, async () =>
        await call('screenshot', { tabId: args.tabId }, 'shot', { tabId: args.tabId }));
      if (r && r.dataUrl) return { dataUrl: r.dataUrl, tabId: args.tabId, switched, restored: true };
      if (r && r.data) return { dataUrl: `data:image/png;base64,${r.data}`, tabId: args.tabId, switched, restored: true };
      throw new Error('screenshot returned no image data');
    }

    case 'browser_eval': {
      const result = unwrap(await call('eval', { tabId: args.tabId, code: args.code, world: args.world },
        'eval', { tabId: args.tabId, expr: args.code, world: args.world }));
      if (result && result.__error) throw new Error(result.__error);
      return result;
    }

    case 'browser_get_text': {
      // Extension-side textInTab (func injection): CSP-safe on strict pages.
      const r = await call('text', { tabId: args.tabId }, 'text', { tabId: args.tabId });
      if (r == null) return { text: '' };
      if (typeof r === 'string') return { text: r };
      if (typeof r === 'object' && 'text' in r) return { text: r.text };
      if (typeof r === 'object' && 'value' in r) return { text: r.value };
      return { text: r };
    }

    case 'browser_close_tab': {
      const tabId = await resolveTabId(args.tabId);
      await call('close', { tabId }, 'close', { tabId });
      return { ok: true, tabId };
    }

    // ★指令29号 R3（主审按需穿透的手 = 手术刀，不是巡逻队）：tabId 自找 workspace 页
    // （同 A5 修法：按 URL 认领，浏览器重启改 id 也不废），走既有 13_exec.js 流程，
    // 复用现成协议，不新造。
    case 'k13_exec': {
      const cmd = String(args.cmd || '');
      if (!cmd) throw new Error('k13_exec: cmd 不能为空');
      const waitMs = Number(args.waitMs || 90000);
      const tabs = await call('list_tabs', {}, 'list_tabs', {});
      const ws = tabs.find((t) => /modelscope\.cn\/code\/workspace/.test(t.url || ''))
        || tabs.find((t) => t.id === Number(args.tabId || 0))
        || tabs.find((x) => x.active) || tabs[0];
      if (!ws) throw new Error('k13_exec: 找不到可用页签');
      const r = await new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(__dirname, '13_exec.js'), cmd, String(waitMs)], {
          cwd: __dirname, windowsHide: true,
          env: Object.assign({}, process.env, { MOTA_IDE_TAB: String(ws.id) }),
        });
        let out = ''; let err = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        const t = setTimeout(() => { try { child.kill(); } catch {} }, waitMs + 45000);
        child.on('close', (code) => { clearTimeout(t); resolve({ code, out: out.trim(), err: err.trim() }); });
        child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: '', err: e.message }); });
      });
      return { ok: r.code === 0, exitCode: r.code, tabId: ws.id, stdout: r.out, stderr: r.err };
    }

    case 'browser_scroll': {
      const dir = args.direction || 'down';
      const amount = args.amount || 500;
      const dx = dir === 'left' ? -amount : dir === 'right' ? amount : 0;
      const dy = dir === 'up' ? -amount : dir === 'down' ? amount : 0;
      const result = unwrap(await call('scroll', { tabId: args.tabId, selector: args.selector, dx, dy },
        'scroll', { tabId: args.tabId, selector: args.selector, dx, dy }));
      if (result && result.__error) throw new Error(result.__error);
      return result;
    }

    // ── P0-1 wait_for（2026-10-11 需求包§二）：轮询循环在 server 侧，
    // 每次注入一个 ISOLATED 轻探针 → SW 每次注入都刷新存活、事件循环空闲
    // 可响应别的命令（验收线③）。超时只回 ok:false，绝不 throw（验收线②）。
    case 'browser_wait_for': {
      const tabId = Number(args.tabId);
      if (!tabId) throw new Error('wait_for: tabId required');
      const kinds = [
        ['text', args.text], ['selector', args.selector], ['predicate', args.predicate],
      ].filter(([, v]) => v != null && v !== '');
      if (kinds.length !== 1) throw new Error('wait_for: give exactly ONE of text / selector / predicate');
      const [kind, value] = kinds[0];
      const timeoutMs = Math.min(Math.max(Number(args.timeoutMs || 30000), 1), 120000);
      const intervalMs = Math.max(Number(args.intervalMs || 500), 200);
      const t0 = Date.now();
      if (kind === 'predicate') {
        // 语义（B4 修正，2026-10-11 opencode 回归）：与 text/selector 对齐进轮询——
        //   eval 返回真 → matched；返回假 → 继续等到 timeoutMs 回 {timeout:true}；
        //   eval 抛错（CSP 页）或卡死 → 立即回 {error}，不吞成超时。
        // 所有 return 统一带 timeout 标志（P1-接口一致性）。
        for (;;) {
          let r = null;
          try {
            r = await Promise.race([
              (async () => unwrap(await call('eval', { tabId, code: value, world: 'MAIN' },
                'eval', { tabId, expr: value, world: 'MAIN' })))(),
              new Promise((_, rej) => setTimeout(() => rej(new Error('single eval did not finish within ' + Math.max(intervalMs * 3, 10000) + 'ms (page busy / SW asleep?)')), Math.max(intervalMs * 3, 10000))),
            ]);
          } catch (e) {
            return { ok: false, matched: false, timeout: false,
              error: 'predicate eval failed (strict-CSP page / busy page?): ' + e.message,
              waitedMs: Date.now() - t0 };
          }
          const elapsed = Date.now() - t0;
          if (r) return { ok: true, matched: true, timeout: false, waitedMs: elapsed };
          if (elapsed >= timeoutMs) return { ok: false, matched: false, timeout: true, waitedMs: elapsed };
          await new Promise((s) => setTimeout(s, intervalMs));
        }
      }
      for (;;) {
        let probe = null;
        try {
          probe = await call('probe', { tabId, kind, value }, 'probe', { tabId, kind, value });
        } catch (e) {
          probe = { err: e.message }; // 页面导航/注入失败 → 当作未命中继续等
        }
        if (probe && probe.matched) {
          return { ok: true, matched: true, timeout: false, waitedMs: Date.now() - t0 };
        }
        const elapsed = Date.now() - t0;
        if (elapsed >= timeoutMs) {
          return { ok: false, matched: false, timeout: true, waitedMs: elapsed,
            lastProbeError: probe && probe.err };
        }
        await new Promise((s) => setTimeout(s, intervalMs));
      }
    }

    // ── P0-2 uid 定位（2026-10-11 需求包§二）：快照 uid → 指纹反查 → CDP 真点击。
    // resolveUidInTab 找不到时回 {ok:false,...}，不 throw（桥不挂，调用方自行决定重试/降级坐标）。
    case 'browser_click_by_uid': {
      try {
        const { result } = await withForeground(args.tabId, async () =>
          await call('click_by_uid', { tabId: args.tabId, uid: args.uid },
            'click_by_uid', { tabId: args.tabId, uid: args.uid }));
        if (result && result.__error) return { ok: false, reason: result.__error, uid: args.uid };
        return result;
      } catch (e) {
        // resolveUidInTab 的 throw（扩展报错: uid not found / not visible）→ 转 {ok:false}，桥不挂
        return { ok: false, reason: e.message.replace(/^扩展报错:\s*/, ''), uid: args.uid };
      }
    }

    case 'browser_type_by_uid': {
      try {
        const { result } = await withForeground(args.tabId, async () =>
          await call('type_by_uid', { tabId: args.tabId, uid: args.uid, text: args.text, submit: args.submit },
            'type_by_uid', { tabId: args.tabId, uid: args.uid, text: args.text, submit: args.submit }));
        if (result && result.__error) return { ok: false, reason: result.__error, uid: args.uid, typed: 0 };
        return result;
      } catch (e) {
        return { ok: false, reason: e.message.replace(/^扩展报错:\s*/, ''), uid: args.uid, typed: 0 };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP Protocol Handler ──────────────────────────────────────────────

function handleMCPMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'opencode-browser-bridge', version: VERSION },
        },
      };

    case 'notifications/initialized':
    case 'initialized':
      return null; // notification, no response

    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: TOOLS },
      };

    case 'tools/call': {
      const { name, arguments: args } = params;
      return callTool(name, args || {})
        .then((result) => ({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          },
        }))
        .catch((err) => ({
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Error: ${err.message}` }],
            isError: true,
          },
        }));
    }

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    default:
      if (id !== undefined) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
      }
      return null;
  }
}

// ── stdio transport (resident mode) ───────────────────────────────────

// Resident mode can also be driven straight over stdio (handy when you run
// `node server.js` under an MCP client by hand). It MUST NOT be attached in
// `mcp` mode: both handlers would answer every request and the client would
// see two replies per id.
function startResidentStdio() {
  let stdinBuffer = '';

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    stdinBuffer += chunk;
    // MCP stdio uses newline-delimited JSON
    let idx;
    while ((idx = stdinBuffer.indexOf('\n')) !== -1) {
      const line = stdinBuffer.slice(0, idx).trim();
      stdinBuffer = stdinBuffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      // handleMCPMessage may return a Promise (for async tools/call)
      Promise.resolve(handleMCPMessage(msg)).then((response) => {
        if (response) {
          process.stdout.write(JSON.stringify(response) + '\n');
        }
      }).catch((err) => {
        console.error('[bridge] Error handling message:', err);
      });
    }
  });

  process.stdin.on('end', () => {
    // stdin closed (e.g. parent process disconnected) — keep running
    // so the WebSocket relay stays alive for the extension.
    console.error('[bridge] stdin closed, continuing...');
  });
}

// ── Client side: talk to the resident instance over /tool ──────────────

// The resident server is not expected to be pre-started: any client (mcp or
// CLI) brings it up on demand. This is why there is no boot-time service the
// user has to click - the first tool call of a session is what starts it.
function residentAlive() {
  return new Promise((resolve) => {
    const req = http.request(
      { host: WS_HOST, port: WS_PORT, path: '/health', method: 'GET', timeout: 2000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function spawnResident() {
  // Detached so it outlives this client; logs land next to the script for
  // post-mortem. EADDRINUSE (another copy already owns the port) exits 0 and
  // is fine - residentAlive() will confirm the port is being served.
  const out = (() => {
    try { return fs.openSync(path.join(__dirname, 'server.log'), 'a'); } catch { return 'ignore'; }
  })();
  try {
    const child = spawn(process.execPath, [__filename], {
      cwd: path.dirname(__filename),
      stdio: ['ignore', out, out],
      windowsHide: true,
      detached: true,
    });
    child.unref();
    return child.pid;
  } catch (e) {
    console.error('[bridge] could not spawn resident server:', e.message);
    return null;
  }
}

async function ensureResident(attempts = 5) {
  if (await residentAlive()) return true;
  for (let i = 0; i < attempts; i++) {
    spawnResident();
    await new Promise((r) => setTimeout(r, 1200));
    if (await residentAlive()) return true;
  }
  return false;
}

function httpJson(method, pathname, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? null : JSON.stringify(payload);
    const req = http.request(
      {
        host: WS_HOST,
        port: WS_PORT,
        path: pathname,
        method,
        headers: body
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
              'x-bridge-token': BRIDGE_TOKEN,
            }
          : { 'x-bridge-token': BRIDGE_TOKEN },
        timeout: 40000,
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf));
          } catch {
            reject(new Error(`bad reply from resident server: ${buf.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('resident server timeout')); });
    req.on('error', (e) => {
      reject(new Error(
        e.code === 'ECONNREFUSED'
          ? `no resident server on ${WS_HOST}:${WS_PORT} - run: node server.js`
          : String(e.message || e)
      ));
    });
    if (body) req.write(body);
    req.end();
  });
}

async function remoteCall(name, args) {
  const reply = await httpJson('POST', '/tool', { name, arguments: args || {} });
  if (!reply.ok) throw new Error(reply.error || 'tool failed');
  return reply.result;
}

async function activeTabId() {
  const tabs = await remoteCall('browser_list_tabs', {});
  const t = tabs.find((x) => x.active) || tabs[0];
  if (!t) throw new Error('no tabs open');
  return t.id;
}

async function runCli(argv) {
  await ensureResident();
  const [cmd, ...rest] = argv;
  const out = (v) => console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));

  switch (cmd) {
    case 'status':
      out(await httpJson('GET', '/health'));
      return 0;

    case 'list': {
      const tabs = await remoteCall('browser_list_tabs', {});
      for (const t of tabs) {
        console.log(`${String(t.id).padStart(8)}  active=${t.active ? 'Y' : 'n'}  ${(t.title || '').slice(0, 28).padEnd(28)} ${t.url || ''}`);
      }
      return 0;
    }

    case 'open': {
      if (!rest[0]) { console.error('usage: node server.js open <url>'); return 1; }
      out(await remoteCall('browser_new_tab', { url: rest[0] }));
      return 0;
    }

    case 'close': {
      const tabId = rest[0] ? Number(rest[0]) : await activeTabId();
      out(await remoteCall('browser_close_tab', { tabId }));
      return 0;
    }

    case 'navigate': {
      if (!rest[0]) { console.error('usage: node server.js navigate <url>'); return 1; }
      out(await remoteCall('browser_navigate', { tabId: await activeTabId(), url: rest[0] }));
      return 0;
    }

    case 'eval': {
      if (!rest[0]) { console.error('usage: node server.js eval <js>'); return 1; }
      out(await remoteCall('browser_eval', { tabId: await activeTabId(), code: rest[0] }));
      return 0;
    }

    case 'text': {
      const r = await remoteCall('browser_get_text', { tabId: await activeTabId() });
      console.log(r.text || '');
      return 0;
    }

    case 'shot': {
      const file = rest[0] || 'shot.png';
      const r = await remoteCall('browser_screenshot', { tabId: await activeTabId() });
      const b64 = String(r.dataUrl || '').replace(/^data:image\/\w+;base64,/, '');
      if (!b64) { console.error('no image returned'); return 1; }
      require('fs').writeFileSync(file, Buffer.from(b64, 'base64'));
      console.log('saved', file);
      return 0;
    }

    default:
      console.error(`unknown cmd: ${cmd}`);
      console.error('usage: node server.js list | open <url> | navigate <url> | eval <js> | text | shot <file> | status');
      return 1;
  }
}

// MCP stdio bridge: a thin client so several AI sessions can share one
// resident server without fighting over port 18795.
async function handleBridgeMessage(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'opencode-browser-bridge', version: VERSION },
        },
      };
    case 'notifications/initialized':
    case 'initialized':
      return null;
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/call': {
      const { name, arguments: args } = params;
      try {
        const result = await remoteCall(name, args || {});
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] },
        };
      } catch (err) {
        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true },
        };
      }
    }
    default:
      if (id !== undefined) {
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
      }
      return null;
  }
}

function startStdioBridge() {
  // Fire-and-forget: the first tool call is what needs the resident server,
  // and it arrives seconds later - enough time for the spawn to come up.
  ensureResident().catch((e) => console.error('[bridge] ensureResident:', e.message));
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      Promise.resolve(handleBridgeMessage(msg))
        .then((r) => { if (r) process.stdout.write(JSON.stringify(r) + '\n'); })
        .catch((e) => console.error('[bridge] mcp error:', e.message));
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

// ── Start ─────────────────────────────────────────────────────────────
//
//   node server.js                 resident server (autostart target)
//   node server.js mcp             MCP stdio bridge -> resident server
//   node server.js list|open|...   CLI -> resident server

const VERSION = '0.3.7';

const MODE = process.argv[2];

if (MODE === 'mcp') {
  startStdioBridge();
} else if (MODE && MODE !== 'serve') {
  runCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error('error:', err.message);
      process.exit(1);
    });
} else {
  bridge.start();
  bridge.startHeartbeat();
  startResidentStdio();
  console.error('[bridge] resident server ready on ' + WS_HOST + ':' + WS_PORT);
  // 指令18 A5：魔搭 8h 结构守护（常驻侧，页面关了也活；server.js.bak_pre18 是改动前备份）
  try {
    const guard = require('./a5_guard.js');
    guard.start().catch((e) => console.error('[a5] guard crashed:', e && e.message));
    console.error('[bridge] a5_guard started');
  } catch (e) {
    console.error('[bridge] a5_guard load failed:', e && e.message);
  }
}
