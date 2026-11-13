// The address of a service the app uses, with a field to change it: the user server (sign-in screen, Settings >
// Account) and the TURN server (Settings > Account). The address is checked before it is used.
import { Show, createSignal } from "solid-js";
import { checkUserServer, defaultUserServer, hostOf, setUserServer, userServer } from "../core/userServer";
import Collapse from "../ui/Collapse";
import "./auth.css";

export default function AddressField(props: {
  label: string;
  // Name for the input, e.g. "User server address".
  name: string;
  current: () => string;
  defaultUrl: string;
  // Throws with a readable message when the address isn't such a service.
  check: (url: string) => Promise<unknown>;
  set: (url: string) => void;
  onChange?: () => void;
}) {
  const [editing, setEditing] = createSignal(false);
  const [value, setValue] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const open = () => {
    setValue(hostOf(props.current()));
    setError("");
    setEditing(!editing());
  };
  const save = async (url: string) => {
    setBusy(true);
    setError("");
    try {
      await props.check(url);
      props.set(url);
      setEditing(false);
      props.onChange?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="user-server-field">
      <p class="hint">
        {props.label} <strong>{hostOf(props.current())}</strong>{" "}
        <button type="button" class="auth-link" aria-expanded={editing()} onClick={open}>{editing() ? "Cancel" : "Change"}</button>
      </p>
      <Collapse open={editing()}>
        <form class="user-server-form" onSubmit={(e) => {
          e.preventDefault();
          void save(value());
        }}>
          <input class="mw-input mw-box" aria-label={props.name} placeholder={hostOf(props.defaultUrl)} spellcheck={false}
            value={value()} onInput={(e) => setValue(e.currentTarget.value)} />
          <button type="submit" class="mw-button primary mw-box" disabled={busy() || !value().trim()}>Use</button>
          <Show when={props.current() !== props.defaultUrl}>
            <button type="button" class="mw-button mw-box" disabled={busy()} onClick={() => void save(props.defaultUrl)}>Default</button>
          </Show>
        </form>
        <Show when={error()}><p class="warning">{error()}</p></Show>
      </Collapse>
    </div>
  );
}

// The user server's field; the same on the sign-in screen and in settings.
export function UserServerField(props: { label: string; onChange?: () => void }) {
  return (
    <AddressField label={props.label} name="User server address" current={userServer} defaultUrl={defaultUserServer}
      check={checkUserServer} set={setUserServer} onChange={props.onChange} />
  );
}
