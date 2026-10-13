// MCP smoke test: spawn server.js and drive it like a real MCP client.
//
// Proves the WebSocket path works end to end:
//   this script -> server.js (stdio) -> WS :18795 -> offscreen.js -> chrome.tabs
//
// Usage: node selftest_mcp.js [toolName] [jsonArgs]
const { spawn } = require('child_process');
const path = require('path');

const SERVER = path.join(__dirname, 'server.js');
const TOOL = process.argv[2] || 'browser_list_tabs';
const ARGS = process.argv[3] ? JSON.parse(process.argv[3]) : {};

// 'mcp' = the mode opencode actually uses: a thin stdio client attached to
// the resident server, so this exercises the real production path.
const child = spawn(process.execPath, [SERVER, 'mcp'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: __dirname,
});

let buf = '';
const seen = [];
child.stdout.setEncoding('utf8');
child.stdout.on('data', (d) => {
  buf += d;
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
    seen.push(msg);
    console.log('<-', JSON.stringify(msg).slice(0, 600));
  }
});
child.stderr.on('data', (d) => {
  process.stderr.write('[server] ' + d.toString().slice(0, 400));
});

const send = (obj) => {
  console.log('->', JSON.stringify(obj).slice(0, 300));
  child.stdin.write(JSON.stringify(obj) + '\n');
};

setTimeout(() => {
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'selftest', version: '1.0' } } });
}, 300);

setTimeout(() => send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), 900);

setTimeout(() => {
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: TOOL, arguments: ARGS } });
}, 1500);

setTimeout(() => {
  const call = seen.find((m) => m.id === 3);
  const ok = call && call.result && !call.result.isError;
  console.log('\n=== MCP ' + (ok ? 'PASS' : 'FAIL') + ' (' + TOOL + ') ===');
  child.kill();
  process.exit(ok ? 0 : 1);
}, 25000);
