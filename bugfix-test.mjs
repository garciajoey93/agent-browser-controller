import WebSocket from 'ws';
import { setTimeout as wait } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

let nextId = 1;
const pending = new Map();

async function call(ws, action, params = {}, idemKey) {
  return new Promise((resolve, reject) => {
    const id = String(nextId++);
    const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout: ' + action)); }, 8000);
    pending.set(id, { resolve, reject, t });
    const body = { id, action, params };
    if (idemKey) body.idempotencyKey = idemKey;
    ws.send(JSON.stringify(body));
  });
}
function makeClient() {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:9223/ws');
    let ready = false;
    ws.on('open', () => { ws.send(JSON.stringify({ role: 'client' })); });
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'hello-ack' && !ready) { ready = true; resolve(ws); return; }
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p.resolve(m); }
    });
  });
}

const log = (m) => console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + m);

// Test A: Idempotency for queued
log('=== A. Idempotency for queued actions ===');
const ws1 = await makeClient();
const idemKey = 'test-idem-' + Date.now();
const r1 = await call(ws1, 'tabs', {}, idemKey);
log('first:  queued=' + r1.queued + ' id=' + r1.id + ' position=' + r1.position);
const r2 = await call(ws1, 'tabs', {}, idemKey);
log('second: queued=' + r2.queued + ' id=' + r2.id + ' position=' + r2.position + ' replay=' + r2._idempotent_replay);
// The replay returns the cached data but with the NEW msg.id (so the
// caller's pending map can find it). The replay flag is what tells the
// caller it was a cached response, not a fresh one.
const ok1 = r1.position === r2.position && r2._idempotent_replay === true;
log('result: ' + (ok1 ? '✓ PASS' : '✗ FAIL'));
ws1.close();
await wait(200);

// Test B: Replay for queued
log('');
log('=== B. /action/replay/:id for queued actions ===');
const r3 = await fetch('http://127.0.0.1:9223/action', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ action: 'tabs' })
}).then(r => r.json());
log('first action: id=' + r3.id + ' queued=' + r3.queued);
const replay = await fetch('http://127.0.0.1:9223/action/replay/' + r3.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(r => r.json());
log('replay: source=' + replay.source + ' result.queued=' + (replay.result && replay.result.queued));
const ok2 = replay.source === 'queue' && replay.result && replay.result.queued;
log('result: ' + (ok2 ? '✓ PASS' : '✗ FAIL'));

// Test C: Rate limit on WS
log('');
log('=== C. Rate limit on WS path (limit 5) ===');
// Restart controller with limit 5
const { execSync } = await import('node:child_process');
execSync('pkill -f "node controller-server" || true');
await wait(500);
const { spawn } = await import('node:child_process');
const cproc = spawn('node', ['controller-server.js'], { env: { ...process.env, MAX_INFLIGHT_PER_CLIENT: '5' }, cwd: '/Users/joey/apps/chrome-agent-extension', stdio: 'ignore', detached: true });
cproc.unref();
await wait(1500);
const ws2 = await makeClient();
await wait(200);
const results = await Promise.all(Array.from({ length: 15 }, () => call(ws2, 'tabs', {}).catch(e => ({ error: e.message }))));
const limited = results.filter(r => r && r.errorCode === 'RATE_LIMITED').length;
const queued = results.filter(r => r && r.queued).length;
log('total=' + results.length + ' queued=' + queued + ' rate_limited=' + limited);
const ok3 = limited > 0;
log('result: ' + (ok3 ? '✓ PASS' : '✗ FAIL'));
ws2.close();
await wait(200);

// Test D: WS auth for all roles
log('');
log('=== D. WS auth for all roles ===');
execSync('pkill -f "node controller-server" || true');
await wait(500);
const cproc2 = spawn('node', ['controller-server.js'], { env: { ...process.env, CONTROLLER_AUTH_TOKEN: 'secret' }, cwd: '/Users/joey/apps/chrome-agent-extension', stdio: 'ignore', detached: true });
cproc2.unref();
await wait(1500);
let ws3 = new WebSocket('ws://127.0.0.1:9223/ws');
await new Promise((r) => ws3.once('open', r));
ws3.on('close', (code, reason) => { globalThis._closeInfo = code + ' ' + reason.toString(); });
ws3.on('error', (e) => { globalThis._closeInfo = 'error: ' + e.message; });
ws3.send(JSON.stringify({ role: 'client', auth: 'WRONG' }));
await wait(500);
log('wrong token close: ' + globalThis._closeInfo);
const ok4 = globalThis._closeInfo && globalThis._closeInfo.indexOf('1008') >= 0;
log('result: ' + (ok4 ? '✓ PASS' : '✗ FAIL'));
ws3.close();

// Cleanup
execSync('pkill -f "node controller-server" || true');
await wait(500);
spawn('node', ['controller-server.js'], { cwd: '/Users/joey/apps/chrome-agent-extension', stdio: 'ignore', detached: true }).unref();
process.exit(0);
