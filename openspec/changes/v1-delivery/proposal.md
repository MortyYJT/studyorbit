## Why

Development was paused on 2026-10-15 because there was no PRD (#114). The PRD (`note/product/prd.md`, #115), the owner's architecture drawing and the frontend prototype (`design/prototype/index.html`, #134–#146) are now done, and they change the product: the frontend becomes the only entry point, with an agent chat page backed by the Claude Agent SDK (#116, #123), autonomy levels are now per assessment type and set from the frontend (#117, #120–#126), and planning works per day with owner-set start times (#145). `v1-rescope` delivered issues A–C (cuts, resident browser, protocol integration) and was archived with only those specs; this change carries everything else in v1 against the PRD's acceptance lists.

## What Changes

- **`coursework sync`** (carried from `v1-rescope`): current-term Canvas `/api/v1` and Ed JSON into the local store, Canvas/Ed courses merged by course code (#104), platform facts only, latest state only (#101), redaction before storing, measured runs. Started from the frontend's sync button or the CLI (#128). Expired sign-ins are shown in the frontend.
- **Agent annotations** (carried): cited agent values for weights, kinds, hurdles and syllabus-only assessments, one-to-many assessment–item links (#105), precedence owner > agent > sync (#103). The owner can confirm or replace any agent value from the frontend; those choices become the labelled set for annotation accuracy (#133).
- **Planning, per day** (#145, replaces the minute-level plan): deterministic earliest-deadline-first allocation of each day's available hours; overflow kept visible; agent estimates with a reason that the owner can override (#131); manual off-campus tasks (#132); owner-set start times; recorded actual time (#133).
- **Agent chat backend** (new, #116, #144): one agent adapter interface designed for several agents, with a Claude Agent SDK adapter first; conversations and messages stored locally; replies streamed to the frontend; preset prompts with course and assessment context. Our code never calls a model API or stores an API key; it starts the owner's signed-in agent (#123).
- **Agent browser tools** (new): our own MCP tools for opening, reading, clicking, filling and submitting on Canvas and Ed through the resident browser. Code enforces the autonomy check, the red-outline highlight before each click (#98), an audit record for every write (#111), and a pause for the owner's confirmation in the frontend before any submit (#121).
- **Autonomy by assessment type** (**BREAKING**, #120, #117, #122, #124–#126): levels become L0 read / L1 quizzes / L2 assignments and essays; each course has a default level with per-assessment overrides; prohibited courses are locked at L0; courses with no recorded policy are not capped; exams get no separate code check. Levels, overrides, policies and the confirm-before-submit switch are set only through the frontend's owner session; agents have no command to change them. Old L0–L4 grants are kept on disk but no longer read.
- **Revision** (carried, re-scoped by #127 and #144): durable study records in SQLite (#108), code-fetched citable sources (`source.fetch`, #109), exam scope with citations, practice attempts and statistics. Preparation and tutoring run in the chat page from preset prompts; the scheduled stage of #102 is dropped (#153).
- **Frontend** (new, replaces `ui-live-data`): a Vite + React app built from the prototype's layout: the seven-column week view with "needs you" and a month toggle (#135, #143), the course page with the score ring, policy and level, and Assessments / Revision tabs (#141, #142), the assessment drawer with origin markers (#138), the Agent chat page (#144), and the avatar menu (sync and sign-in, metrics, audit, settings). Real data only, dark mode (#140), no level or "let the agent do it" entry for exams (#146).
- **Metrics** (new, #133): sync time and success rate, annotation accuracy against the owner's labels, estimate versus actual time, and agent steps and cost per conversation.

## Capabilities

### New Capabilities

- `coursework-sync`: current-term Canvas and Ed JSON into the local store, course merging, platform facts, latest state, redaction, measured runs, frontend trigger.
- `agent-annotations`: cited agent and owner annotations, syllabus-only assessments, assessment–item links, precedence, owner verdicts.
- `study-planning`: availability settings, day-granular EDF plan, estimates, manual tasks, start times, actual time.
- `agent-chat`: agent adapter interface, Claude Agent SDK adapter, tool policy, conversations, streaming, preset prompts, run cost and steps.
- `agent-browser-tools`: MCP browser tools on the resident browser with enforced checks, highlight, audit and submit confirmation.
- `revision`: durable study records, `source.fetch`, exam scope, practice attempts and the revision skill.
- `web-ui`: the React frontend, its owner session and its pages.
- `metrics`: the four PRD metrics computed from recorded data.

### Modified Capabilities

- `domain-model`: course sources; optional assessment kind and weight with origin, new `quiz` kind; platform facts and removal; assessment links; annotations; planning settings; task estimates, start times and actual time; conversations and messages; course autonomy settings; grade projection with unknown weights.
- `local-store`: `materials/` and the agent workspace under the data directory; additive migrations that keep old rows.
- `protocol-reads`: reads for platform items, annotations, the plan, conversations, pending confirmations, metrics and course autonomy.
- `validated-agent-writes`: annotation, estimate and practice-attempt writes join the validated, cited writes.
- `assessment-autonomy`: type-based levels, course default plus overrides, frontend-only owner settings, L0 lock for prohibited courses, no cap without a policy, no exam check, code-enforced checks in browser tools.
- `command-registry`: owner commands are accepted from a TTY or the frontend's owner session; the chat agent's MCP server lists only agent commands.
- `ed-capture`: Ed reads cover the courses in sync scope instead of a terminal selection.

## Impact

- **Code added:** `src/sync/` Canvas reader, merge and writer; `src/annotations/`; `src/planning/`; `src/agent/` (adapter interface, Claude adapter, conversation store, tool policy, presets); `src/browser/tools/`; `src/revision/` (`source.fetch`, study-record store); `web/` (Vite + React source, built to `dist/ui`); HTTP routes for the UI session and the chat stream.
- **Code changed:** domain schemas and grade projection; SQLite migrations (additive); protocol reads and writes; authorization and audit (type-based levels, course settings); HTTP host (owner session, static UI, server-sent events); the assessment skill.
- **Dependencies:** `@anthropic-ai/claude-agent-sdk` (approved by the owner on 2026-10-15, not on the pre-approved list); Vite, React, react-dom and `@vitejs/plugin-react` (pre-approved, #64); `unpdf@1.8.1` (pre-approved, #74). `@types/react` and `@types/react-dom` are not on the pre-approved list and need the owner's approval before installation.
- **Data:** additive tables and columns only; the old change-event table and old grant records stay untouched.
- **Specs:** `v1-rescope` is archived; this is the only open v1 change. Email intake (US-4), Notion and other agents stay out of scope (PRD §4).
