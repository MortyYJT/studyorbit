import { describe, expect, it } from 'vitest';
import { projectGrade } from '../../src/domain/grade.js';
import { syntheticCourse as course, syntheticAssessment as item, syntheticAssessments as assessments } from '../fixtures/synthetic.js';

describe('grade projection scenarios', () => {
  it('needed final score', () => {
    const result = projectGrade(course, assessments, 'H1');
    expect(result.gradedWeight).toBe(35);
    expect(result.earned).toBeCloseTo(28.8, 1);
    expect(result.currentAverage).toBeCloseTo(82.29, 2);
    expect(result.need.status).toBe('score');
    if (result.need.status === 'score') {
      expect(result.need.value).toBeCloseTo(76.6, 1);
      expect(result.need.setByHurdle).toBe(false);
    }
  });
  it('raw need above the hurdle keeps the calculated score', () => {
    const result = projectGrade(course, [assessments[0]!, assessments[1]!, assessments[2]!, assessments[3]!, item('final', 40, undefined, true, 40)], 'H1');
    expect(result.need.status).toBe('score');
    if (result.need.status === 'score') {
      expect(result.need.value).toBeCloseTo(76.6, 1);
      expect(result.need.setByHurdle).toBe(false);
    }
  });
  it('hurdle sets the floor', () => {
    const result = projectGrade(course, [assessments[0]!, assessments[1]!, assessments[2]!, item('d', 25, 60), item('final', 40, undefined, true, 40)], 'P');
    expect(result.need).toEqual({ status: 'score', value: 40, setByHurdle: true });
  });
  it('out of reach and secured', () => {
    expect(projectGrade(course, [item('a', 60, 0), item('final', 40, undefined, true)], 'H1').need).toEqual({ status: 'unreachable' });
    expect(projectGrade(course, [item('a', 80, 90), item('final', 20, undefined, true)], 'P').need).toEqual({ status: 'secured' });
  });
  it('hurdle beats secured', () => {
    expect(projectGrade(course, [item('a', 80, 90), item('final', 20, undefined, true, 50)], 'P').need).toEqual({ status: 'score', value: 50, setByHurdle: true });
  });
  it('nothing graded yet', () => {
    const result = projectGrade(course, [item('a', 60), item('final', 40, undefined, true)], 'H1');
    expect(result.currentAverage).toBeNull();
    expect(result.need).toEqual({ status: 'unavailable', reason: 'nothing_graded' });
  });
  it('no final or final already graded', () => {
    expect(projectGrade(course, [item('a', 100, 80)], 'H1').need).toEqual({ status: 'unavailable', reason: 'no_final' });
    expect(projectGrade(course, [item('a', 60, 80), item('final', 40, 70, true)], 'H1').need).toEqual({ status: 'unavailable', reason: 'final_graded' });
  });
  it('several unavailable reasons: nothing graded takes precedence', () => {
    expect(projectGrade(course, [item('a', 100)], 'H1').need).toEqual({ status: 'unavailable', reason: 'nothing_graded' });
  });
});
