import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Command, CommanderError, Option } from 'commander';
import { z } from 'zod';
import { dispatch, type Registry, type RegistryEntry } from './registry.js';
import type { TrustedContext } from './context.js';
import { ownerCommands } from './contracts.js';
import { CourseworkError } from './errors.js';
import { fail, ok, type Envelope, type FailureEnvelope } from './envelope.js';

export const MAX_INPUT_BYTES = 4 * 1024 * 1024;
export interface ProtocolCLIOptions {
  registry: Registry; context: TrustedContext; isTTY?: boolean; program?: Command;
  stdout?: (message: string) => void; stderr?: (message: string) => void;
  /** Explicit legacy-envelope bridge; never supplies another business handler. */
  result?: (response: Envelope, input: unknown) => Promise<Envelope>;
  inputFailure?: (response: FailureEnvelope) => Promise<Envelope>;
}
interface FieldSchema {
  type?: string | string[]; enum?: unknown[]; const?: unknown; default?: unknown;
  anyOf?: FieldSchema[]; oneOf?: FieldSchema[]; properties?: Record<string, FieldSchema>;
}
function invalid(): never { throw new CourseworkError('INVALID_INPUT', 'Invalid command arguments.'); }
function coerce(value: string, schema: FieldSchema): unknown {
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives) {
    for (const alternative of alternatives) {
      try {
        const parsed = coerce(value, alternative);
        if (alternative.const !== undefined && parsed !== alternative.const) continue;
        return parsed;
      } catch { /* Try the next explicitly represented scalar type. */ }
    }
    return invalid();
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) || !Number.isFinite(Number(value))) return invalid();
    return Number(value);
  }
  if (schema.type === 'boolean') {
    if (value !== 'true' && value !== 'false') return invalid();
    return value === 'true';
  }
  if (schema.type === 'object' || schema.type === 'array' || schema.type === 'null') {
    try { return JSON.parse(value) as unknown; } catch { return invalid(); }
  }
  return value;
}
/** Bound both the initial size and actual read; never read special files or follow final symlinks. */
async function loadInput(path: string): Promise<unknown> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) return invalid();
      if (stat.size > MAX_INPUT_BYTES) throw new CourseworkError('LIMIT_EXCEEDED', 'Input exceeds the private record limit.');
      const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1); let size = 0;
      while (size < buffer.length) {
        const read = await handle.read(buffer, size, buffer.length - size, null);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size > MAX_INPUT_BYTES) throw new CourseworkError('LIMIT_EXCEEDED', 'Input exceeds the private record limit.');
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size))) as unknown;
    } finally { await handle.close(); }
  } catch (error) {
    throw new CourseworkError(error instanceof CourseworkError ? error.code : 'INVALID_INPUT', 'Input file is unavailable or invalid.');
  }
}
function fields(entry: RegistryEntry): Record<string, FieldSchema> {
  const schema = z.toJSONSchema(entry.input, { io: 'input', unrepresentable: 'any' }) as FieldSchema;
  const collect = (node: FieldSchema): Record<string, FieldSchema> => {
    const result = { ...node.properties };
    for (const branch of node.anyOf ?? node.oneOf ?? []) {
      for (const [key, field] of Object.entries(collect(branch))) {
        result[key] = result[key] ? { anyOf: [result[key], field] } : field;
      }
    }
    return result;
  };
  return collect(schema);
}
/** Generate transport syntax only. Zod/authorization/output checks remain in dispatch. */
export async function parseProtocolCLI(args: string[], options: ProtocolCLIOptions): Promise<void> {
  const stdout = options.stdout ?? console.log; const stderr = options.stderr ?? console.error;
  const program = (options.program ?? new Command().name('coursework').description('Manage cited coursework tasks'))
    .exitOverride().configureOutput({ writeOut: () => {}, writeErr: () => {} });
  const nodes = new Map<string, Command>([['', program]]);
  const leaves = new Map<Command, RegistryEntry>();
  let response: Envelope | undefined; let selected: RegistryEntry | undefined;
  const context: TrustedContext = { ...options.context, owner: {
    assertOwner: async name => {
      if (!(options.isTTY ?? (process.stdin.isTTY === true && process.stderr.isTTY === true)) || !options.context.owner) return invalid();
      await options.context.owner.assertOwner(name);
    },
  } };
  for (const entry of options.registry.list()) {
    const parts = entry.name === 'sync.run' ? ['sync'] : entry.name.split('.'); let parent = program;
    for (let index = 0; index < parts.length; index++) {
      const key = parts.slice(0, index + 1).join('.'); let node = nodes.get(key);
      if (!node) { node = parent.command(parts[index]!).description(key); nodes.set(key, node); }
      parent = node;
    }
    const command = parent; leaves.set(command, entry);
    command.description(`${entry.name} (L${entry.level}${ownerCommands.has(entry.name) ? ', owner terminal' : ''})`)
      .option('--json', 'Print one coursework.agent/v1 envelope')
      .option('--input <path>', `Strict JSON input file (maximum ${MAX_INPUT_BYTES} bytes; exclusive with field flags)`);
    command.options.find(option => option.long === '--input')!.argParser((value: string, previous: unknown) => {
      if (previous !== undefined) return invalid();
      return value;
    });
    const shape = fields(entry);
    for (const [field, schema] of Object.entries(shape)) {
      const flag = field.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`);
      const option = new Option(`--${flag} <value>`, `${field}: ${schema.type ?? 'JSON'}${schema.enum ? ` (${schema.enum.join(', ')})` : ''}${schema.default === undefined ? '' : `; default ${JSON.stringify(schema.default)}`}`);
      option.argParser((value: string, previous: unknown) => {
        if (previous !== undefined) return invalid();
        return coerce(value, schema);
      });
      // Store by schema field, independent of Commander camel-casing .
      option.attributeName = () => field;
      command.addOption(option);
    }
    command.action(async (values: Record<string, unknown>) => {
      selected = entry;
      const { json: _json, input, ...supplied } = values;
      let request: unknown;
      try {
        if (input !== undefined && Object.keys(supplied).length) return invalid();
        request = input === undefined ? supplied : await loadInput(input as string);
      } catch (error) {
        response = fail(entry.name, error instanceof CourseworkError ? error.code : 'INVALID_INPUT', 'Invalid command input.');
        if (options.inputFailure) response = await options.inputFailure(response as FailureEnvelope);
        return;
      }
      response = await dispatch(options.registry, entry.name, request, context);
      if (options.result) response = await options.result(response, request);
    });
  }
  // Find only registered path segments; unknown request prose never enters output metadata/help.
  let current = program; let unknownPath = false;
  for (const token of args) {
    if (token.startsWith('-')) break;
    const child = current.commands.find(command => command.name() === token);
    if (!child) { unknownPath = true; break; }
    current = child;
  }
  selected = leaves.get(current);
  try {
    if (unknownPath) return invalid();
    await program.parseAsync(args, { from: 'user' });
    if (!response) response = fail(selected?.name ?? 'unknown', 'INVALID_INPUT', 'Choose a registered command.');
  } catch (error) {
    if (error instanceof CommanderError && ['commander.helpDisplayed', 'commander.help'].includes(error.code)) {
      response = ok(selected?.name ?? 'help', { usage: current.helpInformation() });
    } else {
      response = fail(selected?.name ?? 'unknown', 'INVALID_INPUT', 'Invalid command arguments.');
      if (options.inputFailure) response = await options.inputFailure(response as FailureEnvelope);
    }
  }
  if (!response.ok) stderr(`Command failed: ${response.error.code}.`);
  // Sinks stay outside parser recovery: a write failure cannot cause a second envelope.
  stdout(JSON.stringify(response));
}
