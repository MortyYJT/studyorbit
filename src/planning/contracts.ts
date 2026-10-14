import { z } from 'zod';
import { PlanningSettingsSchema } from '../domain/schemas.js';
import { IdSchema } from '../protocol/contracts.js';
const date = z.iso.date();
const minutes = z.number().int().positive().safe();
const time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const planScope = z.strictObject({ term: z.string().min(1).max(256), startDate: date, horizonDays: z.number().int().min(1).max(366) });
export type PlanScope = z.infer<typeof planScope>;
export const settingsInput = PlanningSettingsSchema.extend({ breakWeeks: PlanningSettingsSchema.shape.breakWeeks.max(366), timeZone: PlanningSettingsSchema.shape.timeZone.default('Australia/Melbourne') }).strict();
const fields = { title: z.string().trim().min(1).max(1024), due: z.iso.datetime({ offset: true }).optional(), estimateMinutes: minutes.optional(), allDay: z.boolean().optional() };
export const planningInputs = {
  'planning.settings.set': settingsInput,
  'estimate.agent.set': z.strictObject({ workId: IdSchema, minutes, reason: z.string().trim().min(1).max(2048) }),
  'estimate.owner.set': z.strictObject({ workId: IdSchema, minutes }),
  'plan.start.set': planScope.extend({ workId: IdSchema, date, time }),
  'plan.start.clear': z.strictObject({ workId: IdSchema, date }),
  'time.record': z.strictObject({ workId: IdSchema, minutes }),
  'manual.create': z.strictObject({ moduleId: IdSchema, ...fields }),
  'manual.edit': z.strictObject({ id: IdSchema, title: fields.title.optional(), due: fields.due.nullable(), estimateMinutes: fields.estimateMinutes, allDay: fields.allDay }),
  'manual.complete': z.strictObject({ id: IdSchema }),
  'manual.delete': z.strictObject({ id: IdSchema }),
} as const;
export type PlanningWrite = keyof typeof planningInputs;
const workOutput = z.strictObject({ workId: IdSchema, title: z.string(), courseId: IdSchema.optional(), due: z.iso.datetime({ offset: true }).optional(),
  estimateMinutes: z.number().nonnegative().optional(), estimateOrigin: z.enum(['agent', 'owner']).optional(),
  agentEstimate: z.strictObject({ minutes, reason: z.string().optional() }).optional(), actualMinutes: z.number().nonnegative() });
const planOutput = z.strictObject({ settings: PlanningSettingsSchema,
  days: z.array(z.strictObject({ date, availableMinutes: z.number().nonnegative(), items: z.array(workOutput.extend({ minutes: z.number().positive(), startTime: time.optional() })) })),
  work: z.array(workOutput), overflow: z.array(workOutput.extend({ minutes: z.number().positive() })), unestimated: z.array(workOutput),
  deadlines: z.array(z.strictObject({ workId: IdSchema, title: z.string(), courseId: IdSchema.optional(), due: z.iso.datetime({ offset: true }).optional(), date: date.optional(), kind: z.enum(['exam', 'all-day']) })),
});
export const planningOwnerCommands = new Set(Object.keys(planningInputs).filter(name => name !== 'estimate.agent.set'));
export const planningSessionCommands = new Set(['plan.start.set', 'plan.start.clear', 'time.record', 'manual.create', 'manual.edit', 'manual.complete', 'manual.delete']);
export const planningContracts = {
  'plan.read': { input: planScope, output: planOutput, level: 0 as const },
  'planning.settings.read': { input: z.strictObject({}), output: z.strictObject({ settings: PlanningSettingsSchema.optional() }), level: 0 as const },
  ...Object.fromEntries(Object.entries(planningInputs).map(([name, input]) => [name, { input, output: z.strictObject({ recorded: z.literal(true), id: IdSchema.optional() }), level: 0 as const }])),
};
