import { ClientError, type Client, type Output } from './client.js';
import { mergePlanWork, type AutonomyRead, type EditableField, type Policy, type Work, type WorkLevel } from './course.js';

export type CourseItem = Output<'courses.list'>['items'][number];
export type AssessmentItem = Output<'assessments.list'>['items'][number];
export type AnnotationDetail = Output<'annotation.read'>;
export type Source = Output<'sources.get'>;
type Section = 'course' | 'autonomy' | 'assessments' | 'plan' | 'revision' | 'notes' | 'stats' | 'detail' | 'source' | 'write';
export interface CourseState {
  course?: CourseItem;
  assessments?: AssessmentItem[];
  complete: boolean;
  work?: Record<string, Work>;
  revision?: Output<'revision.read'>;
  notes?: Output<'revision.list'>['items'];
  stats?: Output<'practice.stats'>;
  details: Record<string, AnnotationDetail>;
  tasks: Record<string, Output<'tasks.list'>['items']>;
  sources: Record<string, Source>;
  autonomy?: AutonomyRead;
  /** Minutes recorded on this page for work outside the plan; no read returns their totals. */
  recorded: Record<string, number>;
  saving?: string;
  errors: Partial<Record<Section, string>>;
}
const code = (error: unknown) => error instanceof ClientError ? error.code : 'SOURCE_UNAVAILABLE';
/** Follows continuation cursors; a bound stops a misbehaving server from looping forever. */
async function pages<T extends { nextCursor?: string }>(read: (cursor?: string) => Promise<T>): Promise<T[]> {
  const result = [await read()];
  while (result.at(-1)!.nextCursor && result.length < 100) result.push(await read(result.at(-1)!.nextCursor));
  return result;
}
const today = () => new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** One course page's reads and owner writes; every value comes from registry commands. */
export class CourseStore {
  private state: CourseState = { complete: true, details: {}, tasks: {}, sources: {}, recorded: {}, errors: {} };
  private listeners = new Set<() => void>();
  constructor(readonly client: Client, readonly courseId: string) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(value: Partial<CourseState>) { this.state = { ...this.state, ...value }; for (const listener of this.listeners) listener(); }
  private error(key: Section, value?: string) { this.update({ errors: { ...this.state.errors, [key]: value } }); }
  private async section(key: Section, run: () => Promise<Partial<CourseState>>) {
    try { this.update(await run()); this.error(key); } catch (error) { this.error(key, code(error)); }
  }
  async load() {
    await this.loadCourse();
    await Promise.all([this.loadAssessments(), this.loadPlan(), this.loadAutonomy(),
      this.section('revision', async () => ({ revision: await this.client.call('revision.read', { courseId: this.courseId }) })),
      this.section('notes', async () => ({ notes: (await pages(cursor => this.client.call('revision.list', { courseId: this.courseId, limit: 500, ...(cursor ? { cursor } : {}) })))
        .flatMap(page => page.items).filter(record => record.type !== 'exam-scope') })),
      this.section('stats', async () => ({ stats: await this.client.call('practice.stats', { courseId: this.courseId }) })),
    ]);
  }
  private loadCourse() {
    return this.section('course', async () => {
      const found = (await pages(cursor => this.client.call('courses.list', { limit: 500, ...(cursor ? { cursor } : {}) })))
        .flatMap(page => page.items).find(course => course.id === this.courseId);
      if (!found) throw new ClientError('NOT_FOUND', 'Course not found.');
      // The agent-read policy and its quote are on the Course itself (#180); no annotation history is needed.
      return { course: found };
    });
  }
  private loadAutonomy() {
    return this.section('autonomy', async () => ({ autonomy: await this.client.call('autonomy.read', { courseId: this.courseId }) }));
  }
  private loadAssessments() {
    return this.section('assessments', async () => {
      const read = await pages(cursor => this.client.call('assessments.list', { courseId: this.courseId, limit: 500, ...(cursor ? { cursor } : {}) }));
      return { assessments: read.flatMap(page => page.items), complete: read.every(page => page.coverage.complete) };
    });
  }
  private async loadPlan() {
    if (!this.state.course) return;
    const term = this.state.course.term;
    // Work rows (estimates, origins, actual time) do not depend on the horizon, so read the shortest plan.
    await this.section('plan', async () => ({ work: Object.fromEntries(mergePlanWork(await pages(cursor =>
      this.client.call('plan.read', { term, startDate: today(), horizonDays: 1, ...(cursor ? { cursor } : {}) }))).map(item => [item.workId, item])) }));
  }
  async openAssessment(id: string) {
    await this.section('detail', async () => {
      const [detail, tasks] = await Promise.all([this.client.call('annotation.read', { entity: 'assessment', entityId: id, limit: 100 }),
        pages(cursor => this.client.call('tasks.list', { assessmentId: id, limit: 500, ...(cursor ? { cursor } : {}) }))]);
      return { details: { ...this.state.details, [id]: detail }, tasks: { ...this.state.tasks, [id]: tasks.flatMap(page => page.items) } };
    });
  }
  async source(id: string) {
    if (this.state.sources[id]) return;
    await this.section('source', async () => ({ sources: { ...this.state.sources, [id]: await this.client.call('sources.get', { sourceItemId: id }) } }));
  }
  private async write(key: string, run: () => Promise<unknown>, after: () => Promise<unknown> | Partial<CourseState> = () => ({})): Promise<boolean> {
    if (this.state.saving) return false;
    this.update({ saving: key }); this.error('write');
    try {
      await run();
      const next = await after();
      if (next && typeof next === 'object') this.update(next as Partial<CourseState>);
      return true;
    } catch (error) { this.error('write', code(error)); return false; }
    finally { this.update({ saving: undefined }); }
  }
  setPolicy(status: Policy | null) {
    return this.write('policy', () => this.client.call('autonomy.policy.set', { courseId: this.courseId, status }), () => Promise.all([this.loadCourse(), this.loadAutonomy()]));
  }
  setDefault(level: WorkLevel) {
    return this.write('default', () => this.client.call('autonomy.default.set', { courseId: this.courseId, level }), () => this.loadAutonomy());
  }
  setConfirm(confirmBeforeSubmit: boolean) {
    return this.write('confirm', () => this.client.call('autonomy.confirmation.set', { courseId: this.courseId, confirmBeforeSubmit }), () => this.loadAutonomy());
  }
  setOverride(assessmentId: string, level: WorkLevel | null) {
    return this.write(`level:${assessmentId}`, () => level === null ? this.client.call('autonomy.override.clear', { assessmentId })
      : this.client.call('autonomy.override.set', { assessmentId, level }), () => this.loadAutonomy());
  }
  private reloadAnnotated(entity: 'assessment' | 'course', entityId: string) {
    // A kind change can change the level an assessment needs, so autonomy is read again too.
    return Promise.all([entity === 'course' ? this.loadCourse() : Promise.all([this.loadAssessments(), this.openAssessment(entityId)]), this.loadAutonomy()]);
  }
  confirm(entity: 'assessment' | 'course', entityId: string, field: EditableField | 'aiPolicy', annotationId: string) {
    return this.write(`field:${field}`, () => this.client.call('annotation.confirm', { entity, entityId, field, annotationId }), () => this.reloadAnnotated(entity, entityId));
  }
  replace(entity: 'assessment' | 'course', entityId: string, field: EditableField, value: unknown, annotationId: string) {
    return this.write(`field:${field}`, () => this.client.call('annotation.replace', { entity, entityId, field, value: value as never, annotationId }),
      () => this.reloadAnnotated(entity, entityId));
  }
  setEstimate(workId: string, minutes: number) {
    return this.write('estimate', () => this.client.call('estimate.owner.set', { workId, minutes }), () => this.loadPlan());
  }
  recordTime(workId: string, minutes: number) {
    return this.write('time', () => this.client.call('time.record', { workId, minutes }), async () => {
      await this.loadPlan();
      if (!this.state.work?.[workId]) this.update({ recorded: { ...this.state.recorded, [workId]: (this.state.recorded[workId] ?? 0) + minutes } });
    });
  }
}
