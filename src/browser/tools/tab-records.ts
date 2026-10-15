import { constants } from 'node:fs';
import { mkdir, open, unlink, chmod, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { dataDir } from '../../config/data-dir.js';
import { CourseworkError } from '../../protocol/errors.js';
const record = z.strictObject({ targetId: z.string().regex(/^[a-zA-Z0-9-]{1,128}$/) });
/** Private host lookup for owner focus across the MCP and UI processes, never an agent tab-discovery API. */
export class ToolTabRecords {
  constructor(private readonly directory = join(dataDir(), 'browser-tabs')) {}
  private path(id: string) { return join(this.directory, `${z.uuid().parse(id)}.json`); }
  private async checkDirectory() {
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid()) throw new CourseworkError('SOURCE_UNAVAILABLE', 'Private tab storage unavailable.');
  }
  async save(id: string, targetId: string) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 }); await this.checkDirectory(); await chmod(this.directory, 0o700);
    const file = await open(this.path(id), 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(record.parse({ targetId }))); } finally { await file.close(); }
  }
  async load(id: string): Promise<string> {
    let file;
    try {
      await this.checkDirectory();
      file = await open(this.path(id), constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 || process.getuid && stat.uid !== process.getuid()) throw new Error();
      return record.parse(JSON.parse(await file.readFile('utf8'))).targetId;
    } catch { throw new CourseworkError('NOT_FOUND', 'Tool-owned tab not found.'); }
    finally { await file?.close(); }
  }
  async remove(id: string) { await unlink(this.path(id)).catch(() => {}); }
}
