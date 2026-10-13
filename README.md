# Browser Bridge MCP

Let AI agents drive your **real** browser - the same instance, the same cookies,
the same tabs you are using. Works with any stdio MCP client: **OpenCode,
Claude Code, Cursor, ZCode, TRAE**, and anything else that speaks MCP.

## Why

Cloud/hosted browser tools spin up a sandbox browser with no login state.
This bridge puts your day-to-day browser (Edge/Chrome) under AI control, so
the AI can use the sites **you** are already logged into - web IDEs, dashboards,
AI chat consoles, internal tools - without touching any credentials.

## Architecture

Two live transports + one fallback, auto-degrading in order `queue -> ws -> cli`:

```
1. queue  AI/MCP ──stdio──> server.js ──HTTP long-poll──> service worker ──> chrome.*
                            /extension/next  /extension/result
                            (commands queue server-side; nothing lost while the
                             MV3 service worker sleeps)  ← primary, most reliable

2. ws     AI/MCP ──stdio──> server.js ──WS :18795──> any connected extension client
                            (lowest latency; available when a WS client is attached)

3. cli    CLI ──8766──> serve.py ──8765──> native-host.bat ──> host.py ──(NM)──> background.js
                            (fallback via native messaging; independent of server.js)
```

Health check:

```
curl http://127.0.0.1:18795/health
{"ok":true,"ws":true,"pending":0,"waiters":1,"sticky":"queue","stickyAgeSec":3,"extAuth":true}
```

- `waiters` = service workers currently long-polling for commands (normally 1)
- `sticky` = last transport that worked (5 min TTL, avoids preferring a dead path)
- `extAuth` = the paired extension has checked in (false = reload it in edge://extensions)

## One file, four roles

```
node server.js        # resident service (kept alive; watchable via watchdog.js)
node server.js mcp    # MCP stdio bridge -> attach to resident  (MCP clients use this)
node server.js list   # one-shot CLI  -> attach to resident
node server.js status # connection status
```

The resident server starts on demand: the first `mcp` spawn launches it
(detached) if nothing is listening yet, and later sessions reuse it.

## Install

Requirements: Node 18+, Python 3 (only for the CLI fallback + NM host), Edge or Chrome.

### 1. Pair the extension (generates a shared secret)

```
powershell -ExecutionPolicy Bypass -File scripts\pair.ps1
```

This writes the same random token to `~/.ext_bridge_ext_token` (server side)
and `extension/config.js` (extension side, gitignored). Without a token the
`/extension/*` endpoints stay open until the first correctly paired extension
checks in, then lock down permanently.

### 2. Register the native messaging host (CLI fallback path)

```
python register_nmh.py            # writes HKCU keys for Edge + Chrome
python register_nmh.py --status
```

### 3. Load the extension

1. Open `edge://extensions`
2. Enable **Developer mode** (bottom left)
3. **Load unpacked** -> select the `extension/` folder
4. After code changes, click **Reload** on the extension card

### 4. Point your MCP client at it

Example for `~/.config/opencode/opencode.jsonc`:

```json
"browser-bridge": {
  "type": "local",
  "command": ["node", "<path-to>/server.js", "mcp"],
  "enabled": true
}
```

The `mcp` argument is required - without it the process tries to become the
resident server (and fights over port 18795). Restart your client afterwards.

Any stdio MCP client can attach to the same server.js.

## MCP tools

| Tool | What it does |
|---|---|
| `browser_list_tabs` | List all tabs |
| `browser_navigate` | Navigate a tab to a URL |
| `browser_new_tab` | Open a new tab |
| `browser_close_tab` | Close a tab (current tab if no tabId) |
| `browser_snapshot` | Interactive-element list with stable `uid` fingerprints |
| `browser_click` | Click by CSS selector or snapshot ref |
| `browser_type` | Type text into a selector |
| `browser_screenshot` | Screenshot (base64 PNG) |
| `browser_eval` | Run JS in the page (MAIN world by default) |
| `browser_get_text` | Page text |
| `browser_scroll` | Scroll page or element |
| `browser_wait_for` | **Wait** until text / a CSS selector / a JS predicate appears. Polls a CSP-safe ISOLATED-world probe; never throws on timeout (returns `{ok:false,timeout:true}`) |
| `browser_click_by_uid` | Click by stable `uid` (survives DOM reflow; real CDP mouse event) |
| `browser_type_by_uid` | Click-to-focus by `uid`, then insert text (works on xterm terminals too) |

The `uid` fingerprint algorithm: `id=` > `name=` > `data-testid=` > `aria-label=`
> `tx=` (text hash + DOM path). Stateless - the uid itself is the lookup key,
so it survives service-worker restarts and element reflow. `tx=` uids are
sensitive to DOM structure changes; prefer `id=`/`name=` when available.

## CLI (fallback path)

```
python -u serve.py list
python -u serve.py open <url>
python -u serve.py use <tabid-prefix>
python -u serve.py text
python -u serve.py eval <js>
python -u serve.py shot out.png
python -u serve.py navigate <url>
python -u serve.py cookies <domain>   # names only; values are stripped extension-side
```

One-shot caller. On Windows PowerShell, inline JSON args get their quotes
eaten - **always use `-f` or the pipe there**:

```
node br.js browser_list_tabs '{}'
node br.js browser_wait_for -f args.json     # args from UTF-8 file (BOM tolerated)
echo '{"url":"https://example.com"}' | node br.js browser_new_tab
```

## Isolated test instance

Env vars let you run a second, fully isolated instance (own port, own tokens):

```
EXT_BRIDGE_PORT=18895 EXT_BRIDGE_TOKEN=... EXT_BRIDGE_EXT_TOKEN=... node server.js
```

Then point a test browser profile's `extension/config.js` at that port.
`tests/testpage.html` is a tiny self-contained page for wait_for/uid tests.

## Self tests

```
node selftest_mcp.js browser_list_tabs {}   # MCP protocol loopback -> "MCP PASS"
node verify.js                              # read-only checks (server/token/extension/eval)
node verify.js --full                       # + open tab / screenshot / close tab
python -u selftest_e2e.py                   # fake-extension loopback (native msg) -> "E2E PASS"
```

## Security

- All listeners bind `127.0.0.1` only
- `/tool` (arbitrary JS, cookies, screenshots) requires `x-bridge-token`;
  the token auto-generates into `~/.ext_bridge_token` (0600)
- `/extension/*` is gated by the paired secret from `scripts/pair.ps1`;
  it self-arms: until the first correctly paired extension checks in,
  unauthenticated calls are honoured (compat with not-yet-reloaded extensions),
  then the endpoint locks permanently
- The native-messaging host allowlist locks the extension ID
- The extension can access everything in your browser (including logins) -
  use it on your own machine only; remove it in `edge://extensions` to cut access

These are speed bumps, not defenses: any local process can read the token
files. The goal is to stop drive-by callers (port scans, npm postinstall
scripts), not a determined local attacker.

## Known limitations

- Unpacked extensions trigger Edge's "disable developer mode extensions" prompt - keep it
- Moving the extension folder changes its ID; re-run `python register_nmh.py`
- `chrome.alarms` minimum period is 1 minute, so a fully idle browser can take
  up to ~1 min to wake the worker (tab activation/focus events close most of
  that gap)
- `eval` runs in the MAIN world, which is governed by the **page's** CSP.
  Extremely strict CSP pages (script-src 'none') fail there - use the
  ISOLATED-world probes (`wait_for` text/selector) on such pages

## License

MIT
