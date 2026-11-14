// Asked when a repository needs a sign-in, or a channel a host connection: another of this member's connections for
// the host (connections.ts), MakeWork's own GitHub sign-in on desktop (core/githubAuth.ts: a code to enter on
// github.com, which opens in the browser), or a token pasted for that host (GitLab, browsers). Signing in or pasting
// saves it as a connection; `onDone` then runs whatever needed it again.
import { Match, Show, Switch, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { userMessage } from "../../../api/client";
import { checkGitHubSignIn, githubSignInReady, openGitHubDevicePage, startGitHubSignIn, type DeviceSignIn } from "../../../core/githubAuth";
import { Icon } from "../../../theme/icons";
import Collapse from "../../../ui/Collapse";
import Select from "../../../ui/Select";
import { createCopied } from "../../../ui/clipboard";
import { addConnection, connectionRevision, connectionsFor, nameGitHubSignIn } from "./connections";

export default function SignInPrompt(props: {
  host: string;
  reason: string;
  // What the connection is used for at once ("Update with it", "Try again with it").
  submitLabel: string;
  // The channel's connection now, which isn't offered again.
  current?: string | null;
  // Starts at adding a connection (signing in or pasting) rather than offering the saved ones first.
  adding?: boolean;
  // GitHub refused the sign-in in the "github.com" slot as run out or revoked: signing in again comes first, though the
  // slot still holds the old token.
  renew?: boolean;
  // `key`: the connection picked or added, null when a pasted token couldn't be kept (`token` is it, for this once);
  // `login`: after signing in to GitHub.
  onDone: (key: string | null, token: string | null, login?: string | null) => void;
  onNotSaved: (e: unknown) => void;
  onCancel?: () => void;
}) {
  onMount(() => void checkGitHubSignIn());
  const [saved] = createResource(() => ({ host: props.host, revision: connectionRevision() }),
    ({ host }) => (host ? connectionsFor(host) : Promise.resolve([])));
  const others = () => (saved.latest ?? []).filter((c) => c.key !== props.current);
  // Signing in to GitHub is offered while this account has no working GitHub sign-in here (it lives in the "github.com"
  // slot).
  const signedIn = () => (saved.latest ?? []).some((c) => c.key === "github.com");
  const github = () => props.host === "github.com" && githubSignInReady() === true && (props.renew || !signedIn());
  // Only to someone without any connection for the host: one who has one may pick it instead. Read from `latest`, so a
  // refetch (any connection change) neither hides the form nor ends a GitHub sign-in waiting for approval.
  const loaded = () => saved.latest !== undefined;
  const noApp = () => props.host === "github.com" && githubSignInReady() === false && loaded() && !saved.latest!.length;
  const [picked, setPicked] = createSignal<string | null>(null);
  const pick = () => (others().some((c) => c.key === picked()) ? picked()! : others()[0]?.key ?? null);
  // With other connections, they come first and adding one is a step further (unless asked to add one; read once:
  // the prompts that set it are mounted anew for each ask).
  const [adding, setAdding] = createSignal(props.adding ?? props.renew ?? false);
  const showAdd = () => adding() || (loaded() && !others().length);
  const [pasting, setPasting] = createSignal(false);
  const [name, setName] = createSignal("");
  const [token, setTokenText] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const provider = () => (props.host === "github.com" ? "github" : "gitlab");

  const paste = async (e: SubmitEvent) => {
    e.preventDefault();
    const value = token().trim();
    if (!value || saving()) return;
    setSaving(true);
    try {
      const connection = await addConnection({ host: props.host, provider: provider(), token: value, name: name() });
      props.onDone(connection.key, value);
    } catch (error) {
      // Not kept (no keychain): still used for what asked, this once.
      props.onNotSaved(error);
      props.onDone(null, value);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="git-token mw-box mw-fade-in">
      <p class="git-token-reason">{props.reason}</p>
      <Collapse open={!!others().length && !showAdd()}>
        <div class="git-token-pick">
          <Select value={pick()} label={`Connection for ${props.host}`} onChange={setPicked}
            options={others().map((c) => ({ value: c.key, label: c.name, icon: "lock" }))} />
          <button class="mw-button mw-box accent" disabled={!pick()} onClick={() => props.onDone(pick(), null)}>{props.submitLabel}</button>
          <button class="mw-button mw-box" onClick={() => setAdding(true)}><Icon name="add" /> Add a connection</button>
          <Show when={props.onCancel}>
            <button class="mw-button mw-box" onClick={() => props.onCancel?.()}>Cancel</button>
          </Show>
        </div>
      </Collapse>
      <Collapse open={showAdd()}>
        <Switch>
          <Match when={github() && !pasting()}>
            <GitHubDevice again={props.renew} onCancel={props.onCancel} onPaste={() => setPasting(true)} onDone={(login) => {
              nameGitHubSignIn(login);
              props.onDone("github.com", null, login);
            }} />
          </Match>
          <Match when={true}>
            <form class="git-token-form" onSubmit={(e) => void paste(e)}>
              <Show when={noApp()}>
                <p class="hint">Your user server has no GitHub app set up, so MakeWork can't sign in to GitHub. A token works instead.</p>
              </Show>
              <span class="muted">A token for {props.host}:</span>
              <input class="mw-input mw-box" type="password" autocomplete="off" value={token()} onInput={(e) => setTokenText(e.currentTarget.value)} />
              <input class="mw-input mw-box git-token-name" placeholder="Name (optional)" value={name()} onInput={(e) => setName(e.currentTarget.value)}
                title="Without one it is named after the user the host says the token is for" />
              <button class="mw-button mw-box" type="submit" disabled={!token().trim() || saving()}>{saving() ? "Saving..." : props.submitLabel}</button>
              <Show when={github()}>
                <button class="mw-button mw-box" type="button" onClick={() => setPasting(false)}>Sign in to GitHub instead</button>
              </Show>
              <Show when={others().length}>
                <button class="mw-button mw-box" type="button" onClick={() => setAdding(false)}>Pick a saved connection</button>
              </Show>
              <Show when={props.onCancel}>
                <button class="mw-button mw-box" type="button" onClick={() => props.onCancel?.()}>Cancel</button>
              </Show>
            </form>
          </Match>
        </Switch>
      </Collapse>
    </div>
  );
}

// The device flow: start, show the code until GitHub says yes, no or the code ran out.
function GitHubDevice(props: { again?: boolean; onDone: (login: string | null) => void; onCancel?: () => void; onPaste: () => void }) {
  const [signIn, setSignIn] = createSignal<DeviceSignIn | null>(null);
  const [starting, setStarting] = createSignal(false);
  const [error, setError] = createSignal("");
  const { copied, copy: copyCode } = createCopied(2000);
  let current: DeviceSignIn | null = null;
  onCleanup(() => current?.cancel());

  const start = async () => {
    current?.cancel();
    setError("");
    setSignIn(null);
    setStarting(true);
    try {
      const started = await startGitHubSignIn();
      current = started;
      setSignIn(started);
      const result = await started.done;
      if (current !== started) return;
      setSignIn(null);
      if (result.ok) return props.onDone(result.login);
      if (result.reason === "denied") setError("GitHub says the sign-in was declined; nothing was kept.");
      else if (result.reason === "expired") setError("The code ran out before it was entered on GitHub.");
      else if (result.reason === "failed") setError(`GitHub didn't finish the sign-in: ${result.message ?? "no reason given"}.`);
    } catch (e) {
      setError(userMessage(e));
    } finally {
      setStarting(false);
    }
  };
  const copy = () => {
    const code = signIn()?.userCode;
    if (!code) return;
    void copyCode(code);
  };
  const cancel = () => {
    current?.cancel();
    current = null;
    setSignIn(null);
    props.onCancel?.();
  };

  return (
    <div class="git-signin">
      <Switch>
        <Match when={signIn()}>
          <span>Enter this code on github.com (opened in your browser), then approve MakeWork:</span>
          <div class="git-signin-code">
            <code>{signIn()!.userCode}</code>
            <button class="icon-button" title={copied() ? "Copied" : "Copy the code"} aria-label="Copy the code" onClick={copy}>
              <Icon name={copied() ? "check" : "copy"} />
            </button>
          </div>
          <span class="muted git-signin-wait">Waiting for you to approve on github.com...</span>
          <div class="git-signin-actions">
            <button class="mw-button mw-box" onClick={openGitHubDevicePage}><Icon name="link" /> Open GitHub again</button>
            <button class="mw-button mw-box" onClick={cancel}>Cancel</button>
          </div>
        </Match>
        <Match when={true}>
          <Show when={error()}><span class="view-error">{error()}</span></Show>
          <div class="git-signin-actions">
            <button class="mw-button mw-box accent" disabled={starting()} onClick={() => void start()}>
              <Icon name="channel-git" /> {starting() ? "Opening GitHub..." : error() ? "Try again" : props.again ? "Sign in to GitHub again" : "Sign in to GitHub"}
            </button>
            <button class="mw-button mw-box" onClick={props.onPaste}>Paste a token instead</button>
            <Show when={props.onCancel}>
              <button class="mw-button mw-box" onClick={cancel}>Cancel</button>
            </Show>
          </div>
          <span class="muted">MakeWork's own connection: other apps' GitHub sign-ins aren't used.</span>
        </Match>
      </Switch>
    </div>
  );
}
