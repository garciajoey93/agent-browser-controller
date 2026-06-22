import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:9223/ws');
let nextId = 1;
const pending = new Map();
let helloAck = null;
ws.on('open', () => ws.send(JSON.stringify({ role: 'client' })));
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'hello-ack') { helloAck = m; return; }
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id); p.resolve(m);
  }
});
function call(action, params={}) {
  return new Promise((resolve, reject) => {
    const id = String(nextId++);
    const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, 8000);
    pending.set(id, { resolve, reject, t });
    ws.send(JSON.stringify({ id, action, params }));
  });
}
(async () => {
  while (!helloAck) await new Promise(r => setTimeout(r, 100));
  console.log('hello: ext=' + helloAck.extensionConnected);
  const actions = ['tabs', 'inspect', 'find_tab'];
  for (const a of actions) {
    try {
      const r = await call(a, {});
      const summary = JSON.stringify(r).slice(0, 200);
      console.log(a + ': ' + summary);
    } catch (e) {
      console.log(a + ': ERROR ' + e.message);
    }
  }
  process.exit(0);
})();
