import { z } from 'zod';
import { parseProtocolCLI } from '../protocol/cli.js';
import { contracts } from '../protocol/contracts.js';
import { Registry, createRegistry, adaptLegacyHandler } from '../protocol/registry.js';
import { unavailableCLIContext } from '../protocol/cli-context.js';
import { fail, ok, withMetadata, type Envelope, type FailureEnvelope } from '../protocol/envelope.js';
import { recordOwnerAction, proposeQuiz, proposalInputError, recordInputFailure, type QuizWriteDependencies } from './proposals.js';
import { readQuiz, type QuizReadDependencies } from './read/command.js';
import { safeQuizError } from './audit.js';
import { CourseworkError } from '../protocol/errors.js';
import { reviewQuiz, type QuizReviewDependencies } from './review.js';

/** Keep the delivered Q1 handlers and durable journals; only their transport syntax is replaced. */
export async function parseQuizCLI(args: string[], dependencies: QuizReadDependencies & QuizWriteDependencies & QuizReviewDependencies = {}): Promise<void> {
  const registry = new Registry(); let legacy: Envelope | undefined;
  const names = ['quiz.read', 'quiz.policy', 'quiz.grant', 'quiz.prerequisites', 'quiz.propose', 'quiz.review'] as const;
  for (const entry of createRegistry().list()) {
    const name = names.find(name => name === entry.name);
    if (!name) { registry.register(entry); continue; }
    registry.register<z.ZodType, z.ZodType>({ name, ...contracts[name], handler: adaptLegacyHandler(async input => {
      legacy = await (name === 'quiz.read' ? readQuiz(input, dependencies)
        : name === 'quiz.review' ? reviewQuiz(input, dependencies)
        : name === 'quiz.propose' ? proposeQuiz(input, dependencies)
        : recordOwnerAction(name === 'quiz.policy' ? 'policy' : name === 'quiz.grant' ? 'grant' : 'prerequisites', input, dependencies));
      return legacy;
    }) });
  }
  const inputFailure = async (failure: FailureEnvelope): Promise<Envelope> => {
    const kind = failure.command.slice('quiz.'.length);
    if (kind === 'policy' || kind === 'grant' || kind === 'prerequisites' || kind === 'propose') {
      const message = failure.error.message === 'Invalid command input.'
        ? 'Quiz input file is unavailable or invalid.' : failure.error.message === 'Invalid command arguments.'
          ? 'Invalid quiz command arguments.' : failure.error.message;
      return recordInputFailure(kind, withMetadata(fail(failure.command, failure.error.code, message, failure.error.next), failure.meta) as FailureEnvelope, dependencies);
    }
    if (failure.command === 'quiz.review') return reviewQuiz(undefined, dependencies);
    if (failure.command === 'quiz.read' || failure.command === 'unknown') return readQuiz(undefined, dependencies);
    return failure;
  };
  const context = unavailableCLIContext();
  // Q1 already checks its targets, grants, citations, privacy and durable audit inside the handler.
  // The shared dispatcher still validates both schemas and enforces the host TTY gate.
  const unavailableAuthorization = context.authorization;
  context.authorization = { check: async (name, level, input) => {
    if (!names.some(legacyName => legacyName === name)) await unavailableAuthorization.check(name, level, input);
  } };
  context.evidence = { check: async () => {} };
  context.owner = { assertOwner: async () => {} };
  await parseProtocolCLI(args, {
    registry, context, isTTY: dependencies.isTTY, stdout: dependencies.stdout, stderr: dependencies.stderr,
    inputFailure,
    result: async (response, input) => {
      if (!legacy) {
        if (!response.ok && response.error.code === 'INVALID_INPUT' && names.some(name => name === response.command)
          && !['quiz.read', 'quiz.review'].includes(response.command)) {
          const error = safeQuizError(response.command === 'quiz.propose' ? proposalInputError(input)
            : new CourseworkError('INVALID_INPUT', 'Owner recording is unavailable.'));
          response = withMetadata(fail(response.command, error.code, error.message, error.next), response.meta);
        }
        return response.ok ? response : inputFailure(response);
      }
      if (response.ok && legacy.ok) return withMetadata(ok(response.command, response.data), legacy.meta);
      if (!response.ok && !legacy.ok && response.error.code === legacy.error.code) return legacy;
      return withMetadata(response, legacy.meta);
    },
  });
}
