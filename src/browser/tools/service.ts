import { randomUUID } from 'node:crypto';
import type { PendingConfirmation } from '../../domain/schemas.js';
import type { OwnerInteraction, AuditEvent } from '../../protocol/context.js';
import { CourseworkError } from '../../protocol/errors.js';
import { browserClock } from '../resident.js';
import { createRedactor } from '../../sync/redaction.js';
import { toolContracts } from './contracts.js';
import { browserURL, coursePage, discussion, quizPage } from './url.js';
import type { BrowserToolOptions, ToolPage, ToolScope, PageTarget } from './ports.js';

interface Tab { page: ToolPage; conversationId?: string; refs: Map<string, PageTarget>; busy: boolean }
interface Waiter { row: PendingConfirmation; resolve(state: 'confirmed' | 'cancelled' | 'expired'): void; timer: ReturnType<typeof setTimeout>; poll: ReturnType<typeof setInterval> }
type WriteInput = { tabId: string; assessmentId: string; ref: string; value?: string; summary?: string };
const denied = (message = 'Browser action refused.') => new CourseworkError('INVALID_INPUT', message);
/** Process-local tab capabilities and confirmation waiters. No tab discovery or agent authority promotion. */
export class BrowserTools {
  private readonly tabs = new Map<string, Tab>();
  private readonly waiters = new Map<string, Waiter>();
  private readonly clock;
  private closed = false;
  constructor(private readonly options: BrowserToolOptions) {
    this.clock = options.clock ?? browserClock;
    // A restarted host never recreates an action from persisted confirmation data.
    if (options.recoverOnStart !== false) this.recoverInterrupted();
  }
  recoverInterrupted() {
    for (const row of this.options.confirmations.list()) if (row.state === 'pending') this.save({ ...row, state: 'expired', decidedAt: new Date().toISOString() });
  }
  private save(row: PendingConfirmation) { this.options.confirmations.save(row); }
  pending(): PendingConfirmation[] { return this.options.confirmations.list().filter(row => row.state === 'pending'); }
  private tab(id: string, scope?: ToolScope): Tab {
    const tab = this.tabs.get(id);
    if (!tab || tab.conversationId !== scope?.conversationId) throw new CourseworkError('NOT_FOUND', 'Tool-owned tab not found.');
    return tab;
  }
  private async validate(page: ToolPage, read = false) {
    if (await page.signedOut()) throw new CourseworkError('AUTH_EXPIRED', 'Ask the owner to sign in by hand.');
    const url = browserURL(page.url());
    if (read && discussion(url)) throw denied('Discussion threads and replies are refused.');
    return url;
  }
  async focus(tabId: string, owner?: OwnerInteraction): Promise<void> {
    if (!owner) throw denied(); await owner.assertOwner('browser.view');
    const tab = this.tabs.get(tabId);
    if (!tab) {
      if (!this.options.browser.focus) throw new CourseworkError('NOT_FOUND', 'Tool-owned tab not found.');
      await this.options.browser.focus(tabId); return;
    }
    await this.validate(tab.page); await tab.page.front();
  }
  private async check(tab: Tab, input: WriteInput, action: 'click' | 'fill' | 'select' | 'submit', runId: string) {
    const assessment = this.options.store.loadAssessment(input.assessmentId);
    const course = assessment && this.options.store.loadCourse(assessment.courseId);
    const url = await this.validate(tab.page, true); const location = coursePage(url);
    if (!assessment || !course || !location || !course.sources?.some(s => s.platform === location.platform && s.externalId === location.externalId)) throw denied('The page does not belong to the assessment course and platform.');
    const decision = await this.options.autonomy.check({ assessmentId: assessment.id, action }, runId);
    if (decision.decision !== 'allowed') {
      throw denied(`Browser action denied: ${decision.reason}.`);
    }
    return { assessment, refs: this.options.autonomy.references('autonomy.check', { assessmentId: assessment.id, action }) };
  }
  async execute(name: string, raw: unknown, scope?: ToolScope): Promise<Record<string, any>> {
    let writeAudit: AuditEvent | undefined; let actionRecorded = false; let acted = false; let pendingId: string | undefined;
    let tabId: string | undefined; let screenshotRef: string | undefined; let target = name.replace('browser.', '');
    const emit = (outcome: 'ok' | 'error' | 'denied' | 'waiting', output?: Record<string, any>) => scope?.emit({ type: 'tool_step', tool: name, outcome,
      input: { target: name === 'browser.open' ? 'Provider page' : target },
      ...(output ? { output } : {}), ...(screenshotRef ? { screenshotRef } : {}), ...(tabId ? { viewUrl: `/api/browser.view?tabId=${encodeURIComponent(tabId)}` } : {}) });
    try {
      if (this.closed) throw new CourseworkError('SOURCE_UNAVAILABLE', 'Browser tools are closed.');
      if (scope?.isActive?.() === false) throw denied('Conversation is no longer active.');
      const contract = toolContracts[name as keyof typeof toolContracts];
      if (!contract) throw new CourseworkError('NOT_FOUND', 'Browser tool not found.');
      const parsed = contract.input.safeParse(raw); if (!parsed.success) throw denied('Invalid browser tool input.');
      const input = parsed.data;
      if ('assessmentId' in input) {
        let refs = {};
        try { refs = this.options.autonomy.references('autonomy.check', { assessmentId: input.assessmentId, action: 'other' }); } catch { /* Only resolved identities may enter the journal. */ }
        writeAudit = { ...refs, command: name, runId: randomUUID(), phase: 'denial', code: 'INVALID_INPUT', action: name.slice(8) as AuditEvent['action'], outcome: 'failure', ...(scope ? { conversationId: scope.conversationId } : {}) };
      }
      let result: Record<string, any>;
      if ('url' in input) {
        const url = browserURL(input.url); tabId = randomUUID(); const page = await this.options.browser.newPage(tabId);
        try { await page.navigate(url.href); await this.validate(page); }
        catch (error) { await page.close(); throw error; }
        this.tabs.set(tabId, { page, conversationId: scope?.conversationId, refs: new Map(), busy: false });
        result = { tabId };
      } else {
        tabId = input.tabId; const tab = this.tab(tabId, scope);
        if (tab.busy) throw new CourseworkError('LOCKED', 'A browser action is already pending on this tab.');
        tab.busy = true;
        try {
          const url = await this.validate(tab.page, true);
          if (name === 'browser.read') {
            const before = tab.page.url(); const snapshot = await tab.page.read();
            if (tab.page.url() !== before) throw denied('Page changed during read.');
            const redactor = createRedactor({ people: snapshot.people.map(name => ({ name })) });
            const protect = (value: string): string => {
              for (const peer of snapshot.peers) if (peer) value = value.split(peer).join('[redacted]');
              return redactor.readText(value, { assessmentPage: quizPage(url) });
            };
            const targets: PageTarget[] = snapshot.targets.slice(0, 50).map(t => ({ ref: t.ref, kind: t.kind, description: protect(t.description).slice(0, 200) }));
            tab.refs = new Map(targets.map(t => [t.ref, t]));
            const text = protect(snapshot.text).slice(0, 8000);
            result = { tabId, text, targets, truncated: text.length < snapshot.text.length || snapshot.targets.length > 50 };
          } else if (name === 'browser.screenshot') {
            screenshotRef = await tab.page.screenshot(); result = { tabId, screenshotRef };
          } else {
            const write = input as WriteInput; const action = name.slice(8) as 'click' | 'fill' | 'select' | 'submit'; const runId = writeAudit!.runId;
            const startURL = tab.page.url();
            let checked = await this.check(tab, write, action, runId);
            target = tab.refs.get(write.ref)?.description ?? action;
            if (action !== 'submit' && tab.refs.get(write.ref)?.kind === 'submit') throw denied('Use browser.submit for submission controls.');
            if (!tab.refs.has(write.ref) || !await tab.page.isVisible(write.ref)) throw denied('Read the visible target before acting.');
            let confirmation: AuditEvent['confirmation'];
            if (action === 'submit') {
              if (this.options.autonomy.settings(checked.assessment.courseId).confirmBeforeSubmit) {
                if (!scope || !this.options.store.readConversations().some(c => c.id === scope.conversationId)) throw denied('A conversation is required for submission confirmation.');
                screenshotRef = await tab.page.screenshot();
                const row: PendingConfirmation = { id: randomUUID(), conversationId: scope.conversationId, assessmentId: write.assessmentId,
                  summary: write.summary!, screenshotRef, state: 'pending', createdAt: new Date().toISOString() };
                this.save(row);
                let resolve!: Waiter['resolve']; const decision = new Promise<'confirmed' | 'cancelled' | 'expired'>(r => { resolve = r; });
                const timer = setTimeout(() => { try { this.settle(row.id, 'expired'); } catch { /* The waiter is consumed even if persistence fails. */ } }, 15 * 60 * 1000); timer.unref();
                // MCP and the owner UI may be separate processes. Only the owner-session
                // handler can CAS the durable state; the action's original process observes it.
                const poll = setInterval(() => {
                  try {
                    const stored = this.options.confirmations.list().find(r => r.id === row.id);
                    if (!stored || scope.isActive?.() === false) this.settle(row.id, 'cancelled');
                    else if (stored.state !== 'pending') this.release(row.id, stored.state);
                  } catch { this.release(row.id, 'expired'); }
                }, 100); poll.unref();
                this.waiters.set(row.id, { row, resolve, timer, poll }); pendingId = row.id;
                emit('waiting', { confirmationId: row.id }); scope.emit({ type: 'confirmation', confirmationId: row.id, decision: 'pending' });
                const state = await decision;
                scope.emit({ type: 'confirmation', confirmationId: row.id, decision: state });
                if (state !== 'confirmed') {
                  actionRecorded = true;
                  await this.options.audit.record({ ...checked.refs, command: name, runId, phase: 'outcome', code: 'OK', action, outcome: 'failure', submissionState: state, ...(scope ? { conversationId: scope.conversationId } : {}) });
                  emit('denied', { outcome: state });
                  return { tabId, outcome: state, screenshotRef };
                }
                confirmation = 'owner-ui';
              } else confirmation = 'not-required';
            }
            if (this.closed || scope?.isActive?.() === false || tab.page.url() !== startURL) throw denied('Page or conversation changed while awaiting confirmation.');
            await this.check(tab, write, action, runId);
            await tab.page.front(); await tab.page.highlight(write.ref);
            const deadline = this.clock.now() + 1000;
            while (this.clock.now() < deadline) await this.clock.sleep(deadline - this.clock.now());
            checked = await this.check(tab, write, action, runId);
            if (this.closed || scope?.isActive?.() === false || tab.page.url() !== startURL || !await tab.page.isVisible(write.ref)) throw denied('The visible target or page changed.');
            let outcome: 'success' | 'uncertain' = 'success';
            acted = true;
            try { await tab.page.act(action, write.ref, write.value); }
            catch { outcome = 'uncertain'; }
            screenshotRef = undefined;
            try { screenshotRef = await tab.page.screenshot(); } catch { outcome = 'uncertain'; }
            actionRecorded = true;
            try { await this.options.audit.record({ ...checked.refs, command: name, runId, phase: 'outcome', code: outcome === 'success' ? 'OK' : 'UNCERTAIN', action, outcome, ...(scope ? { conversationId: scope.conversationId } : {}), ...(confirmation ? { confirmation } : {}) }); }
            catch { outcome = 'uncertain'; }
            if (outcome === 'uncertain') throw new CourseworkError('UNCERTAIN', 'Browser action may have completed. Inspect the page before retrying.');
            result = { tabId, outcome, screenshotRef };
          }
        } finally { tab.busy = false; }
      }
      emit('ok');
      return result;
    } catch (error) {
      if (pendingId && this.waiters.has(pendingId)) { try { this.settle(pendingId, 'cancelled'); } catch { /* Already fail-closed. */ } }
      if (acted) error = new CourseworkError('UNCERTAIN', 'Browser action may have completed. Inspect the page before retrying.');
      if (writeAudit && !actionRecorded) {
        const match = error instanceof CourseworkError && /^Browser action denied: (grant-level|course-prohibited|audit-unavailable|authorization-unavailable|assessment-unavailable)\.$/.exec(error.message);
        try { await this.options.audit.record({ ...writeAudit, decision: 'denied', ...(match ? { reason: match[1] as AuditEvent['reason'] } : {}) }); } catch { /* No action was taken. */ }
      }
      try { emit(error instanceof CourseworkError && error.code === 'INVALID_INPUT' ? 'denied' : 'error', { code: error instanceof CourseworkError ? error.code : 'SOURCE_UNAVAILABLE' }); } catch { /* Step storage cannot expose diagnostics or repeat an action. */ }
      if (error instanceof CourseworkError) throw error;
      throw new CourseworkError('SOURCE_UNAVAILABLE', 'Browser operation unavailable.');
    }
  }
  private release(id: string, state: 'confirmed' | 'cancelled' | 'expired') {
    const waiter = this.waiters.get(id); if (!waiter) return;
    this.waiters.delete(id); clearTimeout(waiter.timer); clearInterval(waiter.poll); waiter.resolve(state);
  }
  private settle(id: string, state: 'confirmed' | 'cancelled' | 'expired') {
    try {
      const stored = this.options.confirmations.list().find(row => row.id === id);
      if (!stored || stored.state !== 'pending') throw new CourseworkError('CONFLICT', 'Confirmation is no longer pending.');
      if (this.options.confirmations.transition) {
        if (!this.options.confirmations.transition(id, state)) throw new CourseworkError('CONFLICT', 'Confirmation is no longer pending.');
      } else this.save({ ...stored, state, decidedAt: new Date().toISOString() });
      this.release(id, state);
    } catch (error) {
      this.release(id, 'expired');
      if (error instanceof CourseworkError) throw error;
      throw new CourseworkError('INTERNAL', 'Confirmation storage unavailable; submission was not released.');
    }
  }
  async decide(id: string, state: 'confirmed' | 'cancelled', owner?: OwnerInteraction) {
    if (!owner) throw denied('Frontend owner session required.'); await owner.assertOwner('confirmation.decide');
    this.settle(id, state);
  }
  async close() {
    if (this.closed) return; this.closed = true;
    for (const id of this.waiters.keys()) { try { this.settle(id, 'expired'); } catch { /* Fail closed and finish tab cleanup. */ } }
    await Promise.allSettled([...this.tabs.values()].map(tab => tab.page.close())); this.tabs.clear();
    await this.options.browser.close();
  }
}
