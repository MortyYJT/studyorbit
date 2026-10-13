import { expectTypeOf, it } from 'vitest';
import type { Module, Run, Task } from '../../src/domain/schemas.js';
import type { Repository, SaveBatch } from '../../src/store/repository.js';

it('exposes synchronous entity, batch, change and run operations without SQL', () => {
  expectTypeOf<Repository['saveModule']>().parameters.toEqualTypeOf<[Module]>();
  expectTypeOf<Repository['loadModule']>().returns.toEqualTypeOf<Module | undefined>();
  expectTypeOf<Repository['loadTask']>().returns.toEqualTypeOf<Task | undefined>();
  expectTypeOf<Repository['saveBatch']>().parameters.toEqualTypeOf<[SaveBatch]>();
  expectTypeOf<Repository['saveBatch']>().returns.toEqualTypeOf<void>();
  expectTypeOf<Repository['recordRun']>().parameters.toEqualTypeOf<[Run]>();
});
