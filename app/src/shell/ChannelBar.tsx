import { For, Match, Show, Switch, createEffect, createSignal, on, type JSX } from "solid-js";
import { ApiRequestError, userMessage } from "../api/client";
import { channelType, channelTypes } from "../core/channelTypes";
import { isForgotten } from "../core/content";
import { canGoBack, canGoForward, current, goBack, goForward, openChannel, openInNewTab, workspaceDirection } from "../core/navigation";
import { openContextMenu } from "../ui/contextMenu";
import { categoryMenu, channelMenu } from "./channelMenu";
import { userMenu } from "./userMenu";
import { Transition } from "solid-transition-group";
import { slideEnter, slideExit } from "../ui/transitions";
import { addCategory, addChannel, findCategory, findChannel, moveChannel, workspaces, type Category, type Channel, type WorkspaceData } from "../core/workspaces";
import { categoryDrop, channelDrop, draggedCategory, draggedChannel, setCategoryDrop, setChannelDrop, setDraggedCategory, setDraggedChannel, type ChannelDrop } from "./channelDrag";
import { categoryOrder, orderedCategories, reorderCategories, setCategoryOrder } from "../core/categoryOrder";
import { isCollapsed, isStarred, isUnread, mentionCount, starredIds, toggleCollapsed } from "../core/sidebar";
import { Icon } from "../theme/icons";
import {
  channelBarWidth, closeOverlays, saveChannelBarWidth, setChannelBarWidth, overlayShowing, workspacePage, toggleOverlay,
} from "../core/ui";
import OverlayButton from "../ui/OverlayButton";
import { connectingNote } from "./LoadingView";
import { can } from "../core/roles";
import { importChannel } from "../core/channelArchive";
import { isServerless } from "../core/serverless";
import Collapse from "../ui/Collapse";
import { motionMs } from "../ui/presence";
import { member, memberLoaded } from "../core/members";
import "../ui/Skeleton.css";
import Avatar from "../ui/Avatar";
import { presenceOf } from "../core/presence";
import { callSize, isInCall, participants } from "../voice/state";
import VoiceState from "../voice/VoiceState";
import SpeakerName from "../voice/SpeakerName";
import Dialog from "../ui/Dialog";
import SearchBox from "../ui/SearchBox";
import ResizeHandle from "../ui/ResizeHandle";
import { ConversationList, showingMessages } from "../dm/MessagesHome";
import { categoryNote, pluginOfType, pluginPackage, type PluginRecord } from "../plugins/registry";
import { declaredTypeOf, parseDeclared, resolveDeclared } from "../system/declared";
import { prepareUpload } from "../core/files";
import { workspaceApi } from "../core/workspaces";
import ConfirmPrompt from "../ui/ConfirmPrompt";
import { acceptsFiles, dropFilesOnChannel } from "../plugins/builtin/channelFileDrop";
import { dropCodeFile, hasCodeFile, readCodePayload } from "../plugins/builtin/codeDrag";
import { playSound } from "../theme/sounds";
import { focusWhenShown } from "../ui/focus";
import { quickSwitcherOpen, toggleQuickSwitcher } from "../core/quickSwitcher";

// Collapse key for the starred section; category ids start at 1.
const starredSection = 0;

// A starred channel is listed twice; only the copy that was clicked gets the selection line.
type RowSection = "starred" | "category";
const [clickedSection, setClickedSection] = createSignal<RowSection>("category");

export default function ChannelBar() {
  const workspace = () => {
    const id = current()?.workspaceId;
    return id ? workspaces.byId[id] : undefined;
  };

  return (
    <aside class="channel-bar" aria-label="Channels" style={{ width: channelBarWidth() ? `${channelBarWidth()}px` : undefined }}>
      <ResizeHandle edge="right" label="Resize channel list" setWidth={setChannelBarWidth} save={saveChannelBarWidth} />
      <Transition mode="outin" onEnter={slideEnter(workspaceDirection)} onExit={slideExit(workspaceDirection)}>
        <Show when={!showingMessages()} fallback={<ConversationList />}>
          <Show when={workspace()} keyed fallback={
            <p class="channel-bar-note">{workspaces.order.length > 0 ? "Pick a workspace to get started." : "No workspaces joined."}</p>
          }>
            {(w) => <WorkspaceChannels workspace={w} />}
          </Show>
        </Show>
      </Transition>
    </aside>
  );
}

function WorkspaceChannels(props: { workspace: WorkspaceData }) {
  const [query, setQuery] = createSignal("");
  const search = () => query().trim().toLowerCase();
  const matches = (channel: Channel) => !search() || channel.name.includes(search());
  const channelsIn = (category: Category) =>
    props.workspace.channels.filter((c) => c.categoryId === category.id && matches(c));
  const starred = () => starredIds(props.workspace.id)
    .map((id) => props.workspace.channels.find((c) => c.id === id))
    .filter((c): c is Channel => c !== undefined && matches(c));
  // The order is personal (core/categoryOrder.ts): the account's stored order, new categories after in the workspace's.
  const categories = () => orderedCategories(props.workspace.categories, categoryOrder(props.workspace.id));

  return (
    <div class="workspace-channels">
      <header class="channel-bar-header" data-drag-region>
        <h1 title={props.workspace.info.name} data-drag-region>{props.workspace.info.name}</h1>
        <OverlayButton class="icon-button" icon="profile" label="Your profile in this workspace" motion="grow"
          open={overlayShowing(workspacePage(props.workspace.id, "profile"))} onToggle={() => toggleOverlay(workspacePage(props.workspace.id, "profile"))} />
        <OverlayButton class="icon-button" icon="admin" label="Workspace settings" motion="tilt"
          open={overlayShowing(workspacePage(props.workspace.id))} onToggle={() => toggleOverlay(workspacePage(props.workspace.id))} />
      </header>
      <div class="channel-tools">
        <SearchBox class="channel-search" workspaceId={props.workspace.id} value={query()} onInput={setQuery}
          operators={[]} placeholder="Filter channels..." label="Filter channels">
          <button class="search-toggle" aria-expanded={quickSwitcherOpen()} title="Search everything (Ctrl+K)" aria-label="Search everything"
            onClick={toggleQuickSwitcher}>
            <Icon name="search" />
          </button>
        </SearchBox>
        <div class="history-buttons mw-box">
          <button onClick={goBack} disabled={!canGoBack()} title="Back (Alt+Left)" aria-label="Back"><Icon name="back" /></button>
          <button onClick={goForward} disabled={!canGoForward()} title="Forward (Alt+Right)" aria-label="Forward"><Icon name="forward" /></button>
        </div>
      </div>

      <Switch>
        <Match when={props.workspace.status === "loading"}>
          <p class="channel-bar-note">{isServerless(props.workspace.id) ? connectingNote : "Loading channels..."}</p>
        </Match>
        <Match when={props.workspace.status === "error"}>
          <p class="channel-bar-note warning">{props.workspace.error}</p>
        </Match>
        <Match when={props.workspace.status === "ready"}>
          <div class="channel-list mw-scroll-fade">
            <Show when={starred().length > 0}>
              <Section workspaceId={props.workspace.id} sectionId={starredSection} name="starred" open={!!search()}>
                <For each={starred()}>
                  {(channel) => (
                    <ChannelRow workspaceId={props.workspace.id} channel={channel} section="starred"
                      label={`${findCategory(props.workspace.id, channel.categoryId)?.name ?? ""}/${channel.name}`} />
                  )}
                </For>
              </Section>
            </Show>
            <For each={categories()}>
              {(category, i) => (
                <Show when={!search() || channelsIn(category).length > 0}>
                  <CategorySection workspaceId={props.workspace.id} category={category} channels={channelsIn(category)}
                    open={!!search()} categories={categories()} index={i()} />
                </Show>
              )}
            </For>
            <Show when={search() && props.workspace.channels.every((c) => !matches(c))}>
              <p class="channel-bar-note">No channels match.</p>
            </Show>
            <Show when={!search() && can(props.workspace.id, "manage_channels")}>
              <AddCategory workspaceId={props.workspace.id} />
            </Show>
          </div>
        </Match>
      </Switch>
    </div>
  );
}

function Section(props: {
  workspaceId: string; sectionId: number; name: string; open: boolean; action?: JSX.Element; children: JSX.Element;
  // A short line after the name, from a plugin.
  note?: string;
  onContextMenu?: (event: MouseEvent) => void;
  // Dropping a dragged channel on the header puts it at the end of the category.
  dropInto?: () => ChannelDrop | null;
  // Dragging a category header to reorder it (personal, not shared). `next` is the category after this one.
  categoryDrag?: { id: number; next: () => number | null; onDrop: () => void };
}) {
  const expanded = () => props.open || !isCollapsed(props.workspaceId, props.sectionId);
  const into = () => channelDrop()?.edge === "into" && channelDrop()?.categoryId === props.sectionId;
  const catEdge = () => {
    const d = categoryDrop();
    return d && d.rowId === props.categoryDrag?.id ? d.edge : null;
  };
  return (
    <section class="channel-section mw-box"
      classList={{ collapsed: !expanded(), scratchpad: !!props.note, "drop-above": catEdge() === "above", "drop-below": catEdge() === "below" }}
      // Dropping a category anywhere in the section puts it before or after the whole category. The header alone
      // is a thin strip, so the section gives a much wider target; channel rows ignore category drags.
      onDragOver={(e) => {
        if (!draggedCategory() || !props.categoryDrag || draggedCategory()!.categoryId === props.categoryDrag.id) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        const above = e.clientY < r.top + r.height / 2;
        setCategoryDrop({ beforeId: above ? props.categoryDrag.id : props.categoryDrag.next(), rowId: props.categoryDrag.id, edge: above ? "above" : "below" });
      }}
      onDrop={(e) => {
        if (!draggedCategory() || !props.categoryDrag) return;
        e.preventDefault();
        props.categoryDrag.onDrop();
      }}>
      <div class="channel-section-header"
        classList={{ "drop-into": into() }}
        draggable={!!props.categoryDrag}
        onContextMenu={(e) => props.onContextMenu?.(e)}
        onDragStart={(e) => {
          if (!props.categoryDrag) return;
          setDraggedCategory({ workspaceId: props.workspaceId, categoryId: props.categoryDrag.id });
          e.dataTransfer!.effectAllowed = "move";
          e.dataTransfer!.setData("application/x-makework-category", String(props.categoryDrag.id));
        }}
        onDragEnd={() => {
          setDraggedCategory(null);
          setCategoryDrop(null);
        }}
        onDragOver={(e) => {
          if (draggedCategory()) return; // the section handles category drops over a wider area
          const drop = props.dropInto?.();
          if (!drop) return;
          e.preventDefault();
          setChannelDrop(drop);
        }}
        onDrop={(e) => {
          if (draggedCategory()) return; // the section handles it
          e.preventDefault();
          finishChannelDrop(props.workspaceId);
        }}>
        <button class="channel-section-toggle" aria-expanded={expanded()}
          onClick={() => toggleCollapsed(props.workspaceId, props.sectionId)}>
          <span class="chevron"><Icon name="expanded" /></span>
          {props.name}
          <Show when={props.note}><span class="channel-section-note">{props.note}</span></Show>
        </button>
        {props.action}
      </div>
      <Collapse open={expanded()}>{props.children}</Collapse>
    </section>
  );
}

function CategorySection(props: { workspaceId: string; category: Category; channels: Channel[]; open: boolean; categories: Category[]; index: number }) {
  const [adding, setAdding] = createSignal(false);
  const add = (
    <Show when={can(props.workspaceId, "manage_channels")}>
      <button class="icon-button" title={`Add a channel to ${props.category.name}`} aria-label="Add channel"
        onClick={() => setAdding(true)}>
        <Icon name="add" />
      </button>
    </Show>
  );
  return (
    <Section workspaceId={props.workspaceId} sectionId={props.category.id} name={props.category.name}
      note={categoryNote(props.category.name)}
      open={props.open || adding()} action={add}
      dropInto={() => dropAllowed(props.workspaceId, props.channels, null) ? { categoryId: props.category.id, beforeId: null, rowId: null, edge: "into" } : null}
      categoryDrag={props.open ? undefined : {
        id: props.category.id,
        next: () => props.categories[props.index + 1]?.id ?? null,
        onDrop: () => {
          const dragged = draggedCategory();
          const drop = categoryDrop();
          setCategoryDrop(null);
          setDraggedCategory(null);
          if (dragged?.workspaceId !== props.workspaceId || !drop) return;
          const current = props.categories.map((c) => c.id);
          const ids = reorderCategories(current, dragged.categoryId, drop.beforeId);
          if (ids !== current) setCategoryOrder(props.workspaceId, ids);
        },
      }}
      onContextMenu={(e) => openContextMenu(e, categoryMenu(props.workspaceId, props.category, () => setAdding(true)))}>
      <For each={props.channels}>
        {(channel, i) => (
          <ChannelRow workspaceId={props.workspaceId} channel={channel} section="category"
            order={props.open ? undefined : { siblings: props.channels, next: () => props.channels[i() + 1]?.id ?? null }} />
        )}
      </For>
      <Dialog open={adding()} title={`New channel in ${props.category.name}`} onClose={() => setAdding(false)}>
        <Show when={adding()}>
          <AddChannelForm workspaceId={props.workspaceId} categoryId={props.category.id} onDone={() => setAdding(false)} />
        </Show>
      </Dialog>
    </Section>
  );
}

// Whether the dragged channel may land among these channels (not when one of them has its name).
function dropAllowed(workspaceId: string, siblings: Channel[], overId: number | null): boolean {
  const dragged = draggedChannel();
  if (dragged?.workspaceId !== workspaceId || dragged.channelId === overId) return false;
  const name = findChannel(workspaceId, dragged.channelId)?.name;
  return !siblings.some((c) => c.name === name && c.id !== dragged.channelId);
}

function finishChannelDrop(workspaceId: string) {
  const dragged = draggedChannel();
  const drop = channelDrop();
  setChannelDrop(null);
  setDraggedChannel(null);
  if (!dragged || !drop || drop.beforeId === dragged.channelId) return;
  void moveChannel(workspaceId, dragged.channelId, drop.categoryId, drop.beforeId).catch((e) => console.warn("Moving the channel failed", e));
}

function ChannelRow(props: {
  workspaceId: string; channel: Channel; section: RowSection; label?: string;
  // In a category's list, while not searching: rows can be dragged to reorder.
  order?: { siblings: Channel[]; next: () => number | null };
}) {
  const movable = () => !!props.order && can(props.workspaceId, "manage_channels");
  const dropEdge = () => {
    const d = channelDrop();
    return d?.rowId === props.channel.id && d.edge !== "into" ? d.edge : null;
  };
  const here = () => current();
  const active = () => here()?.workspaceId === props.workspaceId && here()?.channelId === props.channel.id;
  const type = () => channelType(props.channel.type);
  const starred = () => isStarred(props.workspaceId, props.channel.id);
  const hasLine = () => active() && (props.section === clickedSection() || (props.section === "category" && !starred()));
  const forgotten = () => isForgotten(props.workspaceId, props.channel.id);

  // Slides the label between its old and new place when the selection moves (FLIP), so only a transform animates.
  let label!: HTMLSpanElement;
  let lastLeft: number | undefined;
  let pressedLeft: number | undefined;
  createEffect(on(hasLine, () => {
    const from = pressedLeft ?? lastLeft;
    pressedLeft = undefined;
    // Layout position, without the hover offset that is still transitioning out.
    const to = label.offsetLeft + (label.offsetParent?.getBoundingClientRect().left ?? 0);
    lastLeft = to;
    if (from === undefined || Math.abs(from - to) < 1 || motionMs() === 0) return;
    label.animate([{ transform: `translateX(${from - to}px)` }, { transform: "none" }],
      { duration: motionMs() * 1.5, easing: "cubic-bezier(0.2, 0, 0, 1)" });
  }, { defer: true }));

  // Bots that are working in this channel now (a cursor, "working"), from presence.
  const botsHere = () => presenceOf(props.workspaceId, props.channel.id).map((p) => member(props.workspaceId, p.userId)).filter((m) => m.bot);
  return (
    <>
    <div class="channel-row" onContextMenu={(e) => openContextMenu(e, channelMenu(props.workspaceId, props.channel))}
      draggable={movable()}
      onDragStart={(e) => {
        setDraggedChannel({ workspaceId: props.workspaceId, channelId: props.channel.id });
        e.dataTransfer!.effectAllowed = "move";
        e.dataTransfer!.setData("application/x-makework-channel", String(props.channel.id));
      }}
      onDragEnd={() => {
        setDraggedChannel(null);
        setChannelDrop(null);
      }}
      onDragOver={(e) => {
        if (e.dataTransfer?.types.includes("Files") || hasCodeFile(e.dataTransfer)) {
          if (!acceptsFiles(props.channel) || !can(props.workspaceId, "edit_content")) return;
          e.preventDefault();
          e.currentTarget.classList.add("drop-files");
          return;
        }
        if (draggedCategory()) return;
        if (!props.order || !dropAllowed(props.workspaceId, props.order.siblings, props.channel.id)) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        const above = e.clientY < r.top + r.height / 2;
        setChannelDrop({
          categoryId: props.channel.categoryId, beforeId: above ? props.channel.id : props.order.next(),
          rowId: props.channel.id, edge: above ? "above" : "below",
        });
      }}
      onDragLeave={(e) => e.currentTarget.classList.remove("drop-files")}
      onDrop={(e) => {
        e.preventDefault();
        e.currentTarget.classList.remove("drop-files");
        const code = readCodePayload(e.dataTransfer);
        if (code) {
          if (acceptsFiles(props.channel) && can(props.workspaceId, "edit_content") && !(code.workspaceId === props.workspaceId && code.channelId === props.channel.id))
            void dropCodeFile(code, { workspaceId: props.workspaceId, channelId: props.channel.id, type: props.channel.type, parentId: null }, e.shiftKey).then(() => playSound("upload-done"), () => playSound("error"));
          return;
        }
        if (e.dataTransfer?.types.includes("Files")) {
          if (acceptsFiles(props.channel) && can(props.workspaceId, "edit_content")) void dropFilesOnChannel(props.workspaceId, props.channel, e.dataTransfer).catch(() => {});
          return;
        }
        finishChannelDrop(props.workspaceId);
      }}
      classList={{
      "drop-above": dropEdge() === "above", "drop-below": dropEdge() === "below",
      active: hasLine(), "active-copy": active() && !hasLine(), unread: isUnread(props.workspaceId, props.channel.id),
      mentioned: mentionCount(props.workspaceId, props.channel.id) > 0,
      "in-call": isInCall(props.workspaceId, props.channel.id),
      forgotten: forgotten(),
    }}>
      <button class="channel-open" title={`${type().label}: ${props.channel.name}`}
        aria-current={active() ? "page" : undefined}
        onAuxClick={(e) => e.button === 1 && openInNewTab({ workspaceId: props.workspaceId, channelId: props.channel.id })}
        onMouseDown={(e) => e.button === 1 && e.preventDefault()}
        onClick={(e) => {
          closeOverlays();
          if (e.ctrlKey || e.metaKey) return openInNewTab({ workspaceId: props.workspaceId, channelId: props.channel.id });
          pressedLeft = label.getBoundingClientRect().left;
          setClickedSection(props.section);
          openChannel(props.workspaceId, props.channel.id);
        }}>
        <span class="channel-line" />
        <span class="channel-label" ref={label}>
          <Icon name={type().icon} />
          <span class="channel-name">{props.label ?? props.channel.name}</span>
        </span>
        <Show when={props.channel.type === "voice" && callSize(props.workspaceId, props.channel.id)}>
          {(count) => <span class="channel-call-size mw-fade-in">{count()} {count() === 1 ? "member" : "members"}</span>}
        </Show>
        <Show when={botsHere().length > 0}>
          <span class="channel-bots" aria-label="Bots working here">
            <For each={botsHere()}>{(bot) => <span class="mw-fade-in" title={`${bot.displayName} is working here`}><Avatar user={bot} size={18} /></span>}</For>
          </span>
        </Show>
        <Show when={mentionCount(props.workspaceId, props.channel.id)}>
          {(count) => (
            <span class="mention-badge mw-box mw-fade-in" title={`${count()} unread ${count() === 1 ? "mention" : "mentions"}`}>
              @{count()}
            </span>
          )}
        </Show>
      </button>
      <Show when={forgotten()}>
        <span class="channel-cloud-off" title="Forgotten on this device">
          <Icon name="cloud-off" />
        </span>
      </Show>
    </div>
    <Show when={props.channel.type === "voice"}>
      <VoiceMembers workspaceId={props.workspaceId} channelId={props.channel.id} />
    </Show>
    </>
  );
}

// The call's members; a member another one counts but this device doesn't know of yet shows as a placeholder.
function VoiceMembers(props: { workspaceId: string; channelId: number }) {
  const people = () => participants(props.workspaceId, props.channelId);
  const unseen = () => Array.from({ length: Math.max(0, callSize(props.workspaceId, props.channelId) - people().length) });
  return (
    <Collapse open={people().length + unseen().length > 0}>
      <ul class="voice-members" aria-label="In this call">
        <For each={people()}>
          {(p) => {
            const who = () => member(props.workspaceId, p.userId);
            return (
              <li class="voice-member mw-fade-in"
                onContextMenu={(e) => openContextMenu(e, userMenu(props.workspaceId, p.userId))}>
                <Avatar user={who()} size={16} />
                <Show when={memberLoaded(props.workspaceId, p.userId)} fallback={<span class="skeleton voice-member-loading" title="Loading this member" />}>
                  <SpeakerName class="voice-member-name" workspaceId={props.workspaceId} userId={p.userId} />
                </Show>
                <VoiceState workspaceId={props.workspaceId} participant={p} />
              </li>
            );
          }}
        </For>
        <For each={unseen()}>
          {() => (
            <li class="voice-member mw-fade-in" title="In the call, still loading here">
              <span class="skeleton voice-member-loading-avatar" />
              <span class="skeleton voice-member-loading" />
            </li>
          )}
        </For>
      </ul>
    </Collapse>
  );
}

function AddCategory(props: { workspaceId: string }) {
  const [adding, setAdding] = createSignal(false);
  const [name, setName] = createSignal("");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let input!: HTMLInputElement;
  createEffect(() => adding() && requestAnimationFrame(() => input.focus()));
  const done = () => {
    setAdding(false);
    setName("");
    setError("");
  };
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await addCategory(props.workspaceId, name().trim());
      done();
    } catch (e) {
      setError(e instanceof ApiRequestError && e.code === "invalid_request" ? e.message : userMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="add-category">
      <Show when={!adding()}>
        <button class="add-category-button" onClick={() => setAdding(true)}><Icon name="add" size={14} /> Add category</button>
      </Show>
      <Collapse open={adding()}>
        <form class="add-channel" onSubmit={submit} onKeyDown={(e) => e.key === "Escape" && done()}>
          <input class="mw-input mw-box" placeholder="Category name" value={name()} maxLength={64} required
            ref={input}
            onInput={(e) => setName(e.currentTarget.value)} aria-label="Category name" />
          <div class="add-channel-row">
            <button type="submit" class="mw-button primary mw-box" disabled={busy() || !name().trim()}>Add</button>
            <button type="button" class="mw-button mw-box" onClick={done}>Cancel</button>
          </div>
          <Show when={error()}><p class="warning">{error()}</p></Show>
        </form>
      </Collapse>
    </div>
  );
}

function AddChannelForm(props: { workspaceId: string; categoryId: number; onDone: () => void }) {
  const [name, setName] = createSignal("");
  const [type, setType] = createSignal(channelTypes()[0]?.id ?? "chat");
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  // An installed plugin the workspace doesn't have yet: the first Add asks to add it first.
  const [adding, setAdding] = createSignal<{ plugin: PluginRecord; name: string } | null>(null);

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const chosen = type();
    const channelName = name().trim().toLowerCase().replace(/\s+/g, "-");
    setBusy(true);
    setError("");
    try {
      const found = pluginOfType(chosen);
      // An installed plugin with data needs a channels_plugins row before its channel can store anything.
      if (found?.origin === "installed" && found.plugin.manifest.data && declaredTypeOf(found.plugin.manifest) === chosen
        && !(await workspaceHas(props.workspaceId, chosen))) {
        if (!can(props.workspaceId, "manage_plugins"))
          throw new Error("A member with Manage plugins permission must add this plugin to the workspace first.");
        setAdding({ plugin: found, name: channelName });
        setBusy(false);
        return;
      }
      await create(channelName, chosen);
    } catch (e) {
      setError(e instanceof ApiRequestError && e.code === "invalid_request" ? e.message : userMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const create = async (channelName: string, chosen: string) => {
    const id = await addChannel(props.workspaceId, props.categoryId, channelName, chosen);
    props.onDone();
    openChannel(props.workspaceId, id);
  };

  // Adds the plugin's data side to the workspace (its package uploaded as content), then creates the channel.
  const addPluginAndCreate = async () => {
    const pending = adding();
    if (!pending) return;
    setBusy(true);
    setError("");
    try {
      const bytes = await pluginPackage(pending.plugin.plugin.manifest.id);
      if (!bytes) throw new Error("This device doesn't have the plugin's package.");
      const file = new File([bytes as BlobPart], `${pending.plugin.plugin.manifest.id}.mwp`, { type: "application/zip" });
      const upload = await prepareUpload(file);
      await workspaceApi(props.workspaceId).plugin("channels").call("add-plugin", {
        plugin_id: pending.plugin.plugin.manifest.id,
        version: pending.plugin.plugin.manifest.version,
        manifest: JSON.stringify(resolveDeclared(pending.plugin.plugin)),
        package: upload.url,
      });
      setAdding(null);
      await create(pending.name, declaredTypeOf(pending.plugin.plugin.manifest));
    } catch (e) {
      setAdding(null);
      setError(e instanceof ApiRequestError && e.code === "invalid_request" ? e.message : userMessage(e));
    } finally {
      setBusy(false);
    }
  };

  let picker!: HTMLInputElement;
  const importZip = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const id = await importChannel(props.workspaceId, props.categoryId, file);
      props.onDone();
      openChannel(props.workspaceId, id);
    } catch (e) {
      setError(e instanceof Error && !(e instanceof ApiRequestError) ? e.message : userMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="add-channel" onSubmit={submit}>
      <input class="mw-input mw-box" placeholder="channel-name" value={name()} required ref={focusWhenShown}
        onInput={(e) => setName(e.currentTarget.value)} aria-label="Channel name" />
      <div class="channel-type-list mw-scroll-fade" role="radiogroup" aria-label="Channel type">
        <For each={channelTypes()}>
          {(t) => (
            <button type="button" class="channel-type-option mw-box" classList={{ active: type() === t.id }} role="radio" aria-checked={type() === t.id}
              onClick={() => setType(t.id)}>
              <Icon name={t.icon} />
              <span class="channel-type-text"><span>{t.label}</span><Show when={t.description}><span class="hint">{t.description}</span></Show></span>
            </button>
          )}
        </For>
      </div>
      <div class="add-channel-row">
        <button type="submit" class="mw-button primary mw-box" disabled={busy() || !name().trim()}>Add channel</button>
        <button type="button" class="mw-button mw-box" onClick={props.onDone}>Cancel</button>
      </div>
      <Show when={isServerless(props.workspaceId)}>
        <button type="button" class="add-category-button" disabled={busy()} onClick={() => picker.click()}>
          <Icon name="upload" size={14} /> {busy() ? "Importing..." : "Import a channel from .zip"}
        </button>
        <input ref={picker} type="file" accept=".zip,application/zip" hidden
          onChange={(e) => { void importZip(e.currentTarget.files?.[0]); e.currentTarget.value = ""; }} />
      </Show>
      <Show when={adding()}>
        {(pending) => (
          <ConfirmPrompt
            open
            question={`Add plugin "${pending().plugin.plugin.manifest.name}" to this workspace? Its channels store their data here.`}
            confirmLabel="Add to workspace"
            onConfirm={() => void addPluginAndCreate()}
            onCancel={() => setAdding(null)}
          />
        )}
      </Show>
      <Show when={error()}><p class="warning">{error()}</p></Show>
    </form>
  );
}

// Whether the workspace already keeps the plugin's data side (a channels_plugins row with its data name).
async function workspaceHas(workspaceId: string, type: string): Promise<boolean> {
  const rows = await workspaceApi(workspaceId).plugin("channels").read("channels_plugins");
  return rows.some((row) => {
    try {
      return parseDeclared(String(row.manifest)).name === type;
    } catch {
      return false;
    }
  });
}
