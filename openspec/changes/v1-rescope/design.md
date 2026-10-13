## Context

v1 was planned as a deterministic pipeline: crawl or capture pages, normalize, diff, store, then let agents read and write through gated commands. By 2026-10-14 the foundation, Ed transport, registry/CLI/MCP/HTTP, citation service, authorization and audit were merged, and Q1 was completed by the agent operating the browser directly (#94, #97). Two dry runs then showed which parts an agent does better (finding courses, reading syllabi, judging which items belong to which assessment, operating pages) and which parts are stable code (API reads, storage, scheduling, display, guardrails). Decisions #100–#102 record the new split. On 2026-10-14 the owner also answered the three open sync questions and chose to close `v1-ui` into this change.

Current truth after this change's housekeeping: `openspec/specs/` holds the archived `v1-foundation`, `capture-selection-ed` and `v1-protocol` requirements, because that code is on `main`. `v1-sync`, `ed-quiz-assist` and `v1-ui` were closed without syncing specs. This change removes the cut requirements from current truth and adds the new ones.

## Goals / Non-Goals

**Goals:** one resident signed-in browser; `coursework sync` writing the latest Canvas and Ed state; cited agent annotations for weights, classification and assessment links; deterministic deadline-first planning; the prototype UI showing real data; a revision skill usable by 2026-10-26; simpler autonomy that still meets the red lines; removing the cut code and its tests.

**Non-Goals:** email intake (later); syncing every course PDF in `coursework sync` (the revision skill fetches only what it cites); Hermes integration; a React rebuild of the UI; UI screens for review, fill or submit; change detection; any code that clicks submit on its own; dropping the old change-event table.

## Decisions

### 1. Agent understands, code remembers and guards (#100)
Code keeps only what is the same every run: authenticated JSON reads, validation, redaction, storage, the plan and the view, permission checks and the audit log. Anything that needs reading prose (which assessment a lesson counts toward, the final's weight, whether a quiz is an exam) is an agent annotation with a checked citation. Alternative rejected: encoding syllabus rules in sync, which was where the old design stalled (v1-sync open questions).

### 2. Resident browser over per-command launches
One headed Edge runs on the managed profile with a loopback debugging port; sync, status checks and agents attach to it. This keeps one signed-in session alive for scheduled jobs (#102) and lets the owner watch agent actions (#98). Endpoint and pid live in `<data dir>/browser.json` (0600). Any local process running as the owner could attach to the port; that is the same trust boundary as the profile directory itself, so no extra secret is added. If the platform refuses remote debugging on the default profile directory, fall back to Playwright's `launchPersistentContext` inside a long-lived `coursework browser start` process that exposes the same attach contract; record which one shipped.

### 3. Sync stores facts; annotations add structure (owner answers 1 and 3)
Sync stores each gradable platform entry as a SourceItem with `facts` (due, points, owner's score, submitted). The only assessment sync creates is one per Canvas assignment group with an explicit weight, because that weight is a platform fact; its items are linked automatically. Everything else (Ed workshops, syllabus-only exams, hurdles) comes from agent annotations. Assessment `weight` and `kind` become optional, so "unknown" is representable instead of zero or non-exam. Precedence: owner > agent > sync. Annotations are append-only. Alternative rejected: one Assessment per platform item, which cannot express "ten workshops together are 10%".

### 4. Course merge by normalized code (owner answer 2)
The owner chose automatic merging by course code. This partly overrides #85 O4 ("do not merge by course name"). The rule stays mechanical: extract exactly one `[A-Z]{4}[0-9]{5}` match per provider course; merge one Canvas and one Ed course in the same term with equal codes; anything else (no match, duplicates) stays separate and is reported. Names are never used. An owner mapping record, if one is ever added, wins. Course identity is the course id; provider ids live in `Course.sources`.

### 5. Latest state, soft removal, no events (#101)
Each course is written in one transaction. Items missing from a complete collection read are marked `removed` so links and annotations keep a target; partial reads never remove. The change-event table stays in the database but receives no writes. The `changes` command, diff and reconciliation code are deleted.

### 6. Autonomy: check plus audit instead of gates
Code cannot stop an agent's click in the browser, so the fill/submit commands, single-use confirmations and exact-review binding are removed (#100 overrides #85 O6 and #88). What remains: owner-recorded course policy and per-assessment grants (TTY only), `autonomy.check` (unknown kind counts as exam), and an append-only `audit.record` for each browser write that names the confirmation method for L4. The skills tell the agent to check first, list answers for confirmation (#97), and record afterwards. This keeps the red lines (per-assessment grants, audit, L4 owner confirmation by default, exams capped at L1) while recognizing that enforcement now relies on the agent following the skill. The existing protocol `authorization.ts` and `audit.ts` are the base; `src/quiz/policy.ts` and `src/quiz/audit.ts` are folded in or deleted after their tests are ported.

### 7. Planning in core, UI only displays
The EDF planner is a pure function with injected dates in core code (moved from the old UI plan, #89 O4/O5 kept): minutes split across days, overdue first, undated last, stable ties, overflow and unestimated work kept. It is exposed as `plan.read`. Settings are one owner-only record.

### 8. UI: serve the prototype, swap sample data for reads
`coursework ui` serves `design/prototype/index.html` (with its data layer replaced by fetches to the L0 read routes) from the HTTP process. No React or Vite until the prototype stops being enough. Reads need no owner token; the only write offered is planning settings, which uses the existing owner token flow (#86) or is left to the CLI if that flow is not ready.

### 9. Revision skill lives in the repository
The skill is a Markdown skill file in the repository (path decided in implementation, under the agent-agnostic skills folder), plus a short scheduled-task prompt. It uses `coursework browser status`, `source.fetch`, the existing `revision.write`/`practice.write` study writes and the citation service; notifications use the agent host's notification tool. Two owner choices on 2026-10-14 close the gaps that would have blocked it: study records move from the in-memory store to a SQLite `study_record` table (id, command, revision, JSON, compare-and-swap kept), and citable sources are fetched by code from a URL the agent names (`source.fetch`, PDFs via the pre-approved `unpdf`), so the agent never supplies the source text it cites. Weak topics are kept inside the revision notes rather than a new entity.

### 10. Housekeeping order
Implemented changes were archived with their specs so truth matches `main`, and this change removes what #100/#101 cut. This differs from the handoff's "rewrite each change's scope", but it ends with one open v1 change instead of four overlapping ones and needs no rewriting of finished specs.

## Risks / Trade-offs

- [Agent skips `autonomy.check` or `audit.record`] → skills state the rule; audit gaps are visible on review; L4 always needs the owner's chat confirmation. This is weaker than code gates and is accepted by #100.
- [Remote debugging port is attachable by any local owner process] → loopback only, endpoint file 0600, same boundary as the profile itself.
- [Sessions expire overnight] → status check first; scheduled jobs stop and notify instead of retrying or prompting; the maximum session lifetime is still unmeasured.
- [Course codes collide or differ across providers] → exact single-match rule, ambiguity reported, no name matching.
- [Agent annotations are wrong but cited] → citation proves the quote exists, not the interpretation; owner annotations override; UI shows origin and quote.
- [Revision skill deadline 2026-10-26] → it depends only on the resident browser, `source.fetch` and durable study records, so it is scheduled before sync.
- [Deleting merged code loses tested behavior] → deletions follow the #100 list only; git history keeps them; each removal PR runs the full check.

## Migration Plan

1. Done in this change's PR: archive `v1-foundation`, `capture-selection-ed`, `v1-protocol` with specs; close `v1-sync`, `ed-quiz-assist`, `v1-ui` with `--skip-specs`; record decisions #103–#111.
2. Delete `codex/quiz-fill`; redo `claude/protocol-integration` without the gates as issue C; drop `codex/ui-inventory`.
3. Implement in order: cuts (A) → resident browser (B) → protocol integration (C) → revision skill (D, by 2026-10-26) → schema (E) → sync (F) → annotations (G) → planning (H) → UI (I) → acceptance and archive (J). D can run in parallel with E–F.
4. Migrations are additive; the change-event table is kept. Rollback is reverting the PR; no local data is deleted.

## Open Questions

- #96 (quiz pages read without redaction) still needs the owner's explicit confirmation before `AGENTS.md` changes. Until then the revision skill sees course content only through `source.fetch` and sync (both redact), and the assessment skill (task 4.4) may not read quiz pages raw.
- Whether a chat confirmation may also record a per-assessment grant, instead of a TTY command, would change a red line; it stays TTY-only unless the owner decides otherwise.
- Does Edge allow remote debugging on the existing managed profile directory? Answer in issue B; fallback in Decision 2.
- Installing `unpdf@1.8.1` (pre-approved, #74) needs the owner present to approve the install prompt.
