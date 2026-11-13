// Renders markdown as elements through JSX, never innerHTML, so text can't inject markup. Links are
// limited to http(s), mailto and makework:// (shown as link chips). Images stored in the app (mwc:) show right away;
// images from the web wait for a click, since loading them tells whoever hosts them who read the text.
import { For, Index, Match, Show, Switch, createContext, createEffect, createSignal, useContext, type JSX } from "solid-js";
import { contentUrl } from "../core/content";
import { customEmojiName, splitEmoji } from "./emoji";
import { customEmojiByName, customEmojiSrc, loadCustomEmoji } from "../core/customEmoji";
import { highlight } from "./highlight";
import { parseBlocks, type Block } from "./parse";
import "./markdown.css";
import { isLink, linkMenu, parseLink } from "../core/links";
import { openContextMenu } from "../ui/contextMenu";
import LinkChip from "../ui/LinkChip";
import ExportEmbed from "../ui/ExportEmbed";
import { trimEnd } from "../core/text";

// Shortcodes come first so their underscores are never read as italics.
const inline = new RegExp([
  String.raw`(:[a-z0-9_+-]+:)`,
  String.raw`(\x60[^\x60\n]+\x60)`,
  String.raw`(!?\[[^\]\n]*\]\((?:https?:\/\/|mailto:|makework:\/\/|mwc:)(?:[^\s()]|\([^\s()]*\))+\))`,
  String.raw`(<@\d+>|(?<![\w@.])@[a-z0-9._]*[a-z0-9_])`,
  String.raw`(\*\*\*[^*\n]+\*\*\*|___[^_\n]+___)`,
  String.raw`(\*\*[^*\n]+\*\*|__[^_\n]+__)`,
  String.raw`(~~[^~\n]+~~)`,
  String.raw`(\*[^*\n]+\*|(?<![\w:])_[^_\n]+_(?![\w:]))`,
  String.raw`((?:https?|makework):\/\/(?:[^\s<>()]|\([^\s<>()]*\))*(?:[^\s<>().,;:!?'"]|\([^\s<>()]*\)))`,
].join("|"), "g");

const linkParts = /^!?\[([^\]]*)\]\(((?:[^\s()]|\([^\s()]*\))+)\)$/;

// Finds who a mention names, so it shows their display name: a member id (<@id>), or an @username from before
// mentions by id. `group` is @everyone, @here or a role, shown in the role's color.
// `openMenu` opens the member's right-click menu for a mention of a member.
export type MentionLookup = (who: string | number) => { name: string; me: boolean; group?: boolean; color?: string; openMenu?: (event: MouseEvent) => void } | undefined;
const Mentions = createContext<MentionLookup>();

function Mention(props: { text: string }) {
  const who = () => useContext(Mentions)?.(props.text.startsWith("<@") ? Number(props.text.slice(2, -1)) : props.text.slice(1).toLowerCase());
  return (
    <Show when={who()} fallback={props.text}>
      {(w) => (
        <span class="md-mention" classList={{ me: w().me, group: !!w().group }} title={props.text}
          onContextMenu={(e) => { if (w().openMenu) { e.preventDefault(); e.stopPropagation(); w().openMenu!(e); } }}
          style={w().color ? { "--mention-color": w().color } : undefined}>@{w().name}</span>
      )}
    </Show>
  );
}

export function renderInline(text: string, breaks = true, workspaceId?: string): JSX.Element[] {
  const out: JSX.Element[] = [];
  let last = 0;
  for (const match of text.matchAll(inline)) {
    if (match.index > last) out.push(...renderText(text.slice(last, match.index), breaks, workspaceId));
    const [whole, shortcode, code, link, mention, boldItalic, bold, strike, italic, url] = match;
    if (shortcode) out.push(...renderText(shortcode, breaks, workspaceId));
    else if (code) out.push(<code class="md-inline-code">{code.slice(1, -1)}</code>);
    else if (link) {
      const [, label, href] = linkParts.exec(link)!;
      const parsed = isLink(href) ? parseLink(href) : null;
      if (link.startsWith("!") && parsed?.target?.kind === "export") out.push(<ExportEmbed url={href} label={label} />);
      else if (link.startsWith("!") && (href.startsWith("mwc:") || /^https?:\/\//.test(href))) out.push(<MdImage url={href} alt={label} />);
      else if (href.startsWith("mwc:")) out.push(...renderText(link, breaks, workspaceId));
      else if (isLink(href)) out.push(<LinkChip url={href} label={label} />);
      else out.push(<a href={href} target="_blank" rel="noopener noreferrer" title={href} onContextMenu={(e) => openContextMenu(e, linkMenu(href))}>{label ? renderInline(label, breaks, workspaceId) : href}</a>);
    } else if (mention) out.push(<Mention text={mention} />);
    else if (boldItalic) out.push(<strong><em>{renderInline(boldItalic.slice(3, -3), breaks, workspaceId)}</em></strong>);
    else if (bold) out.push(<strong>{renderInline(bold.slice(2, -2), breaks, workspaceId)}</strong>);
    else if (strike) out.push(<s>{renderInline(strike.slice(2, -2), breaks, workspaceId)}</s>);
    else if (italic) out.push(<em>{renderInline(italic.slice(1, -1), breaks, workspaceId)}</em>);
    else if (url && isLink(url)) out.push(<LinkChip url={url} />);
    else if (url) out.push(<a href={url} target="_blank" rel="noopener noreferrer" onContextMenu={(e) => openContextMenu(e, linkMenu(url))}>{url}</a>);
    last = match.index + whole.length;
  }
  if (last < text.length) out.push(...renderText(text.slice(last), breaks, workspaceId));
  return out;
}

function MdImage(props: { url: string; alt: string }) {
  const stored = props.url.startsWith("mwc:");
  const [load, setLoad] = createSignal(stored);
  const src = () => (stored ? contentUrl(props.url) : props.url);
  const host = () => {
    try {
      return new URL(props.url).host;
    } catch {
      return props.url;
    }
  };
  return (
    <Show when={load()} fallback={
      <button class="md-image-ask mw-box" title={props.url} onClick={() => setLoad(true)}>Show image{props.alt ? ` "${props.alt}"` : ""} from {host()}</button>
    }>
      <Show when={src()} fallback={<span class="md-image-wait mw-box">{props.alt || "Image"} is on its way...</span>}>
        <img class="md-image mw-box" src={src()!} alt={props.alt} title={props.alt || undefined} referrerPolicy="no-referrer" loading="lazy" />
      </Show>
    </Show>
  );
}

function renderText(text: string, breaks: boolean, workspaceId?: string): JSX.Element[] {
  const out: JSX.Element[] = [];
  // Every name that could be a workspace emoji is parsed as one; the view falls back to its shortcode until the
  // workspace's list (or the image) arrives, so an unknown :word: still shows as text.
  const custom = workspaceId ? (name: string) => customEmojiName.test(name) : undefined;
  for (const part of splitEmoji(text, custom)) {
    if ("emoji" in part) {
      out.push(<span class="md-emoji" title={`:${part.code}:`}>{part.emoji}</span>);
      continue;
    }
    if ("custom" in part) {
      out.push(<CustomEmojiImage name={part.custom} workspaceId={workspaceId!} />);
      continue;
    }
    part.text.split("\n").forEach((line, i) => {
      if (i > 0) out.push(breaks ? <br /> : " ");
      if (line) out.push(line);
    });
  }
  return out;
}

function CustomEmojiImage(props: { name: string; workspaceId: string }) {
  createEffect(() => { void loadCustomEmoji(props.workspaceId); });
  const row = () => customEmojiByName(props.workspaceId, props.name);
  return (
    <Show when={row()} fallback={`:${props.name}:`}>
      {(emoji) => (
        <Show when={customEmojiSrc(emoji())} fallback={`:${props.name}:`}>
          {(src) => <img class="md-emoji md-emoji-custom" src={src()} alt={`:${props.name}:`} title={`:${props.name}:`} loading="lazy" />}
        </Show>
      )}
    </Show>
  );
}

export function CodeBlock(props: { code: string; lang?: string }) {
  return (
    <pre class="md-code mw-box" data-lang={props.lang || undefined}>
      <code>
        <For each={highlight(props.code)}>
          {(token) => (token.kind === "plain" ? token.text : <span class={`tok-${token.kind}`}>{token.text}</span>)}
        </For>
      </code>
    </pre>
  );
}

// breaks: every newline is a line break (chat). Otherwise only lines ending in two spaces or a backslash
// break, as in documents.
function paragraphText(lines: string[], breaks: boolean): string {
  if (breaks) return lines.join("\n");
  return lines.map((l, i) => {
    const broken = i < lines.length - 1 ? hardBreak(l) : null;
    return broken === null ? l + " " : broken + "\n";
  }).join("").trim();
}

// A line that ends in a backslash or two spaces, without them; null for a line that doesn't break.
function hardBreak(line: string): string | null {
  if (line.endsWith("\\")) return line.slice(0, -1);
  return line.endsWith("  ") ? trimEnd(line, " ") : null;
}

function BlockView(props: { block: Block; breaks: boolean; workspaceId?: string; tight?: boolean }): JSX.Element {
  const b = props.block;
  switch (b.type) {
    case "code":
      return <CodeBlock code={b.code} lang={b.lang} />;
    case "heading": {
      const content = renderInline(b.text, props.breaks, props.workspaceId);
      return (
        <Switch>
          <Match when={b.level === 1}><h1>{content}</h1></Match>
          <Match when={b.level === 2}><h2>{content}</h2></Match>
          <Match when={b.level === 3}><h3>{content}</h3></Match>
          <Match when={b.level === 4}><h4>{content}</h4></Match>
          <Match when={b.level === 5}><h5>{content}</h5></Match>
          <Match when={true}><h6>{content}</h6></Match>
        </Switch>
      );
    }
    case "hr":
      return <hr />;
    case "quote":
      return <blockquote><Blocks blocks={b.children} breaks={props.breaks} workspaceId={props.workspaceId} /></blockquote>;
    case "list": {
      const items = (
        <Index each={b.items}>
          {(item) => <li><Blocks blocks={item()} breaks={props.breaks} workspaceId={props.workspaceId} tight /></li>}
        </Index>
      );
      return b.ordered ? <ol start={b.start}>{items}</ol> : <ul>{items}</ul>;
    }
    case "table":
      return (
        <div class="md-table-wrap">
          <table class="md-table">
            <thead>
              <tr><Index each={b.head}>{(cell, i) => <th style={{ "text-align": b.align[i] ?? undefined }}>{renderInline(cell(), props.breaks, props.workspaceId)}</th>}</Index></tr>
            </thead>
            <tbody>
              <Index each={b.rows}>
                {(row) => (
                  <tr><Index each={b.head}>{(_, i) => <td style={{ "text-align": b.align[i] ?? undefined }}>{renderInline(row()[i] ?? "", props.breaks, props.workspaceId)}</td>}</Index></tr>
                )}
              </Index>
            </tbody>
          </table>
        </div>
      );
    case "paragraph": {
      const content = renderInline(paragraphText(b.lines, props.breaks), props.breaks, props.workspaceId);
      return props.tight ? <div class="md-tight">{content}</div> : <p>{content}</p>;
    }
  }
}

// Paragraphs in list items render without paragraph spacing.
function Blocks(props: { blocks: Block[]; breaks: boolean; workspaceId?: string; tight?: boolean }) {
  return <For each={props.blocks}>{(block) => <BlockView block={block} breaks={props.breaks} workspaceId={props.workspaceId} tight={props.tight} />}</For>;
}

export default function Markdown(props: { source: string; breaks?: boolean; class?: string; mentions?: MentionLookup; workspaceId?: string }) {
  return (
    <div class={`md ${props.class ?? ""}`}>
      <Mentions.Provider value={props.mentions}>
        <Blocks blocks={parseBlocks(props.source)} breaks={props.breaks ?? false} workspaceId={props.workspaceId} />
      </Mentions.Provider>
    </div>
  );
}
