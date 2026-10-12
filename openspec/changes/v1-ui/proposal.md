## Why

M2 exposes validated coursework contracts, but the owner still needs a local interface to see deadlines, plan work, revise and review agent proposals. M3 delivers the approved web UI against synthetic M2 HTTP data first, without coupling the browser to ingestion, storage or a model provider.

## What Changes

- Add the Vite + React SPA, built into `dist/ui`, served by the same loopback process and opened by `coursework ui`; reuse `design/prototype/` CSS variables and the approved month/week calendar, teaching weeks, module rail, task drawer and avatar menu.
- Consume only M2 JSON POST commands through loopback HTTP with runtime envelope validation, bounded pagination, evidence/coverage display and explicit unavailable states. Start with independently synthetic server fixtures.
- Display coursework and manual/recurring tasks, module progress, required manual assessment weight/score entry and existing grade projections; implement a pure, tested earliest-deadline-first weekly planner that never drops work that does not fit.
- Add cited course/week revision notes, browser-graded objective practice, external-agent feedback for open practice and weak-topic inputs to revision planning.
- Add proposal review, separate L3 fill and L4 submit confirmation using exact M2 revisions and trusted authorization. Exams and prohibited courses stay capped at L1; L2–L4 require recorded course policy and assessment grants. Confirmation is the L4 default.
- Spike Hermes connectivity at M3 start; chat remains a relay to the local external agent, with no model calls or keys managed by coursework.
- Expose undecided integration/security/planning choices in design Open options; block affected implementation until recorded choices and required M2 contracts exist, rather than invent private UI APIs.

## Capabilities

### New Capabilities

- `local-web-ui`: same-process SPA host, synthetic-first HTTP client, status/evidence and accessible prototype shell.
- `ui-planning`: calendar, tasks/modules, grade presentation and deterministic EDF weekly planning.
- `ui-study`: cited study content, objective/open practice and weak-topic revision feedback.
- `ui-assessment-review`: owner review, authorization display and separate fill/confirmed-submit interactions.
- `ui-chat-relay`: Hermes interface spike, safe external-agent chat and open-practice relay.

### Modified Capabilities

None. `openspec/specs/` is absent here; M2 and foundation/M1/Q1 change specs remain the baseline pending archive reconciliation. This change adds consumer requirements and does not silently change M2 command contracts. Any selected protocol extension must be specified and merged at the M2 boundary before the dependent UI work.

## Non-goals

No Canvas/Ed adapter or remote submit endpoint, real assessment action during development, database access from UI, direct Q1/CLI invocation from browser, model SDK, Hermes scheduling/MCP mounting (M4), iCal, Notion, hosting, solver or minimal-change rescheduling. Login, MFA and course policy configuration remain outside the UI per the standing design.

## Impact

Future implementation affects the UI, local host/CLI integration and pure planning logic. Reuse Node 24, strict TypeScript, zod, Vitest and Playwright; add only pre-approved Vite, React, react-dom, @vitejs/plugin-react and their @types (#64/#69). No router, calendar, state, testing or HTTP framework dependency is assumed.

This draft changes only `openspec/changes/v1-ui/`: no source, package/lock, CI/deployment, decisions or handoff edits, commit or live writes. Technical-design sections 1–9 and decisions #56/#77 supersede obsolete config context about no L4/iCal. Merged source and the consumer guide determine actual M2 availability; schema presence or fake success is not production integration or authorization evidence.
