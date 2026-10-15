// Chrome manager: single headless Chrome instance, CDP over raw WebSocket.
// One persistent worker page; navigate it per operation. Zero npm deps.
// Managed Cloudflare challenge is passed by locating the Turnstile widget
// position and dispatching a synthetic mouse click.

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');

const CDP_PORT = 9333;
const USER_DATA_DIR = process.env.CHROME_DATA_DIR || '/home/dave/.cache/flix-chrome';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

let chromeLock = null;
let chromeProc = null;
let worker = null; // persistent worker page { page, ev }

function httpGet(url) {
  return new Promise((res, rej) => {
    const req = http.get(url, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => res(d));
    });
    req.on('error', rej);
    req.setTimeout(3000, () => req.destroy());
  });
}

class Cdp {
  constructor(wsurl) {
    this.ws = new WebSocket(wsurl);
    this.nextId = 0;
    this.pending = new Map();
    this.opened = new Promise((r) => { this.ws.onopen = () => r(); });
    this.ws.onmessage = (m) => {
      let d; try { d = JSON.parse(m.data); } catch { return; }
      if (d.id && this.pending.has(d.id)) {
        const done = this.pending.get(d.id);
        this.pending.delete(d.id);
        done(d);
      }
    };
  }
  send(method, params = {}) {
    return new Promise((res) => {
      const id = ++this.nextId;
      const done = (out) => (out.error ? res({ error: new Error(out.error.message), result: {} }) : res({ result: out.result || {}, error: null }));
      this.pending.set(id, done);
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); done({ error: new Error('timeout') }); } }, 30000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

function cdp(wsurl) { return new Cdp(wsurl); }

async function waitChrome() {
  for (let i = 0; i < 40; i++) {
    try { await httpGet('http://127.0.0.1:' + CDP_PORT + '/json/version'); return true; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function clearStaleLocks() {
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { fs.unlinkSync(USER_DATA_DIR + '/' + f); } catch {}
  }
}

async function ensureChrome() {
  if (chromeLock) return chromeLock;
  chromeLock = (async () => {
    if (await waitChrome()) return 'ok';
    try { fs.mkdirSync(USER_DATA_DIR, { recursive: true }); } catch {}
    clearStaleLocks();
    chromeProc = spawn('google-chrome', [
      '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
      '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + USER_DATA_DIR,
      '--user-agent=' + UA,
      '--window-size=1366,900',
      '--lang=en-US',
      'about:blank',
    ], { stdio: 'ignore', detached: true });
    chromeProc.unref();
    chromeProc.on('exit', () => { chromeProc = null; chromeLock = null; worker = null; clearStaleLocks(); });
    if (!(await waitChrome())) throw new Error('Chrome did not start');
    return 'ok';
  })();
  try { await chromeLock; } catch (e) { chromeLock = null; throw e; }
  return 'ok';
}

// Attach a CDP session to a page target by id. Returns { page, ev }.
async function attachPage(targetId) {
  let wsurl = null;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const list = JSON.parse(await httpGet('http://127.0.0.1:' + CDP_PORT + '/json'));
    const p = list.find((x) => x.id === targetId && x.type === 'page');
    if (p && p.webSocketDebuggerUrl) { wsurl = p.webSocketDebuggerUrl; break; }
  }
  if (!wsurl) throw new Error('page target not found');
  const page = cdp(wsurl);
  await page.opened;
  const ev = (expr) => page.send('Runtime.evaluate', { expression: expr, returnByValue: true }).then((r) => {
    if (r.error) return undefined;
    const rr = r.result && r.result.result;
    return rr ? rr.value : undefined;
  });
  return { page, ev };
}

// Get (or create) the single persistent worker page. Returns { page, ev }.
async function getPage() {
  if (worker) return worker;
  await ensureChrome();
  const ver = JSON.parse(await httpGet('http://127.0.0.1:' + CDP_PORT + '/json/version'));
  const browser = cdp(ver.webSocketDebuggerUrl);
  await browser.opened;
  const created = await browser.send('Target.createTarget', { url: 'about:blank' });
  const targetId = created.result && created.result.targetId;
  browser.close();
  if (!targetId) throw new Error('no target');
  const w = await attachPage(targetId);
  w.targetId = targetId;
  worker = w;
  return worker;
}

function dropWorker() {
  if (!worker) return;
  const w = worker;
  worker = null;
  try { w.page.close(); } catch {}
  if (!w.targetId) return;
  (async () => {
    try {
      const ver = JSON.parse(await httpGet('http://127.0.0.1:' + CDP_PORT + '/json/version'));
      const browser = cdp(ver.webSocketDebuggerUrl);
      await browser.opened;
      await browser.send('Target.closeTarget', { targetId: w.targetId });
      browser.close();
    } catch {}
  })();
}

// Navigate the worker page to a url and wait for it to settle.
async function navigate(sess, url, waitMs = 12000) {
  await sess.page.send('Page.enable');
  await sess.page.send('Page.navigate', { url });
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    const rs = await sess.ev('document.readyState');
    if (rs === 'complete') break;
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Wait out the CF managed challenge if present, click the Turnstile widget.
async function passChallenge(sess, timeoutMs = 90000) {
  const t0 = Date.now();
  const t = await sess.ev('document.title');
  if (t && t !== 'Just a moment...') return true;
  while (Date.now() - t0 < timeoutMs) {
    const box = await sess.ev(`(function(){ const d=document.getElementById('bstyI3'); if(!d) return null; const r=d.getBoundingClientRect(); return JSON.stringify([Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]) })()`);
    let left = -1, top = -1;
    if (box) { try { const b = JSON.parse(box); left = b[0]; top = b[1]; } catch {} }
    if (left >= 0) {
      const x = left + 14, y = top + 32;
      for (let i = 0; i < 5; i++) {
        await sess.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 24 + i * 4, y: y - 12 });
        await new Promise((r) => setTimeout(r, 30));
      }
      await sess.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await new Promise((r) => setTimeout(r, 120));
      await sess.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    }
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const tt = await sess.ev('document.title');
      if (tt && tt !== 'Just a moment...') return true;
    }
  }
  return false;
}

module.exports = { CDP_PORT, ensureChrome, getPage, dropWorker, navigate, passChallenge, cdp };
