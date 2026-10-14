import { afterEach, expect, it } from 'vitest';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { PlanningService } from '../../src/planning/service.js';
const stores: SqliteRepository[] = [];
afterEach(() => stores.splice(0).forEach(store => store.close()));
const owner = { assertOwner: async () => {} };
const settings = { weekdayMinutes: [60, 60, 60, 60, 60, 0, 0], teachingWeekAnchor: '2026-10-19', breakWeeks: [3] };
function setup() { const store = new SqliteRepository(':memory:'); stores.push(store); return { store, service: new PlanningService(store) }; }
it('saves owner availability with Melbourne default and rejects invalid updates atomically', async () => {
  const { store, service } = setup();
  await service.saveSettings(settings, owner);
  expect(service.settings()).toEqual({ ...settings, timeZone: 'Australia/Melbourne' });
  for (const input of [{ ...settings, weekdayMinutes: [-30, 0, 0, 0, 0, 0, 0] }, { ...settings, timeZone: 'invalid' }, { ...settings, teachingWeekAnchor: 'invalid' }]) {
    await expect(service.saveSettings(input, owner)).rejects.toThrow();
  }
  expect(store.readPlanningSettings()).toHaveLength(1);
});
it('refuses agent availability changes without mutating storage', async () => {
  const { store, service } = setup();
  await expect(service.saveSettings(settings, undefined)).rejects.toThrow();
  expect(store.readPlanningSettings()).toEqual([]);
});
it('rejects settings too large for safe reads and leaves the previous record intact', async () => {
  const { service, store } = setup(); await service.saveSettings(settings, owner);
  await expect(service.saveSettings({ ...settings, breakWeeks: Array(20001).fill(1) }, owner)).rejects.toThrow();
  expect(store.readPlanningSettings()).toHaveLength(1);
  expect(service.settings()?.breakWeeks).toEqual([3]);
});
