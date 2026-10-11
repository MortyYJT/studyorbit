## Context

`v1-foundation` is implemented but not archived. Its `specs/page-capture/spec.md` is the baseline: `c` currently crawls every Canvas course linked from `/courses`, in a hidden tab, with GET navigation, a one-second delay and a 300-attempt cap. `src/capture/crawl.ts` saves by requested URL without final-URL deduplication; `session.ts` consumes terminal commands; `command.ts` owns the profile lock and browser lifecycle. The current CLI prints human errors rather than agent envelopes.

Decisions [#43–#50 and #52–#54](../../../note/decisions.md) govern this change. #45/#47 supersede earlier browser/profile choices; their behavior remains intact. The [Ed survey](../../../note/product/ed-findings.md) observed lesson, slide, thread, and resource endpoints on `https://edstem.org`, but did not verify the course-list endpoint, auth headers, or requests without `view=1`. This is evidence of endpoint shapes, not proof that capture already works.

## Goals / Non-Goals

**Goals:** selected-course Canvas and Ed capture; durable terminal selection; predictable no-TTY behavior; duplicate-free Canvas final URLs; raw Ed JSON snapshots; shared bounded reads; source-isolated authentication outcomes.

**Non-Goals:** code in this draft; domain/schema or SQLite changes; automatic assignment parsing, deadline reconciliation, model calls, submission, token provisioning, `coursework login`, dependency additions, CI/deployment changes. Raw capture is not a model-safe ingestion interface.

## Decisions

### 1. Source-qualified selection, discovered once and reused (#50/#54)

Discover current-term Canvas courses from the rendered `/courses` listing and Ed courses from its own course-list GET endpoint. Use explicit term/current-course metadata from each source, not a regular expression on course codes, page position, or a guessed semester date. Keep rows distinct by source, origin, and source course id; a synthetic course such as ABCD10001 can have one row per source. Selecting a Canvas row does not implicitly select an Ed row.

Persist a small versioned selection file at `<data dir>/capture-selection.json`, using the existing `.local/` default and `COURSEWORK_HOME` override. Store source-qualified ids and source term context, not auth material; display names need not be persisted. Validate on read, use atomic replacement and owner-only permissions. Empty selection is valid and schedules no course reads. Discovery endpoints are permitted even when they list unselected courses; no unselected course detail endpoint is visited.

Interactive reselection refreshes discovery; reuse does not silently broaden or change selection. If term eligibility cannot be determined, report source discovery as unavailable rather than guessing. If one source is unavailable, allow selection of the available source while retaining existing choices for the unavailable source and reporting the gap; never replace its choices with an inferred empty list. Cancellation keeps the prior file unchanged.

Rejected: automatic code filtering (can exclude valid courses, #54); select everything by default (violates #50); joining providers by name (ambiguous); storing configuration in the repo (privacy).

### 2. Explicit command surfaces without new protocol codes

Interactive `coursework capture` retains `s`, `c`, and `q`; first `c` invokes the picker and subsequent `c` reuses the saved selection. Add `coursework capture --reselect` to open the picker before the next crawl. Add `coursework capture --crawl` as a one-shot entry point for stored selection, so an agent need not feed keystrokes into readline. With a TTY and no saved selection, this entry point runs the same picker first and then crawls. Without a TTY it never prompts, including for browser fallback or sign-in, and emits exactly one `coursework.agent/v1` envelope on stdout. Operational logs go to stderr and exclude raw content.

Use existing `INVALID_INPUT` for absent/invalid selection or non-TTY reselection, with a recovery hint to run interactive capture. An unavailable source uses `SOURCE_UNAVAILABLE`; expired Ed uses `AUTH_EXPIRED` in the Ed outcome. Successful orchestration returns a bounded envelope with counts and per-source statuses/errors; an Ed error does not erase a successful Canvas outcome. Profile locks, browser detection, and password/MFA boundaries remain as in #45–#47. Interactive lock contention retains exit status 3 and the human message; non-interactive contention is mapped to a single `LOCKED` envelope. Other browser/preflight errors must also be mapped to the existing envelope contract in the one-shot path. A non-TTY plain invocation uses the one-shot path rather than waiting on stdin.

Rejected: adding a new error-code family (existing codes express the failure); requiring agent terminal interaction (can hang); relying on stored selection while still running the interactive command loop (not a usable agent contract).

### 3. One scheduler and budget for both providers

Inject a common limiter into discovery and crawl adapters. Count every capture-initiated Canvas navigation and Ed API GET attempt, including failures, unavailable endpoints, auth errors, duplicates, discovery and Ed page bootstrap navigation. The entire run permits at most 300 attempts. Wait at least one second after each attempt completes, including snapshot writing, before starting another. Normal browser subresources are not separately counted, matching the Canvas page-load baseline. No automatic retries; 429 is recorded without immediately retrying. Stop on cap/cancellation, and retain completed snapshots. Discovery responses fetched for the picker are reused in that run rather than fetched twice. No provider gets a separate 300-attempt allowance.

Issue A owns selection and this scheduler. After its contracts are available, Canvas and Ed adapters can be implemented independently; issue C owns their final wiring in `command.ts`/`session.ts`/CLI so two issues do not edit the orchestration concurrently.

Rejected: parallel independent limiters (can burst and double the cap); exhaustive pagination (unbounded); hidden retries (consume time and make budgets misleading).

### 4. Deduplicate Canvas by final URL

Copy the full affected baseline requirements into MODIFIED deltas, then revise selected-course planning, orchestration, and redirects. Normalize same-origin final URLs by removing credentials, query, fragment, and equivalent trailing slash. Save a final URL once per run, entering it into the saved set only after a successful write. For a disabled tab redirect to its selected course's home, record requested and final URLs plus whether its snapshot was already saved. Do not discover assignments/announcements from home HTML under the original tab's identity. Redirects to unselected course details are recorded and not saved or expanded; off-origin or login redirects retain Canvas signed-out handling.

Rejected: deduplication by requested URL (does not remove redirected duplicates); skipping every redirect (loses the first home snapshot); global deduplication across runs (would lose later changes).

### 5. Ed GET responses from the logged-in page (#52/#53)

Perform deterministic same-origin fetch inside a Playwright page on the fixed Ed origin, using the persistent profile's own session. No external HTTP client, self-issued token, model-authenticated call, password handling, POST, or explicit token-renew endpoint. Validate endpoint origin and identifiers and refuse cross-origin redirects before following them. The page's own login state is used; cookies alone have not been proven sufficient. If Ed requires an application auth header, verify its mechanism without exposing secrets; do not guess it or persist its value.

Capture the course list; per selected course, lessons list, each `kind: attempt` lesson and its referenced slides, the first thread-list page (`limit=30&sort=new`), and resources. The first thread page is the explicit pagination bound. Ordinary `kind: content` lesson bodies, thread details/replies, workspaces, external files and resource downloads are excluded. Lesson and slide GETs omit `view` entirely. A refusal without `view=1` is a gap/open question, never permission to send it. Absent tabs/endpoints (404/405) are recorded as unavailable/skipped, not failures; 401/403 always take precedence and stop only Ed.

Save successful raw JSON response bodies as `response.json` with a metadata sidecar under `<data dir>/snapshots/edstem.org/`, with collision-safe folders and owner-only permissions. Preserve embedded XML strings and date fields verbatim. Metadata identifies provider, endpoint path, capture time, status and safe pagination parameters, not request headers/cookies. Summaries contain counts and sanitized endpoint references, not response bodies or names.

Rejected: HTML-only Ed capture (SPA API gives structured assignment dates, #52); `view=1` even when convenient (marks viewed); unlimited threads (privacy, time); assuming every course has Lessons (survey disproves it).

### 6. Privacy boundary and partial outcomes

Raw course-list and thread snapshots can contain personal data. Keep all selection, snapshots and summaries in private local storage, ignored by Git. No raw response body or student name enters envelopes, logs, docs, fixtures, or models. Tests use wholly synthetic data, never redacted copies of real course captures. Any later ingestion/export must remove classmates' personal data, including names in nested authors and free text, before anything reaches a model; until such redaction is verified, raw snapshots cannot be exposed through model-facing tools.

Maintain per-source results: Canvas's existing signed-out behavior applies to Canvas only; Ed 401/403 yields `AUTH_EXPIRED` with manual-login recovery and stops its remaining queue. Canvas can continue within the remaining shared budget. Missing Ed endpoints are skips, malformed/non-JSON successes or other HTTP errors are failures with no raw payload in messages. Both success and failure evidence survive cancellation or partial authentication.

Rejected: failing the entire run for an Ed expiry (loses usable Canvas evidence); claiming raw GET JSON is model-safe (thread authors contain classmates' names).

## Risks / Trade-offs

- [Undocumented Ed API changes] → Small source adapter, synthetic contract tests, bounded reads and explicit gaps; no claim of stable public API compatibility.
- [Unknown authentication header] → Verify page-context GET behavior during implementation using the existing logged-in session; absent proof report unavailable/expired rather than fabricate credentials.
- [Read endpoints can have side effects] → Never send `view=1`; do not call renewal endpoints; verify no-view lesson and slide calls without weakening the boundary.
- [Rate limits or large selected courses] → Shared one-second spacing, 300 attempts including discovery, one thread page, no retries; report incomplete capture on cap/429.
- [Current-term markers differ or are absent] → Confirm both discovery responses before implementing adapters; do not infer eligibility from codes or silently select historical courses.
- [Raw local snapshots contain private data] → Restricted files, Git-ignore checks, no model exposure, synthetic fixtures; future redaction is a separate verified ingestion requirement.
- [Canvas consumes the budget before Ed] → Report per-source attempted/not-started outcomes and cap reason; fair scheduling beyond the deterministic initial order is deferred.

## Migration Plan

No database migration or dependency change. Existing profiles and HTML snapshots stay compatible; absence of the new selection file requires the first interactive selection. Rollback to the previous capture implementation leaves local selection/JSON files intact, without promising the old version can interpret them.

Archive **after `v1-foundation`**, and only after its outstanding acceptance and archive gate are complete. This change's `page-capture` MODIFIED blocks use the complete current requirement text from that change, with scoped updates. The new `course-selection` and `ed-capture` capabilities use ADDED requirements. Reconcile any intervening baseline changes before archive; do not archive either change as part of this drafting task.

## Open Questions

- What exact Ed GET endpoint returns the course list, and what field distinguishes the current term? The survey did not establish either.
- Which rendered Canvas `/courses` section or term marker reliably identifies current-term entries?
- Do page-context GETs authenticate with cookies alone, or need Ed's existing application header? The name and acquisition mechanism are unverified.
- Do lesson and slide GETs work with `view` omitted? If not, record missing capture coverage without sending `view=1`.
- How long does the Ed profile session survive restart, and when does MFA recur? This draft does not claim live acceptance or complete foundation task 5.5.

These are implementation evidence gaps, not reopened user choices. Decisions #52–#54 record a pending personal rationale; do not invent one beyond their recorded context.
