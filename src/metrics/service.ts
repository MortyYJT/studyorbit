import type { SqliteRepository } from '../store/sqlite.js';
import type { Collection, QueryInput, QueryItem } from '../store/queries.js';
import { planningTasks } from '../planning/work.js';
import { metricsContracts, type MetricsInput, type MetricsOutput } from './contracts.js';
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
const unavailable = <R extends string>(reason: R) => ({ available: false as const, reason, count: 0 as const });
type ConversationTotals = { conversationId: string; kind: string; steps: number; turns: number; costs: number[]; unknown: boolean };
/** Aggregate stored records only; completed items remain eligible for historical metrics. */
export class MetricsService {
  constructor(private readonly store: SqliteRepository, private readonly effectiveKind: (id: string) => string | null | undefined) {}
  private all<K extends Collection>(collection: K): QueryItem<K>[] {
    const rows: QueryItem<K>[] = []; let cursor: string | undefined;
    do {
      // Retired assessments keep their annotations and verdicts, which still count as recorded labels.
      const page = this.store.query(collection, { limit: 500, cursor, ...(collection === 'assessments' ? { includeRetired: true } : {}) } as QueryInput<K>);
      rows.push(...page.items); cursor = page.nextCursor;
    } while (cursor);
    return rows;
  }
  read(input: MetricsInput): MetricsOutput {
    const { from, to, cursor = 0, limit = 25 } = metricsContracts['metrics.read'].input.parse(input);
    const end = Date.parse(to); const start = Date.parse(from);
    const inRange = (at: string) => Date.parse(at) >= start && Date.parse(at) < end;
    const runs = this.all('runs').filter(run => inRange(run.startedAt));
    const provider = (name: 'canvas' | 'ed') => {
      const measured = runs.filter(run => run.command === 'sync' && run.coverage?.some(row => row.provider === name));
      if (!measured.length) return unavailable('no_runs');
      const durations = measured.map(run => Date.parse(run.endedAt) - Date.parse(run.startedAt));
      const successes = measured.filter(run => run.coverage!.filter(row => row.provider === name)
        .every(row => !row.codes.length && !row.failed && !row.skipped && !row.notStarted && row.completed >= row.planned)).length;
      // Coverage has provider outcomes but no provider timings: these are whole sync-run durations.
      return { available: true as const, count: measured.length, successes, successRate: successes / measured.length,
        medianDurationMs: median(durations), maxDurationMs: durations.reduce((max, duration) => Math.max(max, duration), 0), durationBasis: 'sync_run' as const };
    };
    // Agent sync jobs are measured per run; a run waiting for the owner's course selection is neither a success nor a failure.
    const agentRuns = runs.filter(run => run.command === 'sync' && run.syncOutcome !== undefined && run.syncOutcome !== 'NEEDS_SELECTION');
    const perRun = () => {
      if (!agentRuns.length) return unavailable('no_runs');
      const durations = agentRuns.map(run => Date.parse(run.endedAt) - Date.parse(run.startedAt));
      const successes = agentRuns.filter(run => run.syncOutcome === 'OK').length;
      return { available: true as const, count: agentRuns.length, successes, successRate: successes / agentRuns.length,
        medianDurationMs: median(durations), maxDurationMs: Math.max(...durations), durationBasis: 'sync_run' as const };
    };
    const assessments = this.all('assessments');
    const targets = [...assessments.map(item => ({ entity: 'assessment', id: item.id })),
      ...this.all('courses').map(item => ({ entity: 'course', id: item.id }))];
    // Verdicts are append-only, so a re-judged annotation is one label: its latest in-range verdict (append order breaks ties).
    const verdicts = targets.flatMap(target => this.store.readAnnotations(target.entity, target.id)
      .filter(row => row.origin === 'agent').flatMap(row => this.store.readAnnotationVerdicts(row.id).filter(verdict => inRange(verdict.at))
        .reduce<{ verdict: string; at: string }[]>((latest, verdict) => !latest[0] || Date.parse(verdict.at) >= Date.parse(latest[0].at) ? [verdict] : latest, [])));
    const correct = verdicts.filter(row => row.verdict === 'correct').length;
    const tasks = planningTasks(this.store);
    const work = new Map<string, number | undefined>(assessments.map(item => [item.id, undefined]));
    for (const task of tasks.values()) {
      // Manual task step totals are the owner's fallback estimate, as in planning.
      if (task.source === 'manual') {
        const minutes = sum(task.steps.map(step => step.estimateMinutes)); work.set(task.id, !task.allDay && minutes > 0 ? minutes : undefined);
      } else task.steps.forEach((_step, index) => work.set(`${task.id}:step:${index}`, undefined));
    }
    // Retained actuals discover historical work even after its task has been deleted.
    const logsByWork = new Map<string, number[]>();
    for (const log of this.store.listTimeLogs().filter(row => inRange(row.at))) {
      const minutes = logsByWork.get(log.workId) ?? [];
      minutes.push(log.minutes); logsByWork.set(log.workId, minutes);
    }
    const ratios: number[] = [];
    for (const [workId, logs] of logsByWork) {
      const estimates = this.store.readEstimates(workId).filter(row => Date.parse(row.at) < end);
      const estimate = estimates.filter(row => row.origin === 'owner').at(-1)?.minutes
        ?? work.get(workId) ?? estimates.filter(row => row.origin === 'agent').at(-1)?.minutes;
      if (estimate !== undefined && logs.length) ratios.push(sum(logs) / estimate);
    }
    const conversations = new Map(this.store.readConversations().map(row => [row.id, row]));
    const grouped = new Map<string, ConversationTotals>();
    for (const run of this.store.readAgentRuns().filter(row => inRange(row.startedAt))) {
      if (run.conversationId === undefined || run.turns === undefined) continue;
      let row = grouped.get(run.conversationId);
      if (!row) {
        const assessmentId = run.assessmentId ?? conversations.get(run.conversationId)?.assessmentId;
        row = { conversationId: run.conversationId, kind: assessmentId && this.store.loadAssessment(assessmentId) ? this.effectiveKind(assessmentId) ?? 'unknown' : 'unknown',
          steps: 0, turns: 0, costs: [], unknown: false };
        grouped.set(run.conversationId, row);
      }
      row.steps += run.steps; row.turns += run.turns;
      if (run.costUsd === undefined) row.unknown = true; else row.costs.push(run.costUsd);
    }
    const rows = [...grouped.values()].sort((a, b) => a.conversationId < b.conversationId ? -1 : a.conversationId > b.conversationId ? 1 : 0);
    // Only detail is paged; every aggregate covers the full selected range.
    const remaining = rows.slice(cursor);
    const page = remaining.slice(0, limit);
    const nextCursor = remaining.length > page.length ? cursor + page.length : undefined;
    // Counts are conversations: a partially reported conversation contributes to both counts.
    const costs = (items: ConversationTotals[]) => {
      const known = items.filter(row => row.costs.length); const unknownCount = items.filter(row => row.unknown).length;
      return known.length ? { available: true as const, totalUsd: sum(known.flatMap(row => row.costs)), count: known.length, unknownCount }
        : { ...unavailable('no_reported_costs'), unknownCount };
    };
    const totals = (items: ConversationTotals[]) => ({ steps: sum(items.map(row => row.steps)), turns: sum(items.map(row => row.turns)), cost: costs(items) });
    return metricsContracts['metrics.read'].output.parse({ from, to, sync: { runs: perRun(), canvas: provider('canvas'), ed: provider('ed') },
      accuracy: verdicts.length ? { available: true, count: verdicts.length, correct, incorrect: verdicts.length - correct, value: correct / verdicts.length } : unavailable('no_labels'),
      estimates: ratios.length ? { available: true, count: ratios.length, medianRatio: median(ratios), meanRatio: sum(ratios) / ratios.length } : unavailable('no_items'),
      agent: rows.length ? { available: true, count: rows.length, cost: costs(rows),
        nextCursor, conversations: page.map(row => ({ conversationId: row.conversationId, kind: row.kind, ...totals([row]) })),
        byKind: [...new Set(rows.map(row => row.kind))].sort().map(kind => {
          const items = rows.filter(row => row.kind === kind); return { kind, count: items.length, ...totals(items) };
        }) } : unavailable('no_conversations'),
    });
  }
}
