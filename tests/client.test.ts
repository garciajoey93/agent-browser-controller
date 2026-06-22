// TypeScript test for the typed client. Compiled and run with tsx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentControllerClient } from '../client';
import { KNOWN_ACTIONS, type ActionName } from '../types';

test('TS client: KNOWN_ACTIONS has 44 entries', () => {
  assert.equal(KNOWN_ACTIONS.length, 44);
});

test('TS client: all action names are valid ActionName type', () => {
  for (const a of KNOWN_ACTIONS) {
    // The type-check happens at compile time; at runtime we just
    // verify the entries are non-empty strings.
    assert.equal(typeof a, 'string');
    assert.ok((a as string).length > 0);
  }
});

test('TS client: connect to controller works', async () => {
  const c = new AgentControllerClient({ url: 'ws://127.0.0.1:9223/ws' });
  try {
    const hello = await c.connect();
    assert.equal(hello.ok, true);
    assert.equal(typeof hello.extensionConnected, 'boolean');
    const r = await c.call('tabs');
    // With the extension disconnected, the action is queued.
    assert.equal(r.ok, true);
    assert.equal(r.queued, true);
    c.close();
  } catch (e) {
    c.close();
    // If controller isn't running, the test is environment-dependent.
    // Skip rather than fail.
    if ((e as Error).message.includes('ECONNREFUSED')) {
      console.log('  (skipped — controller not running)');
      return;
    }
    throw e;
  }
});

test('TS client: type-safe parameter helpers', () => {
  // Compile-time check: this only compiles if ActionName is properly typed.
  const actions: ActionName[] = [
    'click', 'type', 'screenshot', 'tabs', 'navigate', 'press_key',
    'tag_elements', 'click_by_tag', 'agent_start', 'agent_status',
  ];
  assert.equal(actions.length, 10);
  for (const a of actions) {
    assert.ok(KNOWN_ACTIONS.includes(a), 'should be in KNOWN_ACTIONS: ' + a);
  }
});
