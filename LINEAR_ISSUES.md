# Agent Browser Controller — Improvement Issues

20 issues filed from the post-launch review. Priority bands and
ordering are based on production impact, not alphabetical.

---

## 🔴 Critical — production blockers

### 1. Offline action queue
**Priority: Urgent**
Right now the moment the MV3 service worker terminates, every action
sent to the controller is rejected with `"Extension not connected"`.
An AI agent firing during a worker restart loses its work.

The controller should buffer actions per session id, return a
`QUEUED` response with a position, and replay them in order when
the extension reconnects. Add a max buffer size (e.g. 100 actions,
5 min TTL) with `QUEUE_FULL` rejection past the cap.

### 2. MV3 service worker = single point of failure
**Priority: Urgent**
Chrome can terminate the background service worker any time. The
30s heartbeat means up to 30s of dropped actions per restart.

Move the long-lived WebSocket into a `chrome.offscreen` document.
The service worker creates the offscreen doc on first connect; the
offscreen doc owns the socket and proxies action requests to the SW
via `chrome.runtime.sendMessage`. Survives SW termination.

### 3. Read-only operations attach the debugger
**Priority: Urgent**
`inspect`, `screenshot`, and `evaluate` all go through
`chrome.debugger`, which shows the "Chrome is being controlled" banner
even when the AI is just reading the page.

Add a `readOnly: true` flag on the action. When set, the extension
uses `chrome.tabs.captureVisibleTab` (which works under `activeTab`
once the user has invoked the extension once) and
`chrome.scripting.executeScript` with `world: 'MAIN'` for `evaluate`.
Falls back to CDP only for writes.

### 4. No auth on the WebSocket
**Priority: High**
Anyone with localhost access to port 9223 can drive the browser.
The HTTP `pollingSecret` exists but the WS path doesn't enforce it.

Require a bearer token on the first WS message (in addition to
`{ role: ... }`). Reject mismatched tokens with a 1008 close code.
Add `authToken` to the popup config UI.

### 5. No request idempotency keys
**Priority: High**
Same action sent twice → executes twice. An AI retrying after a
network blip will re-click the "Buy" button.

Add optional `idempotencyKey` on every action. The controller dedupes
in-flight and recently-completed (last 5 min) requests with the same
key. AI agents set `idempotencyKey: hash(action + params + attempt)`.

---

## 🟡 High value — clear quality wins

### 6. Add `press_key` action
**Priority: High**
The test had to use `evaluate` to submit the YouTube form because
there's no "press Enter" action.

```
POST /action {"action":"press_key","params":{"key":"Enter"}}
POST /action {"action":"press_key","params":{"key":"Tab","shift":true}}
```

Backed by `Input.dispatchKeyEvent` via the already-attached debugger.
Use the same charToKeyInfo table from the type action.

### 7. Shadow DOM landmark extraction
**Priority: High**
That's why the YouTube search input wasn't in the initial landmark
list — it's inside YouTube's custom web component.

Update `extractLandmarks` in content.js to walk `element.shadowRoot`
recursively. Filter out closed shadow roots (can't introspect).

### 8. Smart tab discovery / routing
**Priority: High**
The AI has to guess which tab to drive. Add:
- `find_tab { urlPattern?, titlePattern?, active? }` returns the best
  match.
- `click/type` etc. accept `tabHint: "main" | "last-active" | urlPattern`
  instead of a hard `tabId`.

Define "main" as the tab whose window has the most non-chrome:// tabs.

### 9. Server-push events from extension
**Priority: Medium**
The extension can detect tab changes / navigations but can't tell
clients. The controller already has `broadcastToClients` — wire it
up to forward:
- `tab_activated`
- `tab_removed`
- `navigation_committed` (URL changed)
- `download_started`
- `crashed` (tab crashed)

Clients subscribe on the WS by sending `{type:"subscribe", events:[...]}`.

### 10. Structured error taxonomy
**Priority: Medium**
Errors are free-form strings. An AI agent can't reliably branch on
them. Add an `errorCode` enum:
- `NO_TAB` — no active tab
- `ELEMENT_NOT_FOUND` — coordinate hit non-interactive
- `DEBUGGER_DENIED` — chrome.debugger attach failed
- `PERMISSION_DENIED` — host permission blocked
- `TIMEOUT`
- `INVALID_PARAMS`
- `UNKNOWN_ACTION`

Keep the human-readable `error` string alongside for logs.

### 11. Action history + replay
**Priority: Medium**
The popup shows the last result; the rest is gone.

- Persist last 200 actions to `chrome.storage.local`.
- Add `GET /history` on the controller.
- Add `POST /action/replay/{id}` to re-send a stored action.

Useful for debugging "what did the AI do 10 minutes ago" and for
recovering from a partial failure.

### 12. Streaming endpoint for long flows
**Priority: Medium**
For long-running flows ("wait for the user to log in"), there's no
way to stream page events back. Add a server-sent-events endpoint at
`/stream` that multiplexes every extension event. Clients open with
`EventSource('/stream')`.

### 13. Schema validation in the controller
**Priority: Medium**
The controller forwards anything; the extension validates. A typo'd
action name wastes a round trip with a 502.

Add a small JSON-schema validator (or hand-rolled check) on the
controller. Reject with `400 { error: "unknown action: clikc" }`
before forwarding.

---

## 🟢 Nice to have — polish

### 14. TypeScript everywhere
**Priority: Low**
Right now we rely on `node --check` + careful coding. A build step
with `tsc` (or `tsx` for no-build) would catch the
`insp.result.url` vs `insp.url` class of bug at compile time. Start
with the controller-server, then background.js, then content.js.

### 15. Real regression test suite
**Priority: Low**
`test-minimax-agent.js` is a one-shot demo. A real suite (Vitest)
covering:
- Coordinate-scaling math (all 4 modes, DPR edge cases)
- Protocol round-trip
- Per-action execution path
- Error taxonomy codes

…would catch breakage on refactor.

### 16. Metrics endpoint
**Priority: Low**
No counter for actions-per-second, error rates, p99 latencies. The
log is rich but not queryable.

Add a tiny `/metrics` endpoint in Prometheus text format:
```
agent_actions_total{action="click",result="ok"} 42
agent_actions_total{action="click",result="err"} 1
agent_action_latency_ms{action="click",quantile="0.99"} 87
```

### 17. Popup UI polish
**Priority: Low**
Functional, but a real product needs a sidebar layout, history view,
per-action latency display, connection-uptime counter.

### 18. Auto-reload file filter
**Priority: Low**
I excluded `.swp`, `~`, etc. but real projects have `*.lock`,
`.turbo/`, `dist/`, `coverage/`, `.git/`, `node_modules/`. Make the
ignore list configurable with a default that reads `.gitignore`.

### 19. WebSocket backpressure
**Priority: Low**
A client that fires 1000 actions/sec will pile them up. Per-client
in-flight cap (default 16) with `QUEUE_FULL` rejection. Sends a
`{type:"backpressure"}` event when the cap is hit.

### 20. Screenshot format consistency
**Priority: Low**
`Page.captureScreenshot` returns PNG only. `chrome.tabs.captureVisibleTab`
supports PNG and JPEG. The 47 KB JPEG screenshots are ~3x smaller than
the equivalent PNG. Add `format: "jpeg" | "png" | "webp"` (with
`quality` for jpeg/webp) to the `screenshot` action.

---

## Suggested sprint ordering

If you want a single priority order for the backlog:

1. **#1 Offline queue** + **#2 Offscreen doc** (one PR, fixes the
   biggest reliability gap)
2. **#4 Auth** (security hygiene)
3. **#3 Read-only mode** (removes the banner from most operations)
4. **#5 Idempotency** + **#10 Error taxonomy** (AI reliability)
5. **#6 press_key** (unblocks many real flows)
6. **#7 Shadow DOM** (better landmark coverage)
7. **#8 Tab discovery** + **#9 Push events** (better AI ergonomics)
8. Everything else in any order
