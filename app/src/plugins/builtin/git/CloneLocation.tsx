// Where a repository is cloned on this computer: a free folder under ~/MakeWork/Repositories, or under a folder the
// user picks. Desktop app only.
import { createEffect, createResource, createSignal, Show } from "solid-js";
import { userMessage } from "../../../api/client";
import { desktop, desktopError } from "../../../core/desktop";
import { Icon } from "../../../theme/icons";

// `onChange` gets the folder, null while it is being worked out or couldn't be.
export default function CloneLocation(props: { name: string; disabled?: boolean; onChange: (target: string | null) => void;
  onError: (message: string) => void }) {
  const [parent, setParent] = createSignal<string | undefined>();
  const [target] = createResource(() => ({ name: props.name, parent: parent() }),
    ({ name, parent: under }) => desktop!.git!.cloneLocation(name, under).catch((e) => { throw desktopError(e); }));
  const ready = () => (target.state === "ready" ? target() : null);
  createEffect(() => props.onChange(ready()));
  createEffect(() => target.state === "errored" && props.onError(userMessage(target.error)));

  const change = async () => {
    try {
      const picked = await desktop!.git!.pickCloneParent();
      if (picked) setParent(picked);
    } catch (e) {
      props.onError(userMessage(desktopError(e)));
    }
  };

  return (
    <div class="git-clone-location">
      <span>Save to <span class="muted">(cloned with its whole history, to commit, branch and push from here)</span></span>
      <div class="git-clone-row">
        <code class="git-clone-path mw-box" title={ready() ?? ""}>
          <Show when={ready()} fallback={<span class="mw-spinner" aria-label="Finding a folder" />}>{ready()}</Show>
        </code>
        <button class="mw-button mw-box" type="button" disabled={props.disabled} onClick={() => void change()}>
          <Icon name="folder" /> Change...
        </button>
      </div>
    </div>
  );
}
