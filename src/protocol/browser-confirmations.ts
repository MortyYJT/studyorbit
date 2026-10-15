import type { SqliteRepository } from '../store/sqlite.js';
import type { PendingConfirmation } from '../domain/schemas.js';
import type { ConfirmationStore } from '../browser/tools/ports.js';
/** Delegates persistence to the repository; transitions never reconstruct a browser action. */
export class BrowserConfirmationStore implements ConfirmationStore {
  constructor(private readonly store: Pick<SqliteRepository,
    'listPendingConfirmations' | 'savePendingConfirmation' | 'transitionPendingConfirmation'>) {}
  list(): PendingConfirmation[] { return this.store.listPendingConfirmations(); }
  save(row: PendingConfirmation): void { this.store.savePendingConfirmation(row); }
  transition(id: string, state: 'confirmed' | 'cancelled' | 'expired'): PendingConfirmation | undefined {
    return this.store.transitionPendingConfirmation(id, state);
  }
}
