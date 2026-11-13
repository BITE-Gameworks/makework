import { Show, createSignal } from "solid-js";
import Skeleton from "../ui/Skeleton";
import Markdown from "../markdown/Markdown";
import type { FileContext } from "../plugins/types";
import { createText } from "./content";
import { CodeView } from "./TextViewer";

export default function MarkdownViewer(props: { file: FileContext }) {
  const text = createText(props.file);
  const [source, setSource] = createSignal(false);
  return (
    <Show when={text() !== undefined} fallback={<Skeleton kind="document" header={false} />}>
      <div class="markdown-viewer">
        <div class="viewer-toolbar mw-box">
          <button class="mw-button mw-box" classList={{ active: !source() }} onClick={() => setSource(false)}>Rendered</button>
          <button class="mw-button mw-box" classList={{ active: source() }} onClick={() => setSource(true)}>Source</button>
        </div>
        <Show when={source()} fallback={
          <div class="markdown-scroll mw-scroll-fade mw-fade-in"><Markdown source={text()!} class="markdown-document" /></div>
        }>
          <div class="markdown-source mw-fade-in"><CodeView text={text()!} name={props.file.name} highlight={false} /></div>
        </Show>
      </div>
    </Show>
  );
}
