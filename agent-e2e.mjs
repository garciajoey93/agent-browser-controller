import { runAgent } from '/Users/joey/apps/chrome-agent-extension/agent.mjs';
import WebSocket from 'ws';
import { setTimeout as wait } from 'node:timers/promises';

const log = (m) => console.log('[' + new Date().toISOString().slice(11, 19) + '] ' + m);

let nextId = 1;
const pending = new Map();

function callCtrl(action, params = {}, idemKey) {
  return new Promise((resolve, reject) => {
    const id = String(nextId++);
    const t = setTimeout(() => { pending.delete(id); reject(new Error('timeout: ' + action)); }, 8000);
    pending.set(id, { resolve, reject, t });
    const body = { id, action, params };
    if (idemKey) body.idempotencyKey = idemKey;
    ws.send(JSON.stringify(body));
  });
}

const ws = new WebSocket('ws://127.0.0.1:9223/ws');
let helloAck = null;
ws.on('open', () => ws.send(JSON.stringify({ role: 'client' })));
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'hello-ack') { helloAck = m; return; }
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id); p.resolve(m);
  }
});
await wait(300);
log('controller: ext=' + (helloAck && helloAck.extensionConnected));

// Mock LLM that returns a realistic 5-step plan
const steps = [
  { action: 'navigate', params: { url: 'https://en.wikipedia.org/wiki/Artificial_intelligence' }, thought: 'Start at the AI Wikipedia page' },
  { action: 'scroll', params: { direction: 'down', amount: 1000 }, thought: 'See more content' },
  { action: 'evaluate', params: { script: "document.title" }, thought: 'Get the current title to confirm we\'re on AI' },
  { action: 'scroll', params: { direction: 'down', amount: 1500 }, thought: 'See more' },
  { action: 'finish', params: { summary: 'Loaded AI Wikipedia page, scrolled through it, confirmed title. Found 3,219 words of content on the page.' }, thought: 'Done' },
];
let stepIdx = 0;
const llm = async () => {
  const s = steps[stepIdx++];
  if (!s) return '{"action":"finish","params":{"summary":"no more steps"}}';
  return JSON.stringify({ action: s.action, params: s.params, thought: s.thought });
};

// Mock controller that the agent talks to via WS
const mockController = {
  log: () => {},
  connect: async () => {},
  call: async (action, params) => {
    log('  → ' + action + ' ' + JSON.stringify(params).slice(0, 80));
    // The agent's call will go through the WS to the real controller.
    // Since the extension isn't connected, everything queues.
    return await callCtrl(action, params);
  },
  notify: () => true,
  close: () => { try { ws.close(); } catch {} },
};

log('=== autonomous agent: 5-step plan on AI Wikipedia ===');
const t0 = Date.now();
const report = await runAgent({
  goal: 'Open the AI Wikipedia page, scroll through it, and summarize what you find',
  startUrl: 'https://en.wikipedia.org/wiki/Artificial_intelligence',
  maxSteps: 8,
  _controller: mockController,
  _llmChat: llm,
  log,
});
const ms = Date.now() - t0;

log('');
log('=== AGENT REPORT ===');
log('goal:     ' + report.goal);
log('steps:    ' + report.steps);
log('summary:  ' + report.summary);
log('took:     ' + ms + 'ms');
log('history:  ' + report.history.length + ' action(s)');
for (const h of report.history.slice(0, 6)) {
  log('  - ' + h.action.action + ' ' + (h.result && h.result.ok ? '✓' : '✗'));
}
log('controller actions queued: ' + report.history.length);
process.exit(0);
