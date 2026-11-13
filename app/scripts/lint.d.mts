// Types for scripts/lint.mjs, which runs as plain JavaScript.
export function lintText(file: string, text: string): { file: string; line: number; rule: string; message: string }[];
