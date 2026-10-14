import { randomUUID } from 'node:crypto';
import { TaskSchema, type PlanningSettings } from '../domain/schemas.js';
import type { SqliteRepository } from '../store/sqlite.js';
import type { OwnerInteraction } from '../protocol/context.js';
import { CourseworkError } from '../protocol/errors.js';
import { collectWork } from './work.js';
import { planDays } from './planner.js';
import { settingsInput, planningInputs, planScope, type PlanScope, type PlanningWrite } from './contracts.js';
const invalid = () => new CourseworkError('INVALID_INPUT', 'Invalid planning input.');
export class PlanningService {
  constructor(readonly store: SqliteRepository) {}
  work(term: string) { return collectWork(this.store, term, this.settings()?.timeZone ?? 'Australia/Melbourne'); }
  settings(): PlanningSettings | undefined { return this.store.readPlanningSettings().at(-1); }
  async saveSettings(input: unknown, owner?: OwnerInteraction): Promise<void> {
    await this.requireOwner('planning.settings.set', owner);
    const parsed = settingsInput.safeParse(input); if (!parsed.success) throw invalid();
    this.store.appendPlanningSettings(parsed.data);
  }
  private async requireOwner(name: string, owner?: OwnerInteraction) {
    if (!owner) throw invalid(); await owner.assertOwner(name);
  }
  private target(workId: string) {
    if (this.store.loadAssessment(workId) || this.store.loadTask(workId)?.source === 'manual') return;
    const match = /^(.*):step:(\d+)$/.exec(workId);
    const task = match && this.store.loadTask(match[1]!);
    if (!task || task.source !== 'coursework' || !task.steps[Number(match![2])]) throw new CourseworkError('NOT_FOUND', 'Work not found.');
  }
  plan(input: PlanScope) {
    const scope = planScope.parse(input); const settings = this.settings();
    if (!settings) throw new CourseworkError('SOURCE_UNAVAILABLE', 'Planning settings required.');
    const work = this.work(scope.term); const plan = planDays({ ...scope, settings, items: work.items });
    const byId = new Map(work.items.map(item => [item.workId, item]));
    const startTimes = this.store.listStartTimes();
    const days = plan.days.map(day => {
      const assigned = new Set(day.items.map(item => item.workId));
      // Invalidate only dates evaluated in this plan; navigation must not erase other weeks.
      for (const row of startTimes) {
        if (row.date !== day.date || assigned.has(row.workId)) continue;
        const assessment = this.store.loadAssessment(row.workId);
        const task = this.store.loadTask(row.workId) ?? this.store.loadTask(row.workId.replace(/:step:\d+$/, ''));
        const courseId = assessment?.courseId ?? task?.courseId;
        if (!courseId || this.store.loadCourse(courseId)?.term === scope.term) this.store.clearStartTime(row.workId, day.date);
      }
      const items = day.items.map(item => {
        const start = this.store.readStartTimes(item.workId).filter(row => row.date === day.date).at(-1);
        return { ...byId.get(item.workId)!, ...item, ...(start ? { startTime: start.time } : {}) };
      });
      items.sort((a, b) => a.startTime && b.startTime ? a.startTime < b.startTime ? -1 : a.startTime > b.startTime ? 1 : 0 : a.startTime ? -1 : b.startTime ? 1 : 0);
      return { ...day, items };
    });
    return { settings, days, work: work.items, deadlines: work.deadlines.filter(item => !item.date || item.date >= scope.startDate && item.date <= plan.days.at(-1)!.date),
      overflow: plan.overflow.map(item => ({ ...byId.get(item.workId)!, ...item })), unestimated: plan.unestimated };
  }
  async execute(name: string, input: unknown, owner?: OwnerInteraction): Promise<{ recorded: true; id?: string }> {
    if (!(name in planningInputs)) throw new CourseworkError('NOT_FOUND', 'Planning command not found.');
    const command = name as PlanningWrite;
    if (command !== 'estimate.agent.set') await this.requireOwner(command, owner);
    const parsed = planningInputs[command].safeParse(input); if (!parsed.success) throw invalid();
    const at = new Date().toISOString();
    if (command === 'planning.settings.set') this.store.appendPlanningSettings(settingsInput.parse(input));
    else if (command === 'estimate.agent.set' || command === 'estimate.owner.set') {
      const value = planningInputs[command].parse(input); this.target(value.workId);
      this.store.appendEstimate({ ...value, origin: command === 'estimate.agent.set' ? 'agent' : 'owner', at });
    } else if (command === 'time.record') {
      const value = planningInputs[command].parse(input); this.target(value.workId); this.store.appendTimeLog({ ...value, at });
    } else if (command === 'plan.start.set') {
      const { workId, date, time, ...scope } = planningInputs[command].parse(input); this.target(workId);
      if (!this.plan(scope).days.find(day => day.date === date)?.items.some(item => item.workId === workId)) throw invalid();
      this.store.appendStartTime({ workId, date, time, at });
    } else if (command === 'plan.start.clear') {
      const { workId, date } = planningInputs[command].parse(input); this.target(workId); this.store.clearStartTime(workId, date);
    } else if (command === 'manual.create') {
      const { estimateMinutes, ...value } = planningInputs[command].parse(input);
      if (!this.store.loadModule(value.moduleId)) throw new CourseworkError('NOT_FOUND', 'Module not found.');
      const id = randomUUID();
      const task = TaskSchema.safeParse({ ...value, id, source: 'manual', done: false, steps: [{ title: value.title, done: false, estimateMinutes: 0, citations: [] }] });
      if (!task.success) throw invalid(); this.store.saveTask(task.data);
      if (estimateMinutes !== undefined) this.store.appendEstimate({ workId: id, minutes: estimateMinutes, origin: 'owner', at });
      return { recorded: true, id };
    } else {
      const value = planningInputs[command].parse(input);
      const task = this.store.loadTask(value.id);
      if (!task || task.source !== 'manual') throw new CourseworkError('NOT_FOUND', 'Manual task not found.');
      if (command === 'manual.delete') this.store.deleteManualTask(task.id);
      else if (command === 'manual.complete') this.store.saveTask({ ...task, done: true });
      else {
        const { estimateMinutes, due, ...patch } = planningInputs['manual.edit'].parse(input);
        const edited = TaskSchema.safeParse({ ...task, ...patch, ...(due !== undefined ? { due: due ?? undefined } : {}) });
        if (!edited.success) throw invalid(); this.store.saveTask(edited.data);
        if (estimateMinutes !== undefined) this.store.appendEstimate({ workId: task.id, minutes: estimateMinutes, origin: 'owner', at });
      }
    }
    return { recorded: true };
  }
}
