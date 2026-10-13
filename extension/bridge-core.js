// Shared command implementation, loaded by BOTH the service worker
// (importScripts) and the offscreen document (<script src>).
//
// Keeping it in one file means the WebSocket path (offscreen) and the
// native-messaging path (service worker) answer commands identically.

var BridgeCore = (function () {
  'use strict';

  async function evalInTab(tabId, code, world) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [code],
      // MAIN world, not ISOLATED: injected code running in the extension's
      // isolated world is subject to the *extension* CSP, and MV3 forbids
      // unsafe-eval there. MAIN world is governed by the page's own CSP,
      // which most pages do not restrict.
      world: world || 'MAIN',
      // NOTE: this function is serialised into the page, so it cannot close
      // over anything from this file - serialize() is inlined on purpose.
      func: (code) => {
        const ser = (value) => {
          if (value === null || value === undefined) return value;
          if (typeof value === 'object') {
            if (value.__error) return value;
            if (value instanceof Element) {
              return {
                __element: true,
                tag: value.tagName,
                id: value.id || undefined,
                class: value.className || undefined,
                text: value.innerText?.slice(0, 500) || undefined,
                href: value.href || undefined,
                src: value.src || undefined,
              };
            }
            try {
              return JSON.parse(JSON.stringify(value));
            } catch {
              return String(value);
            }
          }
          return value;
        };
        try {
          // eslint-disable-next-line no-eval
          const value = eval(code);
          if (value instanceof Promise) return value.then(ser);
          return ser(value);
        } catch (e) {
          return { __error: String(e?.message || e) };
        }
      },
    });
    if (result && result.__error) throw new Error(result.__error);
    return result;
  }

  async function typeInTab(tabId, selector, text, clear) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      args: [String(selector || ''), text, clear !== false],
      func: (selector, text, clear) => {
        try {
          let el;
          if (/^e\d+$/.test(selector)) {
            // SAME filtering as snapshotInTab/clickInTab - refs are indices
            // into the filtered list (type used to be CSS-only only, which
            // dead-ended the snapshot->type flow on CSP pages).
            const els = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [onclick]');
            const want = parseInt(selector.slice(1), 10);
            let n = 0;
            for (const e of els) {
              const r = e.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              const t = (e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || '').trim().slice(0, 80);
              if (!t && e.tagName !== 'INPUT' && e.tagName !== 'BUTTON') continue;
              if (++n === want) { el = e; break; }
            }
          } else {
            el = document.querySelector(selector);
          }
          if (!el) return { __error: 'Element not found: ' + selector };
          if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
            return { __error: 'Element is not an input/textarea: ' + selector + ' (' + el.tagName + ')' };
          }
          el.focus();
          const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          if (clear) setter.call(el, '');
          setter.call(el, text);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true, value: el.value };
        } catch (e) {
          return { __error: String((e && e.message) || e) };
        }
      },
    });
    if (result && result.__error) throw new Error(result.__error);
    return result;
  }

  // Fixed operations below deliberately do NOT go through evalInTab: they use
  // executeScript's `func` + `args` (same pattern as typeInTab), so the code
  // is serialised by the extension API itself and never runs through eval().
  // That makes them immune to strict page CSP (search engines, web IDEs, ...),
  // where the eval route dies with "unsafe-eval not allowed".

  async function textInTab(tabId) {
    // allFrames: pages whose app lives in a cross-origin iframe (Huawei Cloud
    // WebIDE) are invisible to a top-frame-only read; content scripts pierce
    // frames, so collect every frame that has text and join them.
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'ISOLATED',
      args: [],
      func: () => (document.body ? document.body.innerText : ''),
    });
    const parts = (results || [])
      .map((r) => (r && typeof r.result === 'string' ? r.result : ''))
      .filter((t) => t.trim().length > 0);
    const SEP = '\n----frame----\n';
    return { text: parts.join(SEP) };
  }

  async function snapshotInTab(tabId) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      args: [],
      func: () => {
        try {
          // ── uid 指纹 ────────────────────────────────────────────
          // 稳定标识，优先级 id > name > data-testid > aria-label > 文本hash+DOM路径。
          // 无状态：uid 本身就是重查钥匙（resolveUidInTab 用同一算法反查），
          // 不存 SW 内存，SW 半路死掉也不失效。
          function h(s) {
            var x = 5381;
            for (var i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0;
            return (x >>> 0).toString(36);
          }
          function domPath(el) {
            var segs = [];
            var e = el;
            while (e && e !== document.documentElement) {
              var tag = e.tagName, n = 1, s = e;
              while (s.previousElementSibling) { s = s.previousElementSibling; if (s.tagName === tag) n++; }
              segs.unshift(tag + ':' + n);
              e = e.parentElement;
            }
            return segs.join('/');
          }
          function uidOf(el) {
            if (el.id) return 'id=' + el.id;
            var v;
            if ((v = el.getAttribute && el.getAttribute('name'))) return 'name=' + v;
            if ((v = el.getAttribute && el.getAttribute('data-testid'))) return 'dt=' + v;
            if ((v = el.getAttribute && el.getAttribute('aria-label'))) return 'al=' + v;
            var t = (el.innerText || el.value || '').trim().slice(0, 80);
            return 'tx=' + h(t) + '@' + domPath(el);
          }
          const els = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [onclick]');
          const items = [];
          let ref = 0;
          for (const el of els) {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;
            const text = (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().slice(0, 80);
            if (!text && el.tagName !== 'INPUT' && el.tagName !== 'BUTTON') continue;
            items.push({
              ref: 'e' + (++ref),
              uid: uidOf(el),
              tag: el.tagName.toLowerCase(),
              type: el.type || undefined,
              text: text || undefined,
              id: el.id || undefined,
              class: el.className || undefined,
              href: el.href || undefined,
              placeholder: el.placeholder || undefined,
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              w: Math.round(rect.width),
              h: Math.round(rect.height),
            });
          }
          return items;
        } catch (e) {
          return { __error: String((e && e.message) || e) };
        }
      },
    });
    if (result && result.__error) throw new Error(result.__error);
    return result;
  }

  async function clickInTab(tabId, selector) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      args: [String(selector || '')],
      func: (selector) => {
        try {
          let el;
          if (/^e\d+$/.test(selector)) {
            // MUST mirror snapshotInTab's filtering EXACTLY: refs are indices
            // into the *filtered* list (visible, then the text/INPUT/BUTTON
            // rule). Counting the raw visible list instead silently clicks
            // the wrong element - reproduced on modelscope (e22 snapshot=button,
            // click landed on an INPUT).
            const els = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [onclick]');
            const want = parseInt(selector.slice(1), 10);
            let n = 0;
            for (const e of els) {
              const r = e.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              const text = (e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || '').trim().slice(0, 80);
              if (!text && e.tagName !== 'INPUT' && e.tagName !== 'BUTTON') continue;
              if (++n === want) { el = e; break; }
            }
          } else {
            el = document.querySelector(selector);
          }
          if (!el) return { __error: 'Element not found: ' + selector };
          el.click();
          return { ok: true, tag: el.tagName, text: (el.innerText || '').slice(0, 50) };
        } catch (e) {
          return { __error: String((e && e.message) || e) };
        }
      },
    });
    if (result && result.__error) throw new Error(result.__error);
    return result;
  }

  async function scrollInTab(tabId, selector, dx, dy) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      args: [selector || null, dx | 0, dy | 0],
      func: (selector, dx, dy) => {
        try {
          if (selector) {
            const el = document.querySelector(selector);
            if (!el) return { __error: 'Element not found: ' + selector };
            el.scrollBy(dx, dy);
          } else {
            window.scrollBy(dx, dy);
          }
          return { ok: true };
        } catch (e) {
          return { __error: String((e && e.message) || e) };
        }
      },
    });
    if (result && result.__error) throw new Error(result.__error);
    return result;
  }

  // ── Real input via CDP (chrome.debugger) ─────────────────────────────
  //
  // el.click() produces an untrusted event (isTrusted=false). antd5 modals -
  // and any component listening for real pointer sequences - ignore them
  // silently (it used to answer {"ok":true} while the dialog stayed open).
  // The only clean
  // cure is chrome.debugger: Input.dispatchMouseEvent/KeyEvent are trusted
  // by the page. Cost: the "正在调试此浏览器" infobar shows while attached,
  // so attach -> act -> detach, always.

  function dbgAttach(tabId) {
    return new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        const e = chrome.runtime.lastError;
        e ? reject(new Error('debugger attach: ' + e.message)) : resolve();
      });
    });
  }

  function dbgDetach(tabId) {
    try {
      chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError);
    } catch {}
  }

  function dbgSend(tabId, method, params) {
    return new Promise((resolve, reject) => {
      chrome.debugger.sendCommand({ tabId }, method, params || {}, (r) => {
        const e = chrome.runtime.lastError;
        e ? reject(new Error(e.message)) : resolve(r);
      });
    });
  }

  // Resolve an eN ref / CSS selector to the element's centre in *viewport*
  // coordinates (what Input.dispatchMouseEvent wants). Same filtering rules
  // as snapshotInTab - refs stay consistent across all three.
  async function locateInTab(tabId, selector) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      args: [String(selector || '')],
      func: (selector) => {
        try {
          let el;
          if (/^e\d+$/.test(selector)) {
            const els = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [onclick]');
            const want = parseInt(selector.slice(1), 10);
            let n = 0;
            for (const e of els) {
              const r = e.getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              const t = (e.innerText || e.value || e.placeholder || e.getAttribute('aria-label') || '').trim().slice(0, 80);
              if (!t && e.tagName !== 'INPUT' && e.tagName !== 'BUTTON') continue;
              if (++n === want) { el = e; break; }
            }
          } else {
            el = document.querySelector(selector);
          }
          if (!el) return { __error: 'Element not found: ' + selector };
          const r = el.getBoundingClientRect();
          return {
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
            tag: el.tagName,
            text: (el.innerText || '').trim().slice(0, 50),
          };
        } catch (e) {
          return { __error: String((e && e.message) || e) };
        }
      },
    });
    if (result && result.__error) throw new Error(result.__error);
    return result;
  }

  async function clickRealInTab(tabId, selector) {
    // "x,y" = raw viewport coordinates, for buttons no selector/ref can reach
    // (e.g. Huawei Cloud's login button is a styled div outside the snapshot
    // selector list). Anything else goes through the normal resolution.
    const coord = /^\s*(\d{1,5})\s*,\s*(\d{1,5})\s*$/.exec(String(selector || ''));
    const pos = coord
      ? { x: Number(coord[1]), y: Number(coord[2]), tag: '(coords)', text: '' }
      : await locateInTab(tabId, selector);
    await dbgAttach(tabId);
    try {
      const common = { x: pos.x, y: pos.y, button: 'left', clickCount: 1 };
      await dbgSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
      await dbgSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });
    } finally {
      dbgDetach(tabId);
    }
    return { ok: true, real: true, x: pos.x, y: pos.y, tag: pos.tag, text: pos.text };
  }

  const KEY_DEFS = {
    Escape:     { key: 'Escape',     code: 'Escape',     windowsVirtualKeyCode: 27 },
    Enter:      { key: 'Enter',      code: 'Enter',      windowsVirtualKeyCode: 13 },
    Tab:        { key: 'Tab',        code: 'Tab',        windowsVirtualKeyCode: 9 },
    Backspace:  { key: 'Backspace',  code: 'Backspace',  windowsVirtualKeyCode: 8 },
    ArrowDown:  { key: 'ArrowDown',  code: 'ArrowDown',  windowsVirtualKeyCode: 40 },
    ArrowUp:    { key: 'ArrowUp',    code: 'ArrowUp',    windowsVirtualKeyCode: 38 },
    ArrowLeft:  { key: 'ArrowLeft',  code: 'ArrowLeft',  windowsVirtualKeyCode: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  };

  async function keyRealInTab(tabId, key) {
    const def = KEY_DEFS[key];
    if (!def) {
      throw new Error('unsupported key: ' + key + ' (supported: ' + Object.keys(KEY_DEFS).join(', ') + ')');
    }
    await dbgAttach(tabId);
    try {
      await dbgSend(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...def });
      await dbgSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...def });
    } finally {
      dbgDetach(tabId);
    }
    return { ok: true, real: true, key };
  }

  // type_real: insert text into whatever has focus via CDP Input.insertText
  // (works on xterm/warp-style web terminals where browser_type can't reach),
  // optionally submitting with a real Enter.
  async function typeRealInTab(tabId, text, submit) {
    await dbgAttach(tabId);
    try {
      await dbgSend(tabId, 'Input.insertText', { text: String(text || '') });
      if (submit) {
        const def = KEY_DEFS.Enter;
        await dbgSend(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...def });
        await dbgSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...def });
      }
    } finally {
      dbgDetach(tabId);
    }
    return { ok: true, real: true, typed: String(text || '').length, submitted: !!submit };
  }

  // ── wait_for：单次轻探针（轮询循环在 server.js 侧）─────────────────
  // 探针走 ISOLATED func 注入（CSP 免疫）——绝不能走 evalInTab 的 MAIN eval，
  // 页面 CSP 无 unsafe-eval 时那条路会挂。
  async function probeInTab(tabId, kind, value) {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'ISOLATED',
      args: [String(kind || ''), String(value == null ? '' : value)],
      func: (kind, value) => {
        try {
          if (kind === 'text') {
            return { matched: !!(document.body && document.body.innerText.includes(value)) };
          }
          if (kind === 'selector') {
            const el = document.querySelector(value);
            const r = el ? el.getBoundingClientRect() : { width: 0 };
            return { matched: !!el && r.width > 0 };
          }
          return { __error: 'unknown probe kind: ' + kind };
        } catch (e) {
          return { __error: String((e && e.message) || e) };
        }
      },
    });
    // 任一 frame 命中即算命中（对齐 textInTab 的 allFrames 语义）
    for (const r of results || []) {
      if (r && r.result && r.result.__error) throw new Error(r.result.__error);
      if (r && r.result && r.result.matched) return { matched: true };
    }
    return { matched: false };
  }

  // ── uid 反查（与 snapshotInTab 的 uidOf 同一算法）──────────────────
  // 全 DOM 查找，不受快照白名单限制——所以能摸到终端容器这类白名单外元素。
  async function resolveUidInTab(tabId, uid) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      args: [String(uid || '')],
      func: (uid) => {
        try {
          function h(s) {
            var x = 5381;
            for (var i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0;
            return (x >>> 0).toString(36);
          }
          function visible(el) {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }
          function centre(el) {
            const r = el.getBoundingClientRect();
            return {
              x: Math.round(r.x + r.width / 2),
              y: Math.round(r.y + r.height / 2),
              tag: el.tagName,
              text: ((el.innerText || el.value || '') + '').trim().slice(0, 50),
            };
          }
          function findByAttr(attr, val) {
            const list = document.querySelectorAll('[' + attr + ']');
            for (const el of list) {
              if (el.getAttribute(attr) === val) return el;
            }
            return null;
          }
          function walkPath(root, segs) {
            let el = root;
            for (const seg of segs) {
              const m = /^([A-Za-z0-9]+):(\d+)$/.exec(seg);
              if (!m) return null;
              let k = 0, found = null;
              for (const c of el.children) {
                if (c.tagName === m[1].toUpperCase()) { if (++k === Number(m[2])) { found = c; break; } }
              }
              if (!found) return null;
              el = found;
            }
            return el;
          }

          let el = null;
          if (uid.startsWith('id=')) {
            el = document.getElementById(uid.slice(3));
          } else if (uid.startsWith('name=')) {
            el = findByAttr('name', uid.slice(5));
          } else if (uid.startsWith('dt=')) {
            el = findByAttr('data-testid', uid.slice(3));
          } else if (uid.startsWith('al=')) {
            el = findByAttr('aria-label', uid.slice(3));
          } else if (uid.startsWith('tx=')) {
            const at = uid.indexOf('@');
            const want = uid.slice(3, at);
            const segs = uid.slice(at + 1).split('/');
            el = walkPath(document.documentElement, segs);
            if (el) {
              const t = (el.innerText || el.value || '').trim().slice(0, 80);
              if (h(t) !== want) el = null; // 路径还在但文本变了 → 回退全 DOM 找
            }
            if (!el) {
              for (const c of document.querySelectorAll('*')) {
                const t = (c.innerText || c.value || '').trim().slice(0, 80);
                if (t && h(t) === want && visible(c)) { el = c; break; }
              }
            }
          } else {
            return { __error: 'bad uid prefix: ' + uid.slice(0, 12) };
          }
          if (!el) return { __error: 'uid not found: ' + uid.slice(0, 60), __reason: 'not_found' };
          if (!visible(el)) return { __error: 'uid element exists but not visible: ' + uid.slice(0, 60), __reason: 'not_visible' };
          return centre(el);
        } catch (e) {
          return { __error: String((e && e.message) || e) };
        }
      },
    });
    if (result && result.__error) throw new Error(result.__error);
    return result;
  }

  async function clickByUidInTab(tabId, uid) {
    const t0 = Date.now();
    const pos = await resolveUidInTab(tabId, uid);
    await dbgAttach(tabId);
    try {
      const common = { x: pos.x, y: pos.y, button: 'left', clickCount: 1 };
      await dbgSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
      await dbgSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });
    } finally {
      dbgDetach(tabId);
    }
    return { ok: true, real: true, uid, x: pos.x, y: pos.y, tag: pos.tag, text: pos.text, waitedMs: Date.now() - t0 };
  }

  async function typeByUidInTab(tabId, uid, text, submit) {
    const t0 = Date.now();
    const pos = await resolveUidInTab(tabId, uid);
    // 先真点击聚焦——这是治"typed:N 回 ok 但没落地"的根：点中了才有焦点。
    await dbgAttach(tabId);
    try {
      const common = { x: pos.x, y: pos.y, button: 'left', clickCount: 1 };
      await dbgSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
      await dbgSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });
      await dbgSend(tabId, 'Input.insertText', { text: String(text || '') });
      if (submit) {
        const def = KEY_DEFS.Enter;
        await dbgSend(tabId, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...def });
        await dbgSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...def });
      }
    } finally {
      dbgDetach(tabId);
    }
    return { ok: true, real: true, uid, typed: String(text || '').length, submitted: !!submit, x: pos.x, y: pos.y, tag: pos.tag, text: pos.text, waitedMs: Date.now() - t0 };
  }

  function serialize(value) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'object') {
      if (value.__error) return value;
      if (value instanceof Element) {
        return {
          __element: true,
          tag: value.tagName,
          id: value.id || undefined,
          class: value.className || undefined,
          text: value.innerText?.slice(0, 500) || undefined,
          href: value.href || undefined,
          src: value.src || undefined,
        };
      }
      try {
        return JSON.parse(JSON.stringify(value));
      } catch {
        return String(value);
      }
    }
    return value;
  }

  async function screenshotTab(tabId) {
    let windowId = null;
    try {
      let tab = null;
      if (tabId != null) tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab) {
        const actives = await chrome.tabs.query({ active: true });
        tab = actives.find((t) => /^https?:/.test(t.url || '')) || actives[0] || null;
      }
      windowId = tab?.windowId ?? null;
    } catch {}
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    return { dataUrl };
  }

  // msg: { method|cmd, params|arg }
  async function handleCommand(msg) {
    const method = msg.method || msg.cmd;
    const p = msg.params || msg.arg || {};
    switch (method) {
      case 'list_tabs':
        return await chrome.tabs.query({});

      case 'get_tab':
        return await chrome.tabs.get(p.tabId);

      case 'navigate':
        return await chrome.tabs.update(p.tabId, { url: p.url });

      case 'new_tab':
      case 'open':
        return [await chrome.tabs.create({ url: p.url || 'about:blank' })];

      case 'close_tab':
      case 'close':
        return await chrome.tabs.remove(p.tabId);

      case 'activate': {
        await chrome.tabs.update(p.tabId, { active: true });
        const tab = await chrome.tabs.get(p.tabId);
        try {
          await chrome.windows.update(tab.windowId, { focused: true });
        } catch {}
        return { ok: true };
      }

      case 'focus_win': {
        const win = await chrome.windows.getLastFocused({});
        if (win && win.id !== undefined) {
          await chrome.windows.update(win.id, { focused: true });
        }
        return { ok: true, windowId: win?.id ?? null };
      }

      case 'eval':
        return { value: await evalInTab(p.tabId, p.expr || p.code, p.world) };

      case 'text':
        return await textInTab(p.tabId);

      case 'snapshot':
        return await snapshotInTab(p.tabId);

      case 'click':
        return await clickInTab(p.tabId, p.selector);

      case 'click_real':
        return await clickRealInTab(p.tabId, p.selector);

      case 'key':
        return await keyRealInTab(p.tabId, p.key);

      case 'type_real':
        return await typeRealInTab(p.tabId, p.text, p.submit);

      case 'locate':
        return await locateInTab(p.tabId, p.selector);

      case 'scroll':
        return await scrollInTab(p.tabId, p.selector, p.dx, p.dy);

      case 'type':
        return await typeInTab(p.tabId, p.selector, p.text, p.clear);

      case 'screenshot':
      case 'shot': {
        const { dataUrl } = await screenshotTab(p.tabId);
        return { data: dataUrl.replace(/^data:image\/\w+;base64,/, ''), dataUrl };
      }

      case 'cookies': {
        // Names/domains only - cookie VALUES never leave the extension.
        const all = await chrome.cookies.getAll({ url: p.url || p.domain });
        return (all || []).map((c) => ({ name: c.name, domain: c.domain, path: c.path }));
      }

      case 'probe':
        return await probeInTab(p.tabId, p.kind, p.value);

      case 'click_by_uid':
        return await clickByUidInTab(p.tabId, p.uid);

      case 'type_by_uid':
        return await typeByUidInTab(p.tabId, p.uid, p.text, p.submit);

      case 'ping': {
        let v = 'unknown';
        try { v = (chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().version) || v; } catch {}
        return { ok: true, version: v };
      }

      // Self-reload: the AI equivalent of clicking 重新加载 on
      // edge://extensions - which we cannot do directly because chrome://
      // pages refuse script injection. The service worker dies mid-call, so
      // the caller should treat "connection dropped right after this" as
      // SUCCESS and just re-poll a few seconds later.
      case 'reload_self':
        setTimeout(() => chrome.runtime.reload(), 200);
        return { ok: true, reloading: true };

      default:
        throw new Error('Unknown method: ' + method);
    }
  }

  return { handleCommand, evalInTab, typeInTab, textInTab, snapshotInTab, clickInTab, clickRealInTab, keyRealInTab, typeRealInTab, locateInTab, scrollInTab, screenshotTab, probeInTab, resolveUidInTab, clickByUidInTab, typeByUidInTab, serialize };
})();

if (typeof self !== 'undefined') self.BridgeCore = BridgeCore;
