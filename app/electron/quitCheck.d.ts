// Types for electron/quitCheck.js, which the main process runs as plain JavaScript (only what tests use).

// What `show` gets: Electron's `MessageBoxOptions`, as far as the question needs them.
export interface QuitQuestion {
  type: "warning";
  title: string;
  noLink: boolean;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  message: string;
  detail: string;
}

export interface QuitCheck {
  // A quit nobody can answer a question for (shutdown, a signal, the session ending): never asks from now on.
  force(): void;
  // True to quit, false to keep running; quits that come while the question is open share its answer.
  confirm(win: unknown): Promise<boolean>;
}

export function createQuitCheck(options: {
  // How many new uploads haven't reached a node (0 when the page doesn't answer).
  ask: (win: unknown) => Promise<number>;
  // Electron's `dialog.showMessageBox`: resolves with the button picked.
  show: (win: unknown, question: QuitQuestion) => Promise<{ response: number }>;
}): QuitCheck;
