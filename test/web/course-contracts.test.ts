import { expect, it } from 'vitest';
import { z } from 'zod';
import { AnnotationService, annotationContracts } from '../../src/protocol/annotations.js';
import { AssessmentAutonomy, autonomyContracts } from '../../src/protocol/autonomy.js';
import { createRegistry, dispatch } from '../../src/protocol/registry.js';
import { createFakeContext } from '../../src/protocol/fakes.js';
import { TrustedStoreEvidence } from '../../src/protocol/reads.js';
import { SqliteRepository } from '../../src/store/sqlite.js';
import { annotationCommands, autonomyCommands, autonomyReads } from '../../web/src/course-contracts.js';
import { en, zh } from '../../web/src/i18n.js';
import { synthetic } from '../fixtures/synthetic.js';

it('keeps the browser copies of the annotation and autonomy contracts identical to the server contracts', () => {
  const server = { ...annotationContracts, ...autonomyContracts } as Record<string, { input: z.ZodType; output: z.ZodType }>;
  for (const [name, contract] of Object.entries({ ...annotationCommands, ...autonomyCommands, ...autonomyReads })) {
    for (const side of ['input', 'output'] as const) {
      expect(z.toJSONSchema(contract[side], { io: 'input', unrepresentable: 'any' }), `${name} ${side}`)
        .toEqual(z.toJSONSchema(server[name]![side], { io: 'input', unrepresentable: 'any' }));
    }
  }
});

const unknownPolicy = { value: 'unknown' as const, origin: 'none' as const, level: 'none' as const };
const policyColumns = { policy: null, policyOrigin: null, policyLevel: null, effectivePolicy: unknownPolicy };

it.each(['exam', 'quiz', 'assignment', 'presentation', 'participation', 'ungraded'] as const)(
  'reads assessment kind %s through the browser autonomy contract', kind => {
    const output = autonomyReads['autonomy.read'].output.parse({ courseId: 'course-1', ...policyColumns, cap: 2, defaultLevel: 0, assessments: [{ assessmentId: 'assessment-1', kind,
        applicable: kind !== 'exam', requiredLevel: kind === 'exam' ? null : 1, override: null,
        effectiveLevel: kind === 'exam' ? null : 1, ...policyColumns }] });
    expect(output.assessments[0]!.kind).toBe(kind);
  });

it('reads a stored ongoing kind through the browser contract as participation', () => {
  const output = autonomyReads['autonomy.read'].output.parse({ courseId: 'course-1', ...policyColumns,
    cap: 2, defaultLevel: 0, assessments: [{ assessmentId: 'assessment-1', kind: 'ongoing', applicable: true,
      requiredLevel: 1, override: null, effectiveLevel: 1, ...policyColumns }] });
  expect(output.assessments[0]!.kind).toBe('participation');
});

it('labels the six kinds in both languages, with participation reusing the old ongoing label', () => {
  expect(en.coursePage.kinds).toMatchObject({ participation: 'Ongoing', presentation: 'Presentation', ungraded: 'Ungraded' });
  expect(zh.coursePage.kinds).toMatchObject({ participation: '持续', presentation: '展示', ungraded: '不计分' });
});

it('parses real autonomy.read and annotation.read responses with the browser contracts', async () => {
  const store = new SqliteRepository(':memory:');
  try {
    const courseId = synthetic.course.id;
    store.saveBatch({ modules: [synthetic.module], courses: [synthetic.course], assessments: synthetic.assessments });
    const context = createFakeContext({ owner: true });
    const registry = createRegistry({ autonomy: new AssessmentAutonomy(store, context.audit),
      annotations: new AnnotationService(store, new TrustedStoreEvidence(store)) });
    expect(await dispatch(registry, 'autonomy.policy.set', { courseId, value: 'allowed' }, context)).toMatchObject({ ok: true });
    expect(await dispatch(registry, 'autonomy.policy.set', { courseId, assessmentId: 'd', value: 'prohibited' }, context)).toMatchObject({ ok: true });

    const autonomy = await dispatch(registry, 'autonomy.read', { courseId }, context);
    expect(autonomy).toMatchObject({ ok: true });
    if (!autonomy.ok) throw new Error('Expected autonomy.read to succeed.');
    const read = autonomyReads['autonomy.read'].output.parse(autonomy.data);
    expect(read).toMatchObject({ courseId, policy: 'allowed', policyOrigin: 'owner', policyLevel: 'course',
      effectivePolicy: { value: 'allowed', origin: 'owner', level: 'course' } });
    expect(read.assessments.find(item => item.assessmentId === 'd')).toMatchObject({ policy: 'prohibited', policyOrigin: 'owner',
      policyLevel: 'assessment', effectivePolicy: { value: 'prohibited', origin: 'owner', level: 'assessment' } });

    const annotation = await dispatch(registry, 'annotation.read', { entity: 'assessment', entityId: 'd' }, context);
    expect(annotation).toMatchObject({ ok: true });
    if (!annotation.ok) throw new Error('Expected annotation.read to succeed.');
    const detail = annotationCommands['annotation.read'].output.parse(annotation.data);
    expect(detail).toMatchObject({ policy: 'prohibited', policyOrigin: 'owner', policyLevel: 'assessment',
      effectivePolicy: { value: 'prohibited', origin: 'owner', level: 'assessment' } });
  } finally {
    store.close();
  }
});
