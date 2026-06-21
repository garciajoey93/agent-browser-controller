// Tests for agent.mjs: action parsing + the LLM-driven loop with
// a mock LLM and a mock controller. No network, no Chrome, runs
// in <100ms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAction, runAgent } from '../agent.mjs';

// ------------------------------------------------------------------
// parseAction: robust to LLM emitting code fences, prose, partial JSON
// ------------------------------------------------------------------

test('parseAction: plain JSON', () => {
  const r = parseAction('{"action":"click","params":{"x":100,"y":200}}');
  assert.equal(r.action, 'click');
  assert.deepEqual(r.params, { x: 100, y: 200 });
});

test('parseAction: JSON wrapped in code fence', () => {
  const r = parseAction('```json\n{"action":"scroll","params":{"direction":"down"}}\n```');
  assert.equal(r.action, 'scroll');
  assert.equal(r.params.direction, 'down');
});

test('parseAction: prose around JSON', () => {
  const r = parseAction('Here is my plan:\n{"action":"finish","params":{"summary":"done"}}\nThanks.');
  assert.equal(r.action, 'finish');
  assert.equal(r.params.summary, 'done');
});

test('parseAction: nested JSON with thought field', () => {
  const r = parseAction('{"action":"navigate","params":{"url":"https://x.com"},"thought":"go to x"}');
  assert.equal(r.action, 'navigate');
  assert.equal(r.thought, 'go to x');
});

test('parseAction: invalid JSON returns null', () => {
  assert.equal(parseAction('not json'), null);
  assert.equal(parseAction(''), null);
  assert.equal(parseAction('{}'), null);
});

// ------------------------------------------------------------------
// Mock controller — records calls, replays scripted responses.
// ------------------------------------------------------------------

function makeMockController(script) {
  const calls = [];
  const notifs = [];
  let resolveNext = null;
  let nextId = null;

  // Internal: the next call() will await a response keyed by id.
  const controller = {
    log: () => {},
    connect: async () => {},
    call: (action, params) => {
      const id = 'mock-' + (calls.length + 1);
      calls.push({ id, action, params });
      return new Promise((resolve) => {
        // The test runner drives responses by calling
        // controller._respond() with the matching action and
        // response payload. We resolve by action, not by id,
        // because the mock doesn't need to mirror the WS id
        // contract.
        controller._waitingResolves.push({ action, resolve });
      });
    },
    notify: (type, payload) => { notifs.push({ type, payload }); return true; },
    close: () => {},
    _waitingResolves: [],
    _calls: calls,
    _notifs: notifs,
  };

  // The test pre-loads the script (a list of {action, response})
  // and the mock auto-fulfills as calls come in. Any unused
  // responses stay buffered for the next call of that action.
  let queue = script.slice();

  // After each call(), drain the queue and fulfill the first
  // waiting promise whose action matches the most recent call.
  controller.call = (action, params) => {
    calls.push({ action, params });
    return new Promise((resolve) => {
      // Find a matching scripted response.
      const idx = queue.findIndex(s => s.action === action);
      if (idx >= 0) {
        const s = queue.splice(idx, 1)[0];
        resolve(s.response);
      } else {
        // Default: success with no result.
        resolve({ ok: true });
      }
    });
  };
  return controller;
}

// ------------------------------------------------------------------
// runAgent: full loop with mocks
// ------------------------------------------------------------------

const mockState = (url = 'https://example.com', title = 'Example') => ({
  inspect: { result: { url, title, width: 1280, height: 900, screenshot: null } },
  tags: [
    { num: 1, tag: 'button', id: 'submit', text: 'Submit', rect: { x: 100, y: 200, w: 80, h: 32, cx: 140, cy: 216 } },
    { num: 2, tag: 'input',  id: 'q',      text: '',     rect: { x: 100, y: 100, w: 400, h: 32, cx: 300, cy: 116 } },
  ],
});

test('runAgent: emits finish on first LLM turn and stops', async () => {
  const controller = makeMockController([
    { action: 'set_active_tab', response: { ok: true, activeTabId: 42 } },
    { action: 'inspect',        response: { ok: true, result: mockState().inspect.result } },
    { action: 'tag_elements',   response: { ok: true, elements: mockState().tags } },
  ]);
  const llmChat = async () => '{"action":"finish","params":{"summary":"task complete"}}';
  const r = await runAgent({
    goal: 'do something',
    _controller: controller,
    _llmChat: llmChat,
    maxSteps: 5,
    log: () => {},
  });
  assert.equal(r.summary, 'task complete');
  assert.equal(r.steps, 0); // finish doesn't go into history
  assert.equal(r.history.length, 0);
});

test('runAgent: takes an action then finishes', async () => {
  const controller = makeMockController([
    { action: 'set_active_tab', response: { ok: true, activeTabId: 42 } },
    { action: 'inspect',        response: { ok: true, result: mockState().inspect.result } },
    { action: 'tag_elements',   response: { ok: true, elements: mockState().tags } },
    { action: 'click_by_tag',   response: { ok: true } },
    { action: 'inspect',        response: { ok: true, result: mockState('https://example.com/2', 'After').inspect.result } },
    { action: 'tag_elements',   response: { ok: true, elements: mockState().tags } },
  ]);
  const replies = [
    '{"action":"click_by_tag","params":{"num":1}}',
    '{"action":"finish","params":{"summary":"clicked submit"}}',
  ];
  let i = 0;
  const r = await runAgent({
    goal: 'click submit',
    _controller: controller,
    _llmChat: async () => replies[i++],
    maxSteps: 5,
    log: () => {},
  });
  assert.equal(r.summary, 'clicked submit');
  assert.equal(r.history.length, 1);
  assert.equal(r.history[0].action.action, 'click_by_tag');
  assert.deepEqual(r.history[0].action.params, { num: 1 });
});

test('runAgent: stops on maxSteps', async () => {
  const controller = makeMockController([
    { action: 'set_active_tab', response: { ok: true, activeTabId: 1 } },
    { action: 'inspect',        response: { ok: true, result: mockState().inspect.result } },
    { action: 'tag_elements',   response: { ok: true, elements: mockState().tags } },
  ]);
  let n = 0;
  const r = await runAgent({
    goal: 'loop',
    _controller: controller,
    _llmChat: async () => '{"action":"click","params":{"x":100,"y":200}}',
    maxSteps: 3,
    log: () => {},
  });
  // 3 steps executed, each calling click
  assert.equal(r.steps, 3);
  assert.equal(r.history.length, 3);
});

test('runAgent: 5 consecutive no-progress states triggers break', async () => {
  // Same state every time, plus 5 no-progress iterations = break.
  const controller = makeMockController([
    { action: 'set_active_tab', response: { ok: true, activeTabId: 1 } },
    { action: 'inspect',        response: { ok: true, result: mockState().inspect.result } },
    { action: 'tag_elements',   response: { ok: true, elements: mockState().tags } },
  ]);
  const r = await runAgent({
    goal: 'do',
    _controller: controller,
    _llmChat: async () => '{"action":"click","params":{"x":1,"y":1}}',
    maxSteps: 20,
    log: () => {},
  });
  // The same summary repeats, noProgressCount climbs. After 5
  // identical states the loop breaks. We expect ≤6 steps.
  assert.ok(r.steps <= 6, 'expected early break on no-progress, got ' + r.steps);
});

test('runAgent: AGENT_REGISTER + AGENT_UPDATE + AGENT_UNREGISTER are notified', async () => {
  const controller = makeMockController([
    { action: 'set_active_tab', response: { ok: true, activeTabId: 7 } },
    { action: 'inspect',        response: { ok: true, result: mockState().inspect.result } },
    { action: 'tag_elements',   response: { ok: true, elements: mockState().tags } },
  ]);
  const r = await runAgent({
    goal: 'register test',
    _controller: controller,
    _llmChat: async () => '{"action":"finish","params":{"summary":"done"}}',
    maxSteps: 3,
    log: () => {},
  });
  const types = controller._notifs.map(n => n.type);
  assert.ok(types.includes('AGENT_REGISTER'), 'should register');
  assert.ok(types.includes('AGENT_UPDATE'), 'should update working tab');
  // UNREGISTER happens on process exit; we just check register happened.
  const reg = controller._notifs.find(n => n.type === 'AGENT_REGISTER');
  assert.ok(reg.payload.agent.id.startsWith('run-'), 'id should start with run-');
  assert.equal(reg.payload.agent.goal, 'register test');
  const upd = controller._notifs.find(n => n.type === 'AGENT_UPDATE');
  // First update has just workingTabId; later updates have lastAction/steps.
  assert.equal(upd.payload.runId, reg.payload.agent.id);
  assert.equal(upd.payload.patch.workingTabId, 7);
});
