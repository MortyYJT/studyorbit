import { contracts, type CommandName, type CommandOutput } from './contracts.js';
import type { EvidenceService, ProtocolServices, ServiceInput, TrustedContext, WriteCommand } from './context.js';
import { CourseworkError } from './errors.js';
import { adaptLegacyHandler } from './registry.js';
import { QuizFiles } from '../quiz/files.js';
import { proposeQuiz, proposalEvidence, proposalInputError, proposalSchema, type QuizWriteDependencies } from '../quiz/proposals.js';
import { reviewQuiz, type QuizReviewDependencies } from '../quiz/review.js';

const unavailable = () => new CourseworkError('SOURCE_UNAVAILABLE', 'The requested write service is unavailable.');
/** Explicit host routing of write commands to their owning services; unrouted commands fail unavailable. */
export class ComposedServices implements ProtocolServices {
  constructor(private readonly routes: { [K in WriteCommand]?: ProtocolServices }) {}
  write<N extends WriteCommand>(name: N, input: ServiceInput<N>, context: TrustedContext): Promise<CommandOutput<N>> {
    const route = this.routes[name];
    if (!route) return Promise.reject(unavailable());
    return route.write(name, input, context);
  }
  async recordingTarget(name: 'policy.record' | 'grant.record', input: unknown): Promise<{ courseId: string; assessmentId?: string }> {
    const route = this.routes[name];
    if (!route?.recordingTarget) throw new CourseworkError('INVALID_INPUT', 'No trusted legacy target translation is installed.');
    return route.recordingTarget(name, input);
  }
}
/** Explicit per-command evidence routing; a command without a route is never silently accepted. */
export class ComposedEvidence implements EvidenceService {
  constructor(private readonly routes: Partial<Record<CommandName, EvidenceService>>) {}
  async check(command: CommandName, input: unknown): Promise<void> {
    const route = this.routes[command];
    if (!route) throw new CourseworkError('SOURCE_UNAVAILABLE', 'Citation adapter is unavailable for this command.');
    await route.check(command, input);
  }
}
/** Fill/submit evidence is the exact reviewed revision, which GatedQuizActions rechecks under its locks. */
export const reviewBoundActionEvidence: EvidenceService = {
  async check(command, input) {
    if ((command !== 'quiz.fill' && command !== 'quiz.submit') || !contracts[command].input.safeParse(input).success) {
      throw new CourseworkError('INVALID_INPUT', 'Exact reviewed action target is required.');
    }
  },
};
/** Q1 proposal preflight: trusted snapshot/material resolution and existing #63/#84 checks, no writes. */
export class Q1ProposalEvidence implements EvidenceService {
  constructor(private readonly files: QuizFiles) {}
  async check(command: CommandName, input: unknown): Promise<void> {
    if (command !== 'quiz.propose') throw new CourseworkError('SOURCE_UNAVAILABLE', 'Citation adapter is unavailable for this command.');
    const parsed = proposalSchema.safeParse(input);
    if (!parsed.success) throw proposalInputError(input);
    await proposalEvidence(this.files, parsed.data);
  }
}
/** Routes proposals and terminal review to the delivered Q1 handlers; they keep their own locks, journals and TTY gates. */
export class Q1QuizServices implements ProtocolServices {
  constructor(private readonly dependencies: QuizWriteDependencies & QuizReviewDependencies = {}) {}
  async write<N extends WriteCommand>(name: N, input: ServiceInput<N>, context: TrustedContext): Promise<CommandOutput<N>> {
    if (name === 'quiz.propose') return await adaptLegacyHandler(value => proposeQuiz(value, this.dependencies))(input, context) as CommandOutput<N>;
    if (name === 'quiz.review') return await adaptLegacyHandler(value => reviewQuiz(value, this.dependencies))(input, context) as CommandOutput<N>;
    throw unavailable();
  }
}
