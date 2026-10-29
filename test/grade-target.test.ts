import { describe, expect, it } from 'vitest';
import { bandTargets, finalNeeded } from '../shared/course-calculations.js';

// One test per scenario in specs/grade-target/spec.md.
describe('finalNeeded', () => {
  it('returns the average still needed across the remaining weight', () => {
    const result = finalNeeded({ earned: 30, weight: 40 }, bandTargets.H1);
    expect(result.status).toBe('reachable');
    expect(result.status === 'reachable' && result.percent).toBeCloseTo(83.333, 2);
  });

  it('is secured once the earned points reach the target', () => {
    expect(finalNeeded({ earned: 52, weight: 60 }, bandTargets.P)).toEqual({ status: 'secured' });
  });

  it('is unreachable when more than 100% would be needed', () => {
    expect(finalNeeded({ earned: 20, weight: 70 }, bandTargets.H1)).toEqual({ status: 'unreachable' });
  });

  it('decides from the earned points alone when nothing is left to mark', () => {
    expect(finalNeeded({ earned: 81, weight: 100 }, bandTargets.H1)).toEqual({ status: 'secured' });
    expect(finalNeeded({ earned: 79, weight: 100 }, bandTargets.H1)).toEqual({ status: 'unreachable' });
    // Sums such as weight * score / outOf can land a hair under the target.
    expect(finalNeeded({ earned: 80 - 1e-12, weight: 100 }, bandTargets.H1)).toEqual({ status: 'secured' });
  });

  it('needs the target itself when nothing is graded yet', () => {
    expect(finalNeeded({ earned: 0, weight: 0 }, bandTargets.H2A)).toEqual({ status: 'reachable', percent: 75 });
  });
});
