import WebSocket from 'ws';
import { setTimeout as wait } from 'node:timers/promises';

const ws = new WebSocket('ws://127.0.0.1:9223/ws');
let nextId = 1;
const pending = new Map();
ws.on('open', () => ws.send(JSON.stringify({ role: 'client' })));
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'hello-ack') { return; }
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id); p.resolve(m);
  }
});
await wait(300);

function call(idem) {
  return new Promise((resolve, reject) => {
    const id = String(nextId++);
    const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, 5000);
    pending.set(id, { resolve, reject, t });
    ws.send(JSON.stringify({ id, action: 'tabs', params: {}, idempotencyKey: idem }));
  });
}

// Fire 100 with the same idem key (should all be rate limited after 30)
const results = await Promise.all(Array.from({length: 100}, (_, i) => call('idem-' + i).catch(e => ({error: e.message}))));
const errorKinds = {};
for (const r of results) {
  const key = r.errorCode || (r.error ? r.error.slice(0, 30) : 'ok');
  errorKinds[key] = (errorKinds[key] || 0) + 1;
}
console.log('100 actions (different idem keys):');
console.log('  breakdown:', JSON.stringify(errorKinds));
console.log('  first 5:', JSON.stringify(results.slice(0, 5)));
console.log('  any rate-limited:', results.filter(r => r.errorCode === 'RATE_LIMITED').length);
process.exit(0);
