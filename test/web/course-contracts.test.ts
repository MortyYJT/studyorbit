import { expect, it } from 'vitest';
import { z } from 'zod';
import { annotationContracts } from '../../src/protocol/annotations.js';
import { autonomyContracts } from '../../src/protocol/autonomy.js';
import { annotationCommands, autonomyCommands, autonomyReads } from '../../web/src/course-contracts.js';
import { en, zh } from '../../web/src/i18n.js';

it('keeps the browser copies of the annotation and autonomy contracts identical to the server contracts', () => {
  const server = { ...annotationContracts, ...autonomyContracts } as Record<string, { input: z.ZodType; output: z.ZodType }>;
  for (const [name, contract] of Object.entries({ ...annotationCommands, ...autonomyCommands, ...autonomyReads })) {
    for (const side of ['input', 'output'] as const) {
      expect(z.toJSONSchema(contract[side], { io: 'input', unrepresentable: 'any' }), `${name} ${side}`)
        .toEqual(z.toJSONSchema(server[name]![side], { io: 'input', unrepresentable: 'any' }));
    }
  }
});

it.each(['exam', 'quiz', 'assignment', 'presentation', 'participation', 'ungraded'] as const)(
  'reads assessment kind %s through the browser autonomy contract', kind => {
    const output = autonomyReads['autonomy.read'].output.parse({ courseId: 'course-1', policy: null, policyOrigin: null,
      cap: 2, defaultLevel: 0, assessments: [{ assessmentId: 'assessment-1', kind, applicable: kind !== 'exam',
        requiredLevel: kind === 'exam' ? null : 1, override: null, effectiveLevel: kind === 'exam' ? null : 1 }] });
    expect(output.assessments[0]!.kind).toBe(kind);
  });

it('reads a stored ongoing kind through the browser contract as participation', () => {
  const output = autonomyReads['autonomy.read'].output.parse({ courseId: 'course-1', policy: null, policyOrigin: null,
    cap: 2, defaultLevel: 0, assessments: [{ assessmentId: 'assessment-1', kind: 'ongoing', applicable: true,
      requiredLevel: 1, override: null, effectiveLevel: 1 }] });
  expect(output.assessments[0]!.kind).toBe('participation');
});

it('labels the six kinds in both languages, with participation reusing the old ongoing label', () => {
  expect(en.coursePage.kinds).toMatchObject({ participation: 'Ongoing', presentation: 'Presentation', ungraded: 'Ungraded' });
  expect(zh.coursePage.kinds).toMatchObject({ participation: '持续', presentation: '展示', ungraded: '不计分' });
});
