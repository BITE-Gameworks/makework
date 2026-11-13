// The private messages home: add friends, answer requests, and the friends and blocked lists (dm/friends.ts).
import { For, Show, createSignal, type JSX } from "solid-js";
import { handleOf, type PublicAccount } from "../core/userServer";
import { Icon } from "../theme/icons";
import Avatar from "../ui/Avatar";
import { allowsStrangers, changeFriend, relations, requestFriend, setAllowStrangers } from "./friends";
import { openWith } from "./messages";

export default function FriendsPage() {
  const [name, setName] = createSignal("");
  const [note, setNote] = createSignal<{ text: string; warning: boolean } | null>(null);
  const [busy, setBusy] = createSignal(false);

  const add = async (e: SubmitEvent) => {
    e.preventDefault();
    setBusy(true);
    setNote(null);
    try {
      const person = await requestFriend(name());
      setName("");
      setNote({ text: relations()?.friends.some((p) => p.id === person.id)
        ? `You and ${handleOf(person)} are friends now.` : `Friend request sent to ${handleOf(person)}.`, warning: false });
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : String(err), warning: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="friends-page mw-scroll-fade mw-fade-in">
      <h2>Friends</h2>
      <form class="friends-add" onSubmit={add}>
        <input class="mw-input mw-box" placeholder="Email, or name with tag like ada·4f2a" aria-label="Email or name with tag" spellcheck={false}
          value={name()} onInput={(e) => setName(e.currentTarget.value)} />
        <button type="submit" class="mw-button primary mw-box" disabled={busy() || !name().trim()}>Send request</button>
      </form>
      <Show when={note()}>{(n) => <p classList={{ warning: n().warning, hint: !n().warning }}>{n().text}</p>}</Show>
      <StrangersSetting />

      <Show when={relations()} fallback={<p class="hint">Loading...</p>}>
        {(r) => (
          <>
            <Section title="Friend requests" people={r().incoming}>
              {(p) => (
                <>
                  <Action label="Accept" icon="check" primary onClick={() => changeFriend("accept", p.id)} />
                  <Action label="Decline" icon="close" onClick={() => changeFriend("remove", p.id)} />
                </>
              )}
            </Section>
            <Section title="Sent requests" people={r().outgoing}>
              {(p) => <Action label="Cancel" icon="close" onClick={() => changeFriend("remove", p.id)} />}
            </Section>
            <Section title="Friends" people={r().friends} empty="No friends yet. Add someone by their email or name·tag above.">
              {(p) => (
                <>
                  <Action label="Message" icon="messages" primary onClick={() => openWith(p)} />
                  <Action label="Remove" icon="delete" onClick={() => changeFriend("remove", p.id)} />
                </>
              )}
            </Section>
            <Section title="Blocked" people={r().blocked}>
              {(p) => <Action label="Unblock" icon="close" onClick={() => changeFriend("unblock", p.id)} />}
            </Section>
          </>
        )}
      </Show>
    </div>
  );
}

// Who may send private messages; friends only by default. In Settings > Account and on the friends page.
export function StrangersSetting() {
  const [error, setError] = createSignal("");
  return (
    <div class="friends-setting">
      <label>
        <input type="checkbox" checked={allowsStrangers()} disabled={!relations()} onChange={(e) => {
          const allow = e.currentTarget.checked;
          setError("");
          setAllowStrangers(allow).catch((err) => setError(err instanceof Error ? err.message : String(err)));
        }} />
        Allow messages from people who aren't my friends
      </label>
      <Show when={error()}><p class="warning">{error()}</p></Show>
    </div>
  );
}

function Section(props: { title: string; people: PublicAccount[]; empty?: string; children: (p: PublicAccount) => JSX.Element }) {
  return (
    <Show when={props.people.length > 0 || props.empty}>
      <section class="friends-section">
        <h3>{props.title} <span class="muted">{props.people.length || ""}</span></h3>
        <For each={props.people} fallback={<p class="hint">{props.empty}</p>}>
          {(p) => (
            <div class="friends-row mw-box mw-fade-in">
              <Avatar user={{ ...p.profile, username: p.username }} size={32} />
              <span class="dm-row-text">
                <span class="dm-row-name">{p.profile.displayName}</span>
                <span class="dm-row-last">{handleOf(p)}</span>
              </span>
              {props.children(p)}
            </div>
          )}
        </For>
      </section>
    </Show>
  );
}

function Action(props: { label: string; icon: "check" | "close" | "messages" | "delete"; primary?: boolean; onClick: () => unknown }) {
  const [busy, setBusy] = createSignal(false);
  return (
    <button class="mw-button mw-box" classList={{ primary: props.primary }} disabled={busy()} onClick={async () => {
      setBusy(true);
      try {
        await props.onClick();
      } catch (e) {
        console.warn(`${props.label} failed:`, e);
      } finally {
        setBusy(false);
      }
    }}>
      <Icon name={props.icon} /> {props.label}
    </button>
  );
}
