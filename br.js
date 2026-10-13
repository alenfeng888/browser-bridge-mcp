#!/usr/bin/env node
/**
 * br.js - one-shot caller for any bridge tool (no need to write a script per action).
 *
 * Usage:
 *   node br.js <toolName> '<json args>'        inline args (watch shell quoting)
 *   node br.js <toolName> -f args.json         read args from a UTF-8 file (PowerShell-safe)
 *   echo '<json args>' | node br.js <toolName> read args from stdin
 *
 * Examples:
 *   node br.js browser_list_tabs '{}'
 *   node br.js browser_navigate -f args.json
 *
 * Options via env:
 *   EXT_BRIDGE_PORT   server port (default 18795)
 *   EXT_BRIDGE_TOKEN  tool token (default: read from ~/.ext_bridge_token)
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.EXT_BRIDGE_PORT || 18795);
const TOKEN = process.env.EXT_BRIDGE_TOKEN ||
  fs.readFileSync(path.join(os.homedir(), '.ext_bridge_token'), 'utf8').trim();

function tool(name, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ name, arguments: args || {} });
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: '/tool', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-bridge-token': TOKEN },
        timeout: timeoutMs || 60000 },
      (res) => {
        let buf = ''; res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try { const j = JSON.parse(buf); j.ok ? resolve(j.result) : reject(new Error(j.error || 'tool failed')); }
          catch { reject(new Error('bad reply ' + buf.slice(0, 300))); }
        });
      });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout ' + name)));
    req.write(body); req.end();
  });
}

(async () => {
  const argv = process.argv.slice(2);
  const name = argv[0];
  if (!name) {
    console.log('usage: node br.js <toolName> [\'<json>\' | -f file.json]   (env: EXT_BRIDGE_PORT, EXT_BRIDGE_TOKEN)');
    process.exit(1);
  }
  let argsJson = null;
  if (argv[1] === '-f' && argv[2]) {
    argsJson = fs.readFileSync(argv[2], 'utf8');
  } else if (!argv[1] && !process.stdin.isTTY) {
    // no inline args and something is piped in: read stdin
    argsJson = fs.readFileSync(0, 'utf8');
  } else {
    argsJson = argv[1];
  }
  // strip UTF-8 BOM if present (Windows editors/Write tools add it; JSON.parse chokes)
  if (argsJson) argsJson = argsJson.replace(/^\uFEFF/, '');
  const args = argsJson && argsJson.trim() ? JSON.parse(argsJson) : {};
  const r = await tool(name, args, 90000);
  console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 1));
})().catch((e) => { console.log('FAIL ' + e.message); process.exit(1); });
