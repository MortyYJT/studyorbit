import { ConversationService } from '../agent/conversations.js';
import { unavailableAdapter, type AgentAdapter, type AgentTool } from '../agent/adapter.js';
import { PlanningService } from '../planning/service.js';
import { productionSync } from '../sync/runtime.js';
import type { SyncCommands } from './sync.js';
import { SqliteStudyRecordStore } from '../store/study-records.js';
import { RevisionService, StoreStudyEvidence } from '../revision/service.js';
import type { SourceTransport } from '../revision/source-fetch.js';
import { databasePath } from '../config/data-dir.js';
import { SqliteRepository } from '../store/sqlite.js';
import { ProtocolFiles } from './files.js';
import { createRegistry, sessionOnlyCommand } from './registry.js';
import { StoreProtocolReads, TrustedStoreEvidence, type AuxiliaryReadPorts, type EvidenceMetadata } from './reads.js';
import { SharedAuthorization } from './authorization.js';
import { CanonicalAuthorizationStore } from './canonical-authorization.js';
import { AssessmentAutonomy } from './autonomy.js';
import { DurableAudit, DurableRuns } from './audit.js';
import { ComposedServices, ComposedEvidence } from './writes.js';
import { StudyWriteService, type StudyRecordStore } from './study-writes.js';
import { StudyCitationService, type StudyEvidenceProvider } from './citations.js';
import type { TrustedContext } from './context.js';
import { CourseworkError } from './errors.js';
export interface ProductionOptions {
  store?: SqliteRepository; files?: ProtocolFiles; metadata?: readonly EvidenceMetadata[]; privacyScope?: unknown;
  reads?: AuxiliaryReadPorts; study?: { provider: StudyEvidenceProvider; store: StudyRecordStore };
  sync?: SyncCommands;
  agentAdapter?: AgentAdapter; agentTools?: readonly AgentTool[];
  owner?: TrustedContext['owner']; sourceTransport?: SourceTransport;
}
/** Compose durable storage and validated revision services once for all transports. */
export function createProductionProtocol(options: ProductionOptions = {}) {
  const store = options.store ?? new SqliteRepository(databasePath());
  const chat = new ConversationService(store, options.agentAdapter ?? unavailableAdapter, options.agentTools);
  const files = options.files ?? new ProtocolFiles();
  const audit = new DurableAudit(files); const runs = new DurableRuns(files);
  const authorizationStore = new CanonicalAuthorizationStore(files, store);
  const authorization = new SharedAuthorization(authorizationStore, audit);
  const autonomy = new AssessmentAutonomy(store, audit);
  const evidence = new TrustedStoreEvidence(store, { metadata: options.metadata, privacyScope: options.privacyScope });
  const accepted = new SqliteStudyRecordStore(store, evidence);
  const provider = options.study?.provider ?? new StoreStudyEvidence(store, evidence);
  const study = new StudyWriteService({ provider, store: options.study?.store ?? accepted });
  const studyEvidence = new StudyCitationService(provider);
  const revision = new RevisionService(store, evidence, { transport: options.sourceTransport });
  const repository = new StoreProtocolReads(store, evidence, {
    ...options.reads,
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
      'breakdown.write': study, 'revision.write': study, 'practice.write': study, 'source.fetch': revision, 'practice.attempt.record': revision }),
    evidence: new ComposedEvidence({ 'breakdown.write': studyEvidence, 'revision.write': studyEvidence, 'practice.write': studyEvidence }),
    // Autonomy outputs are closed enums validated by their schemas; free-text filtering would only corrupt reason codes.
    privacy: { protect: async (command, value) => command.startsWith('autonomy.') ? value : evidence.protect(value) },
    owner: options.owner ?? { assertOwner: async name => {
      if (sessionOnlyCommand(name)) throw new CourseworkError('INVALID_INPUT', 'Open coursework ui to perform this owner action.');
      if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) throw new CourseworkError('INVALID_INPUT', 'Owner terminal required.');
    } },
  };
  return { chat, registry: createRegistry({ autonomy, planning: new PlanningService(store), sync: options.sync ?? productionSync(store) }), context, audit, store, close: () => { if (!options.store) store.close(); } };
}
