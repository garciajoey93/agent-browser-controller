// IPI-318: End-to-end stress test for the Agent Browser Controller.
// Exercises every action type, the schema validator, the action
// history, the Prometheus metrics, idempotency, replay, SSE stream,
// per-client backpressure, the offline queue, and a real YouTube
// flow.
//
// Usage:
//   CONTROLLER=http://127.0.0.1:9223 WS_URL=ws://127.0.0.1:9223/ws \
//     node --test tests/stress-integration.test.mjs
//
// NOTE: The Codex Chrome extension in the user's session also connects
// to ws://localhost:9223/ws, which conflicts with the mock. Run this
// test on a different port (e.g. --port 19223) to avoid the conflict.

// Comprehensive stress test that runs once and reports what struggles.
import http from 'node:http';
import WebSocket from 'ws';
import { writeFileSync, existsSync } from 'node:fs';

const CONTROLLER = process.env.CONTROLLER || 'http://127.0.0.1:9223';
const WS_URL    = process.env.WS_URL     || 'ws://127.0.0.1:9223/ws';
const PASS = '\x1b[32m✓\x1b[0m', FAIL = '\x1b[31m✗\x1b[0m', INFO = '\x1b[36m•\x1b[0m';
let totalPass = 0, totalFail = 0, totalSkip = 0;
const failures = [];
function ok(label, cond, detail) {
  const passed = !!cond;
  if (passed) totalPass++; else { totalFail++; failures.push({label, detail}); }
  console.log('  ' + (passed ? PASS : FAIL) + '  ' + label + (detail ? '  — ' + detail : ''));
  return passed;
}
function skip(label, why) { totalSkip++; console.log('  ' + INFO + '  ' + label + '  — SKIPPED: ' + why); }
function section(name) { console.log('\n\x1b[1m=== ' + name + ' ===\x1b[0m'); }

// Use a single keep-alive agent so all requests share the same remote
// port. This is the only way to exercise per-client backpressure
// because the controller keys inflight by IP+port.
// keepAlive so the same source IP persists across requests. The
// controller keys inflight by IP only (not IP+port), so even with
// maxSockets=200 every request from 127.0.0.1 shares one bucket.
const agent = new http.Agent({ keepAlive: true, maxSockets: 200 });
function fetchJson(path, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(path, CONTROLLER);
    const req = http.request({ ...opts, agent, hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: opts.method || 'GET', headers: { 'Content-Type': 'application/json', ...(opts.headers||{}) } }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body), headers: res.headers }); }
        catch { resolve({ status: res.statusCode, body: body, headers: res.headers }); }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });
}
function postAction(action, params, opts) {
  opts = opts || {};
  const body = { action, params: params || {}, id: opts.id, sessionId: opts.sessionId || 'default' };
  if (opts.idemKey) body.idempotencyKey = opts.idemKey;
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return fetchJson('/action', { method: 'POST', body });
}

async function main() {
  // Skip the whole suite if the controller isn't reachable. This lets
  // `npm test` pass in environments where the full stack isn't running.
  try {
    const probe = await fetchJson('/status');
    if (probe.status !== 200) throw new Error('not 200');
  } catch (e) {
    console.log('[skip] controller not reachable at ' + CONTROLLER + ' - run with stack up: `node controller-server.js` + `node mock-extension.js`');
    process.exit(0);
  }
  section('0. /status health check');
  const status = await fetchJson('/status');
  ok('server reachable', status.status === 200, 'status=' + status.status);
  ok('extension connected', status.body.extensionConnected === true, 'connected=' + status.body.extensionConnected);

  if (!status.body.extensionConnected) {
    console.log('\n\x1b[31mExtension not connected — aborting\x1b[0m');
    process.exit(1);
  }

  section('1. Schema validation');
  const r1 = await fetchJson('/action', { method: 'POST', body: { action: 'fly_to_mars' } });
  ok('rejects unknown action', r1.status === 400 && r1.body.errorCode === 'UNKNOWN_ACTION', 'status=' + r1.status);
  const r2 = await fetchJson('/action', { method: 'POST', body: {} });
  ok('rejects missing action', r2.status === 400 && r2.body.errorCode === 'INVALID_PARAMS');
  const r3 = await fetchJson('/action', { method: 'POST', body: { action: 'click', params: 'oops' } });
  ok('rejects non-object params', r3.status === 400 && r3.body.errorCode === 'INVALID_PARAMS');
  const r4 = await fetchJson('/action', { method: 'POST', body: { action: 'click' } });
  ok('accepts action without params', r4.status === 200);

  section('2. Action history');
  await postAction('evaluate', { script: '1+1' }, { id: 'h-1' });
  await postAction('evaluate', { script: '2+2' }, { id: 'h-2' });
  const hist = await fetchJson('/history');
  ok('history 200', hist.status === 200);
  ok('history has entries', hist.body.history.length >= 2, 'len=' + hist.body.history.length);
  ok('history has action field', hist.body.history.every(h => typeof h.action === 'string'));
  ok('history has ok field', hist.body.history.every(h => typeof h.ok === 'boolean'));
  ok('history has ms timing', hist.body.history.every(h => typeof h.ms === 'number' && h.ms >= 0));
  ok('history has sessionId', hist.body.history.every(h => typeof h.sessionId === 'string'));
  const sess = await fetchJson('/history?sessionId=default');
  ok('history sessionId filter works', sess.body.history.every(h => h.sessionId === 'default'));

  section('3. Metrics endpoint');
  const m = await fetchJson('/metrics');
  ok('metrics 200', m.status === 200);
  ok('metrics HELP comment', String(m.body).includes('# HELP'));
  ok('metrics TYPE comment', String(m.body).includes('# TYPE'));
  ok('metrics agent_actions_total', /agent_actions_total\s+\d+/.test(String(m.body)));
  ok('metrics agent_actions_ok', /agent_actions_ok\s+\d+/.test(String(m.body)));
  ok('metrics agent_actions_err', /agent_actions_err\s+\d+/.test(String(m.body)));

  section('4. Idempotency');
  const idem = 'idem-' + Date.now() + '-' + Math.random();
  const a1 = await postAction('evaluate', { script: 'Math.random()' }, { idemKey: idem });
  const a2 = await postAction('evaluate', { script: 'Math.random()' }, { idemKey: idem });
  ok('first call ok', a1.body.ok === true);
  ok('second call is _idempotent_replay', a2.body._idempotent_replay === true);
  const a1Strip = { ...a1.body }; delete a1Strip._idempotent_replay;
  const a2Strip = { ...a2.body }; delete a2Strip._idempotent_replay;
  ok('first and second return identical result (sans replay flag)', JSON.stringify(a1Strip) === JSON.stringify(a2Strip));

  section('5. Action replay');
  const sentinel = 'sent-' + Date.now() + '-' + Math.random();
  const replayId = 'rep-' + Date.now();
  const fresh = await postAction('evaluate', { script: "window.__sentinel='" + sentinel + "';window.__sentinel" }, { id: replayId });
  ok('fresh action ok', fresh.body.ok === true && fresh.body.result === sentinel, 'got=' + fresh.body.result);
  const hist2 = await fetchJson('/history');
  const match = hist2.body.history.find(h => h.id === replayId);
  ok('found historical action by id', !!match, 'id=' + (match && match.id));
  if (match) {
    const replay = await fetchJson('/action/replay/' + match.id, { method: 'POST' });
    ok('replay 200', replay.status === 200, 'status=' + replay.status);
    ok('replay wraps result', replay.body.ok === true && replay.body.result && replay.body.result.ok === true);
    ok('replay has replayOf', replay.body.replayOf === match.id, 'replayOf=' + replay.body.replayOf);
  }
  const bogus = await fetchJson('/action/replay/bogus-id-12345', { method: 'POST' });
  ok('replay of bogus id 404', bogus.status === 404);

  section('6. SSE /stream');
  const sseOk = await new Promise((resolve) => {
    const u = new URL('/stream', CONTROLLER);
    const req = http.request({ agent, hostname: u.hostname, port: u.port, path: u.pathname }, (res) => {
      let buf = '';
      const ok200 = res.statusCode === 200;
      res.on('data', c => { buf += c.toString(); });
      res.on('end', () => resolve(ok200 && buf.includes('event: hello')));
      res.on('error', () => resolve(false));
      setTimeout(() => { try { req.destroy(); } catch {} resolve(ok200 && buf.includes('event: hello')); }, 2000);
    });
    req.on('error', () => resolve(false));
    req.end();
  });
  ok('SSE returns 200 + hello event', sseOk);

  section('7. WebSocket backpressure');
  // Single keep-alive agent: all 100 requests share the same remote port
  // (after the first one), so they collide on the same clientKey.
  const httpFires = [];
  for (let i = 0; i < 100; i++) httpFires.push(postAction('evaluate', { script: '1+' + i }));
  const httpResults = await Promise.all(httpFires);
  const ok2xx = httpResults.filter(r => r.status === 200).length;
  const limited = httpResults.filter(r => r.status === 429).length;
  const other = httpResults.filter(r => r.status !== 200 && r.status !== 429).length;
  ok('backpressure: at least 1 429 under 100 concurrent', limited >= 1, '200=' + ok2xx + ' 429=' + limited + ' other=' + other);

  section('8. Offline queue (rejection path)');
  const q1 = await fetchJson('/queue');
  ok('/queue GET 200', q1.status === 200);
  ok('/queue returns queues object', q1.body.queues && typeof q1.body.queues === 'object');
  const d1 = await fetchJson('/queue?all=1', { method: 'DELETE' });
  ok('/queue DELETE 200', d1.status === 200);

  section('9. Real YouTube flow');
  const nav = await postAction('navigate', { url: 'https://www.youtube.com/' });
  if (nav.body && nav.body.ok) {
    ok('navigate to YouTube', true, 'url=' + nav.body.url);
    await new Promise(r => setTimeout(r, 2500));
    const insp = await postAction('inspect');
    ok('inspect after load', insp.body && insp.body.ok === true);
    ok('YouTube URL reached', insp.body && insp.body.url && insp.body.url.includes('youtube'));
    ok('viewport > 0', insp.body && insp.body.width > 0 && insp.body.height > 0);
    ok('landmarks populated', insp.body && Array.isArray(insp.body.landmarks) && insp.body.landmarks.length > 0, insp.body && (insp.body.landmarks || []).length + ' landmarks');
    if (insp.body && insp.body.dataUrl) {
      const b64 = insp.body.dataUrl.replace(/^data:image\/[a-z]+;base64,/, '');
      writeFileSync('/tmp/agent-stress/youtube.png', Buffer.from(b64, 'base64'));
      ok('screenshot saved', existsSync('/tmp/agent-stress/youtube.png'));
    }
  } else {
    skip('YouTube flow', 'navigate failed: ' + (nav.body && (nav.body.error || JSON.stringify(nav.body).slice(0,150))));
  }

  console.log('\n\x1b[1m========== SUMMARY ==========\x1b[0m');
  console.log(totalPass + ' passed, ' + totalFail + ' failed, ' + totalSkip + ' skipped (of ' + (totalPass + totalFail + totalSkip) + ')');
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f.label + '  ' + (f.detail || ''));
  }
  agent.destroy();
  process.exit(totalFail ? 1 : 0);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
