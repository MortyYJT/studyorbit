import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtocolFiles } from '../../src/protocol/files.js';
import { hash } from '../../src/citations/exact.js';
import { SharedAuthorization, Q1AuthorizationStore, IdentityMap } from '../../src/protocol/authorization.js';
import { DurableAudit } from '../../src/protocol/audit.js';
import { createRegistry, dispatch } from '../../src/protocol/registry.js';
import { protectRead } from '../../src/protocol/read-privacy.js';
import { createFakeContext, examples } from '../../src/protocol/fakes.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('deferred dispatcher P3 fixes', () => {
  it('reports UNCERTAIN, not INTERNAL, when output or privacy validation fails after a successful write', async () => {
    const context = createFakeContext(); const write = vi.spyOn(context.services, 'write').mockResolvedValue({ invalid: true } as never);
    expect(await dispatch(createRegistry(), 'revision.write', examples['revision.write'].input, context)).toMatchObject({ ok: false, error: { code: 'UNCERTAIN', retryable: false } });
    expect(write).toHaveBeenCalledOnce();
    const other = createFakeContext(); const calls = vi.spyOn(other.services, 'write');
    other.privacy.protect = async () => { throw new Error('privacy sentinel'); };
    const result = await dispatch(createRegistry(), 'practice.write', examples['practice.write'].input, other);
    expect(result).toMatchObject({ ok: false, error: { code: 'UNCERTAIN' } });
    expect(JSON.stringify(result)).not.toContain('sentinel');
    expect(calls).toHaveBeenCalledOnce();
    expect(other.events.at(-1)).toMatchObject({ phase: 'outcome', code: 'UNCERTAIN' });
  });

  it('keeps INTERNAL for reads whose output fails validation', async () => {
    const context = createFakeContext();
    context.repository.read = vi.fn(async () => ({ invalid: true })) as typeof context.repository.read;
    expect(await dispatch(createRegistry(), 'courses.list', examples['courses.list'].input, context)).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
  });
});
