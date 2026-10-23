import { expect, it } from 'vitest';
import { z } from 'zod';
import { annotationContracts } from '../../src/protocol/annotations.js';
import { autonomyContracts } from '../../src/protocol/autonomy.js';
import { annotationCommands, autonomyCommands } from '../../web/src/course-contracts.js';

it('keeps the browser copies of the annotation and autonomy contracts identical to the server contracts', () => {
  const server = { ...annotationContracts, ...autonomyContracts } as Record<string, { input: z.ZodType; output: z.ZodType }>;
  for (const [name, contract] of Object.entries({ ...annotationCommands, ...autonomyCommands })) {
    for (const side of ['input', 'output'] as const) {
      expect(z.toJSONSchema(contract[side], { io: 'input', unrepresentable: 'any' }), `${name} ${side}`)
        .toEqual(z.toJSONSchema(server[name]![side], { io: 'input', unrepresentable: 'any' }));
    }
  }
});
