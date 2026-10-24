import type { Client, Output } from './client.js';
import type { Copy, Language } from './i18n.js';
export type Metrics = Output<'metrics.read'>;
export type DateRange = { from: string; to: string };
type Cost = Extract<Metrics['agent'], { available: true }>['cost'];
export type Card = { key: 'runs' | 'canvas' | 'ed' | 'accuracy' | 'estimates' | 'agent'; title: string; value?: string; reason?: string; facts: [string, string][]; note?: string };
const day = 86400000;
const isoDate = (at: number) => new Date(at).toISOString().slice(0, 10);
function parts(at: number, timeZone: string) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at).map(part => [part.type, Number(part.value)]));
  return Date.UTC(values.year!, values.month! - 1, values.day!, values.hour!, values.minute!, values.second!);
}
/** The instant a calendar date starts in a time zone; re-checks the offset so DST changes resolve correctly. */
function midnight(date: string, timeZone: string): number {
  const guess = Date.parse(`${date}T00:00:00Z`);
  const first = guess - (parts(guess, timeZone) - Math.floor(guess / 1000) * 1000);
  return guess - (parts(first, timeZone) - Math.floor(first / 1000) * 1000);
}
/** Last 30 calendar days in the owner's time zone, both ends inclusive. */
export function defaultRange(now: Date, timeZone: string): DateRange {
  const today = parts(now.getTime(), timeZone);
  return { from: isoDate(today - 29 * day), to: isoDate(today) };
}
/** Convert inclusive dates to the half-open instants metrics.read takes; undefined when invalid. */
export function rangeInput(range: DateRange, timeZone: string): DateRange | undefined {
  const valid = /^\d{4}-\d{2}-\d{2}$/;
  if (!valid.test(range.from) || !valid.test(range.to) || range.from > range.to) return undefined;
  try {
    return { from: new Date(midnight(range.from, timeZone)).toISOString(), to: new Date(midnight(isoDate(Date.parse(`${range.to}T00:00:00Z`) + day), timeZone)).toISOString() };
  } catch { return undefined; }
}
/** First page for a range, or the next detail page appended to previous (aggregates already cover the range). */
export async function loadMetrics(client: Client, range: DateRange, previous?: Metrics): Promise<Metrics> {
  const cursor = previous?.agent.available ? previous.agent.nextCursor : undefined;
  if (!previous || cursor === undefined) return client.call('metrics.read', range);
  const next = await client.call('metrics.read', { ...range, cursor });
  if (!next.agent.available || !previous.agent.available) return next;
  const { nextCursor: _old, ...agent } = previous.agent;
  return { ...previous, agent: { ...agent, conversations: [...agent.conversations, ...next.agent.conversations],
    ...(next.agent.nextCursor === undefined ? {} : { nextCursor: next.agent.nextCursor }) } };
}
export function formatDuration(ms: number, t: Copy): string {
  if (ms < 1000) return `${Math.round(ms)}${t.mUnitMs}`;
  if (ms < 60000) return `${Math.round(ms / 100) / 10}${t.mUnitS}`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}${t.mUnitM}${t.mUnitSep}${seconds % 60}${t.mUnitS}`;
}
const number = (value: number, language: Language, digits = 2) => new Intl.NumberFormat(language, { maximumFractionDigits: digits }).format(value);
const percent = (value: number, language: Language) => new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 }).format(value);
export function costText(cost: Cost, t: Copy, language: Language): string {
  return cost.available ? `${new Intl.NumberFormat(language, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(cost.totalUsd)} (${cost.count})` : t.mNoCosts;
}
export function kindLabel(kind: string, t: Copy): string {
  return ({ quiz: t.mQuiz, ongoing: t.mOngoing, assignment: t.mAssignment, exam: t.mExam } as Record<string, string>)[kind] ?? t.unknown;
}
const reasons = (t: Copy): Record<string, string> => ({ no_runs: t.mNoRuns, no_labels: t.mNoLabels, no_items: t.mNoItems, no_conversations: t.mNoConversations });
/** One card per metric; an unavailable metric carries its reason and no value or facts. */
export function metricsCards(data: Metrics, t: Copy, language: Language): Card[] {
  const off = (key: Card['key'], title: string, metric: { reason: string }): Card => ({ key, title, reason: reasons(t)[metric.reason] ?? t.unavailable, facts: [] });
  const sync = (key: 'runs' | 'canvas' | 'ed'): Card => {
    const metric = data.sync[key];
    const title = key === 'runs' ? t.mSyncRuns : `${t.mSyncHistory} · ${key === 'ed' ? 'Ed' : 'Canvas'}`;
    if (!metric.available) return off(key, title, metric);
    return { key, title, value: `${formatDuration(metric.medianDurationMs, t)} · ${percent(metric.successRate, language)}`, note: key === 'runs' ? t.mSyncRunsBasis : t.mSyncBasis,
      facts: [[t.mMedian, formatDuration(metric.medianDurationMs, t)], [t.mMax, formatDuration(metric.maxDurationMs, t)], [t.mSuccess, `${metric.successes} / ${metric.count}`]] };
  };
  const { accuracy, estimates, agent } = data;
  // Agent sync runs replace the per-provider API sync; those cards stay only while their history has runs in range.
  return [sync('runs'), ...(['canvas', 'ed'] as const).filter(site => data.sync[site].available).map(sync),
    accuracy.available ? { key: 'accuracy', title: t.mAccuracy, value: percent(accuracy.value, language),
      facts: [[t.mVerdicts, String(accuracy.count)], [t.mCorrect, String(accuracy.correct)], [t.mIncorrect, String(accuracy.incorrect)]] } : off('accuracy', t.mAccuracy, accuracy),
    estimates.available ? { key: 'estimates', title: t.mEstimates, value: `${number(estimates.medianRatio, language)}×`, note: t.mRatioHelp,
      facts: [[t.mMedianRatio, `${number(estimates.medianRatio, language)}×`], [t.mMeanRatio, `${number(estimates.meanRatio, language)}×`], [t.mItems, String(estimates.count)]] } : off('estimates', t.mEstimates, estimates),
    agent.available ? { key: 'agent', title: t.mAgent, value: String(agent.count),
      facts: [[t.mConversations, String(agent.count)], [t.mSteps, String(agent.byKind.reduce((sum, row) => sum + row.steps, 0))],
        [t.mTurns, String(agent.byKind.reduce((sum, row) => sum + row.turns, 0))], [t.mCost, costText(agent.cost, t, language)], [t.mCostUnknown, String(agent.cost.unknownCount)]] } : off('agent', t.mAgent, agent)];
}
