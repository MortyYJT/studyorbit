import type { CommandName, CommandOutput, ParsedCommandInput, Level, AuditRecord } from './contracts.js';
import type { ErrorCode } from './errors.js';
export type ReadCommand = Extract<CommandName, `${string}.list`> | 'sources.get';
export type WriteCommand = Exclude<CommandName, ReadCommand>;
export interface ProtocolRepository {
  read<N extends ReadCommand>(name: N, input: ParsedCommandInput<N>): Promise<CommandOutput<N>>;
}
export type ServiceInput<N extends WriteCommand> = ParsedCommandInput<N>;
export interface ProtocolServices {
  write<N extends WriteCommand>(name: N, input: ServiceInput<N>, context: TrustedContext): Promise<CommandOutput<N>>;
  /** Trusted, pure translation of a legacy Q1 recording payload to its canonical target, resolved before
   * any write so the receipt can be checked. Absent translation denies the legacy alias.
   */
  recordingTarget?(name: 'policy.record' | 'grant.record', input: unknown): Promise<{ courseId: string; assessmentId?: string }>;
}
export interface EvidenceService {
  /** Resolve sources in the target scope; never accept trusted text/offsets from request data. */
  check(command: CommandName, input: unknown): Promise<void>;
}
export interface AuthorizationService {
  /** Recheck recorded policy/exact grant/classification. A registry level alone grants nothing. */
  check(command: string, level: Level, input: unknown): Promise<void>;
  /** Optional trusted target/version resolution for audit metadata; no request prose. */
  references?(command: string, level: Level, input: unknown): Promise<Pick<AuditRecord, 'courseId' | 'assessmentId' | 'revision' | 'policyRef' | 'grantRef'>>;
}
export interface OwnerInteraction {
  /** Host-established capability. Implementations must verify their actual owner interaction. */
  assertOwner(command: string): Promise<void>;
}
export interface AuditEvent extends Pick<AuditRecord, 'courseId' | 'assessmentId' | 'revision' | 'policyRef' | 'grantRef' | 'level' | 'decision' | 'reason' | 'action' | 'outcome' | 'confirmation'> {
  command: string; runId: string; phase: 'intent' | 'outcome' | 'denial'; code: 'OK' | ErrorCode;
}
export interface TrustedContext {
  repository: ProtocolRepository;
  services: ProtocolServices;
  evidence: EvidenceService;
  authorization: AuthorizationService;
  privacy: { protect(command: string, data: unknown): Promise<unknown> };
  audit: { record(event: AuditEvent): Promise<void> };
  /** Audit and operational runs are distinct; neither receives request prose or raw errors. */
  runs: { record(event: AuditEvent): Promise<void> };
  owner?: OwnerInteraction;
  /** Dispatch identity passed only by the trusted host. */
  runId?: string;
}
