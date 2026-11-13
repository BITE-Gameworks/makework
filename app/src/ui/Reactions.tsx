import { For, Show, createEffect, createSignal } from "solid-js";
import { emojiFor, namedEmoji } from "../markdown/emoji";
import { emojiCategories } from "../markdown/emojiData";
import { customEmojiByName, customEmojiList, customEmojiSrc, loadCustomEmoji, type CustomEmoji } from "../core/customEmoji";
import { can } from "../core/roles";
import { Icon } from "../theme/icons";
import { recent, rememberEmoji } from "./emojiRecent";
import CustomEmojiForm from "./CustomEmojiForm";
import Popover from "./Popover";
import "./Reactions.css";

export interface ReactionSummary {
  code: string;      // shortcode without colons
  count: number;
  users: number[];
}

interface EmojiEntry {
  name: string;
  emoji?: string;
  custom?: CustomEmoji;
}

interface EmojiSection {
  id: string;
  label: string;
  emoji: EmojiEntry[];
}

function EntryGlyph(props: { entry: EmojiEntry }) {
  const src = () => (props.entry.custom ? customEmojiSrc(props.entry.custom) : null);
  return (
    <Show when={src()} fallback={props.entry.emoji ?? `:${props.entry.name}:`}>
      {(src) => <img class="mw-emoji-image" src={src()} alt={props.entry.name} loading="lazy" />}
    </Show>
  );
}

// Search, recently used, the workspace's own emoji and categories. Calls onPick with the shortcode name.
export function EmojiGrid(props: { onPick: (code: string) => void; workspaceId?: string }) {
  const [query, setQuery] = createSignal("");
  const [hovered, setHovered] = createSignal<string | null>(null);
  const [adding, setAdding] = createSignal(false);
  let scroller!: HTMLDivElement;
  createEffect(() => {
    const id = props.workspaceId;
    if (id) void loadCustomEmoji(id);
  });
  const q = () => query().trim().toLowerCase().replace(/^:|:$/g, "");
  const customEntries = (): EmojiEntry[] => (props.workspaceId ? customEmojiList(props.workspaceId) : [])
    .map((custom) => ({ name: custom.name, custom }));
  const entryFor = (name: string): EmojiEntry | undefined => {
    const standard = namedEmoji[name];
    if (standard) return { name, emoji: standard };
    const custom = props.workspaceId ? customEmojiByName(props.workspaceId, name) : undefined;
    return custom && !custom.deleted ? { name, custom } : undefined;
  };
  const sections = (): EmojiSection[] => {
    if (q()) {
      const custom = customEntries().filter((entry) => entry.name.includes(q()));
      const found = [
        ...custom,
        ...Object.entries(namedEmoji).filter(([name]) => name.includes(q())).map(([name, emoji]) => ({ name, emoji })),
      ];
      return [{ id: "results", label: found.length ? "Results" : "Nothing found", emoji: found }];
    }
    const used = recent().map(entryFor).filter((entry): entry is EmojiEntry => !!entry);
    const custom = customEntries();
    return [
      ...(used.length ? [{ id: "recent", label: "Recently used", emoji: used }] : []),
      ...(custom.length ? [{ id: "custom", label: "Custom", emoji: custom }] : []),
      ...emojiCategories.map((category) => ({
        id: category.id, label: category.label, emoji: category.emoji.map(([name, emoji]) => ({ name, emoji })),
      })),
    ];
  };
  const hoveredEntry = () => {
    const name = hovered();
    return name ? entryFor(name) : undefined;
  };
  const canAdd = () => !!props.workspaceId && can(props.workspaceId, "manage_emojis");
  const pick = (name: string) => {
    rememberEmoji(name);
    props.onPick(name);
  };
  return (
    <div class="mw-emoji-picker">
      <input class="mw-input mw-box" placeholder="Search emoji" value={query()} aria-label="Search emoji"
        ref={(el) => requestAnimationFrame(() => el.focus({ preventScroll: true }))}
        onInput={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={(e) => {
          const first = sections()[0]?.emoji[0];
          if (e.key === "Enter" && q() && first) pick(first.name);
        }} />
      <Show when={!q()}>
        <nav class="mw-emoji-tabs" aria-label="Emoji categories">
          <For each={sections().filter((section) => section.emoji.length > 0)}>
            {(section) => (
              <button title={section.label} aria-label={section.label}
                onClick={() => scroller.querySelector(`[data-section="${section.id}"]`)?.scrollIntoView({ block: "start" })}>
                <EntryGlyph entry={section.emoji[0]} />
              </button>
            )}
          </For>
        </nav>
      </Show>
      <div class="mw-emoji-scroll mw-scroll-fade" ref={scroller}>
        <For each={sections()}>
          {(section) => (
            <section data-section={section.id}>
              <h4>{section.label}</h4>
              <div class="mw-emoji-grid">
                <For each={section.emoji}>
                  {(entry) => (
                    <button title={`:${entry.name}:`} aria-label={entry.name} onClick={() => pick(entry.name)}
                      onMouseEnter={() => setHovered(entry.name)} onFocus={() => setHovered(entry.name)}>
                      <EntryGlyph entry={entry} />
                    </button>
                  )}
                </For>
              </div>
            </section>
          )}
        </For>
      </div>
      <div class="mw-emoji-footer">
        <Show when={hoveredEntry()} fallback={<span class="muted">Pick an emoji</span>}>
          {(entry) => <><span class="mw-emoji-preview"><EntryGlyph entry={entry()} /></span> :{entry().name}:</>}
        </Show>
        <Show when={canAdd()}>
          <button type="button" class="mw-emoji-add" aria-expanded={adding()} onClick={() => setAdding(!adding())}>
            <Icon name="add" /> Add emoji
          </button>
        </Show>
      </div>
      <Show when={adding() && props.workspaceId}>
        {(id) => <CustomEmojiForm workspaceId={id()} onCancel={() => setAdding(false)}
          onDone={(emoji) => { setAdding(false); setHovered(emoji.name); }} />}
      </Show>
    </div>
  );
}

// Emoji for the right-click menu's React entry: the recently used ones, then common ones.
export function quickReactions(count = 6): [string, string][] {
  const names = [...recent(), "thumbsup", "heart", "joy", "open_mouth", "cry", "tada"];
  return [...new Set(names)].filter((n) => namedEmoji[n]).slice(0, count).map((n) => [n, namedEmoji[n]]);
}

// The "react" button with its emoji picker, then the reaction counts with a toggle each. `picking` and `onPicking`
// let the message's right-click menu open the picker.
export default function Reactions(props: {
  reactions: ReactionSummary[];
  me: number | null;
  nameOf: (userId: number) => string;
  onToggle: (code: string) => void;
  workspaceId?: string;
  placement?: "above" | "below";
  picking?: boolean;
  onPicking?: (open: boolean) => void;
}) {
  const [ownOpen, setOwnOpen] = createSignal(false);
  const open = () => props.picking ?? ownOpen();
  const setOpen = (value: boolean) => (props.onPicking ? props.onPicking(value) : setOwnOpen(value));
  const custom = (code: string) => (props.workspaceId ? customEmojiByName(props.workspaceId, code) : undefined);
  createEffect(() => {
    const id = props.workspaceId;
    if (id) void loadCustomEmoji(id);
  });
  return (
    <div class="mw-reactions">
      <div class="mw-popover-anchor">
        <button class="mw-reaction-add" aria-expanded={open()} onClick={() => setOpen(!open())}>react</button>
        <Popover open={open()} onClose={() => setOpen(false)} label="Add reaction" align="start" placement={props.placement}>
          <EmojiGrid workspaceId={props.workspaceId} onPick={(code) => {
            setOpen(false);
            props.onToggle(code);
          }} />
        </Popover>
      </div>
      <For each={props.reactions}>
        {(r) => (
          <button class="mw-reaction mw-box mw-fade-in" classList={{ mine: r.users.includes(props.me ?? -1) }}
            title={`:${r.code}: by ${r.users.map(props.nameOf).join(", ")}`} onClick={() => props.onToggle(r.code)}>
            <span class="mw-reaction-emoji">
              <Show when={custom(r.code)} fallback={emojiFor(r.code) ?? `:${r.code}:`}>
                {(emoji) => (
                  <Show when={customEmojiSrc(emoji())} fallback={`:${r.code}:`}>
                    {(src) => <img class="mw-reaction-custom" src={src()} alt={`:${r.code}:`} loading="lazy" />}
                  </Show>
                )}
              </Show>
            </span>
            <Show when={r.count > 1}><span class="mw-reaction-count">{r.count}</span></Show>
          </button>
        )}
      </For>
    </div>
  );
}
