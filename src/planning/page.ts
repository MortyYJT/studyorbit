import { createHash } from 'node:crypto';
import type { z } from 'zod';
import { CourseworkError } from '../protocol/errors.js';
import type { planOutput, planReadInput } from './contracts.js';
import type { PlanningService } from './service.js';

type Page = z.infer<typeof planOutput>;
type Collection = 'work' | 'deadlines' | 'days' | 'overflow' | 'unestimated';
type Unit = { [K in Collection]: { kind: K; value: Page[K][number] } }[Collection]
  | { kind: 'textContinuations'; value: NonNullable<Page['textContinuations']>[number] }
  | { kind: 'settings'; value: NonNullable<Page['settings']> };
const invalid = () => new CourseworkError('INVALID_INPUT', 'Invalid plan continuation; restart the read.');

/** Bound serialized bytes (including JSON escapes), retaining whole Unicode code points. */
function splitText(text: string): string[] {
  const parts: string[] = []; let part = ''; let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(JSON.stringify(character), 'utf8') - 2;
    if (bytes + size > 16 * 1024) { parts.push(part); part = ''; bytes = 0; }
    part += character; bytes += size;
  }
  parts.push(part);
  return parts;
}

/** Page the globally computed plan, never schedule subsets independently.
 * Settings occur once; collection rows concatenate and day fragments merge by date.
 * References keep long titles and estimate reasons in just one work row.
 * Large text fields start in that row and continue at UTF-16 string offsets.
 */
export function pagePlan(plan: ReturnType<PlanningService['plan']>, input: z.infer<typeof planReadInput>): Page {
  const { cursor, limit = 100, ...scope } = input;
  const textUnits: Unit[] = [];
  const prefix = (collection: 'work' | 'deadlines', workId: string, field: 'title' | 'agentEstimate.reason', text: string) => {
    const [first = '', ...rest] = splitText(text);
    let offset = first.length;
    for (const text of rest) {
      textUnits.push({ kind: 'textContinuations', value: { collection, workId, field, offset, text } });
      offset += text.length;
    }
    return first;
  };
  const units: Unit[] = [{ kind: 'settings', value: plan.settings },
    ...plan.work.map(item => ({ kind: 'work' as const, value: { ...item,
      title: prefix('work', item.workId, 'title', item.title),
      ...(item.agentEstimate ? { agentEstimate: { ...item.agentEstimate,
        ...(item.agentEstimate.reason !== undefined ? { reason: prefix('work', item.workId, 'agentEstimate.reason', item.agentEstimate.reason) } : {}) } } : {}),
    } })),
    ...plan.deadlines.map(item => ({ kind: 'deadlines' as const, value: { ...item, title: prefix('deadlines', item.workId, 'title', item.title) } })),
    ...textUnits,
    ...plan.days.flatMap(day => {
      const items = day.items.map(({ workId, minutes, startTime }) => ({ workId, minutes, ...(startTime ? { startTime } : {}) }));
      return (items.length ? items.map(item => [item]) : [[]]).map(items => ({ kind: 'days' as const, value: { ...day, items } }));
    }),
    ...plan.overflow.map(({ workId, minutes }) => ({ kind: 'overflow' as const, value: { workId, minutes } })),
    ...plan.unestimated.map(({ workId }) => ({ kind: 'unestimated' as const, value: { workId } })),
  ];
  const digest = createHash('sha256').update(JSON.stringify([scope, units])).digest('hex');
  let offset = 0;
  if (cursor) {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^(\d+):([a-f0-9]{64})$/.exec(decoded);
    if (!match || match[2] !== digest || Buffer.from(decoded).toString('base64url') !== cursor
      || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 0 || Number(match[1]) >= units.length) throw invalid();
    offset = Number(match[1]);
  }
  let page: Page = { work: [], deadlines: [], days: [], overflow: [], unestimated: [] };
  let next = offset;
  for (const unit of units.slice(offset, offset + limit)) {
    const candidate = structuredClone(page);
    switch (unit.kind) {
      case 'settings': candidate.settings = unit.value; break;
      case 'work': candidate.work.push(unit.value); break;
      case 'deadlines': candidate.deadlines.push(unit.value); break;
      case 'overflow': candidate.overflow.push(unit.value); break;
      case 'unestimated': candidate.unestimated.push(unit.value); break;
      case 'textContinuations': (candidate.textContinuations ??= []).push(unit.value); break;
      case 'days': {
        const previous = candidate.days.at(-1);
        if (previous?.date === unit.value.date) previous.items.push(...unit.value.items);
        else candidate.days.push(unit.value);
        break;
      }
    }
    if (next + 1 < units.length) candidate.nextCursor = Buffer.from(`${next + 1}:${digest}`).toString('base64url');
    else delete candidate.nextCursor;
    // Reserve room for the protocol envelope and transport metadata.
    if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > 64 * 1024 - 1024) break;
    page = candidate; next++;
  }
  if (next === offset) throw new CourseworkError('LIMIT_EXCEEDED', 'A plan row exceeds the read response bound.');
  return page;
}
