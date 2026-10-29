import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from '../../shared/course-tools.ts';
export const TOOL_ANNOTATIONS: Readonly<{ readOnlyHint: true; destructiveHint: false; idempotentHint: true; openWorldHint: false }>;
export function createCourseMcpServer(options: {
  loadContext: () => Promise<ToolContext> | ToolContext;
  version: string;
  onLoadError?: (error: unknown) => void;
  timeLabel?: string;
}): McpServer;
export function courseContextLoader(options: {
  projectDir: string;
  desktop?: string;
  courseIds?: string[] | null;
  now?: () => Date;
}): () => Promise<ToolContext>;
