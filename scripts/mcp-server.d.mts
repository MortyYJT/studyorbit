export function parseServerOptions(argv: string[], env: Record<string, string | undefined>): {
  projectDir: string;
  desktop: string | undefined;
  courseIds: string[] | null;
};
