import { z } from 'zod';
const id = z.string().min(1).max(256);
const tab = { tabId: id };
const write = { ...tab, assessmentId: id, ref: id };
const output = z.record(z.string(), z.json());
export const toolContracts = {
  'browser.open': { input: z.strictObject({ url: z.string().max(2048) }), output, level: 0 },
  'browser.read': { input: z.strictObject(tab), output, level: 0 },
  'browser.screenshot': { input: z.strictObject(tab), output, level: 0 },
  'browser.click': { input: z.strictObject(write), output, level: 0 },
  'browser.fill': { input: z.strictObject({ ...write, value: z.string().max(16384) }), output, level: 0 },
  'browser.select': { input: z.strictObject({ ...write, value: z.string().max(4096) }), output, level: 0 },
  'browser.submit': { input: z.strictObject({ ...write, summary: z.string().min(1).max(16384) }), output, level: 0 },
} as const;
export const confirmationInput = z.strictObject({ confirmationId: id, decision: z.enum(['confirmed', 'cancelled']) });
