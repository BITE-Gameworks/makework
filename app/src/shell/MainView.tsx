import { For, Show, createEffect, on, onCleanup } from "solid-js";
import { Transition } from "solid-transition-group";
import { current, savedLocation, workspaceDirection } from "../core/navigation";
import { createViewSwap, slideEnter, slideExit, waitingSlides } from "../ui/transitions";
import { channelType, loaderFor } from "../core/channelTypes";
import { isPopout } from "../core/popout";
import { channelTypeOf, findChannel, workspaces, type Channel } from "../core/workspaces";
import ChannelDetails from "./ChannelDetails";
import { bootStatus, narrow, setSidePanel } from "../core/ui";
import { SwitcherList } from "./QuickSwitcher";
import LoadingView, { connectingNote } from "./LoadingView";
import { isServerless } from "../core/serverless";
import ChannelHost from "../plugins/ChannelHost";
import { Icon } from "../theme/icons";
import { MessagesView, showingMessages } from "../dm/MessagesHome";
import { AddWorkspaceForms } from "./AddWorkspace";
import { keepsAlive, keptInPlace, leaveKept, showKept, viewKey } from "../core/keptViews";

export default function MainView() {
  const channel = () => {
    const here = current();
    return here ? findChannel(here.workspaceId, here.channelId) : undefined;
  };

  // The channel being opened, also before the member's visible list has it (roles still loading).
  const openingType = () => {
    const here = current() ?? (bootStatus() ? savedLocation() : undefined);
    return here ? channelTypeOf(here.workspaceId, here.channelId) : undefined;
  };

  const status = () => {
    const here = current();
    return bootStatus() ?? (here && isServerless(here.workspaceId) && workspaces.byId[here.workspaceId]?.status === "loading" ? connectingNote : null);
  };

  // Every channel type is kept (a type opts out with `keepAlive: false`): its view stays mounted, hidden, while
  // the member is elsewhere, and comes back as it was. Opted-out types render through the in-flow path below.
  const keptHere = () => {
    const c = channel();
    return !!c && !showingMessages() && keepsAlive(c.type);
  };
  createEffect(() => {
    const c = channel();
    if (c && keptHere()) showKept(current()!.workspaceId, c.id, c.type);
  });
  const shownKey = () => (status() === null && keptHere() ? viewKey(current()!.workspaceId, channel()!.id) : undefined);

  // The in-flow layer (messages, the empty state, opted-out channels) transitions with solid-transition-group as
  // before; its arriving view waits, hidden, for a kept view that is still sliding out underneath the kept layer.
  const flow = waitingSlides(workspaceDirection);
  // The kept layer holds every kept view; the swap shows one of them at a time with the same out-in slides.
  const wrappers = new Map<string, HTMLElement>();
  const swap = createViewSwap({
    enter: (el, done) => slideEnter(workspaceDirection)(el, done),
    exit: (el, done) => slideExit(workspaceDirection)(el, done),
    show: (el) => el.classList.remove("hidden"),
    hide: (el) => el.classList.add("hidden"),
  });
  createEffect(() => {
    const key = shownKey();
    swap.to(key ? wrappers.get(key) : undefined);
  });

  return (
    <main class="main-view">
      <Show when={status() === null} fallback={<LoadingView status={status()!} kind={loaderFor(openingType())} />}>
        <Transition mode="outin" onEnter={flow.enter} onExit={flow.exit}>
          <Show when={!showingMessages()} fallback={<MessagesView />}>
          <Show when={channel()} fallback={<EmptyState />} keyed>
            {(c) => (
              <Show when={!keepsAlive(c.type)}>
                <ChannelHost workspaceId={current()!.workspaceId} channel={c}
                  fallback={<ChannelPlaceholder workspaceId={current()!.workspaceId} channel={c} />} />
              </Show>
            )}
          </Show>
          </Show>
        </Transition>
      </Show>
      <For each={keptInPlace()}>
        {(view) => {
          const keptChannel = () => findChannel(view.workspaceId, view.channelId);
          const shown = () => shownKey() === view.key;
          let wrapper: HTMLElement | undefined;
          createEffect(on(shown, (now) => {
            const c = keptChannel();
            if (c && !now) leaveKept(view, c.type);
          }));
          onCleanup(() => {
            if (wrappers.get(view.key) === wrapper) wrappers.delete(view.key);
            if (wrapper) swap.dropped(wrapper);
          });
          return (
            <Show when={keptChannel()} keyed>
              {(c) => (
                <div class="kept-view hidden" aria-hidden={!shown()} ref={(el) => {
                  const previous = wrappers.get(view.key);
                  if (previous && previous !== el) swap.dropped(previous);
                  wrapper = el;
                  wrappers.set(view.key, el);
                  if (shown()) swap.to(el);
                }}>
                  <ChannelHost workspaceId={view.workspaceId} channel={c} active={shown()}
                    fallback={<ChannelPlaceholder workspaceId={view.workspaceId} channel={c} />} />
                </div>
              )}
            </Show>
          );
        }}
      </For>
    </main>
  );
}

// Without servers: how to get one. With servers but no channel open: pick one.
function EmptyState() {
  // A view window shows the one channel it was popped out for: there is nothing to pick from and nothing to join.
  if (isPopout()) return (
    <div class="empty-state mw-fade-in">
      <h2>Nothing to show</h2>
      <p>This channel isn't open on this computer. Close this window and open it again from the main window.</p>
    </div>
  );
  return (
    <Show when={workspaces.order.length > 0} fallback={<StartPage />}>
      <div class="home-page mw-fade-in">
        <h2>Where to?</h2>
        <SwitcherList focusOnShow={!narrow()} />
      </div>
    </Show>
  );
}

function StartPage() {
  return (
    <div class="start-page mw-scroll-fade mw-fade-in">
      <div class="start-page-intro">
        <h2>Welcome to MakeWork</h2>
        <p>
          A workspace is a place for your group: chat, calls, files, tasks and more, organized in channels. Create one
          for your team, or join one with the invite code someone sent you. You can add more later with the
          <span class="start-page-plus" aria-label="plus"><Icon name="add" size={14} /></span> button in the workspace bar.
        </p>
      </div>
      <div class="start-page-forms mw-box">
        <AddWorkspaceForms />
      </div>
      <p class="hint">
        Private messages work without a workspace: the <Icon name="messages" size={14} /> button at the top of the workspace bar.
      </p>
    </div>
  );
}

// Shown when neither a plugin nor the workspace provides a view.
function ChannelPlaceholder(props: { workspaceId: string; channel: Channel }) {
  const type = () => channelType(props.channel.type);
  const openDetails = () =>
    setSidePanel({ title: "Channel details", render: () => <ChannelDetails workspaceId={props.workspaceId} channel={props.channel} /> });

  return (
    <div class="empty-state mw-fade-in">
      <Icon name={type().icon} size={48} />
      <h2>{props.channel.name}</h2>
      <p>No view is installed for {type().label.toLowerCase()} channels yet.</p>
      <button class="mw-button mw-box" onClick={openDetails}><Icon name="info" /> Details</button>
    </div>
  );
}
