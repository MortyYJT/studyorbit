## Why

Course JSON v1 asks the model to write everything: assessment IDs, due dates, scores, maximum scores, statuses and weights. The model invents IDs that change between runs, copies facts that Canvas and Ed already return exactly (decision #208), and can state a weight or hurdle rule that no collected source supports. The evaluation work (#244, #245) also needs a stable way to match the same assessment across runs. The owner decided to move the contract to version 2 with platform references and verbatim quotes (#246), and to clear and flag any weight or rule whose quote cannot be found (#247).

## What Changes

- **Two schemas.** A new *model output* schema (what the model returns) and a *stored document* v2 (what is saved to the Desktop course folder and displayed). The model returns platform references (`refs`), grouping (`key`, `parentKey`), `name`, `kind`, `nature`, `scoring`, `weight` + `weightQuote` and `rule` + `ruleQuote`. It no longer returns IDs, due dates, scores, maximum scores, statuses or `sources`.
- **Code-generated IDs.** IDs are derived deterministically from references: `canvas:<id>`, `ed:<id>`, `canvas-group:<id>`, `handbook:<slug>`, or `group:<slug>` for a group only the model knows.
- **Reference validation.** A reference that is not in the collected data is a validation issue and goes through the existing one-repair loop. Handbook references must name a component parsed from the Handbook assessment table.
- **Fact back-fill.** Due date, score, maximum score and status come from the collected Canvas and Ed data by platform ID; `sources` links are built by code.
- **Quote verification.** Every weight and rule must be backed by the collected data: a matching Canvas group weight or cited Handbook row percentage, or a verbatim quote found in assessment-description text (Handbook rows and lines, Ed context, Canvas group names and rendered drop rules). A failing field is cleared, listed in `unsourced`, and the page shows 「无出处」.
- **Local keys follow the new IDs.** The stored document records `legacyIds` (earlier ID → new ID); corrections, planned work, manual items and ordering are moved to the new keys once.
- **Backward-compatible reading.** `CourseDocumentSchema` accepts version 1 and version 2; a helper turns either into one display shape, so v1 files on the Desktop keep working.
- **BREAKING (model contract only):** the JSON Schema and prompt sent to the model change. Stored v1 files stay readable; new syncs write v2.
- Out of scope: moving corrections to `.local/` (#248), correction conflict handling (#249), `node:sqlite` (#250), new collectors or new collected fields, and the evaluation runner itself.

## Capabilities

### New Capabilities

- `course-contract`: the stored course document v2, reading v1 and v2 into one display shape, showing 「无出处」, and moving local keys to the new IDs through `legacyIds`.
- `course-analysis`: the model output schema, reference validation, ID generation, fact back-fill and quote verification during sync.

### Modified Capabilities

None. No current spec covers the course JSON contract (`openspec/specs/` has `grade-target`, `revision` and `weekly-plan` only).

## Impact

- `shared/course-data.ts`: v2 stored schema, model output schema, v1/v2 union and the display helper.
- `scripts/lib/course-analysis.mjs`: output JSON Schema and prompt.
- `scripts/lib/course-validation.mjs`: reference checks replace the Ed score/maximum check; new `scripts/lib/course-refs.mjs` (IDs, back-fill) and `scripts/lib/course-quotes.mjs` (quote verification), each with `.d.mts`.
- `scripts/course-sync-runner.mjs`: builds the stored document from the model output and the collected data before saving.
- `scripts/lib/course-reports.mjs`, `scripts/lib/chat-context.mjs`, `vite.config.ts`, `web/src/LocalPlanning.tsx`: read through the display helper; the page and the chat context mark unsourced fields.
- `scripts/lib/eval-score.mjs` (if present): matching by ID, then platform identity, then name.
- `docs/course-json.md` rewritten for v2.
- No new dependencies. Existing Desktop files and browser storage stay valid.
