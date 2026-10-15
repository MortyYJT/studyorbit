import type { AgentAdapter, AgentEvent, AgentInput, AgentRun } from '../../src/agent/adapter.js';

export class SyntheticAdapter implements AgentAdapter {
  readonly id = 'synthetic';
  readonly inputs: AgentInput[] = [];
  interrupted = 0;
  constructor(private readonly events: readonly AgentEvent[] = [
    { type: 'text', text: 'First' }, { type: 'text', text: ' second' },
    { type: 'tool_step', tool: 'sources.get', outcome: 'ok', screenshotRef: 'shot-1' },
    { type: 'result', turns: 14, costUsd: 0.42, sessionRef: 'session-1' },
  ], private readonly gate?: Promise<void>) {}
  start(input: AgentInput): AgentRun {
    this.inputs.push(input);
    const self = this;
    return {
      async *[Symbol.asyncIterator]() { for (const event of self.events) yield event; await self.gate; },
      interrupt() { self.interrupted++; },
    };
  }
}
