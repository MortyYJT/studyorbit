import { MetricsService } from '../metrics/service.js';
import { AnnotationService } from './annotations.js';
import { ConversationService } from '../agent/conversations.js';
import { type AgentAdapter, type AgentTool } from '../agent/adapter.js';
import { ClaudeAdapter, type ProtectedPorts } from '../agent/claude.js';
import { CodexAdapter } from '../agent/codex.js';
import { describe, inputSchema } from './mcp.js';
import { PlanningService } from '../planning/service.js';
import { SyncJobs } from '../sync/jobs.js';
import type { ClipboardReader } from '../sync/canvas-api.js';
import { AgentSync, type SyncPipeline } from '../sync/agent-job.js';
import type { SyncCommands } from './sync.js';
import { SqliteStudyRecordStore } from '../store/study-records.js';
import { RevisionService, StoreStudyEvidence } from '../revision/service.js';
import { databasePath, resolveDataDir } from '../config/data-dir.js';
import { SqliteRepository } from '../store/sqlite.js';
import { ProtocolFiles } from './files.js';
import { createRegistry, dispatch, sessionOnlyCommand } from './registry.js';
import { StoreProtocolReads, TrustedStoreEvidence, type AuxiliaryReadPorts, type EvidenceMetadata } from './reads.js';
import { SharedAuthorization } from './authorization.js';
import { CanonicalAuthorizationStore } from './canonical-authorization.js';
import { AssessmentAutonomy } from './autonomy.js';
import { currentLinks, linkedSources, platformState } from '../store/platform-state.js';
import { DurableAudit, DurableRuns } from './audit.js';
import { ComposedServices, ComposedEvidence } from './writes.js';
import { StudyWriteService, type StudyRecordStore } from './study-writes.js';
import { StudyCitationService, type StudyEvidenceProvider } from './citations.js';
import type { TrustedContext } from './context.js';
import { CourseworkError } from './errors.js';
import { MemoryService } from '../memory/service.js';
import { prompt as jobPrompt, tools as jobTools } from '../agent/jobs/index.js';
import { buildCourseDocument } from '../sync/build-document.js';
import { archiveCourse } from '../sync/course-folder.js';
import { assessmentId } from '../sync/course-import.js';
import { edHook, edItems, execFileEdRunner, type EdRunner, type EdStage } from '../sync/ed-cli.js';
import type { CourseDocument } from '../sync/course-json.js';
export interface ProductionOptions {
  store?: SqliteRepository; files?: ProtocolFiles; metadata?: readonly EvidenceMetadata[];
  reads?: AuxiliaryReadPorts; study?: { provider: StudyEvidenceProvider; store: StudyRecordStore };
  sync?: SyncCommands;
  /** Tests inject a fake clipboard for `canvas.capture`; production uses `pbpaste`. */
  clipboard?: ClipboardReader;
  agentAdapter?: AgentAdapter; agentTools?: readonly AgentTool[];
  /** Tests inject a fake `edstem` runner; production uses the CLI. */
  edRunner?: EdRunner;
  owner?: TrustedContext['owner'];
}

/** Merge dated Ed lessons into the built document as their own component, never duplicating an item key. */
function mergeEdItems(document: CourseDocument, items: ReturnType<typeof edItems>, now: string): void {
  const existing = new Set(document.components.flatMap(component => component.items.map(item => item.key)));
  const fresh = items.filter(item => {
    if (existing.has(item.key)) return false;
    existing.add(item.key);
    return true;
  });
  if (!fresh.length) return;
  const code = document.course.code.value;
  const base = `${code ?? 'ed'}:ed`;
  let key = base;
  for (let suffix = 2; document.components.some(component => component.key === key); suffix++) key = `${base}-${suffix}`;
  document.components.push({ key, name: { value: 'Ed lessons', state: 'derived' },
    kind: { value: null, state: 'unknown', checkedAt: now }, count: { value: fresh.length, state: 'derived' },
    weight: { value: null, state: 'unknown', checkedAt: now }, isFinal: { value: false, state: 'derived' },
    hurdleMin: { value: null, state: 'not_applicable' },
    items: fresh.map(item => ({ ...item, unlockAt: { value: null, state: 'unknown' as const, checkedAt: now },
      status: { value: 'not_started' as const, state: 'derived' as const },
      score: { value: null, state: 'unknown' as const, checkedAt: now }, outOf: { value: null, state: 'unknown' as const, checkedAt: now },
      weight: { value: null, state: 'unknown' as const, checkedAt: now } })) });
}
/** Compose durable storage and validated revision services once for all transports. */
export function createProductionProtocol(options: ProductionOptions = {}) {
  const store = options.store ?? new SqliteRepository(databasePath());
  const files = options.files ?? new ProtocolFiles();
  const audit = new DurableAudit(files); const runs = new DurableRuns(files);
  const authorizationStore = new CanonicalAuthorizationStore(files, store);
  const authorization = new SharedAuthorization(authorizationStore, audit);
  const evidence = new TrustedStoreEvidence(store, { metadata: options.metadata });
  const accepted = new SqliteStudyRecordStore(store, evidence);
  const provider = options.study?.provider ?? new StoreStudyEvidence(store, evidence);
  const study = new StudyWriteService({ provider, store: options.study?.store ?? accepted });
  const studyEvidence = new StudyCitationService(provider);
  const revision = new RevisionService(store, evidence);
  const annotations = new AnnotationService(store, evidence);
  const effectiveKind = (id: string) => annotations.read({ entity: 'assessment', entityId: id, limit: 0 }).fields.kind!.value as string | null;
  const autonomy = new AssessmentAutonomy(store, audit, effectiveKind);
  // Import keeps the newest owner or valid agent weight of an item when it computes a component's remainder.
  const annotatedWeight = (id: string) => {
    if (!store.loadAssessment(id)) return undefined;
    const weight = annotations.read({ entity: 'assessment', entityId: id, limit: 0 }).fields.weight;
    return weight && weight.origin !== 'sync' && typeof weight.value === 'number' ? weight.value : undefined;
  };
  const jobs = new SyncJobs(store, { annotatedWeight, ...(options.clipboard ? { clipboard: options.clipboard } : {}) });
  const repository = new StoreProtocolReads(store, evidence, {
    ...options.reads,
    assessments: { query: input => store.queryEffectiveAssessments(input, effectiveKind) },
    project: (entity, value) => {
      const projected = annotations.project(entity, value);
      const storedAt = entity === 'course' ? jobs.storedAt(value.id) : undefined;
      return storedAt ? { ...projected, storedAt } : projected;
    },
    platform: id => {
      const sources = linkedSources(store, currentLinks(store.listAssessmentLinks()), id);
      const candidates = sources.filter(source => source?.facts?.pointsEarned !== undefined && source.facts.pointsPossible !== undefined);
      const points = candidates.length === 1 ? candidates[0]!.facts : undefined;
      return { ...platformState(sources), ...(points ? { pointsEarned: points.pointsEarned, pointsPossible: points.pointsPossible } : {}) };
    },
    accepted: options.reads?.accepted ?? accepted,
    revision: { read: (name, input) => revision.read(name, input) },
    audit: options.reads?.audit ?? { read: async input => {
      // Freeze the append-only prefix so this command's own audit rows do not invalidate paging.
      const rows = (await audit.list()).filter(row => (!input.command || row.command === input.command)
        && (!input.assessmentId || row.assessmentId === input.assessmentId));
      const { createHash } = await import('node:crypto');
      let offset = 0; let length = rows.length;
      let expectedDigest: string | undefined;
      if (input.cursor) {
        const decoded = Buffer.from(input.cursor, 'base64url').toString('utf8');
        const match = /^(\d+):(\d+):([a-f0-9]{64})$/.exec(decoded);
        if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2]))
          || Number(match[1]) >= Number(match[2]) || Number(match[2]) > rows.length
          || Buffer.from(decoded).toString('base64url') !== input.cursor) {
          throw new CourseworkError('INVALID_INPUT', 'Invalid audit continuation.');
        }
        offset = Number(match[1]); length = Number(match[2]); expectedDigest = match[3];
      }
      const snapshot = rows.slice(0, length);
      const scope = JSON.stringify([input.command ?? null, input.assessmentId ?? null, snapshot]);
      const digest = createHash('sha256').update(scope).digest('hex');
      if (expectedDigest && expectedDigest !== digest) throw new CourseworkError('INVALID_INPUT', 'Invalid audit continuation.');
      const items = snapshot.slice(offset, offset + input.limit);
      const next = offset + items.length;
      return { items, evidence: [], coverage: { complete: true, gaps: [] },
        ...(next < length ? { nextCursor: Buffer.from(`${next}:${length}:${digest}`).toString('base64url') } : {}) };
    } },
  });
  const context: TrustedContext = {
    repository, authorization, audit, runs,
    services: new ComposedServices({ 'policy.record': authorization.services, 'grant.record': authorization.services,
      'breakdown.write': study, 'revision.write': study, 'practice.write': study, 'source.record': revision, 'practice.attempt.record': revision }),
    evidence: new ComposedEvidence({ 'breakdown.write': studyEvidence, 'revision.write': studyEvidence, 'practice.write': studyEvidence }),
    owner: options.owner ?? { assertOwner: async name => {
      if (sessionOnlyCommand(name)) throw new CourseworkError('INVALID_INPUT', 'Open coursework ui to perform this owner action.');
      if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) throw new CourseworkError('INVALID_INPUT', 'Owner terminal required.');
    } },
  };
  // A sync run is the layered pipeline over the chat adapter; the adapter and tools are composed below and resolved per run.
  const edRunner = options.edRunner ?? execFileEdRunner;
  const pipeline: SyncPipeline = {
    prompt: (spec, ctx) => jobPrompt(spec, ctx),
    tools: spec => jobTools(spec, agentTools),
    parallel: 1,
    build: (_courseKey, stages, context) => {
      if (!context) return undefined;
      const built = buildCourseDocument({ course: context.course, stages, now: context.now,
        ...(context.resolved ? { resolved: context.resolved } : {}), ...(context.blocked ? { blocked: context.blocked } : {}) });
      const edStage = stages.ed as EdStage | undefined;
      if (edStage?.via === 'api') mergeEdItems(built.document, edItems(edStage, context.course.code, context.now), context.now);
      return built;
    },
    archive: async (courseKey, ctx) => {
      const job = jobs.load(ctx.jobId);
      const courseId = jobs.courseIdFor(courseKey);
      // A course whose build/import failed keeps its old data; there is no new assessment to attach files to.
      if (!job || !courseId) return;
      const result = archiveCourse({ store, course: { id: courseId, code: ctx.course.code,
        ...(ctx.course.name ? { name: ctx.course.name } : {}), term: ctx.course.term }, jobStartedAt: job.startedAt,
        stages: ctx.stages, assessmentIdFor: target =>
          assessmentId(ctx.course.term, `${ctx.course.code}:canvas:assignment:${target}`) });
      jobs.recordStage(ctx.jobId, courseKey, 'archive',
        { moved: result.moved.length, updated: result.updated.length, missing: result.missing.length, unresolved: result.unresolved.length });
    },
    ed: edHook(edRunner, jobs),
  };
  const sync = options.sync ?? new AgentSync({ store, jobs, adapter: () => adapter, pipeline });
  const memory = new MemoryService(store);
  const registry = createRegistry({ memory, autonomy, annotations, metrics: new MetricsService(store, effectiveKind), planning: new PlanningService(store, annotations), sync, courseReading: jobs });
  // The chat agent gets the same owner-free tool set as MCP; every call still goes through dispatch().
  const agent = registry.agentTools(context);
  const agentTools = options.agentTools ?? agent.registry.list().map(entry => ({ name: entry.name, description: describe(entry),
    inputSchema: inputSchema(entry), execute: (input: unknown, scope?: Parameters<AgentTool['execute']>[1]) => dispatch(agent.registry, entry.name, input,
      scope ? { ...agent.context, conversationId: scope.conversationId } : agent.context) }));
  // The UI host records its origin here once it listens.
  const agentRuntime: Pick<ProtectedPorts, 'frontendOrigin'> = {};
  // Codex is the default chat agent (#167); the Claude adapter is selected only with COURSEWORK_AGENT=claude.
  const adapter = options.agentAdapter ?? (process.env.COURSEWORK_AGENT !== 'claude' ? new CodexAdapter({ dataDirectory: resolveDataDir() }) : new ClaudeAdapter({ dataDirectory: resolveDataDir(), runtime: () => ({ ...agentRuntime }) }));
  const chat = new ConversationService(store, adapter, agentTools);
  let closing: Promise<void> | undefined;
  return { chat, agentRuntime, registry, context, audit, store, close: () => closing ??= (async () => {
    await Promise.all(chat.list().map(c => chat.waitForIdle(c.id)));
    if (!options.store) store.close();
  })() };
}
