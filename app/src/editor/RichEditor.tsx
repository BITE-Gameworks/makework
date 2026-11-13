// A formatting editor that reads and writes markdown, so nobody has to type markdown by hand (typed
// markdown still works). Toolbar and shortcuts for bold, italic, strike, code, links, lists, quotes and
// code blocks; "- ", "1. ", "> " and "```" start blocks; # opens the link picker for channels and objects,
// @ the member picker. The markdown button swaps to a plain text box showing the markdown itself.
import { narrow } from "../core/ui";
import { For, Show, createEffect, createRenderEffect, createRoot, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { appLink, isLink, linkMenu, openLink, parseLink, resolveLink } from "../core/links";
import { openContextMenu } from "../ui/contextMenu";
import { iconUrl, Icon } from "../theme/icons";
import LinkPicker, { type Pick } from "./LinkPicker";
import CommandPicker from "./CommandPicker";
import MentionPicker from "./MentionPicker";
import { member } from "../core/members";
import { markdownMode, setMarkdownMode } from "./mode";
import { inlineNodes, markdownToNodes, nodesToMarkdown } from "./markdownDom";
import "./editor.css";

export interface EditorApi {
  focus(atEnd?: boolean): void;
  clear(): void;
  markdown(): string;
  setMarkdown(markdown: string): void;
  insertText(text: string): void;
  insertLink(url: string, title?: string): void;
}

type Format = "bold" | "italic" | "strike" | "code" | "ul" | "ol" | "quote" | "pre";

const tools: { format: Format; icon: string; label: string; keys?: string }[] = [
  { format: "bold", icon: "format-bold", label: "Bold", keys: "Ctrl+B" },
  { format: "italic", icon: "format-italic", label: "Italic", keys: "Ctrl+I" },
  { format: "strike", icon: "format-strike", label: "Strikethrough", keys: "Ctrl+Shift+X" },
  { format: "code", icon: "format-code", label: "Inline code", keys: "Ctrl+E" },
  { format: "ul", icon: "format-list", label: "Bulleted list", keys: "Ctrl+Shift+8" },
  { format: "ol", icon: "format-list-ordered", label: "Numbered list", keys: "Ctrl+Shift+7" },
  { format: "quote", icon: "format-quote", label: "Quote", keys: "Ctrl+Shift+9" },
  { format: "pre", icon: "format-code-block", label: "Code block", keys: "Ctrl+Shift+C" },
];

export default function RichEditor(props: {
  workspaceId: string;
  value?: string;
  placeholder?: string;
  // When set, Enter sends (Shift+Enter, lists and code blocks make new lines; Ctrl+Enter always sends).
  onSubmit?: (markdown: string) => void;
  onInput?: (markdown: string) => void;
  onBlur?: (markdown: string) => void;
  onPasteFiles?: (files: File[]) => void;
  onKeyDown?: (e: KeyboardEvent) => void;
  ref?: (api: EditorApi) => void;
  toolbar?: boolean;
  // Extra buttons at the end of the toolbar row (attach, emoji, ...).
  actions?: JSX.Element;
  class?: string;
  minRows?: number;
}) {
  const [formatting, setFormatting] = createSignal(false);
  let root!: HTMLDivElement;
  let savedRange: Range | null = null;
  const chipRoots = new Set<() => void>();
  const [empty, setEmpty] = createSignal(true);
  const [active, setActive] = createSignal<Set<Format>>(new Set());
  const [focused, setFocused] = createSignal(false);
  // # typed in the text, or the toolbar's link button.
  const [picker, setPicker] = createSignal<{ at: { x: number; top: number; bottom: number }; query?: string } | null>(null);
  let pickerKeys: ((e: KeyboardEvent) => boolean) | null = null;
  let hashRange: Range | null = null;
  // @ typed in the text.
  const [mention, setMention] = createSignal<{ at: { x: number; top: number; bottom: number }; query: string } | null>(null);
  let mentionKeys: ((e: KeyboardEvent) => boolean) | null = null;
  let mentionRange: Range | null = null;
  // "/" typed after an @mentioned bot.
  const [command, setCommand] = createSignal<{ at: { x: number; top: number; bottom: number }; query: string; bots: number[] } | null>(null);
  let commandKeys: ((e: KeyboardEvent) => boolean) | null = null;
  let commandRange: Range | null = null;
  let raw!: HTMLTextAreaElement;

  const chip = (url: string, label: string, embed = false): HTMLElement => {
    if (url.startsWith("mention:")) return mentionChip(Number(url.slice(8)));
    const span = document.createElement("span");
    span.className = "mw-link-chip mw-box";
    span.contentEditable = "false";
    span.dataset.href = url;
    if (embed) span.dataset.embed = "image";
    const icon = document.createElement("span");
    icon.className = "mw-icon";
    const text = document.createElement("span");
    text.className = "mw-link-chip-title";
    text.textContent = label || "...";
    span.append(icon, text);
    // Shows the object's current name; disposed with the editor content.
    createRoot((dispose) => {
      chipRoots.add(dispose);
      const info = resolveLink(url);
      const update = () => {
        const i = info();
        icon.style.setProperty("--mw-icon", `url("${iconUrl(i?.icon ?? "channel-other")}")`);
        if (i && !i.missing) text.textContent = i.title;
        span.classList.toggle("missing", !!i?.missing);
      };
      createRenderEffect(update);
    });
    return span;
  };

  // A member mention: stored as <@id>, shown with the member's current name.
  const mentionChip = (id: number): HTMLElement => {
    const span = document.createElement("span");
    span.className = "md-mention mw-mention-chip";
    span.contentEditable = "false";
    span.dataset.mention = String(id);
    createRoot((dispose) => {
      chipRoots.add(dispose);
      createRenderEffect(() => (span.textContent = `@${member(props.workspaceId, id).displayName}`));
    });
    return span;
  };

  const markdown = () => (markdownMode() ? raw.value : nodesToMarkdown(root));
  const fitRaw = () => {
    raw.style.height = "auto";
    raw.style.height = `${raw.scrollHeight}px`;
  };
  const changed = () => {
    if (markdownMode()) {
      setEmpty(!raw.value.trim());
      fitRaw();
    } else setEmpty(!root.textContent?.trim() && !root.querySelector("[data-href], [data-mention], li, pre, blockquote"));
    props.onInput?.(markdown());
  };
  const disposeChips = () => {
    chipRoots.forEach((d) => d());
    chipRoots.clear();
  };
  const setMarkdown = (md: string) => {
    if (markdownMode()) raw.value = md;
    else {
      disposeChips();
      root.replaceChildren(...markdownToNodes(md, chip));
    }
    changed();
  };
  // Carries the text over when the mode changes.
  createEffect(on(markdownMode, (isOn, wasOn) => {
    if (wasOn === undefined) return;
    if (isOn) {
      raw.value = nodesToMarkdown(root);
      disposeChips();
      root.replaceChildren();
    } else root.replaceChildren(...markdownToNodes(raw.value, chip));
    setPicker(null);
    setMention(null); setCommand(null);
    changed();
  }, { defer: false }));
  const focusEnd = (atEnd = false) => {
    const el = markdownMode() ? raw : root;
    el.focus();
    if (!atEnd) return;
    if (el === raw) raw.setSelectionRange(raw.value.length, raw.value.length);
    else {
      getSelection()?.selectAllChildren(root);
      getSelection()?.collapseToEnd();
    }
  };

  const selectionInside = () => {
    const sel = getSelection();
    return sel && sel.rangeCount > 0 && root.contains(sel.getRangeAt(0).commonAncestorContainer) ? sel.getRangeAt(0) : null;
  };
  const closest = (tag: string) => {
    const range = selectionInside();
    let node: Node | null = range?.startContainer ?? null;
    while (node && node !== root) {
      if (node.nodeName === tag) return node as HTMLElement;
      node = node.parentNode;
    }
    return null;
  };
  const refreshActive = () => {
    if (!selectionInside()) return;
    const on = new Set<Format>();
    if (document.queryCommandState("bold")) on.add("bold");
    if (document.queryCommandState("italic")) on.add("italic");
    if (document.queryCommandState("strikeThrough")) on.add("strike");
    if (closest("CODE")) on.add("code");
    if (closest("UL")) on.add("ul");
    if (closest("OL")) on.add("ol");
    if (closest("BLOCKQUOTE")) on.add("quote");
    if (closest("PRE")) on.add("pre");
    setActive(on);
  };

  const toggleInlineCode = () => {
    const existing = closest("CODE");
    if (existing) {
      existing.replaceWith(...existing.childNodes);
      return;
    }
    const range = selectionInside();
    if (!range) return;
    const code = document.createElement("code");
    if (range.collapsed) code.append("​");
    else code.append(range.extractContents());
    range.insertNode(code);
    const sel = getSelection()!;
    sel.selectAllChildren(code);
    if (code.textContent === "​") sel.collapseToEnd();
  };

  const toggleBlock = (tag: "BLOCKQUOTE" | "PRE") => {
    document.execCommand("formatBlock", false, closest(tag) ? "div" : tag.toLowerCase());
  };

  const apply = (format: Format) => {
    root.focus();
    if (savedRange && !selectionInside()) {
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(savedRange);
    }
    switch (format) {
      case "bold": document.execCommand("bold"); break;
      case "italic": document.execCommand("italic"); break;
      case "strike": document.execCommand("strikeThrough"); break;
      case "code": toggleInlineCode(); break;
      case "ul": document.execCommand("insertUnorderedList"); break;
      case "ol": document.execCommand("insertOrderedList"); break;
      case "quote": toggleBlock("BLOCKQUOTE"); break;
      case "pre": toggleBlock("PRE"); break;
    }
    changed();
    refreshActive();
  };

  const insertNodeAtCaret = (node: Node, range = selectionInside()) => {
    if (!range) {
      root.append(node);
      return;
    }
    range.deleteContents();
    range.insertNode(node);
    const space = document.createTextNode(" ");
    node.parentNode!.insertBefore(space, node.nextSibling);
    const sel = getSelection()!;
    sel.removeAllRanges();
    const after = document.createRange();
    after.setStart(space, 1);
    sel.addRange(after);
  };

  const insertLink = (pasted: string, title = "") => {
    const url = appLink(pasted);
    if (markdownMode()) {
      raw.focus();
      const label = (title || url).replace(/[[\]]/g, "");
      const embed = parseLink(url)?.target?.kind === "export";
      document.execCommand("insertText", false, isLink(url) ? `${embed ? "!" : ""}[${label}](${url})` : title ? `[${label}](${url})` : url);
      changed();
      return;
    }
    root.focus();
    if (isLink(url)) insertNodeAtCaret(chip(url, title, parseLink(url)?.target?.kind === "export"));
    else {
      const range = selectionInside();
      const a = document.createElement("a");
      a.setAttribute("href", url);
      a.append(range && !range.collapsed ? range.extractContents() : document.createTextNode(title || url));
      insertNodeAtCaret(a, range);
    }
    changed();
  };

  const pick = (choice: Pick) => {
    if (markdownMode()) {
      setPicker(null);
      insertLink(choice.url, choice.external ? "" : choice.title);
      return;
    }
    const range = hashRange;
    setPicker(null);
    hashRange = null;
    root.focus();
    const sel = getSelection()!;
    sel.removeAllRanges();
    if (range) sel.addRange(range);
    else if (savedRange) sel.addRange(savedRange);
    insertLink(choice.url, choice.external ? "" : choice.title);
  };

  // The word typed after a trigger character (# or @) at the caret, at the start or after a space.
  const typedAfter = (trigger: "#" | "@" | "/") => {
    const range = selectionInside();
    if (!range?.collapsed || range.startContainer.nodeType !== Node.TEXT_NODE || closest("PRE") || closest("CODE")) return null;
    const before = (range.startContainer.textContent ?? "").slice(0, range.startOffset);
    const match = new RegExp(`(?:^|[\\s(])\\${trigger}([^\\s#@]{0,40})$`).exec(before);
    if (!match) return null;
    const word = document.createRange();
    word.setStart(range.startContainer, range.startOffset - match[1].length - 1);
    word.setEnd(range.startContainer, range.startOffset);
    const rect = word.getBoundingClientRect();
    return { range: word, query: match[1], at: { x: rect.left, top: rect.top, bottom: rect.bottom } };
  };

  // # followed by a word opens the link picker on that word; @ the member picker.
  const checkHash = () => {
    const typed = typedAfter("#");
    if (!typed) {
      if (picker()?.query !== undefined) setPicker(null);
    } else {
      hashRange = typed.range;
      setPicker({ at: typed.at, query: typed.query });
    }
    const named = typedAfter("@");
    mentionRange = named?.range ?? null;
    setMention(named && { at: named.at, query: named.query });
    const slash = typedAfter("/");
    const bots = slash ? [...root.querySelectorAll<HTMLElement>("[data-mention]")].map((el) => Number(el.dataset.mention)) : [];
    commandRange = slash && bots.length ? slash.range : null;
    setCommand(slash && bots.length ? { at: slash.at, query: slash.query, bots } : null);
  };

  const pickCommand = (name: string) => {
    const range = commandRange;
    setCommand(null);
    commandRange = null;
    if (!range) return;
    root.focus();
    const sel = getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("insertText", false, `/${name} `);
    changed();
  };

  const pickMember = (username: string) => {
    const range = mentionRange;
    setMention(null);
    mentionRange = null;
    if (!range) return;
    root.focus();
    const sel = getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    if (username.startsWith("<@")) insertNodeAtCaret(chip(`mention:${username.slice(2, -1)}`, ""), selectionInside());
    else document.execCommand("insertText", false, `@${username} `);
    changed();
  };

  // "- ", "1. ", "> " and "```" at the start of a line turn it into a block.
  const blockShortcut = (e: KeyboardEvent) => {
    if (e.key !== " " || closest("PRE") || closest("LI")) return false;
    const range = selectionInside();
    if (!range?.collapsed) return false;
    const block = range.startContainer.nodeType === Node.TEXT_NODE ? range.startContainer.parentElement : range.startContainer as HTMLElement;
    const text = (range.startContainer.textContent ?? "").slice(0, range.startOffset);
    const isLineStart = block && (block === root || block.parentElement === root || block.tagName === "DIV") &&
      range.startContainer === (block.firstChild ?? block);
    if (!isLineStart) return false;
    const command = text === "-" || text === "*" ? "ul" : /^\d+\.$/.test(text) ? "ol" : text === ">" ? "quote" : text === "```" ? "pre" : null;
    if (!command) return false;
    e.preventDefault();
    const remove = document.createRange();
    remove.setStart(range.startContainer, 0);
    remove.setEnd(range.startContainer, range.startOffset);
    remove.deleteContents();
    apply(command);
    return true;
  };

  const shortcut = (e: KeyboardEvent): Format | null => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
    const k = e.key.toLowerCase();
    if (!e.shiftKey) return k === "b" ? "bold" : k === "i" ? "italic" : k === "e" ? "code" : null;
    return k === "x" ? "strike" : e.code === "Digit8" ? "ul" : e.code === "Digit7" ? "ol" : e.code === "Digit9" ? "quote" : k === "c" ? "pre" : null;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (picker() && pickerKeys?.(e)) return;
    if (mention() && mentionKeys?.(e)) return;
    if (command() && commandKeys?.(e)) return;
    props.onKeyDown?.(e);
    if (e.defaultPrevented) return;
    const format = shortcut(e);
    if (format) {
      e.preventDefault();
      apply(format);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openLinkPicker();
      return;
    }
    if (blockShortcut(e)) return;
    if (e.key === "Enter" && props.onSubmit && !e.isComposing) {
      const inBlock = closest("LI") || closest("PRE") || closest("BLOCKQUOTE");
      if (e.ctrlKey || e.metaKey || (!e.shiftKey && !inBlock)) {
        e.preventDefault();
        props.onSubmit(markdown());
      }
    }
  };

  const onPaste = (e: ClipboardEvent) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length && props.onPasteFiles) {
      e.preventDefault();
      props.onPasteFiles(files);
      return;
    }
    // Plain text only, so pasted pages don't bring their markup; a makework link becomes a chip.
    // Some sources (a link dragged from a browser bar, a copied page) fill other clipboard formats and leave the text empty.
    const data = e.clipboardData;
    const html = data?.getData("text/html") ?? "";
    const text = data?.getData("text/plain") || data?.getData("text/uri-list")?.split("\n").find((l) => l && !l.startsWith("#")) || (html ? new DOMParser().parseFromString(html, "text/html").body.textContent ?? "" : "");
    e.preventDefault();
    if (!text) return;
    const range = selectionInside();
    const url = text.trim();
    // A web address pasted over selected text links that text; pasted alone it is a link too, not plain text.
    if (closest("PRE") || closest("CODE")) document.execCommand("insertText", false, text);
    else if (isLink(url)) insertLink(url);
    else if (/^https?:\/\/\S+$/i.test(url)) insertLink(url, range && !range.collapsed ? range.toString() : "");
    else if (/<@\d+>|\]\((?:makework|https?):\/\//.test(text)) insertMarkdown(text);
    else document.execCommand("insertText", false, text);
  };

  // Pasted text with link and mention markup (copied from a message): chips and links where it says so.
  const insertMarkdown = (markdown: string) => {
    const range = selectionInside();
    const nodes: Node[] = [];
    markdown.split("\n").forEach((line, i) => {
      if (i > 0) nodes.push(document.createElement("br"));
      nodes.push(...inlineNodes(line, chip));
    });
    if (!range) root.append(...nodes);
    else {
      range.deleteContents();
      const fragment = document.createDocumentFragment();
      fragment.append(...nodes);
      const last = fragment.lastChild;
      range.insertNode(fragment);
      if (last) {
        const after = document.createRange();
        after.setStartAfter(last);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(after);
      }
    }
    changed();
  };

  const openLinkPicker = () => {
    if (markdownMode()) {
      const rect = raw.getBoundingClientRect();
      setPicker({ at: { x: rect.left, top: rect.top, bottom: rect.bottom } });
      return;
    }
    savedRange = selectionInside()?.cloneRange() ?? null;
    const rect = (savedRange?.getBoundingClientRect().width || savedRange?.getBoundingClientRect().height)
      ? savedRange!.getBoundingClientRect() : root.getBoundingClientRect();
    hashRange = null;
    setPicker({ at: { x: rect.left, top: rect.top, bottom: rect.bottom } });
  };

  // The markdown box: Enter sends like in the formatted editor, Ctrl+K still links.
  const onRawKeyDown = (e: KeyboardEvent) => {
    if (picker() && pickerKeys?.(e)) return;
    props.onKeyDown?.(e);
    if (e.defaultPrevented) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      openLinkPicker();
    } else if (e.key === "Enter" && props.onSubmit && !e.isComposing && (e.ctrlKey || e.metaKey || !e.shiftKey)) {
      e.preventDefault();
      props.onSubmit(markdown());
    }
  };

  onMount(() => {
    document.execCommand("defaultParagraphSeparator", false, "div");
    if (props.value) setMarkdown(props.value);
    const onSelection = () => {
      if (!selectionInside()) return;
      savedRange = selectionInside()!.cloneRange();
      refreshActive();
    };
    document.addEventListener("selectionchange", onSelection);
    onCleanup(() => document.removeEventListener("selectionchange", onSelection));
    props.ref?.({
      focus: focusEnd,
      clear: () => setMarkdown(""),
      markdown,
      setMarkdown,
      insertText: (text) => {
        (markdownMode() ? raw : root).focus();
        document.execCommand("insertText", false, text);
        changed();
      },
      insertLink,
    });
  });
  onCleanup(disposeChips);

  return (
    <div class={`mw-editor ${props.class ?? ""}`} classList={{ focused: focused() }}>
      <textarea ref={raw} class="mw-editor-input mw-editor-raw" hidden={!markdownMode()} placeholder={props.placeholder}
        aria-label={props.placeholder} rows={props.minRows ?? 1} spellcheck
        onInput={changed} onKeyDown={onRawKeyDown}
        onPaste={(e) => {
          const files = [...(e.clipboardData?.files ?? [])];
          if (!files.length || !props.onPasteFiles) return;
          e.preventDefault();
          props.onPasteFiles(files);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          props.onBlur?.(markdown());
        }} />
      <div ref={root} class="mw-editor-input" classList={{ empty: empty() }} contentEditable tabIndex={0} hidden={markdownMode()}
        role="textbox" aria-multiline="true" aria-label={props.placeholder} data-placeholder={props.placeholder}
        style={{ "min-height": props.minRows ? `${props.minRows * 1.4}em` : undefined }}
        onInput={() => { changed(); checkHash(); }} onKeyDown={onKeyDown} onPaste={onPaste}
        onDrop={(e) => {
          // A task, file or other object dragged in from a view becomes a chip where it is dropped.
          const text = e.dataTransfer?.getData("text/plain").trim() ?? "";
          if (!isLink(text)) return;
          e.preventDefault();
          const at = document.caretRangeFromPoint?.(e.clientX, e.clientY);
          root.focus();
          if (at) {
            getSelection()?.removeAllRanges();
            getSelection()?.addRange(at);
          }
          insertLink(text);
        }}
        onKeyUp={(e) => (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") && checkHash()}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          if (picker()?.query !== undefined) setPicker(null);
          setMention(null); setCommand(null);
          props.onBlur?.(markdown());
        }}
        onContextMenu={(e) => {
          const link = (e.target as HTMLElement).closest<HTMLElement>("[data-href], a[href]");
          const href = link?.dataset.href ?? link?.getAttribute("href");
          if (!link || !href) return;
          openContextMenu(e, linkMenu(href, [
            "separator",
            { label: "Remove link", icon: "close", action: () => {
              link.replaceWith(...(link.dataset.href ? [document.createTextNode(link.textContent ?? "")] : [...link.childNodes]));
              changed();
            } },
          ]));
        }}
        onClick={(e) => {
          // Chips are links: Ctrl+click follows them, a plain click just places the caret.
          const href = (e.target as HTMLElement).closest<HTMLElement>("[data-href]")?.dataset.href;
          if (href && (e.ctrlKey || e.metaKey)) openLink(href);
        }} />
      <Show when={props.toolbar !== false || props.actions}>
        <div class="mw-editor-toolbar">
          <Show when={props.toolbar !== false && !markdownMode() && narrow()}>
            <button type="button" class="icon-button" classList={{ on: formatting() }} title="Formatting" aria-label="Formatting" aria-pressed={formatting()}
              onMouseDown={(e) => e.preventDefault()} onClick={() => setFormatting(!formatting())}>Aa</button>
          </Show>
          <Show when={props.toolbar !== false && !markdownMode() && (!narrow() || formatting())}>
            <For each={tools}>
              {(tool) => (
                <button type="button" class="icon-button" classList={{ on: active().has(tool.format) }} tabIndex={-1}
                  title={`${tool.label} (${tool.keys})`} aria-label={tool.label} aria-pressed={active().has(tool.format)}
                  onMouseDown={(e) => e.preventDefault()} onClick={() => apply(tool.format)}>
                  <Icon name={tool.icon} />
                </button>
              )}
            </For>
          </Show>
          <Show when={props.toolbar !== false}>
            <button type="button" class="icon-button" tabIndex={-1} title="Link (Ctrl+K, or type #)" aria-label="Link"
              onMouseDown={(e) => e.preventDefault()} onClick={openLinkPicker}>
              <Icon name="link" />
            </button>
            <button type="button" class="icon-button" classList={{ on: markdownMode() }} tabIndex={-1}
              title={markdownMode() ? "Back to formatted text" : "Write markdown"} aria-label="Markdown" aria-pressed={markdownMode()}
              onMouseDown={(e) => e.preventDefault()} onClick={() => setMarkdownMode(!markdownMode())}>
              <Icon name="markdown" />
            </button>
          </Show>
          <span class="mw-editor-spacer" />
          {props.actions}
        </div>
      </Show>
      <Show when={picker()}>
        {(p) => (
          <LinkPicker workspaceId={props.workspaceId} at={p().at} query={p().query} onPick={pick}
            onClose={() => { setPicker(null); if (p().query === undefined) root.focus(); }}
            keys={(handler) => (pickerKeys = handler)} />
        )}
      </Show>
      <Show when={mention()}>
        {(m) => (
          <MentionPicker workspaceId={props.workspaceId} at={m().at} query={m().query} onPick={pickMember}
            onClose={() => setMention(null)} keys={(handler) => (mentionKeys = handler)} />
        )}
      </Show>
      <Show when={command()}>
        {(c) => (
          <CommandPicker workspaceId={props.workspaceId} at={c().at} query={c().query} bots={c().bots} onPick={pickCommand}
            onClose={() => setCommand(null)} keys={(handler) => (commandKeys = handler)} />
        )}
      </Show>
    </div>
  );
}
