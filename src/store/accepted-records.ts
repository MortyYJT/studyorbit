import type { CommandOutput, ParsedCommandInput } from '../protocol/contracts.js';
export type AcceptedRead = 'revision.list' | 'practice.list';
/** Accepted-record readers return validated current records from private storage.
 * Implementations must apply exact course/week/revision filters and filter-bound opaque cursors.
 */
export interface AcceptedRecordReader {
  read<N extends AcceptedRead>(name: N, input: ParsedCommandInput<N>): Promise<CommandOutput<N>>;
}
