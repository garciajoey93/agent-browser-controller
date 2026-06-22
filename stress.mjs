import WebSocket from 'ws';
import { setTimeout as wait } from 'node:timers/promises';

const log = (m) => console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + m);

function makeClient() {
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://127.0.0.1:9223/ws');
    let nextId = 1;
    const pending = new Map();
    ws.on('open', () => ws.send(JSON.stringify({ role: 'client' })));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'hello-ack') { resolve({ ws, nextId, pending }); return; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id); p.resolve(m);
      }
    });
  });
}

function call(client, action, params = {}, idemKey) {
  return new Promise((resolve, reject) => {
    const id = String(client.nextId++);
    const t = setTimeout(() => { client.pending.delete(id); reject(new Error('timeout')); }, 5000);
    client.pending.set(id, { resolve, reject, t });
    const body = { id, action, params };
    if (idemKey) body.idempotencyKey = idemKey;
    client.ws.send(JSON.stringify(body));
  });
}

log('=== STRESS TEST: 5 clients × 40 actions = 200 actions, limit 30 per client ===');
const N_CLIENTS = 5, N_ACTIONS = 40;
const t0 = Date.now();
const clients = [];
for (let i = 0; i < N_CLIENTS; i++) clients.push(await makeClient());
log(`${N_CLIENTS} clients connected`);

const allPromises = [];
const perClientResults = [];
for (let c = 0; c < N_CLIENTS; c++) {
  const promises = [];
  for (let a = 0; a < N_ACTIONS; a++) {
    // Mix of action types
    const action = ['tabs', 'find_tab', 'set_status', 'agent_status'][a % 4];
    const idem = 'c' + c + 'a' + a;
    promises.push(call(clients[c], action, {}, idem).catch(e => ({ error: e.message })));
  }
  perClientResults.push(Promise.all(promises));
}
const allResults = (await Promise.all(perClientResults)).flat();
const ms = Date.now() - t0;

let total = 0, queued = 0, limited = 0, errors = 0, replays = 0;
for (const r of allResults) {
  total++;
  if (!r) errors++;
  else if (r.queued) queued++;
  else if (r.errorCode === 'RATE_LIMITED') limited++;
  else if (r._idempotent_replay) replays++;
  else if (r.error) errors++;
}

const perClientCounts = [];
for (let c = 0; c < N_CLIENTS; c++) {
  const rs = allResults.slice(c * N_ACTIONS, (c + 1) * N_ACTIONS);
  const lim = rs.filter(r => r && r.errorCode === 'RATE_LIMITED').length;
  const qd = rs.filter(r => r && r.queued).length;
  perClientCounts.push({ client: c, queued: qd, limited: lim });
}

log('');
log('=== RESULTS ===');
log('total:        ' + total);
log('queued:       ' + queued);
log('rate_limited: ' + limited);
log('replays:      ' + replays);
log('errors:       ' + errors);
log('time:         ' + ms + 'ms (' + Math.round(total / (ms / 1000)) + ' actions/sec)');
log('');
log('per-client:');
for (const c of perClientCounts) {
  log('  client ' + c.client + ': queued=' + c.queued + ' rate_limited=' + c.limited);
}

log('');
log('=== METRICS ===');
const metrics = await fetch('http://127.0.0.1:9223/metrics').then(r => r.text());
log(metrics.split('\n').slice(0, 8).join('\n'));

for (const c of clients) try { c.ws.close(); } catch {}
process.exit(0);
