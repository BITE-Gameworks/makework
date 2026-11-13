// AI suggestions in the code editor: the text to insert at the caret, from an OpenAI-compatible server (llama.cpp
// and the like, through core/llm.ts) or from Claude. Settings are the code plugin's (settings.ts).
import { llmComplete, llmModels } from "../../../core/llm";
import { codeSecret, codeSetting, defaultClaudeModel } from "./settings";

export type AiProvider = "openai" | "anthropic";

async function claude() {
  const key = await codeSecret("ai.key");
  if (!key) throw new Error("Add a Claude API key in Settings > Plugins > Code.");
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  // The key is the user's own, kept on this device, and only sent to Anthropic.
  return new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
}

export async function aiModels(provider: AiProvider, url: string): Promise<string[]> {
  if (provider === "anthropic") {
    const ids: string[] = [];
    for await (const model of (await claude()).models.list()) ids.push(model.id);
    return ids;
  }
  return llmModels({ baseUrl: url, apiKey: (await codeSecret("ai.key")) ?? undefined });
}

const instructions = "You complete code. You get a file with the marker <CURSOR> where the caret is. Reply with only the text to " +
  "insert at the marker: no explanation, no markdown fences, nothing that is already before or after it. Keep it short " +
  "(at most a few lines). Reply with nothing when no completion makes sense.";

const prompt = (file: string, language: string, before: string, after: string) =>
  `File: ${file} (${language})\n\n${before}<CURSOR>${after}`;

// Fences and a repeated start sometimes come back anyway.
function clean(text: string, before: string): string {
  let result = text.replace(/^```[\w-]*\n?/, "").replace(/\n?```\s*$/, "");
  const lastLine = before.slice(before.lastIndexOf("\n") + 1);
  if (lastLine.trim() && result.startsWith(lastLine)) result = result.slice(lastLine.length);
  return result.trimEnd();
}

export async function suggest(file: string, language: string, before: string, after: string, signal: AbortSignal): Promise<string> {
  const provider = (codeSetting("ai.provider") as AiProvider | undefined) ?? "openai";
  const model = codeSetting("ai.model") as string | undefined;
  const head = before.slice(-6000), tail = after.slice(0, 2000);
  if (provider === "anthropic") {
    const response = await (await claude()).messages.create({
      model: model || defaultClaudeModel,
      max_tokens: 1024,
      output_config: { effort: "low" },
      system: instructions,
      messages: [{ role: "user", content: prompt(file, language, head, tail) }],
    }, { signal });
    if (response.stop_reason === "refusal") return "";
    const text = response.content.map((block) => (block.type === "text" ? block.text : "")).join("");
    return clean(text, head);
  }
  const reply = await llmComplete(
    { baseUrl: String(codeSetting("ai.url") ?? ""), apiKey: (await codeSecret("ai.key")) ?? undefined, model },
    [{ role: "system", content: instructions }, { role: "user", content: prompt(file, language, head, tail) }],
    { maxTokens: 128, temperature: 0.2, signal },
  );
  return clean(reply.text, head);
}
