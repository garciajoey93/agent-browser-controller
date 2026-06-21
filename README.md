# Agent Browser Controller

A Manifest V3 Chrome extension plus a Node.js WebSocket/HTTP relay that
turns a real Chrome browser into a low-latency, controllable surface
for an external autonomous-driving agent. The extension contains **no
AI** — it accepts JSON action tokens over WebSocket and dispatches them
through `chrome.debugger` so the page sees authentic `isTrusted: true`
events.

```
┌──────────────┐   JSON action tokens    ┌──────────────────┐
│ MiniMax /    │ ──────────────────────► │ controller-server │ ◄── any HTTP/WS client
│ Codex /      │  ws://host:9223/ws      │  (Node.js relay) │
│ driver script│ ◄────── result ──────── │  bridges          │
└──────────────┘   { ok, result, ... }   └────────┬─────────┘
                                                  │ WebSocket
                                                  ▼
                                         ┌──────────────────┐
                                         │  Agent Browser   │
                                         │  Controller ext  │ ── chrome.debugger ──► browser
                                         │  (MV3 service    │
                                         │   worker)        │
                                         └──────────────────┘
```

## Project layout

```
chrome-agent-extension/
├── manifest.json          MV3 — activeTab, tabs, scripting, storage,
│                                 debugger, <all_urls>
├── background.js          Service worker. Connects to the controller
│                                 over WebSocket (or HTTP polling),
│                                 scales coordinates (DPR-aware),
│                                 dispatches every action through
│                                 chrome.debugger.
├── content.js             Page-side companion. Status badge, click
│                                 ripple, red anchor dot on every
│                                 click action, DOM landmark
│                                 extraction, JPEG resize.
├── content.css            !important-styled overlays.
├── controller-server.js   Node.js relay. WebSocket + HTTP, routes
│                                 action tokens between the
│                                 extension and any number of clients.
├── test-minimax-agent.js  Mock driver: the canonical 3-step
│                                 action chain (Navigate → Click →
│                                 Type) used to verify the system.
├── test-page.html         Deterministic target page for the test.
├── test-server.js         Static file server for test-page.html.
├── mock-extension.js      Stand-in extension that drives a real
│                                 Chrome via CDP (used by the test
│                                 to exercise the real protocol
│                                 without installing the MV3 ext).
├── package.json           One dep: ws.
├── icons/                 16/48/128 PNG icons.
└── README.md              This file.
```

## Install

```bash
# 1. Install the extension
#    Open chrome://extensions, enable Developer mode, click
#    "Load unpacked", pick the chrome-agent-extension/ directory.

# 2. Install + start the controller server
cd chrome-agent-extension
npm install
node controller-server.js --port 9223
# Server prints:
#   Agent Controller server listening on http://127.0.0.1:9223
#   WebSocket:  ws://127.0.0.1:9223/ws
#   HTTP API:   http://127.0.0.1:9223/status

# 3. Connect the extension
#    Click the extension icon, click Connect (URL is prefilled).
#    On the first install, tick "Auto-connect on startup" so it
#    reconnects whenever Chrome restarts.

# 4. Drive it from anywhere
curl -s -X POST http://localhost:9223/action \
  -H 'Content-Type: application/json' \
  -d '{"action":"click","params":{"x":500,"y":300}}'
```

## Protocol

Every message is JSON. Requests carry a unique `id`; responses echo
the same `id` plus `ok` and either the action's return fields spread
at the top level or an `error` string.

```jsonc
// request
{ "id": "1", "action": "click", "params": { "x": 500, "y": 300 } }

// response
{ "id": "1", "ok": true, "x": 500, "y": 300, "tag": "BUTTON" }
//   ^ fields returned by the action are spread at the top level
```

### Available actions

| action           | params                                                                 | returns                                                              |
|------------------|------------------------------------------------------------------------|----------------------------------------------------------------------|
| `inspect`        | `{}`                                                                   | `dataUrl`, `url`, `title`, viewport, `dpr`, `scrollX/Y`, `landmarks` |
| `capture_state`  | `{}`                                                                   | same as `inspect`                                                    |
| `screenshot`     | `{}`                                                                   | `dataUrl`, `width`, `height`                                         |
| `click`          | `{ x, y, tabId? }`                                                     | `x, y, tag, text, trusted: true`                                     |
| `type`           | `{ x, y, text, tabId? }`                                               | `value, charCount, cleared, trusted: true`                           |
| `scroll`         | `{ direction: "up"\|"down"\|"left"\|"right", amount }`                 | `direction, dy, dx`                                                  |
| `navigate`       | `{ url }`                                                              | `url, tabId`                                                         |
| `evaluate`       | `{ script }`                                                           | `result` — runs `eval(script)` in the page                            |
| `tabs`           | `{}`                                                                   | `tabs: [{ id, url, title, active }]`                                 |
| `open`           | `{ url? }`                                                             | `tabId, url`                                                         |
| `close`          | `{ tabId? }`                                                           | `ok: true`                                                           |
| `switch_tab`     | `{ tabId }`                                                            | `activeTabId`                                                        |
| `wait`           | `{ ms }`                                                               | `ms`                                                                 |
| `set_status`     | `{ text, mode: "on"\|"off"\|"error"\|"done" }`                         | `ok: true`                                                           |

## Coordinate matrix alignment

Vision models emit clicks in whatever space they prefer. The extension
serves four conventions via the popup's **Coordinate system** selector
or the `coordMode` config:

| mode               | mapping                                                 |
|--------------------|---------------------------------------------------------|
| `normalized_1000`  | `px = (v / 1000) * viewport_size` (default)             |
| `normalized_1`     | `px = v * viewport_size`                                |
| `pixel`            | pass-through (already CSS pixels)                       |
| `device_pixel`     | `px = v / dpr` (handles device-pixel-space models)      |

`chrome.tabs.captureVisibleTab` returns the screenshot at the
viewport's CSS pixel resolution, and `Input.dispatchMouseEvent` also
takes CSS pixels. So `normalized_1000`, `normalized_1`, and `pixel`
are 1:1 by default. `device_pixel` divides by `dpr` to handle the
rare model that returns device-pixel coordinates.

Every `inspect` response includes `dpr` in the viewport block so
clients can verify the ratio.

## Trusted hardware injection

Every action goes through `chrome.debugger` so the page sees
authentic events:

| action     | CDP call                                                              |
|------------|-----------------------------------------------------------------------|
| `click`    | `Input.dispatchMouseEvent { type: mousePressed \| mouseReleased }`    |
| `type`     | Ctrl+A + Delete (explicit `Control` key), then per-character `rawKeyDown` → `char` → `keyUp` |
| `scroll`   | `Input.dispatchMouseEvent { type: mouseWheel }`                      |
| `navigate` | `chrome.tabs.update` + `waitForTabComplete`                            |

`isTrusted: true` is what most production sites (and React/Vue/Svelte
state) check for. There is no fallback to fragile `.click()`.

The extension also draws a red anchor dot on the page for every click
(`.agent_browser_anchor__`, z-index 2147483647, !important) so a
human watching the browser can see exactly where the model clicked.

## HTTP API

The relay also exposes a small HTTP surface so any tool that can
make a request — `curl`, Python `requests`, the `fetch` API, Codex's
`exec_command` — can drive the browser without speaking WebSocket.

| Method | Path           | Notes                                                          |
|--------|----------------|----------------------------------------------------------------|
| GET    | `/`            | API docs + live status (HTML)                                  |
| GET    | `/status`      | `{ extensionConnected, clients, actions, port, version }`      |
| GET    | `/inspect`     | full `inspect` result                                          |
| GET    | `/screenshot`  | `{ dataUrl, width, height }`                                   |
| GET    | `/tabs`        | list of open tabs                                              |
| POST   | `/action`      | body: `{ action, params }` → forwards and returns              |

CORS is wide-open (`Access-Control-Allow-Origin: *`). Bind to
`127.0.0.1` for local-only access; expose to a LAN only behind a
reverse proxy with auth.

## WebSocket API

```
ws://localhost:9223/ws
```

The first message **must** identify the role:

```json
{ "role": "client" }      // or "extension"
```

The server responds with `hello-ack`. After that, the client sends
action requests and receives responses on the same socket. The
extension side is fully driven by the server (no AI inside the
extension). Multiple clients can connect; events fan out to all.

## The MiniMax driving script

`test-minimax-agent.js` is the canonical mock driver. It runs the
3-step action chain required by the spec:

```bash
node test-minimax-agent.js [url] [clickX] [clickY] [typeText]
# defaults: http://127.0.0.1:9333/  500  300  "hello minimax"
```

It verifies:

1. **Handshake** — extension is connected (`/status`).
2. **Navigate** — `navigate` action returns `ok`.
3. **Inspect** — `inspect` returns the expected URL/title/viewport/
   screenshot/landmarks.
4. **Click** — `click {x:500,y:500}` draws the red anchor dot and
   fires a trusted CDP event (`trusted: true`).
5. **Type** — focuses the actual `#text-input` landmark, then
   dispatches the type action; verifies the input value matches.

## Autonomous agent

The agent (`agent.mjs`) is an LLM-driven loop that takes a natural-
language goal, opens a fresh tab in your existing Chrome, and drives
the browser autonomously — no headless instance, no separate Chrome
profile, no `xvfb`. The agent runs in your real browser session with
your logged-in state, your cookies, and your extensions.

**You can walk away.** The agent opens a new tab pinned to itself, so
you can keep using your other tabs without breaking the agent's
context. Progress streams live to the popup; the final report is
written to a file you can read later.

### Three ways to start

```bash
# 1. CLI — runs in a Node process, streams log to terminal
npm run agent:cli -- "find 10 landscapers in Jonesboro GA that don't have a website"

# 2. CLI with explicit start URL
npm run agent:cli -- "log in to example.com and check the dashboard" \
  --url https://example.com/login

# 3. Popup — click the extension icon, type the goal, click Start agent
```

### LLM provider

Auto-detected from env (in priority order):

| Env var | Endpoint | Use when |
|---|---|---|
| `MINIMAX_API_KEY` | `https://api.minimax.chat/v1/chat/completions` | default |
| `OPENAI_API_KEY`  | `https://api.openai.com/v1/chat/completions` | OpenAI / compatible |
| `ANTHROPIC_API_KEY` | via `OPENAI_BASE_URL` proxy | Anthropic |
| `LLM_PROXY=1` | `http://127.0.0.1:9223/llm` | key stored in the extension popup |

The `LLM_PROXY=1` mode is the most production-safe: the user stores
the API key in the extension's storage; the agent process never sees
it. The controller's `/llm` HTTP endpoint proxies requests using
the stored key.

### Action surface

The agent emits one JSON action per LLM turn:

```json
{"action":"click_by_tag","params":{"num":3},"thought":"click the submit button"}
{"action":"scroll","params":{"direction":"down","amount":600}}
{"action":"finish","params":{"summary":"found 10 businesses"}}
```

Full list: `navigate`, `click`, `click_by_tag`, `type`, `type_by_tag`,
`scroll`, `hover`, `evaluate`, `wait`, `finish`.

### Output

Each run writes a JSON report to `logs/agent-<timestamp>.json` (or
`--report <path>`). The report includes the goal, the working tab
id, every step's action + result, and the LLM's final summary.

## Validation matrix

Verified end-to-end against the spec (mock extension driving a real
Chrome via CDP):

| step                          | result                                                                    |
|-------------------------------|---------------------------------------------------------------------------|
| **1. handshake**              | Extension binds to `ws://localhost:9223/ws` on startup (`autoConnect=true`) |
| **2. telemetry**              | Relay grabs a 47 KB PNG screenshot + 20 DOM landmarks and passes them to the client |
| **3. action execution**       | `click {x:500,y:500}` draws a red anchor dot (`document.querySelectorAll('.__agent_browser_anchor__').length` 0→1) and fires a trusted CDP event |
| **4. error recovery**         | After the extension drops, requests return `{ ok: false, error: "Extension not connected" }`; `/status` still returns 200; a new mock re-registers and the connection resumes |

## End-to-end test harness

The repo includes a self-contained test (mock extension → controller
→ real Chrome via CDP) you can run to verify the system end-to-end
without installing the MV3 extension:

```bash
# In one terminal — the controller
node controller-server.js

# In another — the test page server
node test-server.js

# In a third — Chrome with CDP
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --headless=new --remote-debugging-port=9222 \
  --user-data-dir=/tmp/agent-test-profile about:blank &

# In a fourth — the mock extension
CONTROLLER_URL=ws://127.0.0.1:9223/ws CDP_URL=http://127.0.0.1:9222 \
  node mock-extension.js &

# Then run the driver
node test-minimax-agent.js http://127.0.0.1:9333/ 500 500 "hello minimax"
```

Expected output: every assertion green, exit 0.

## Quick examples

```bash
# Drive the browser from any HTTP client
curl -s -X POST http://localhost:9223/action \
  -H 'Content-Type: application/json' \
  -d '{"action":"navigate","params":{"url":"https://example.com"}}' | jq

curl -s -X POST http://localhost:9223/action \
  -H 'Content-Type: application/json' \
  -d '{"action":"screenshot"}' \
  | jq -r '.dataUrl' | cut -c1-50

# From Python
import requests, json, base64
API = "http://localhost:9223"
state = requests.post(f"{API}/action", json={"action": "inspect"}).json()
print("url:", state["url"], "viewport:", state["width"], "x", state["height"])
requests.post(f"{API}/action", json={"action": "click", "params": {"x": 500, "y": 300}})

# From a WebSocket client (Node, Python, anything)
const ws = new WebSocket('ws://localhost:9223/ws');
ws.send(JSON.stringify({ role: 'client' }));
ws.send(JSON.stringify({ id: '1', action: 'inspect' }));
```

## Security

* The server binds to `127.0.0.1` by default. `--host 0.0.0.0` exposes
  the relay to the LAN — anyone reachable can drive the browser.
* CORS is wide-open. If you bind to `0.0.0.0`, put the relay behind
  a reverse proxy with auth.
* The `debugger` permission produces Chrome's "Debugger is attached"
  banner while the agent is running — that is by design.
* The extension's `pollingSecret` setting is a bearer token for the
  HTTP polling endpoint (WebSocket is not gated by default because
  it requires a same-origin connection).

## Limitations

* `captureVisibleTab` captures only the visible viewport. For a
  full-page screenshot, scroll-and-stitch via repeated `screenshot`
  calls or attach `Page.captureScreenshot` via the debugger.
* The service worker can be terminated by Chrome when idle. The
  `chrome.alarms` heartbeat keeps the controller connection alive;
  if the worker does pause, the extension reconnects automatically
  when reactivated.
* Only one extension is supported per relay; a new extension
  replacing an existing one will close the old connection.
