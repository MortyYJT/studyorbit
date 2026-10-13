import { type CommandName, type CommandOutput } from './contracts.js';
import type { EvidenceService, ProtocolServices, ServiceInput, TrustedContext, WriteCommand } from './context.js';
import { CourseworkError } from './errors.js';

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
