export interface CommandQuestion {
  message: string;
  detail: string;
  confirm: string;
  event?: unknown;
}

export function commandText(command: string): string;
export function createCommandApproval(options: { file: string; ask: (question: CommandQuestion) => Promise<boolean> }): {
  require(what: unknown, question: CommandQuestion): Promise<void>;
};
