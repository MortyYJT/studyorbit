export type ReplyRegistry = {
  begin(id: string): AbortController | null;
  end(id: string, controller: AbortController): void;
  running(id: string): boolean;
  stop(id: string): boolean;
  stopAndWait(id: string): Promise<boolean>;
};
export function createReplyRegistry(): ReplyRegistry;
