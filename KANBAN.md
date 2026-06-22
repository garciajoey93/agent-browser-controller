# Agent Browser Controller — Kanban Board

Last updated: 2026-06-21

This mirrors what would be pushed to Linear once an API key is configured.
20 issues, prioritized by production impact.

## 📋 Backlog (0)

_None._

## 🎯 Todo (0)

_None._

## 🔨 In Progress (0)

_None._

## ✅ Done (20 / 20)

| # | Title | Priority | Status | Verified |
|---|---|---|---|---|
| 1 | Offline action queue | 🔴 Urgent | ✅ Done | ✅ verified |
| 2 | MV3 service worker = single point of failure | 🔴 Urgent | ✅ Done | ✅ verified |
| 3 | Read-only operations attach the debugger | 🔴 Urgent | ✅ Done | ✅ verified |
| 4 | No auth on the WebSocket | 🟠 High | ✅ Done | ✅ verified |
| 5 | No request idempotency keys | 🟠 High | ✅ Done | ✅ verified |
| 6 | Add press_key action | 🟠 High | ✅ Done | ✅ verified |
| 7 | Shadow DOM landmark extraction | 🟠 High | ✅ Done | ✅ verified |
| 8 | Smart tab discovery / routing | 🟠 High | ✅ Done | ✅ verified |
| 9 | Server-push events from extension | 🟡 Medium | ✅ Done | ✅ verified |
| 10 | Structured error taxonomy | 🟡 Medium | ✅ Done | ✅ verified |
| 11 | Action history + replay | 🟡 Medium | ✅ Done | ✅ verified |
| 12 | Streaming endpoint for long flows | 🟡 Medium | ✅ Done | ✅ verified |
| 13 | Schema validation in the controller | 🟡 Medium | ✅ Done | ✅ verified |
| 14 | TypeScript everywhere | 🟢 Low | ✅ Done | ✅ verified |
| 15 | Real regression test suite | 🟢 Low | ✅ Done | ✅ verified |
| 16 | Metrics endpoint | 🟢 Low | ✅ Done | ✅ verified |
| 17 | Popup UI polish | 🟢 Low | ✅ Done | ✅ verified |
| 18 | Auto-reload file filter | 🟢 Low | ✅ Done | ✅ verified |
| 19 | WebSocket backpressure | 🟢 Low | ✅ Done | ✅ verified |
| 20 | Screenshot format consistency | 🟢 Low | ✅ Done | ✅ verified |

## 📝 Migration to Linear

When `LINEAR_API_KEY` is set in the env, run:

```bash
LINEAR_API_KEY=lin_api_xxx LINEAR_TEAM="Engineering" \
  node scripts/push-to-linear.mjs
```

This will create the issues in Linear's `Engineering` team with the labels
from `LINEAR_ISSUES.csv`. The current `LINEAR_ISSUES.md` and
`LINEAR_ISSUES.csv` are the source of truth for issue content.
