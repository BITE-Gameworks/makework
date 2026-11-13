// The code plugin's settings (Settings > Plugins > Code), kept on this device.
import { localServerUrl } from "../../../core/llm";
import { pluginSecret, pluginSetting } from "../../settings";
import { aiModels } from "./ai";
import InstalledServers from "./InstalledServers";
import type { PluginSetting } from "../../types";

const pluginId = "makework.code";
export const codeSetting = (key: string) => pluginSetting(pluginId, key);
export const codeSecret = (key: string) => pluginSecret(pluginId, key);
export const defaultClaudeModel = "claude-opus-5-5";

// Language servers by id (electron/codeTools.js `languageServers`) with the Monaco languages they serve.
export const serverLanguages: Record<string, { label: string; command: string; languages: string[] }> = {
  python: { label: "Python", command: "pyright-langserver", languages: ["python"] },
  rust: { label: "Rust", command: "rust-analyzer", languages: ["rust"] },
  go: { label: "Go", command: "gopls", languages: ["go"] },
  c: { label: "C and C++", command: "clangd", languages: ["c", "cpp"] },
  java: { label: "Java", command: "jdtls", languages: ["java"] },
  csharp: { label: "C#", command: "csharp-ls", languages: ["csharp"] },
  shell: { label: "Shell", command: "bash-language-server", languages: ["shell"] },
};
export const serverFor = (language: string) => Object.keys(serverLanguages).find((id) => serverLanguages[id].languages.includes(language));

const lspOn = (value: (key: string) => unknown) => value("lsp") !== false;
const aiOn = (value: (key: string) => unknown) => value("ai") === true;
const provider = (value: (key: string) => unknown) => (value("ai.provider") as string | undefined) ?? "openai";

export const codeSettings: PluginSetting[] = [
  { type: "heading", key: "lsp.heading", label: "Language servers", desktop: true },
  {
    type: "toggle", key: "lsp", label: "Use language servers", default: true, desktop: true,
    hint: "Errors, completion, hover and go to definition from servers on this computer or downloaded by the app. TypeScript, JavaScript, JSON, CSS and HTML need none.",
  },
  {
    type: "custom", key: "lsp.installed", label: "Downloaded by the app", desktop: true, when: lspOn, render: InstalledServers,
    hint: "A missing server can also be installed from the Problems panel.",
  },
  ...Object.entries(serverLanguages).map(([id, server]): PluginSetting => ({
    type: "text", key: `lsp.${id}`, label: `${server.label} server`, desktop: true, when: lspOn,
    placeholder: `${server.command} (found on PATH)`,
  })),
  { type: "heading", key: "ai.heading", label: "AI suggestions" },
  { type: "toggle", key: "ai", label: "Suggest code while typing", default: false, hint: "Tab takes a suggestion. The open file is sent to the model." },
  {
    type: "select", key: "ai.provider", label: "Model from", default: "openai", when: aiOn,
    options: [{ value: "openai", label: "An OpenAI-compatible server (llama.cpp, ...)" }, { value: "anthropic", label: "Claude (Anthropic API)" }],
  },
  {
    type: "text", key: "ai.url", label: "Server address", when: (value) => aiOn(value) && provider(value) === "openai",
    placeholder: localServerUrl,
  },
  {
    type: "secret", key: "ai.key", label: "API key", when: aiOn,
    hint: "Needed for Claude; optional for other servers.",
  },
  {
    type: "suggest", key: "ai.model", label: "Model", when: aiOn, dependsOn: ["ai.provider", "ai.url"],
    placeholder: "The server's default", hint: `With Claude, empty uses ${defaultClaudeModel}.`,
    suggest: (value) => aiModels(provider(value) === "anthropic" ? "anthropic" : "openai", String(value("ai.url") ?? "")),
  },
  { type: "heading", key: "terminal.heading", label: "Terminal", desktop: true },
  { type: "text", key: "terminal.shell", label: "Shell", desktop: true, placeholder: "The system's shell", hint: "The program terminals and Run use, e.g. /bin/zsh or pwsh." },
];
