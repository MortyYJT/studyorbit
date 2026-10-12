import type { CommandOutput, ParsedCommandInput } from '../protocol/contracts.js';
export type AcceptedRead = 'revision.list' | 'practice.list' | 'proposals.get';
/** D supplies the eventual private accepted-record backend. B owns no persistence layout or writes.
 * Implementations must apply exact course/week/revision filters and filter-bound opaque cursors.
 */
export interface AcceptedRecordReader {
  read<N extends AcceptedRead>(name: N, input: ParsedCommandInput<N>): Promise<CommandOutput<N>>;
}
