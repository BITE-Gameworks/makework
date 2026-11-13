// Monaco is deliberately isolated here, so the code plugin and its workers load only after a code channel opens.
import * as Y from "yjs";
import type { LspDiagnostic, LspRange } from "./lsp";
import { languageWords } from "./snippets";

type Loaded = { monaco: any; MonacoBinding: new (...args: any[]) => { destroy(): void } };
let loaded: Promise<Loaded> | undefined;

async function load(): Promise<Loaded> {
  loaded ??= Promise.all([
    // editor.main, not editor.api: the API alone has none of the editor's features (suggestions, hover, find).
    import("monaco-editor/editor/editor.main"),
    import("y-monaco"),
    import("monaco-editor/editor/editor.worker?worker"),
    import("monaco-editor/language/typescript/ts.worker?worker"),
    import("monaco-editor/language/json/json.worker?worker"),
    import("monaco-editor/language/css/css.worker?worker"),
    import("monaco-editor/language/html/html.worker?worker"),
  ]).then(([monaco, binding, EditorWorker, TsWorker, JsonWorker, CssWorker, HtmlWorker]) => {
    self.MonacoEnvironment = {
      getWorker(_id, label) {
        if (label === "typescript" || label === "javascript") return new TsWorker.default();
        if (label === "json") return new JsonWorker.default();
        if (label === "css" || label === "scss" || label === "less") return new CssWorker.default();
        if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker.default();
        return new EditorWorker.default();
      },
    };
    registerProviders(monaco);
    return { monaco, MonacoBinding: binding.MonacoBinding as Loaded["MonacoBinding"] };
  });
  return loaded!;
}

// What the open models get help from: a language server per model address, the AI source, and where to open
// another file (go to definition). Providers are registered once and look these up.
export interface LanguageServer {
  request<T>(method: string, params: unknown): Promise<T>;
  running(): boolean;
}
const servers = new Map<string, LanguageServer>();
export const attachServer = (uri: string, server: LanguageServer | null) => (server ? servers.set(uri, server) : servers.delete(uri));
type InlineSource = (model: { uri: string; name: string; language: string }, before: string, after: string, signal: AbortSignal) => Promise<string>;
let inlineSource: InlineSource | null = null;
export const setInlineSource = (source: InlineSource | null) => (inlineSource = source);
type Opener = (uri: string, line: number, column: number) => boolean;
let opener: Opener | null = null;
export const setOpener = (open: Opener | null) => (opener = open);

const lspLanguages = ["python", "rust", "go", "c", "cpp", "java", "csharp", "shell"];
const completionKinds = ["", "Text", "Method", "Function", "Constructor", "Field", "Variable", "Class", "Interface", "Module", "Property", "Unit", "Value",
  "Enum", "Keyword", "Snippet", "Color", "File", "Reference", "Folder", "EnumMember", "Constant", "Struct", "Event", "Operator", "TypeParameter"];
const markdownOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(markdownOf).join("\n\n");
  if (value && typeof value === "object") {
    const v = value as { language?: string; value?: string; kind?: string };
    return v.language ? `\`\`\`${v.language}\n${v.value ?? ""}\n\`\`\`` : String(v.value ?? "");
  }
  return "";
};

// Servers may send every name in scope unfiltered (csharp-ls: hundreds of types). Only items that can match the
// typed word are kept, those starting with it first, so the cut never drops a match.
function matching(items: any[], word: string): any[] {
  const typed = word.toLowerCase();
  const fits = (text: string) => {
    let at = 0;
    for (const ch of text.toLowerCase()) if (ch === typed[at]) at++;
    return at === typed.length;
  };
  const kept = typed ? items.filter((item) => fits(String(item.filterText ?? item.label))) : items;
  const starts = (item: any) => String(item.filterText ?? item.label).toLowerCase().startsWith(typed);
  return (typed ? [...kept.filter(starts), ...kept.filter((item) => !starts(item))] : kept).slice(0, 1000);
}

function registerProviders(monaco: any) {
  const range = (r: LspRange) => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
  const at = (model: any, position: any) => ({ textDocument: { uri: model.uri.toString() }, position: { line: position.lineNumber - 1, character: position.column - 1 } });
  const serverOf = (model: any) => {
    const server = servers.get(model.uri.toString());
    return server?.running() ? server : undefined;
  };
  for (const language of lspLanguages) {
    monaco.languages.registerCompletionItemProvider(language, {
      triggerCharacters: [".", ":", ">", "/", "\"", "'", "<", "@", "#"],
      async provideCompletionItems(model: any, position: any) {
        const server = serverOf(model);
        if (!server) return { suggestions: [] };
        const result = await server.request<any>("textDocument/completion", at(model, position)).catch(() => null);
        const word = model.getWordUntilPosition(position);
        const items = matching(Array.isArray(result) ? result : result?.items ?? [], word.word);
        const fallback = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
        return {
          incomplete: !!result?.isIncomplete,
          suggestions: items.map((item) => {
            const edit = item.textEdit;
            return {
              label: item.label, detail: item.detail,
              documentation: item.documentation ? { value: markdownOf(item.documentation) } : undefined,
              kind: monaco.languages.CompletionItemKind[completionKinds[item.kind] ?? "Text"] ?? monaco.languages.CompletionItemKind.Text,
              insertText: edit?.newText ?? item.insertText ?? item.label,
              insertTextRules: item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
              range: edit?.range ? range(edit.range) : edit?.insert ? range(edit.insert) : fallback,
              sortText: item.sortText, filterText: item.filterText,
            };
          }),
        };
      },
    });
    monaco.languages.registerHoverProvider(language, {
      async provideHover(model: any, position: any) {
        const result = await serverOf(model)?.request<any>("textDocument/hover", at(model, position)).catch(() => null);
        const text = result ? markdownOf(result.contents) : "";
        return text ? { contents: [{ value: text }], range: result.range ? range(result.range) : undefined } : null;
      },
    });
    monaco.languages.registerDefinitionProvider(language, {
      async provideDefinition(model: any, position: any) {
        const result = await serverOf(model)?.request<any>("textDocument/definition", at(model, position)).catch(() => null);
        const list: any[] = !result ? [] : Array.isArray(result) ? result : [result];
        return list.map((l) => ({ uri: monaco.Uri.parse(l.targetUri ?? l.uri), range: range(l.targetSelectionRange ?? l.range) }));
      },
    });
  }
  // Snippets where Monaco has no worker, and keywords while no language server serves the file (servers suggest
  // their own).
  for (const [language, words] of Object.entries(languageWords)) {
    monaco.languages.registerCompletionItemProvider(language, {
      provideCompletionItems(model: any, position: any) {
        const served = !!serverOf(model);
        const word = model.getWordUntilPosition(position);
        const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
        const { Keyword, Snippet } = monaco.languages.CompletionItemKind;
        return {
          suggestions: [
            ...(served ? [] : words.keywords.map((keyword) => ({ label: keyword, kind: Keyword, insertText: keyword, range }))),
            ...words.snippets.map((snippet) => ({
              label: snippet.label, kind: Snippet, detail: snippet.detail, documentation: { value: `\`\`\`${language}\n${snippet.body.replace(/\$\{\d+(?::([^}]*)|([^}\d:][^}]*))?\}|\$\d+/g, "$1$2")}\n\`\`\`` },
              insertText: snippet.body, insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet, range,
            })),
          ],
        };
      },
    });
  }
  monaco.languages.registerInlineCompletionsProvider({ pattern: "**" }, {
    async provideInlineCompletions(model: any, position: any, _context: unknown, token: any) {
      const source = inlineSource;
      if (!source) return { items: [] };
      await new Promise((resolve) => setTimeout(resolve, 350));
      if (token.isCancellationRequested) return { items: [] };
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      const offset = model.getOffsetAt(position);
      const text = model.getValue();
      const uri = model.uri.toString();
      try {
        const insert = await source({ uri, name: decodeURIComponent(uri.split("/").pop() ?? ""), language: model.getLanguageId() },
          text.slice(0, offset), text.slice(offset), abort.signal);
        return { items: insert ? [{ insertText: insert, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] : [] };
      } catch {
        return { items: [] };
      }
    },
    disposeInlineCompletions() {},
  });
  monaco.editor.registerEditorOpener({
    openCodeEditor(_source: unknown, resource: any, selection?: any) {
      const line = selection?.startLineNumber ?? selection?.lineNumber ?? 1;
      const column = selection?.startColumn ?? selection?.column ?? 1;
      return opener?.(resource.toString(), line, column) ?? false;
    },
  });
}

// An error or warning in the open file, from any source (built-in TypeScript checks, a language server).
export interface Problem { uri: string; line: number; column: number; message: string; severity: "error" | "warning" | "info"; source: string }
const severityOf = (lsp?: number): Problem["severity"] => (lsp === 1 || lsp === undefined ? "error" : lsp === 2 ? "warning" : "info");
export const problemsOf = (uri: string, diagnostics: LspDiagnostic[]): Problem[] => diagnostics.map((d) => ({
  uri, line: d.range.start.line + 1, column: d.range.start.character + 1, message: d.message, severity: severityOf(d.severity), source: d.source ?? "",
}));

export const languages = [
  ["plaintext", "Plain text"], ["typescript", "TypeScript"], ["javascript", "JavaScript"], ["json", "JSON"], ["css", "CSS"],
  ["html", "HTML"], ["markdown", "Markdown"], ["python", "Python"], ["rust", "Rust"], ["go", "Go"], ["java", "Java"],
  ["c", "C"], ["cpp", "C++"], ["csharp", "C#"], ["yaml", "YAML"], ["shell", "Shell"], ["sql", "SQL"], ["xml", "XML"],
] as const;

const byExtension: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", json: "json",
  css: "css", html: "html", htm: "html", md: "markdown", py: "python", rs: "rust", go: "go", java: "java", c: "c",
  cpp: "cpp", cc: "cpp", h: "cpp", hpp: "cpp", cs: "csharp", yml: "yaml", yaml: "yaml", sh: "shell", sql: "sql", xml: "xml", svg: "xml",
};
export const languageOf = (name: string, override?: string | null) =>
  override || byExtension[name.split(".").pop()?.toLowerCase() ?? ""] || "plaintext";
let converter: CanvasRenderingContext2D | null | undefined;
// Monaco only takes hex colors; the canvas turns any CSS color (even a color-mix) into one.
function hex(value: string, fallback: string): string {
  converter ??= document.createElement("canvas").getContext("2d");
  if (!converter) return fallback;
  converter.fillStyle = "#000";
  converter.fillStyle = value || fallback;
  const result = converter.fillStyle;
  return result.startsWith("#") ? result : fallback;
}
const channel = (color: string, at: number) => Number.parseInt(color.slice(1 + at * 2, 3 + at * 2), 16);
const strip = (color: string) => color.replace("#", "");

export function themeColors() {
  const style = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => hex(style.getPropertyValue(name).trim(), fallback);
  const background = get("--mw-dark", "#1e1e1e");
  return {
    background, text: get("--mw-text", "#dddddd"), muted: get("--mw-text-muted", "#888888"), disabled: get("--mw-text-disabled", "#666666"),
    accent: get("--mw-accent", "#4c8dff"), link: get("--mw-link", "#4c8dff"), success: get("--mw-success", "#3ba55d"),
    warning: get("--mw-warning", "#d9a400"), border: get("--mw-border", "#444444"), darker: get("--mw-darker", "#181818"),
    light: channel(background, 0) * 0.3 + channel(background, 1) * 0.59 + channel(background, 2) * 0.11 > 140,
  };
}

export interface RemoteSelection {
  id: number;
  name: string;
  color: string;
  anchor: number;
  head: number;
}

export interface CodeEditor {
  // `uri`: where the file is in the run folder (file://...), so language servers know it; else an in-memory address.
  openModel(file: { id: number; name: string; language: string | null }, text: Y.Text, readOnly: boolean, uri?: string): void;
  // The open model's address in its canonical form, or null.
  uri(): string | null;
  // Language server diagnostics for a file; shown when it is the open one.
  setDiagnostics(uri: string, diagnostics: LspDiagnostic[]): void;
  // Problems in the open file from every source except language servers (they are kept by the caller).
  ownProblems(): Problem[];
  onProblems(listener: () => void): () => void;
  revealLine(line: number, column: number): void;
  setInline(on: boolean): void;
  // A file edited alone (no live text): Monaco keeps the text and its own undo.
  openPlain(name: string, text: string, readOnly: boolean): void;
  value(): string;
  onChange(listener: () => void): () => void;
  onSave(listener: () => void): void;
  closeModel(): void;
  setLanguage(language: string): void;
  setTheme(): void;
  // Offsets in the open text; null when no file is open.
  selection(): { anchor: number; head: number } | null;
  position(): { line: number; column: number };
  onSelection(listener: () => void): () => void;
  setRemote(selections: RemoteSelection[]): void;
  reveal(offset: number, length?: number): void;
  openFind(): void;
  focus(): void;
  layout(): void;
  dispose(): void;
}

export async function createEditor(element: HTMLElement): Promise<CodeEditor> {
  const { monaco, MonacoBinding } = await load();
  const setTheme = () => {
    const c = themeColors();
    const alpha = (color: string, value: string) => `${color}${value}`;
    monaco.editor.defineTheme("makework", {
      base: c.light ? "vs" : "vs-dark", inherit: true,
      colors: {
        "editor.background": c.background, "editor.foreground": c.text, "editorLineNumber.foreground": c.disabled,
        "editorLineNumber.activeForeground": c.muted, "editorCursor.foreground": c.accent,
        "editor.selectionBackground": alpha(c.accent, "55"), "editor.inactiveSelectionBackground": alpha(c.accent, "33"),
        "editor.lineHighlightBackground": alpha(c.accent, "14"), "editorWidget.background": c.darker, "editorWidget.border": c.border,
        "editorGutter.background": c.background, "minimap.background": c.background, "editorIndentGuide.background1": alpha(c.border, "88"),
        "scrollbarSlider.background": alpha(c.muted, "33"), "scrollbarSlider.hoverBackground": alpha(c.muted, "55"),
      },
      rules: [
        { token: "comment", foreground: strip(c.disabled), fontStyle: "italic" },
        { token: "keyword", foreground: strip(c.accent) },
        { token: "string", foreground: strip(c.success) },
        { token: "number", foreground: strip(c.warning) },
        { token: "type", foreground: strip(c.link) },
        { token: "delimiter", foreground: strip(c.muted) },
      ],
    });
    monaco.editor.setTheme("makework");
  };
  setTheme();
  const root = document.documentElement;
  const themeWatch = new MutationObserver(setTheme);
  themeWatch.observe(root, { attributes: true, attributeFilter: ["style", "data-theme", "class"] });
  const quiet = () => getComputedStyle(root).getPropertyValue("--mw-duration").trim().startsWith("0");
  // Suggestions, hovers and other popups go into the page itself: under the view's slide-in transform their fixed
  // positions would be offset.
  const overflow = document.createElement("div");
  overflow.className = "monaco-editor code-overflow";
  document.body.append(overflow);
  const editor = monaco.editor.create(element, {
    overflowWidgetsDomNode: overflow,
    automaticLayout: true, theme: "makework", minimap: { enabled: true }, scrollBeyondLastLine: false, padding: { top: 8 },
    fontFamily: getComputedStyle(root).getPropertyValue("--mw-font-code"), smoothScrolling: !quiet(), cursorSmoothCaretAnimation: quiet() ? "off" : "on",
    fixedOverflowWidgets: true, fontLigatures: true, inlineSuggest: { enabled: false },
  });
  let model: any;
  let binding: { destroy(): void } | undefined;
  let undo: Y.UndoManager | undefined;
  let text: Y.Text | undefined;
  let remote: string[] = [];
  const styles = document.createElement("style");
  document.head.append(styles);
  const css = (value: string) => value.replace(/["\\\n]/g, "");
  const colorOf = (value: string) => value || "var(--mw-text-muted)";

  editor.addAction({ id: "makework-yjs-undo", label: "Undo", keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ], run: () => (undo ? undo.undo() : editor.trigger("makework", "undo", null)) });
  editor.addAction({
    id: "makework-yjs-redo", label: "Redo",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ],
    run: () => (undo ? undo.redo() : editor.trigger("makework", "redo", null)),
  });

  const closeModel = () => {
    undo?.destroy(); undo = undefined;
    binding?.destroy(); binding = undefined;
    remote = editor.deltaDecorations(remote, []);
    editor.setModel(null);
    model?.dispose(); model = undefined;
    text = undefined;
  };
  const openModel: CodeEditor["openModel"] = (file, ytext, readOnly, uri) => {
    closeModel();
    text = ytext;
    const address = uri ? monaco.Uri.parse(uri) : monaco.Uri.parse(`inmemory://makework/${file.id}/${encodeURIComponent(file.name)}`);
    monaco.editor.getModel(address)?.dispose();
    model = monaco.editor.createModel(ytext.toString(), languageOf(file.name, file.language), address);
    editor.setModel(model);
    editor.updateOptions({ readOnly });
    binding = new MonacoBinding(ytext, model, new Set([editor]), null);
    undo = new Y.UndoManager(ytext, { trackedOrigins: new Set([binding]) });
  };
  const openPlain: CodeEditor["openPlain"] = (name, value, readOnly) => {
    closeModel();
    model = monaco.editor.createModel(value, languageOf(name), monaco.Uri.parse(`inmemory://makework/plain/${Date.now()}/${encodeURIComponent(name)}`));
    editor.setModel(model);
    editor.updateOptions({ readOnly });
  };
  const offsetOf = (point: any) => model.getOffsetAt(point);
  const markerSeverity = (severity: number): Problem["severity"] =>
    severity === monaco.MarkerSeverity.Error ? "error" : severity === monaco.MarkerSeverity.Warning ? "warning" : "info";
  return {
    openModel, openPlain, closeModel, setTheme,
    uri: () => model?.uri.toString() ?? null,
    setDiagnostics(uri, diagnostics) {
      const target = monaco.editor.getModel(monaco.Uri.parse(uri));
      if (!target) return;
      monaco.editor.setModelMarkers(target, "lsp", diagnostics.map((d) => ({
        startLineNumber: d.range.start.line + 1, startColumn: d.range.start.character + 1,
        endLineNumber: d.range.end.line + 1, endColumn: d.range.end.character + 1, message: d.message, source: d.source,
        severity: d.severity === 2 ? monaco.MarkerSeverity.Warning : d.severity === 3 ? monaco.MarkerSeverity.Info
          : d.severity === 4 ? monaco.MarkerSeverity.Hint : monaco.MarkerSeverity.Error,
      })));
    },
    ownProblems() {
      if (!model) return [];
      return monaco.editor.getModelMarkers({ resource: model.uri }).filter((m: any) => m.owner !== "lsp" && m.severity !== monaco.MarkerSeverity.Hint)
        .map((m: any) => ({ uri: model.uri.toString(), line: m.startLineNumber, column: m.startColumn, message: m.message, severity: markerSeverity(m.severity), source: m.source ?? m.owner }));
    },
    onProblems(listener) {
      const subscription = monaco.editor.onDidChangeMarkers(listener);
      return () => subscription.dispose();
    },
    revealLine(line, column) {
      if (!model) return;
      editor.setPosition({ lineNumber: line, column });
      editor.revealPositionInCenter({ lineNumber: line, column });
      editor.focus();
    },
    setInline: (on) => editor.updateOptions({ inlineSuggest: { enabled: on } }),
    value: () => model?.getValue() ?? "",
    onChange(listener) {
      const subscription = editor.onDidChangeModelContent(listener);
      return () => subscription.dispose();
    },
    onSave(listener) {
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, listener);
    },
    setLanguage: (language) => model && monaco.editor.setModelLanguage(model, language),
    selection() {
      const selection = editor.getSelection();
      if (!model || !selection) return null;
      return { anchor: model.getOffsetAt({ lineNumber: selection.selectionStartLineNumber, column: selection.selectionStartColumn }), head: offsetOf(selection.getPosition()) };
    },
    position() {
      const point = editor.getPosition();
      return { line: point?.lineNumber ?? 1, column: point?.column ?? 1 };
    },
    onSelection(listener) {
      const subscription = editor.onDidChangeCursorSelection(listener);
      return () => subscription.dispose();
    },
    setRemote(selections) {
      if (!model || !text) return;
      const rules: string[] = [];
      const decorations = selections.flatMap((who) => {
        const last = model.getValueLength();
        const anchor = Math.min(who.anchor, last), head = Math.min(who.head, last);
        const from = model.getPositionAt(Math.min(anchor, head)), to = model.getPositionAt(Math.max(anchor, head));
        const at = model.getPositionAt(head);
        const color = colorOf(who.color);
        rules.push(
          `.code-remote-${who.id} { background: color-mix(in srgb, ${color} 30%, transparent); }`,
          `.code-caret-${who.id} { border-left: 2px solid ${color}; margin-left: -1px; }`,
          `.code-caret-${who.id}::after { content: "${css(who.name)}"; position: absolute; top: -1.2em; left: -2px; padding: 0 4px; font-size: .75em; line-height: 1.3; white-space: nowrap; pointer-events: none; background: ${color}; color: var(--mw-accent-text, #fff); }`,
        );
        const result: any[] = [{ range: new monaco.Range(at.lineNumber, at.column, at.lineNumber, at.column), options: { afterContentClassName: `code-caret-${who.id}`, stickiness: 1 } }];
        if (anchor !== head) result.unshift({ range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), options: { className: `code-remote-${who.id}`, stickiness: 1 } });
        return result;
      });
      styles.textContent = rules.join("\n");
      remote = editor.deltaDecorations(remote, decorations);
    },
    reveal(offset, length = 0) {
      if (!model) return;
      const from = model.getPositionAt(offset), to = model.getPositionAt(offset + length);
      const range = new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column);
      editor.setSelection(range);
      editor.revealRangeInCenter(range);
      editor.focus();
    },
    openFind: () => editor.getAction("actions.find")?.run(),
    focus: () => editor.focus(),
    layout: () => editor.layout(),
    dispose() {
      themeWatch.disconnect();
      closeModel();
      styles.remove();
      editor.dispose();
      overflow.remove();
    },
  };
}
