#!/usr/bin/env node
/* =============================================================
 * agent.mjs — Autonomous LLM-driven browser agent.
 *
 * The agent takes a natural-language goal (e.g. "find 10 businesses
 * in Jonesboro GA that need a website") and runs a loop:
 *
 *   1. capture state  — screenshot + DOM landmarks + URL + tags
 *   2. ask LLM         — send the state + the goal to MiniMax M3
 *                        (or any OpenAI-compatible endpoint) with
 *                        a system prompt that says "respond with
 *                        a JSON action"
 *   3. execute         — send the action to the controller, which
 *                        routes it to the extension
 *   4. repeat          — until the LLM emits {"action":"finish"} or
 *                        the step budget is exhausted
 *
 * The agent runs in the user's existing Chrome (via the extension),
 * not headless. It can:
 *   - Create a new tab to work in (so the user doesn't have to
 *     watch)
 *   - Pin its activeTabId even if the user switches tabs
 *   - Stream a live log via the controller's WebSocket
 *   - Write a final report to a file the user can read later
 *
 * Two ways to invoke:
 *   - From the popup: "Run agent" panel
 *   - From the CLI:   `npm run agent -- "your goal here"`
 *
 * LLM provider is auto-detected from env:
 *   - MINIMAX_API_KEY → https://api.minimax.chat/v1/chat/completions
 *   - OPENAI_API_KEY  → https://api.openai.com/v1/chat/completions
 *     (override with OPENAI_BASE_URL for any compatible endpoint)
 *   - LLM_PROXY=1     → use the controller's /llm proxy endpoint
 *     (lets a user run the agent without exposing the API key
 *     in the Node process — the key stays in the extension's
 *     storage)
 * ============================================================= */

import WebSocket from 'ws';
import { writeFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------
// LLM client — auto-detects MiniMax M3 or OpenAI-compatible
// ------------------------------------------------------------------

function pickLlmConfig() {
  // Proxy mode: use the controller's /llm endpoint. The extension
  // holds the actual API key in its storage; the agent sends plain
  // HTTP to localhost and never sees the key.
  if (process.env.LLM_PROXY === '1' || process.env.LLM_PROXY === 'true') {
    const port = process.env.CONTROLLER_PORT || '9223';
    return {
      provider: 'proxy',
      url: `http://127.0.0.1:${port}/llm`,
      model: process.env.LLM_MODEL || 'minimax/minimax-m3',
      headers: { 'Content-Type': 'application/json' },
    };
  }
  if (process.env.MINIMAX_API_KEY) {
    const base = process.env.MINIMAX_BASE_URL || 'https://api.minimax.chat';
    return {
      provider: 'minimax',
      url: `${base}/v1/chat/completions`,
      model: process.env.LLM_MODEL || 'minimax/minimax-m3',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.MINIMAX_API_KEY}`,
      },
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: 'openai',
      url: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions',
      model: process.env.LLM_MODEL || 'gpt-4o-mini',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    // Claude is OpenAI-compatible via /v1/messages? No — but the
    // OpenAI-compatible Anthropic proxy works. Document it: set
    // OPENAI_BASE_URL to your anthropic-compatible gateway.
    return {
      provider: 'openai',
      url: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions',
      model: process.env.LLM_MODEL || 'gpt-4o-mini',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.ANTHROPIC_API_KEY}`,
      },
    };
  }
  throw new Error('No LLM credentials found. Set MINIMAX_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, or LLM_PROXY=1.');
}

async function llmChat(cfg, messages, opts = {}) {
  const body = {
    model: cfg.model,
    messages,
    temperature: opts.temperature ?? 0.2,
    max_tokens:  opts.max_tokens ?? 1024,
  };
  if (opts.json) {
    body.response_format = { type: 'json_object' };
  }
  const res = await fetch(cfg.url, { method: 'POST', headers: cfg.headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM ${res.status}: ${text.slice(0, 500)}`);
  }
  const json = await res.json();
  return json.choices?.[0]?.message?.content || '';
}

// ------------------------------------------------------------------
// Controller WebSocket client
// ------------------------------------------------------------------

class Controller {
  constructor({ url, log = () => {} }) {
    this.url = url;
    this.log = log;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.role = null;
    this.connected = false;
    this.events = [];
    this.eventHandlers = new Set();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const t = setTimeout(() => reject(new Error('controller WS timeout')), 8000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ role: 'agent', version: 'agent.mjs-1.0' }));
      });
      ws.on('message', (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (!this.role) {
          if (msg.type === 'hello-ack') {
            this.role = 'agent';
            clearTimeout(t);
            this.connected = true;
            this.log('info', 'controller connected');
            resolve(msg);
            return;
          }
        }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          p.resolve(msg);
        } else if (msg.type === 'event') {
          this.events.push(msg);
          for (const h of this.eventHandlers) h(msg);
        }
      });
      ws.on('close', () => {
        this.connected = false;
        this.log('warn', 'controller disconnected');
      });
      ws.on('error', (e) => { this.log('error', 'ws error: ' + e.message); reject(e); });
    });
  }

  call(action, params = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this.connected || !this.ws) return reject(new Error('not connected'));
      const id = String(this.nextId++);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('controller call timeout: ' + action));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, action });
      this.ws.send(JSON.stringify({ id, action, params }));
    });
  }

  // Fire-and-forget control message (no id, no response awaited).
  notify(type, payload = {}) {
    if (!this.connected || !this.ws) return false;
    try { this.ws.send(JSON.stringify(Object.assign({ type }, payload))); return true; }
    catch { return false; }
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}

// ------------------------------------------------------------------
// System prompt — turn the LLM into a focused action emitter
// ------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an autonomous browser agent. You control a real Chrome browser via JSON actions. You will receive a goal, a screenshot of the current page, and a list of visible interactive elements with numeric tags. Respond with a SINGLE JSON object in this exact shape:

{"action": "<one of: navigate, click, click_by_tag, type, type_by_tag, scroll, hover, finish, evaluate, wait>", "params": {...}, "thought": "one short sentence about why"}

Action reference:
- {"action":"navigate","params":{"url":"https://example.com"}}
- {"action":"click","params":{"x":500,"y":300,"button":"left"}}       — viewport CSS pixels
- {"action":"click_by_tag","params":{"num":3}}                       — pick the element with visible tag [3]
- {"action":"type","params":{"x":500,"y":300,"text":"hello","pressEnter":false}}
- {"action":"type_by_tag","params":{"num":2,"text":"hello"}}
- {"action":"scroll","params":{"direction":"down","amount":600}}     — direction: up|down|left|right
- {"action":"hover","params":{"x":500,"y":300}}
- {"action":"evaluate","params":{"script":"return document.title"}}
- {"action":"wait","params":{"ms":800}}
- {"action":"finish","params":{"summary":"One paragraph describing what you accomplished and what you found."}}

Always prefer click_by_tag / type_by_tag over pixel coordinates when possible — they survive reflows. The element list will say which tag number to use.

If a click doesn't change the page, try a different approach: scroll to see more, check a different element, or adjust the goal. If you've completed the goal, respond with "finish". If you can't make progress for 5+ steps, also "finish" with a summary of what went wrong.

The browser will create a new tab for you to work in. You don't need to ask for permission — just start executing the goal.`;

// ------------------------------------------------------------------
// Action parsing — robust to LLM emitting code fences or extra text
// ------------------------------------------------------------------

export function parseAction(text) {
  if (!text) return null;
  // Strip code fences.
  let t = text.trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  // Find the outermost JSON object.
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0, end = -1;
  for (let i = start; i < t.length; i++) {
    if (t[i] === '{') depth++;
    else if (t[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  const candidate = t.slice(start, end + 1);
  try {
    const obj = JSON.parse(candidate);
    if (typeof obj.action !== 'string') return null;
    return { action: obj.action, params: obj.params || {}, thought: obj.thought || '' };
  } catch (e) {
    return null;
  }
}

// ------------------------------------------------------------------
// State capture
// ------------------------------------------------------------------

async function captureState(controller) {
  // The /inspect endpoint returns screenshot + URL + title + viewport
  // + DOM landmarks. We call the action list so we can also pull
  // tag_elements for a structured element list.
  const inspect = await controller.call('inspect', {}, 30000);
  let tags = [];
  try {
    const r = await controller.call('tag_elements', { max: 200 }, 30000);
    if (r && r.ok && Array.isArray(r.elements)) tags = r.elements;
  } catch (e) { /* non-fatal */ }
  return { inspect, tags };
}

function summarizeState(state, goal, stepNum) {
  const r = state.inspect?.result || {};
  const tags = (state.tags || []).slice(0, 60).map(t => {
    const text = (t.text || '').toString().slice(0, 60).replace(/\s+/g, ' ').trim();
    return `[${t.num}] ${t.tag}${t.id ? '#'+t.id : ''}${t.type ? '[type='+t.type+']' : ''}${text ? ' "'+text+'"' : ''}`;
  }).join('\n');
  return [
    `Goal: ${goal}`,
    `Step: ${stepNum}`,
    `URL: ${r.url || 'unknown'}`,
    `Title: ${r.title || ''}`,
    `Viewport: ${r.width || '?'}x${r.height || '?'}`,
    '',
    'Visible interactive elements (use these tag numbers with click_by_tag / type_by_tag):',
    tags || '(none tagged)',
  ].join('\n');
}

// ------------------------------------------------------------------
// Main agent loop
// ------------------------------------------------------------------

export async function runAgent({
  goal,
  controllerUrl = process.env.CONTROLLER_URL || 'ws://127.0.0.1:9223/ws',
  startUrl = null,
  maxSteps = 30,
  log = (level, msg) => console.log(`[${level}] ${msg}`),
  reportPath = null,
  llmConfig = null,
  onStep = null, // optional callback (stepNum, action, state) for UI
  // Test hooks: pass a stub controller / LLM to skip network.
  _controller = null,
  _llmChat = null,
} = {}) {
  const cfg = _llmChat ? { provider: 'mock', model: 'mock', url: '', headers: {} } : (llmConfig || pickLlmConfig());
  log('info', `LLM: ${cfg.provider} (model=${cfg.model})`);

  const chat = _llmChat || ((messages, opts) => llmChat(cfg, messages, opts));
  const controller = _controller || new Controller({ url: controllerUrl, log });
  if (!_controller) await controller.connect();
  else if (typeof controller.connect === 'function') await controller.connect();

  // Register this run with the controller's agent registry so
  // /agent/status can list it. We pick a stable id so the agent
  // can be tracked across re-registers (e.g. after a reconnect).
  const runId = 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  controller.notify('AGENT_REGISTER', {
    agent: { id: runId, goal, steps: 0, workingTabId: null, lastAction: null },
  });
  process.on('exit', () => {
    try { controller.notify('AGENT_UNREGISTER', { runId }); } catch {}
  });

  // If startUrl, open a new tab. Otherwise just use the current active tab.
  let workingTabId = null;
  if (startUrl) {
    const r = await controller.call('open', { url: startUrl, newTab: true });
    if (r && r.tabId) {
      workingTabId = r.tabId;
      await controller.call('set_active_tab', { tabId: workingTabId });
      log('info', `opened new tab ${workingTabId}: ${startUrl}`);
    } else {
      log('warn', 'open did not return tabId; continuing with current active tab');
    }
  } else {
    const r = await controller.call('set_active_tab', {});
    if (r && r.activeTabId) workingTabId = r.activeTabId;
  }
  // Tell the controller's registry which tab we're working on
  // (so /agent/status can show it).
  controller.notify('AGENT_UPDATE', { runId, patch: { workingTabId } });

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Goal: ${goal}\n\nYou may proceed. Start by capturing the current state and taking the first action.` },
  ];

  const history = [];
  let lastAction = null;
  let lastSummary = '';
  let noProgressCount = 0;
  let lastFp = '';

  for (let step = 1; step <= maxSteps; step++) {
    log('info', `── step ${step}/${maxSteps} ──`);
    let state;
    try {
      state = await captureState(controller);
    } catch (e) {
      log('error', 'capture failed: ' + e.message);
      break;
    }
    // The "did the page change?" signal is the URL + the tags'
    // top-of-list — both change after a successful click. We
    // deliberately exclude the step number from this comparison
    // so the same page state across steps counts as no-progress.
    const fp = (state.inspect?.result?.url || '') + '|' +
               (state.inspect?.result?.title || '') + '|' +
               (state.tags || []).map(t => t.tag + ':' + (t.text || '')).join(',');
    if (fp === lastFp) {
      noProgressCount++;
      log('warn', `no progress for ${noProgressCount} step(s)`);
      if (noProgressCount >= 5) {
        log('error', 'no progress for 5 steps; finishing');
        break;
      }
    } else {
      noProgressCount = 0;
    }
    lastFp = fp;
    const summary = summarizeState(state, goal, step);

    // The screenshot is sent as an image_url to vision-capable models.
    // For text-only models, we strip it.
    const screenshot = state.inspect?.result?.screenshot;
    const userContent = [];
    userContent.push({ type: 'text', text: summary });
    if (screenshot) {
      userContent.push({
        type: 'image_url',
        image_url: { url: screenshot.startsWith('data:') ? screenshot : 'data:image/png;base64,' + screenshot },
      });
    }
    messages.push({ role: 'user', content: userContent });

    let reply;
    try {
      reply = await chat(messages, { json: true });
    } catch (e) {
      log('error', 'LLM call failed: ' + e.message);
      break;
    }
    log('info', 'LLM: ' + reply.replace(/\s+/g, ' ').slice(0, 200));
    const parsed = parseAction(reply);
    if (!parsed) {
      log('error', 'could not parse LLM reply as JSON action; finishing');
      break;
    }
    if (parsed.thought) log('info', 'thought: ' + parsed.thought);
    messages.push({ role: 'assistant', content: reply });

    if (parsed.action === 'finish') {
      lastSummary = parsed.params?.summary || lastSummary;
      log('ok', 'finish: ' + (lastSummary || '(no summary)'));
      lastAction = parsed;
      break;
    }

    // Forward to the controller. The controller normalizes
    // "click_by_tag" to the right action automatically since
    // both names are valid in the relay.
    try {
      const r = await controller.call(parsed.action, parsed.params, 60000);
      const ok = r && r.ok;
      log(ok ? 'ok' : 'warn', `${parsed.action} → ${ok ? 'ok' : (r?.error || 'failed')}`);
      history.push({ step, action: parsed, result: r });
      if (onStep) try { onStep(step, parsed, state, r); } catch {}
      if (!ok) noProgressCount++;
    } catch (e) {
      log('error', parsed.action + ' threw: ' + e.message);
      history.push({ step, action: parsed, error: e.message });
      noProgressCount++;
    }
    lastAction = parsed;
    // Heartbeat the registry so /agent/status reflects live progress.
    controller.notify('AGENT_UPDATE', {
      runId,
      patch: { lastAction: parsed.action, steps: history.length },
    });
  }

  controller.notify('AGENT_UNREGISTER', { runId });
  controller.close();

  const report = {
    goal,
    completedAt: new Date().toISOString(),
    workingTabId,
    steps: history.length,
    finalAction: lastAction,
    summary: lastSummary,
    history,
  };
  if (reportPath) {
    try {
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, JSON.stringify(report, null, 2));
      log('info', 'report written to ' + reportPath);
    } catch (e) { log('warn', 'could not write report: ' + e.message); }
  }
  return report;
}

// ------------------------------------------------------------------
// CLI entry
// ------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const goal = process.argv.slice(2).join(' ');
  if (!goal) {
    console.error('Usage: node agent.mjs "<goal>" [--url <start>] [--max-steps N] [--report <path>] [--controller <ws-url>]');
    process.exit(2);
  }
  const arg = (name, dflt) => {
    const i = process.argv.indexOf('--' + name);
    return i >= 0 ? process.argv[i + 1] : dflt;
  };
  runAgent({
    goal,
    startUrl: arg('url', null),
    maxSteps: parseInt(arg('max-steps', '30'), 10),
    controllerUrl: arg('controller', process.env.CONTROLLER_URL || 'ws://127.0.0.1:9223/ws'),
    reportPath: arg('report', resolve(__dirname, 'logs', `agent-${Date.now()}.json`)),
  }).then((r) => {
    console.log('\n──────────── FINAL REPORT ────────────');
    console.log('Goal:    ', r.goal);
    console.log('Steps:   ', r.steps);
    console.log('Summary: ', r.summary);
    process.exit(0);
  }).catch((e) => {
    console.error('FATAL:', e.message);
    process.exit(1);
  });
}
