// Pulsing blocks in the shape of a view while its data loads, so the place doesn't jump when it arrives. A channel
// type names its shape (`loader` in its ChannelTypeInfo); anything else gets the generic one.
import { For, Index, Match, Switch } from "solid-js";
import "./Skeleton.css";

// "line": one line of text inside a panel (the share quality's live numbers), not a whole view.
export type SkeletonKind = "messages" | "board" | "grid" | "canvas" | "list" | "document" | "pages" | "voice" | "line" | "generic";

const kinds: ReadonlySet<SkeletonKind> = new Set(["messages", "board", "grid", "canvas", "list", "document", "pages", "voice", "line", "generic"]);

const paragraphs = [96, 88, 92, 60, 0, 94, 85, 70];
export const skeletonKind = (value: string | undefined): SkeletonKind =>
  kinds.has(value as SkeletonKind) ? (value as SkeletonKind) : "generic";

const messageRows = [[62, 88], [40], [75, 55, 30], [50], [68, 80], [35], [58, 72]];
const delay = (i: number) => ({ "--delay": `${i * 80}ms` });

export default function Skeleton(props: { kind?: SkeletonKind; header?: boolean }) {
  return (
    <div class="skeleton-view" data-kind={props.kind ?? "generic"} aria-hidden="true">
      {props.header !== false && props.kind && props.kind !== "generic" && props.kind !== "line" && (
        <div class="skeleton-header">
          <span class="skeleton skeleton-icon" />
          <span class="skeleton skeleton-title" />
        </div>
      )}
      <Switch fallback={<Generic />}>
        <Match when={props.kind === "line"}>
          <span class="skeleton skeleton-line" />
        </Match>
        <Match when={props.kind === "messages"}>
          <div class="skeleton-rows">
            <Index each={messageRows}>
              {(lines, i) => (
                <div class="skeleton-message" style={delay(i)}>
                  <span class="skeleton skeleton-avatar" />
                  <div class="skeleton-lines">
                    <span class="skeleton skeleton-name" />
                    <For each={lines()}>{(width) => <span class="skeleton skeleton-line" style={{ width: `${width}%` }} />}</For>
                  </div>
                </div>
              )}
            </Index>
          </div>
        </Match>
        <Match when={props.kind === "board"}>
          <div class="skeleton-columns">
            <Index each={[4, 2, 3]}>
              {(cards, i) => (
                <div class="skeleton-column" style={delay(i)}>
                  <span class="skeleton skeleton-name" />
                  <Index each={Array.from({ length: cards() })}>{() => <span class="skeleton skeleton-card" />}</Index>
                </div>
              )}
            </Index>
          </div>
        </Match>
        <Match when={props.kind === "grid"}>
          <div class="skeleton-grid">
            <Index each={Array.from({ length: 12 })}>{(_, i) => <span class="skeleton skeleton-tile" style={delay(i % 6)} />}</Index>
          </div>
        </Match>
        <Match when={props.kind === "canvas"}>
          <div class="skeleton-canvas">
            <span class="skeleton skeleton-side" />
            <span class="skeleton skeleton-board" style={delay(1)} />
            <span class="skeleton skeleton-side" style={delay(2)} />
          </div>
        </Match>
        <Match when={props.kind === "list"}>
          <div class="skeleton-rows">
            <Index each={[70, 55, 80, 45, 65, 50, 75, 60]}>
              {(width, i) => (
                <div class="skeleton-list-row" style={delay(i)}>
                  <span class="skeleton skeleton-dot" />
                  <span class="skeleton skeleton-line" style={{ width: `${width()}%` }} />
                </div>
              )}
            </Index>
          </div>
        </Match>
        <Match when={props.kind === "document"}><Document /></Match>
        <Match when={props.kind === "pages"}>
          <div class="skeleton-pages">
            <div class="skeleton-tree">
              <Index each={[80, 65, 70, 55, 75]}>
                {(width, i) => <span class="skeleton skeleton-line" style={{ width: `${width()}%`, "margin-left": i % 3 === 2 ? "16px" : undefined, ...delay(i) }} />}
              </Index>
            </div>
            <Document />
          </div>
        </Match>
        <Match when={props.kind === "voice"}>
          <div class="skeleton-tiles">
            <Index each={Array.from({ length: 4 })}>{(_, i) => <span class="skeleton skeleton-voice-tile" style={delay(i)} />}</Index>
          </div>
        </Match>
      </Switch>
    </div>
  );
}

function Document() {
  return (
    <div class="skeleton-document">
      <span class="skeleton skeleton-heading" />
      <Index each={paragraphs}>
        {(width, i) => (width() ? <span class="skeleton skeleton-line" style={{ width: `${width()}%`, ...delay(i) }} /> : <span class="skeleton-gap" />)}
      </Index>
    </div>
  );
}

// Nothing known about the view: a large spinner in the middle.
function Generic() {
  return (
    <div class="skeleton-generic">
      <span class="mw-spinner" />
    </div>
  );
}
