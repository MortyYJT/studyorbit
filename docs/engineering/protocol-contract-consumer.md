# M2 contract consumer guide (Issue A)

The specification remains `openspec/changes/v1-protocol/`. This guide describes the implemented
contract seam for M3 and subsequent M2 issues; it does not select production storage or transports.

- `src/protocol/contracts.ts`: the keyed `contracts` table, `CommandName`, `CommandInput<N>`
  (wire input, including omitted defaults), `ParsedCommandInput<N>` and `CommandOutput<N>`.
  `envelopeSchema(name)` validates the corresponding success/failure envelope. Failure codes and
  retryability reuse `errors.ts`; no new wire error codes were introduced.
- `src/protocol/registry.ts`: `Registry`, `RegistryEntry`, `createRegistry`, `dispatch`, and
  explicit `adaptLegacyHandler`. Entries contain exactly name/input/output/handler/level.
- `src/protocol/context.ts`: host-injected repository, service, evidence, authorization, privacy,
  owner interaction, confirmation, audit/run and action ports. Repository access never opens SQLite
  from a handler. Only trusted host code creates this context; request fields cannot create it.
- `src/protocol/fakes.ts`: independent synthetic `examples`, `FakeRepository`, `FakeServices`,
  `FakeConfirmations`, `createFakeRegistry` and `createFakeContext`.

A minimal fake-data consumer:

```ts
import { contracts, envelopeSchema, type CommandInput } from '../../src/protocol/contracts.js';
import { dispatch } from '../../src/protocol/registry.js';
import { createFakeContext, createFakeRegistry, examples } from '../../src/protocol/fakes.js';

const registry = createFakeRegistry();
const context = createFakeContext();
const request: CommandInput<'courses.list'> = examples['courses.list'].input;
const response = await dispatch(registry, 'courses.list', request, context);
envelopeSchema('courses.list').parse(response);
if (response.ok) {
  const page = contracts['courses.list'].output.parse(response.data);
  // page.items, page.evidence, page.coverage.gaps; page.nextCursor when continuation exists.
}
```

New list cursors are bounded opaque base64url-compatible tokens. Clients echo them unchanged and
never derive offsets or identities from them. A missing `nextCursor` means there is no continuation.
Repository implementations own token validity and filter binding; fake repositories return cloned
fixed examples and deliberately do not implement production filtering/paging. `changes` retains
its exclusive numeric `since`/`nextCursor`, default limit 100 and maximum limit 500. Existing
`changesHandler` can be mounted through `adaptLegacyHandler`; it retains oversized-event handling.

Study writes use cited claim units; breakdown uses a strict, bounded copy of M1 Task with its
existing refinements. Q1 proposal/read/review/prerequisite/policy/grant shapes are reused directly.
`quiz.policy` and `quiz.grant` share canonical owner service handlers; `ServiceInput<N>` explicitly
allows their unchanged legacy payloads. D must resolve trusted provider identities; the dispatcher
never guesses a `courseId` from a legacy numeric `course` or course title.

The owner commands are review, prerequisites, policy and grant recording (including Q1 aliases).
They require `context.owner.assertOwner` even though their registry minimum is L0. Every dispatch
also calls the injected authorization service. Study/proposal/action commands call the injected
evidence service. Production services must perform the corresponding publication/action safety
checks; registry levels and schema success do not grant authorization or verify citations.

Fake contexts are fixture hosts only: their authorization/evidence services are permissive test
stubs and `owner: true` selects a host-side fake capability, never a wire field. Fake services log
cloned inputs and return fixed schema-valid receipts; they do not claim durable publication.
Fake privacy uses the existing default-on redactor. Inject the actual trusted scope in production.
Audit and run sinks receive only safe command/run/phase/code metadata from the dispatcher; their
ports also allow optional target/revision/policy/grant references resolved by trusted D/H services.
Unknown requested command text is withheld from envelopes and journals.

With no action adapter, fill/submit return `status: unavailable`, `reason: SOURCE_UNAVAILABLE`,
without any action call. `createFakeContext({ actions: true })` returns synthetic action receipts;
these stubs do not verify a real endpoint, enforce a real grant, or submit anything. H owns serialized
rechecks, durable intent/outcome audit and accurate uncertain outcomes. The confirmation port
binds tokens to the exact filled target, source revision, page/attempt and policy/grant references.
`FakeConfirmations` demonstrates host-owner issuance, exact binding, single use and expiry; its
60-second lifetime is a test-double choice, not production expiry policy. H must settle production
expiry and consume tokens under the action boundary. An agent boolean cannot represent consent.

Dispatcher failures preserve existing error codes/retryability while replacing raw messages with
safe diagnostics (`AUTH_EXPIRED` still directs the user to sign in). Final metadata is applied
before serialization is checked against the existing 64 KiB bound, including multibyte text.
Invalid output is withheld, and output is validated again after the injected privacy boundary.

No CLI/MCP/HTTP transport, production repository/service, browser adapter, real course fixture,
new dependency, M1 domain migration or actual remote write is included in Issue A.

## Local verification evidence

- Baseline `npm run check`: exit 0; 64 test files passed, 662 tests passed, 2 skipped.
- Red `npx vitest run test/protocol/registry.test.ts`: exit 1 because contracts did not exist.
  Later behavioral regressions failed at the exact envelope boundary (65,546 > 65,536 bytes),
  oversized Task id acceptance and unknown-command prose exposure; each was fixed before green.
- Green targeted contract suite: 18 passed. Independent read-only review: ready to merge for
  tasks 1.1–1.4 only. Oversized fixtures use spaced text to avoid testing the existing redactor's
  pathological long unbroken-string performance in an envelope-boundary test.
- Final `npm run check`: TypeScript passed; 65 test files passed, 680 tests passed, 2 skipped.
  Existing skips remain skips; no live/browser/endpoint or production acceptance was performed.
- `openspec validate v1-protocol --strict` and `git diff --check`: exit 0.

Task 1.5 remains unchecked because this request covers 1.1–1.4 and does not deliver/merge a PR.
Production policy/grant/evidence persistence and gates remain D/C/H, and real submission remains M4.
