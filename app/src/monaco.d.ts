// Monaco's full editor ships without types of its own; it exports the same API as editor.api.
declare module "monaco-editor/editor/editor.main" {
  export * from "monaco-editor/editor/editor.api";
}
