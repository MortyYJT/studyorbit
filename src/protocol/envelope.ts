import { randomUUID } from 'node:crypto';
import { CourseworkError, retryable, type ErrorCode } from './errors.js';

type Meta = { runId: string; durationMs: number };
type BaseEnvelope = { protocol: 'coursework.agent/v1'; command: string; meta: Meta };
export type SuccessEnvelope = BaseEnvelope & { ok: true; data: unknown };
export type FailureEnvelope = BaseEnvelope & {
  ok: false;
  error: { code: ErrorCode; message: string; retryable: boolean; next?: string };
};
export type Envelope = SuccessEnvelope | FailureEnvelope;

const MAX_BYTES = 64 * 1024;

function metadata(): Meta {
  return { runId: randomUUID(), durationMs: 0 };
}

function success(command: string, data: unknown, meta: Meta): SuccessEnvelope {
  return { protocol: 'coursework.agent/v1', ok: true, command, data, meta };
}

function failure(command: string, error: CourseworkError, meta: Meta): FailureEnvelope {
  return { protocol: 'coursework.agent/v1', ok: false, command,
    error: { code: error.code, message: error.message, retryable: retryable[error.code],
      ...(error.next === undefined ? {} : { next: error.next }) }, meta };
}

function mappedError(error: unknown): CourseworkError {
  return error instanceof CourseworkError && Object.hasOwn(retryable, error.code)
    ? error : new CourseworkError('INTERNAL', 'An unexpected error occurred.');
}

function boundedFailure(command: string, error: CourseworkError, meta: Meta): FailureEnvelope {
  const envelope = failure(command, error, meta);
  if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') <= MAX_BYTES) return envelope;
  // Even an oversized command name cannot defeat the output bound.
  return failure('[command exceeds output limit]',
    new CourseworkError('LIMIT_EXCEEDED', 'The response exceeds 64 KiB.',
      'Narrow the request and try again.'), meta);
}

function bounded(envelope: FailureEnvelope): FailureEnvelope;
function bounded(envelope: Envelope): Envelope;
function bounded(envelope: Envelope): Envelope {
  try {
    let serialized = JSON.stringify(envelope);
    // Materialize JSON once: caller-owned objects and toJSON cannot change the measured output.
    const result: Envelope = JSON.parse(serialized);
    if (result.ok && !Object.hasOwn(result, 'data')) {
      result.data = null;
      serialized = JSON.stringify(result);
    }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BYTES) {
      return boundedFailure(envelope.command,
        new CourseworkError('LIMIT_EXCEEDED', 'The response exceeds 64 KiB.',
          'Narrow the request and try again.'), envelope.meta);
    }
    return result;
  } catch {
    return boundedFailure(envelope.command, mappedError(undefined), envelope.meta);
  }
}

export function ok(command: string, data: unknown): Envelope {
  return bounded(success(command, data, metadata()));
}

export function fail(command: string, code: ErrorCode, message: string, next?: string): FailureEnvelope {
  return bounded(failure(command, mappedError(new CourseworkError(code, message, next)), metadata()));
}

export async function run(command: string, fn: () => unknown | Promise<unknown>): Promise<Envelope> {
  const meta = metadata();
  const start = performance.now();
  try {
    const data = await fn();
    meta.durationMs = performance.now() - start;
    return bounded(success(command, data, meta));
  } catch (error) {
    meta.durationMs = performance.now() - start;
    return bounded(failure(command, mappedError(error), meta));
  }
}

/** Reapply serialization bounds after a dispatcher supplies its measured metadata. */
export function withMetadata(envelope: Envelope, meta: Meta): Envelope {
  return bounded({ ...envelope, meta });
}
