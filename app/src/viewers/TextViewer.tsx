// Code and plain text with line numbers. Highlighting is on for known code extensions.
import Skeleton from "../ui/Skeleton";
import { For, Show, createMemo, createSignal } from "solid-js";
import { highlight, type Token } from "../markdown/highlight";
import type { FileContext } from "../plugins/types";
import { createText } from "./content";

const maxLines = 20_000;
const plainExtensions = new Set(["txt", "log", "csv", "tsv", "text", ""]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function splitLines(tokens: Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const token of tokens) {
    const parts = token.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) lines.at(-1)!.push({ kind: token.kind, text: part });
    });
  }
  return lines;
}

export function CodeView(props: { text: string; name: string; highlight?: boolean }) {
  const [wrap, setWrap] = createSignal(false);
  const lines = createMemo(() => {
    const all = props.text.split("\n");
    const truncated = all.length > maxLines;
    const text = truncated ? all.slice(0, maxLines).join("\n") : props.text;
    const tokens = props.highlight ? highlight(text) : [{ kind: "plain" as const, text }];
    return { lines: splitLines(tokens), truncated, total: all.length };
  });

  return (
    <div class="text-viewer">
      <div class="viewer-toolbar mw-box">
        <span class="muted">{lines().total.toLocaleString()} lines</span>
        <label class="toggle">
          <input type="checkbox" checked={wrap()} onChange={(e) => setWrap(e.currentTarget.checked)} /> Wrap lines
        </label>
      </div>
      <Show when={lines().truncated}>
        <p class="viewer-note-inline warning">Showing the first {maxLines.toLocaleString()} lines. Download the file to see all of it.</p>
      </Show>
      <div class="text-scroll mw-scroll-fade">
        <div class="text-lines" classList={{ wrap: wrap() }}>
          <For each={lines().lines}>
            {(line, i) => (
              <div class="text-line">
                <span class="text-number">{i() + 1}</span>
                <code>
                  <For each={line}>{(t) => (t.kind === "plain" ? t.text : <span class={`tok-${t.kind}`}>{t.text}</span>)}</For>
                </code>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

export default function TextViewer(props: { file: FileContext }) {
  const text = createText(props.file);
  return (
    <Show when={text() !== undefined} fallback={<Skeleton kind="document" header={false} />}>
      <CodeView text={text()!} name={props.file.name} highlight={!plainExtensions.has(extensionOf(props.file.name))} />
    </Show>
  );
}
