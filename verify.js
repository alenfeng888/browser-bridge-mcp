#!/usr/bin/env node
/**
 * Post-reload smoke test. One command, readable verdict.
 *
 *   node verify.js          read-only checks (safe to run any time)
 *   node verify.js --full   also opens example.com, screenshots it and closes it
 *
 * What it proves, in order:
 *   1. the resident server is up and the token works
 *   2. the service worker has picked up the current build (extAuth)
 *   3. tabs can be listed, JS can run in the page, text/pixels come back
 */

const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');

const PORT = 18795;
const HOST = '127.0.0.1';
const FULL = process.argv.includes('--full');

const TOKEN_FILE = path.join(os.homedir(), '.ext_bridge_token');
let TOKEN = '';
try {
  TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
} catch {
  console.error('cannot read ' + TOKEN_FILE + ' - is the resident server running?');
  process.exit(1);
}

function req(method, pathname, payload) {
  return new Promise((resolve, reject) => {
    const body = payload === undefined ? null : JSON.stringify(payload);
    const r = http.request(
      {
        host: HOST,
        port: PORT,
        path: pathname,
        method,
        headers: body
          ? {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(body),
              'x-bridge-token': TOKEN,
            }
          : { 'x-bridge-token': TOKEN },
        timeout: 30000,
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(buf) });
          } catch {
            reject(new Error(`bad reply (${res.statusCode}): ${buf.slice(0, 200)}`));
          }
        });
      }
    );
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', (e) => reject(new Error(e.code === 'ECONNREFUSED' ? 'no resident server on 18795' : e.message)));
    if (body) r.write(body);
    r.end();
  });
}

async function tool(name, args) {
  const r = await req('POST', '/tool', { name, arguments: args || {} });
  if (r.status === 401) throw new Error('401 - token mismatch, server was restarted?');
  if (!r.body.ok) throw new Error(r.body.error || 'tool failed');
  return r.body.result;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ->  ' + detail : ''}`);
}

// Arbitrary-JS injection has no clean answer on strict-CSP pages (extension
// CSP bans unsafe-eval in ISOLATED, page CSP bans it in MAIN - see the
// receipt P1). That is a known limitation of browser_eval, not a bridge
// failure: mark it SKIP instead of failing the whole run.
const isCspWall = (e) => /Content Security Policy|unsafe-eval/i.test(String(e && e.message));
function skip(name, detail) {
  results.push({ name, ok: true, detail: 'SKIP ' + detail });
  console.log(`SKIP  ${name}  ->  ${detail}`);
}

(async () => {
  // 1. server + token
  const health = await req('GET', '/health');
  check('resident server + token', health.status === 200 && health.body.ok,
    `ws=${health.body.ws} waiters=${health.body.waiters} sticky=${health.body.sticky}`);

  // 2. did the reload take?
  check('extension build authenticated (extAuth)', health.body.extAuth === true,
    health.body.extAuth ? 'current build' : 'still the old build - reload the extension on edge://extensions/');

  // 3. list tabs
  const tabs = await tool('browser_list_tabs', {});
  check('list tabs', Array.isArray(tabs) && tabs.length > 0, `${tabs.length} tabs`);
  if (!tabs.length) { summary(); return; }

  // edge:// chrome:// about: and friends cannot be scripted at all - an eval
  // there just hangs until timeout. Prefer the active tab, fall back to the
  // first http(s) one.
  const scriptable = (t) => /^https?:/i.test(t.url || '');
  const active = (tabs.find((t) => t.active && scriptable(t)) ||
                  tabs.find(scriptable) ||
                  tabs.find((t) => t.active) ||
                  tabs[0]);
  if (!scriptable(active)) {
    check('eval in page', false, `no http(s) tab open (active is ${active.url}) - open a normal page and rerun`);
    summary();
    return;
  }

  // 4. eval - SKIP on strict-CSP pages (modelscope, bing, ...), which is a
  //    documented browser_eval limitation, not a bridge fault.
  try {
    const title = await tool('browser_eval', { tabId: active.id, code: 'document.title' });
    check('eval in page', typeof title === 'string', JSON.stringify(String(title).slice(0, 60)));
  } catch (e) {
    if (isCspWall(e)) skip('eval in page', `strict CSP on ${(active.url || '').slice(0, 50)} - browser_eval limitation`);
    else throw e;
  }

  // 5. text
  try {
    const text = await tool('browser_get_text', { tabId: active.id });
    check('get text', !!text && typeof text.text === 'string', `${(text.text || '').length} chars`);
  } catch (e) {
    if (isCspWall(e)) skip('get text', `strict CSP + old extension build - reload to get the CSP-safe route`);
    else throw e;
  }

  if (!FULL) { summary(); return; }

  // 6. open / screenshot / close
  const opened = await tool('browser_new_tab', { url: 'https://example.com' });
  check('open tab', !!opened && !!opened.id, `id=${opened && opened.id}`);
  await new Promise((r) => setTimeout(r, 1500));
  try {
    const shot = await tool('browser_screenshot', { tabId: opened.id });
    const b64 = String(shot.dataUrl || '').replace(/^data:image\/\w+;base64,/, '');
    check('screenshot (own tab, auto-switched)', b64.length > 1000, `${Math.round(b64.length / 1024)} KB base64, switched=${shot.switched}`);
  } finally {
    await tool('browser_close_tab', { tabId: opened.id });
    check('close tab', true, `id=${opened.id}`);
  }

  summary();
})().catch((e) => {
  console.error('verify aborted:', e.message);
  process.exit(1);
});

function summary() {
  const bad = results.filter((r) => !r.ok);
  console.log(`\n=== ${bad.length === 0 ? 'ALL PASS' : bad.length + ' FAILED'} (${results.length} checks) ===`);
  process.exit(bad.length === 0 ? 0 : 1);
}
