import type { CommandName, CommandOutput, ParsedCommandInput, Level, FilledTarget, Confirmation, AuditRecord } from './contracts.js';
import type { ErrorCode } from './errors.js';
export type ReadCommand = Extract<CommandName, `${string}.list`> | 'sources.get' | 'proposals.get' | 'changes' | 'quiz.read';
export type WriteCommand = Exclude<CommandName, ReadCommand | 'quiz.fill' | 'quiz.submit'>;
export interface ProtocolRepository {
  read<N extends ReadCommand>(name: N, input: ParsedCommandInput<N>): Promise<CommandOutput<N>>;
}
/** Canonical owner services also accept the unchanged Q1 payload for trusted D mapping. */
export type ServiceInput<N extends WriteCommand> = N extends 'policy.record'
  ? ParsedCommandInput<N> | ParsedCommandInput<'quiz.policy'>
  : N extends 'grant.record' ? ParsedCommandInput<N> | ParsedCommandInput<'quiz.grant'> : ParsedCommandInput<N>;
export interface ProtocolServices {
  write<N extends WriteCommand>(name: N, input: ServiceInput<N>, context: TrustedContext): Promise<CommandOutput<N>>;
}
export interface EvidenceService {
  /** Resolve sources in the target scope; never accept trusted text/offsets from request data. */
  check(command: CommandName, input: unknown): Promise<void>;
}
export interface AuthorizationService {
  /** Recheck recorded policy/exact grant/classification. A registry level alone grants nothing. */
  check(command: string, level: Level, input: unknown): Promise<void>;
}
export interface OwnerInteraction {
  /** Host-established capability. Implementations must verify their actual owner interaction. */
  assertOwner(command: string): Promise<void>;
}
export interface ConfirmationService {
  /** Host-only issue; check/consume under the serialized action boundary, including current versions. */
  issue(target: FilledTarget, owner: OwnerInteraction): Promise<Confirmation>;
  consume(token: string, current: FilledTarget): Promise<void>;
}
export interface ActionAdapter {
  /** No default real adapter. H owns serialized rechecks, confirmation consumption and audit lifecycle. */
  fill(input: ParsedCommandInput<'quiz.fill'>, context: TrustedContext): Promise<CommandOutput<'quiz.fill'>>;
  submit(input: ParsedCommandInput<'quiz.submit'>, context: TrustedContext): Promise<CommandOutput<'quiz.submit'>>;
}
export interface AuditEvent extends Pick<AuditRecord, 'assessmentId' | 'revision' | 'policyRef' | 'grantRef'> {
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
  confirmations?: ConfirmationService;
  actions?: ActionAdapter;
}
