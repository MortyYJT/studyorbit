import { describe, expect, it } from 'vitest';
import { assessmentJump, dueEdit, numberProblem, parseDueInput, statusOptions } from '../web/src/assessment-form.js';

describe('parseDueInput', () => {
  it('takes an empty value as "no due date"', () => {
    expect(parseDueInput('')).toEqual({ ok: true, value: null });
    expect(parseDueInput('   ')).toEqual({ ok: true, value: null });
  });
  it('takes a calendar day, also with slashes or without leading zeros, and writes it as YYYY-MM-DD', () => {
    expect(parseDueInput('2026-12-10')).toEqual({ ok: true, value: '2026-12-10' });
    expect(parseDueInput(' 2026/12/10 ')).toEqual({ ok: true, value: '2026-12-10' });
    expect(parseDueInput('2026-3-5')).toEqual({ ok: true, value: '2026-03-05' });
  });
  it('keeps a date-time with a zone as it was typed, so an untouched synced value is not rewritten', () => {
    expect(parseDueInput('2026-11-27T12:59:00Z')).toEqual({ ok: true, value: '2026-11-27T12:59:00Z' });
    expect(parseDueInput('2026-11-27T23:59:00+11:00')).toEqual({ ok: true, value: '2026-11-27T23:59:00+11:00' });
    expect(parseDueInput('2026-11-27T12:59:00.000Z')).toEqual({ ok: true, value: '2026-11-27T12:59:00.000Z' });
  });
  it('refuses anything the calendar cannot place', () => {
    for (const raw of ['12月10日', 'next Friday', '2026-13-01', '2026-02-30', '10/12/2026', '2026-12-10 23:59', '2026-12-10T23:59', '2026-12-10T25:00:00Z'])
      expect(parseDueInput(raw), raw).toEqual({ ok: false });
  });
});

describe('dueEdit', () => {
  it('leaves a value the form was filled with alone, whatever it is, so another field can still be saved', () => {
    for (const shown of ['2026-11-27T23:59:00', 'Week 12', '12月10日', '2026-11-27T12:59:00Z', ''])
      expect(dueEdit(shown, shown), shown).toEqual({ ok: true, changed: false });
    expect(dueEdit('  Week 12 ', 'Week 12')).toEqual({ ok: true, changed: false });
  });
  it('reads a value that was changed', () => {
    expect(dueEdit('2026/12/10', 'Week 12')).toEqual({ ok: true, changed: true, value: '2026-12-10' });
    expect(dueEdit('', 'Week 12')).toEqual({ ok: true, changed: true, value: null });
    expect(dueEdit('2026-12-10', '')).toEqual({ ok: true, changed: true, value: '2026-12-10' });
  });
  it('refuses a changed value the calendar cannot place', () => {
    expect(dueEdit('Week 13', 'Week 12')).toEqual({ ok: false });
    expect(dueEdit('12月10日', '')).toEqual({ ok: false });
  });
});

describe('numberProblem', () => {
  it('passes empty fields and numbers in range', () => {
    expect(numberProblem({ weight: '', score: '', outOf: '' })).toBeNull();
    expect(numberProblem({ weight: '25', score: '40', outOf: '50' })).toBeNull();
    expect(numberProblem({ weight: '0', score: '0', outOf: '0' })).toBeNull();
    expect(numberProblem({ weight: '100', score: '7.5', outOf: '' })).toBeNull();
  });
  it('names the first field that is wrong', () => {
    expect(numberProblem({ weight: '101', score: '', outOf: '' })).toBe('weight');
    expect(numberProblem({ weight: '-1', score: '', outOf: '' })).toBe('weight');
    expect(numberProblem({ weight: 'abc', score: '', outOf: '' })).toBe('weight');
    expect(numberProblem({ weight: '', score: '-2', outOf: '' })).toBe('score');
    expect(numberProblem({ weight: '', score: '', outOf: '-5' })).toBe('outOf');
    expect(numberProblem({ weight: '', score: '60', outOf: '50' })).toBe('scoreOverMax');
  });
});

describe('statusOptions', () => {
  it('offers "not set" and the four states the plan understands', () => {
    expect(statusOptions('')).toEqual(['', 'not_started', 'in_progress', 'submitted', 'graded']);
    expect(statusOptions('submitted')).toEqual(['', 'not_started', 'in_progress', 'submitted', 'graded']);
  });
  it('keeps a stored value it does not know as one more choice, so saving the form does not lose it', () => {
    expect(statusOptions('已提交')).toEqual(['', 'not_started', 'in_progress', 'submitted', 'graded', '已提交']);
    expect(statusOptions('unknown')).toEqual(['', 'not_started', 'in_progress', 'submitted', 'graded']);
  });
});

describe('assessmentJump', () => {
  const items = [
    { key: '9:a1', parent: '' }, { key: '9:q', parent: '' }, { key: '9:q1', parent: '9:q' },
  ];
  it('opens the assessment a task or deadline names', () => {
    expect(assessmentJump('9:a1', '9', items)).toEqual({ key: '9:a1', group: false });
    expect(assessmentJump('9:q1', '9', items)).toEqual({ key: '9:q1', group: false });
  });
  it('opens the whole group for a task that plans it, and for a deadline on an assessment that has parts', () => {
    expect(assessmentJump('9:group:9:q', '9', items)).toEqual({ key: '9:q', group: true });
    expect(assessmentJump('9:q', '9', items)).toEqual({ key: '9:q', group: true });
  });
  it('opens nothing for a personal task, a task whose assessment is gone, or another course', () => {
    expect(assessmentJump('task:123', '9', items)).toBeNull();
    expect(assessmentJump('9:gone', '9', items)).toBeNull();
    expect(assessmentJump('9:group:9:gone', '9', items)).toBeNull();
    expect(assessmentJump('8:a1', '9', items)).toBeNull();
  });
});
