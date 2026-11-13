// Server settings > Nodes: the nodes that asked to host this server (authorize, ignore, remove), how to add one, and
// for those who manage nodes, a globe of the members who share their location and the node each one uses.
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { shareLocation } from "../core/locationSharing";
import { member, myId } from "../core/members";
import { decideNode, nodeList, nodePage, nodeStorage, removeNode, setNodePage, setNodeStorage, type NodeInfo, type NodeStorage } from "../core/nodes";
import { can } from "../core/roles";
import { addNode } from "../core/serverless";
import { workspaceApi } from "../core/workspaces";
import { showOverlay, workspacePage } from "../core/ui";
import { relativeTime } from "../core/time";
import { askMap, mapAnswers, mapSelf, ownPeer, type Located } from "../p2p/memberMap";
import { closestNode, nodePeers } from "../p2p/nodes";
import { minStripeMb } from "../p2p/pieces";
import { downloadPage } from "../core/updates";
import { Icon } from "../theme/icons";
import Avatar from "../ui/Avatar";
import Collapse from "../ui/Collapse";
import Disclosure from "../ui/Disclosure";
import ConfirmPrompt from "../ui/ConfirmPrompt";
import Popover from "../ui/Popover";
import { createProgressive } from "../ui/progressive";
import { userMessage } from "../api/client";
import NodesGlobe, { type CrowdCardProps, type GlobeLine, type GlobePoint } from "./NodesGlobe";
import { globeMembers, type GlobeMember } from "./globeMembers";
import { createCopied } from "../ui/clipboard";
import { trimEnd } from "../core/text";

const askEveryMs = 5_000;
// How often the globe takes a fresh look at the members and nodes. Read on every frame (the props were getters), they
// were worked out 60 times a second for data that changes every few seconds, and the globe turned choppily.
const globeEveryMs = 1_000;

export default function NodesSettings(props: { workspaceId: string }) {
  const manage = () => can(props.workspaceId, "manage_nodes");
  // Members who use no node and sent no place; the row is hidden while there are none.
  const withoutNode = createMemo(() => withoutPlace(mapAnswers(props.workspaceId), null));
  const byStatus = (status: NodeInfo["status"]) => nodeList(props.workspaceId).filter((n) => n.status === status);
  const [error, setError] = createSignal("");
  const run = async (action: () => Promise<unknown>) => {
    setError("");
    try {
      await action();
    } catch (e) {
      setError(userMessage(e));
    }
  };

  return (
    <div class="settings-section nodes-settings">
      <div class="nodes-layout">
        <div class="nodes-lists">
          <h2>Nodes</h2>
          <p class="hint">
            A node is a computer that stays on and keeps the workspace's files, so members can get them when the person
            who added them is offline. Members connect to the nodes rather than to each other, and get files from the
            closest node that keeps them. A node can read everything in the workspace, like any member.
          </p>
          <Copies workspaceId={props.workspaceId} run={run} />
          <Calls workspaceId={props.workspaceId} run={run} />
          <Show when={manage()}><LocationStats workspaceId={props.workspaceId} /></Show>
          <Show when={byStatus("pending").length > 0}>
            <h3>Waiting for authorization</h3>
            <ul class="workspace-members">
              <For each={byStatus("pending")}>{(node) => <NodeRow workspaceId={props.workspaceId} node={node} run={run} />}</For>
            </ul>
          </Show>

          <h3>Authorized</h3>
          <Show when={byStatus("authorized").length > 0} fallback={<p class="hint">No authorized nodes yet.</p>}>
            <ul class="workspace-members">
              <For each={byStatus("authorized")}>{(node) => <NodeRow workspaceId={props.workspaceId} node={node} run={run} />}</For>
              <Show when={manage() && withoutNode().length > 0}>
                <li class="node-without-item">
                  <WithoutAPlace workspaceId={props.workspaceId} members={withoutNode()} label="Not connected to a node" />
                </li>
              </Show>
            </ul>
          </Show>

          <Show when={byStatus("ignored").length > 0}>
            <h3>Ignored</h3>
            <ul class="workspace-members">
              <For each={byStatus("ignored")}>{(node) => <NodeRow workspaceId={props.workspaceId} node={node} run={run} />}</For>
            </ul>
          </Show>
          <Show when={error()}><p class="warning">{error()}</p></Show>
          <AddNode workspaceId={props.workspaceId} />
        </div>

        <Show when={manage()}>
          <div class="nodes-map">
            <MemberMap workspaceId={props.workspaceId} />
          </div>
        </Show>
      </div>
    </div>
  );
}

// How the nodes keep files: how many of them keep each file, big files (20 GB and more) split into pieces across them,
// and parity instead of copies for those pieces. When a node is gone for a while, the others copy (or rebuild) what
// it kept.
function Copies(props: { workspaceId: string; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const value = () => nodeStorage(props.workspaceId);
  const manage = () => can(props.workspaceId, "manage_nodes");
  const change = (changes: Partial<NodeStorage>) => void props.run(() => setNodeStorage(workspaceApi(props.workspaceId), changes));
  const minGb = () => Math.max(1, Math.ceil(minStripeMb() / 1024));
  const [refused, setRefused] = createSignal(false);
  const setStripeGb = (input: HTMLInputElement) => {
    const gb = Number(input.value);
    if (!Number.isFinite(gb) || gb < minGb()) {
      input.value = String(Math.round(value().stripeMb / 1024));
      setRefused(true);
      return;
    }
    setRefused(false);
    change({ stripeMb: Math.round(gb * 1024) });
  };
  return (
    <div class="nodes-copies">
      <span>Copies of each file</span>
      <Show when={manage()} fallback={<strong>{value().copies}</strong>}>
        <button class="mw-button mw-box" aria-label="Fewer copies" disabled={value().copies <= 1} onClick={() => change({ copies: value().copies - 1 })}>
          <Icon name="remove" />
        </button>
        <strong>{value().copies}</strong>
        <button class="mw-button mw-box" aria-label="More copies" disabled={value().copies >= 9} onClick={() => change({ copies: value().copies + 1 })}>
          <Icon name="add" />
        </button>
      </Show>
      <span class="hint">More copies survive more nodes being offline at once; fewer use less disk on each node.</span>
      <label class="settings-check">
        <input type="checkbox" checked={value().stripeMb > 0} disabled={!manage()}
          onChange={(e) => change({ stripeMb: e.currentTarget.checked ? minStripeMb() : 0 })} />
        Split big files into pieces across the nodes
      </label>
      <Collapse open={value().stripeMb > 0}>
        <label class="settings-field">
          <span>Files of</span>
          <input class="mw-input mw-box" type="number" min={minGb()} step="1" disabled={!manage()} value={Math.round(value().stripeMb / 1024)}
            onChange={(e) => setStripeGb(e.currentTarget)} />
          <span>GB and more</span>
        </label>
      </Collapse>
      <span class="hint">
        No node holds a split file whole: each keeps some of its pieces, and serves the file to members piece by
        piece. {refused() ? `Files under ${minGb()} GB are always kept whole.` : `Smaller files are kept whole; ${minGb()} GB is the least.`}
      </span>
      <label class="settings-check">
        <input type="checkbox" checked={value().parity > 0} disabled={!manage() || value().stripeMb === 0}
          onChange={(e) => change({ parity: e.currentTarget.checked ? 4 : 0 })} />
        Parity instead of copies for pieces
      </label>
      <span class="hint">
        With parity each piece is kept once, plus one parity piece for every 4 pieces, on another node: a lost piece is
        rebuilt from the others. It uses about a quarter more disk
        {value().copies > 1 ? ` instead of ${value().copies} times as much` : " than one copy"}, but rebuilding needs the
        other nodes of the group to be online.
      </span>
    </div>
  );
}

// Calls through the nodes (ADR 0005): a call of this many members stops being sent member-to-member and goes through
// one node instead, which forwards it. Small calls stay a mesh (nothing to forward, and the members' media stays
// between them); a node sees the media of the calls it serves, unlike a mesh call.
function Calls(props: { workspaceId: string; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const value = () => nodeStorage(props.workspaceId);
  const manage = () => can(props.workspaceId, "manage_nodes");
  const change = (changes: Partial<NodeStorage>) => void props.run(() => setNodeStorage(workspaceApi(props.workspaceId), changes));
  return (
    <div class="nodes-calls">
      <label class="settings-check">
        <input type="checkbox" checked={value().sfuCalls} disabled={!manage()}
          onChange={(e) => change({ sfuCalls: e.currentTarget.checked })} />
        Calls go through this server's nodes
      </label>
      <Collapse open={value().sfuCalls}>
        <span class="hint">
          A node sees the media of the calls it serves (it forwards them to the members), unlike a mesh call where
          members send to each other. Small calls stay a mesh.
        </span>
        <label class="settings-check">
          <input type="checkbox" checked={value().sfuForced} disabled={!manage()}
            onChange={(e) => change({ sfuForced: e.currentTarget.checked })} />
          Even for small calls
        </label>
        <Collapse open={!value().sfuForced}>
          <label class="settings-field">
            <span>From</span>
            <input class="mw-input mw-box" type="number" min={2} max={100} step="1" disabled={!manage()} value={value().sfuMinMembers}
              onChange={(e) => change({ sfuMinMembers: Math.max(2, Math.min(100, Math.round(Number(e.currentTarget.value)) || 2)) })} />
            <span>members</span>
          </label>
        </Collapse>
        <label class="settings-field">
          <span>One node takes up to</span>
          <input class="mw-input mw-box" type="number" min={1} max={500} step="1" disabled={!manage()} value={value().sfuCapacity}
            onChange={(e) => change({ sfuCapacity: Math.max(1, Math.min(500, Math.round(Number(e.currentTarget.value)) || 1)) })} />
          <span>members of a call</span>
        </label>
        <span class="hint">More go to the next node, and the nodes link so everyone still hears everyone.</span>
      </Collapse>
    </div>
  );
}

function NodeRow(props: { workspaceId: string; node: NodeInfo; run: (action: () => Promise<unknown>) => Promise<void> }) {
  const api = () => workspaceApi(props.workspaceId);
  const manage = () => can(props.workspaceId, "manage_nodes");
  const peer = () => nodePeers(props.workspaceId).find((p) => p.user === props.node.userId);
  const place = () => [props.node.city, props.node.country].filter(Boolean).join(", ");
  const decided = () => props.node.decidedBy === null ? "" : member(props.workspaceId, props.node.decidedBy).displayName;
  const [removing, setRemoving] = createSignal(false);
  const state = () => {
    if (props.node.status === "pending") return `Asked ${relativeTime(props.node.createdAt)}`;
    if (props.node.status === "ignored") return decided() ? `Ignored by ${decided()}` : "Ignored";
    const reached = peer();
    if (!reached) return "Not reached now";
    const parts = [reached.rtt === null ? "Online" : `Online, ${Math.round(reached.rtt)} ms`];
    if (reached.app) parts.push(`version ${reached.app}`);
    if (closestNode(props.workspaceId) === props.node.userId) parts.push("you use this one first");
    const using = new Set(mapAnswers(props.workspaceId).filter((m) => m.place !== null && m.via === props.node.userId).map((m) => m.user)).size;
    if (using) parts.push(`used first by ${using} shown on the globe`);
    return parts.join(" · ");
  };
  const decide = (status: NodeInfo["status"]) => props.run(() => decideNode(api(), props.node.userId, status));
  return (
    <li class="workspace-member node-row">
      <Show when={props.node.status === "authorized" && manage()}>
        <WithoutAPlace workspaceId={props.workspaceId} members={withoutPlace(mapAnswers(props.workspaceId), props.node.userId)}
          label={`Connected without location`} />
      </Show>
      <Avatar user={member(props.workspaceId, props.node.userId)} size={32} />
      <div class="workspace-member-names node-names">
        <span>
          {props.node.name}
          <span class="node-dot" classList={{ online: !!peer() }} aria-hidden="true" />
        </span>
        <span class="hint">{state()}</span>
      </div>
      <div class="node-facts">
        <span title="Address"><Icon name="globe" size={14} /> {props.node.address || "address unknown"}{place() ? ` · ${place()}` : ""}</span>
        <Show when={nodePage(props.node)}>
          {(page) => <a href={page()} target="_blank" rel="noopener"><Icon name="link" size={14} /> {page()}</a>}
        </Show>
        <Show when={manage() && props.node.status === "authorized"}>
          <label class="node-page">
            <span>Invite page {props.node.url ? `${trimEnd(props.node.url, "/")}/` : "/"}</span>
            <input class="mw-input mw-box" value={props.node.page} placeholder="none" maxLength={64} aria-label="Invite page path"
              onChange={(e) => {
                const input = e.currentTarget;
                void props.run(async () => {
                  try {
                    await setNodePage(api(), props.node.userId, input.value.trim());
                  } catch (error) {
                    input.value = props.node.page;
                    throw error;
                  }
                });
              }} />
          </label>
        </Show>
      </div>
      <Show when={manage()}>
        <div class="workspace-member-ban">
          <div class="workspace-member-actions">
            <Show when={props.node.status !== "authorized"}>
              <button class="mw-button primary mw-box" onClick={() => void decide("authorized")}>Authorize</button>
            </Show>
            <Show when={props.node.status !== "ignored"}>
              <button class="mw-button mw-box" onClick={() => void decide("ignored")}>
                {props.node.status === "authorized" ? "Stop using" : "Ignore"}
              </button>
            </Show>
            <button class="mw-button mw-box" onClick={() => setRemoving(!removing())}>Remove</button>
          </div>
          <ConfirmPrompt open={removing()} confirmLabel="Remove" onCancel={() => setRemoving(false)}
            question={`Remove ${props.node.name}? If it keeps running it asks again and waits for authorization. To keep it out, ignore it instead.`}
            onConfirm={() => {
              setRemoving(false);
              void props.run(() => removeNode(api(), props.node.userId));
            }} />
        </div>
      </Show>
    </li>
  );
}

// How many of the other members online share their location, and how those who don't are connected.
function LocationStats(props: { workspaceId: string }) {
  const stats = createMemo(() => {
    const byUser = new Map<number, Located>();
    for (const m of mapAnswers(props.workspaceId)) if (!byUser.has(m.user) || m.place !== null) byUser.set(m.user, m);
    const hidden = [...byUser.values()].filter((m) => m.place === null);
    return { total: byUser.size, hidden: hidden.length, onNode: hidden.filter((m) => m.via !== null).length };
  });
  return (
    <Show when={stats().total > 0}>
      <p class="hint nodes-location-stats mw-fade-in">
        Other members online: {stats().total} · sharing their location: {stats().total - stats().hidden} · not
        sharing: {stats().hidden}
        <Show when={stats().hidden > 0}> ({stats().onNode} through a node, {stats().hidden - stats().onNode} not connected to a node)</Show>
      </p>
    </Show>
  );
}

// Members who sent no place: those whose first node is `node` (or all of them when `node` is null), deduped by member.
function withoutPlace(answers: Located[], node: number | null): Located[] {
  const seen = new Set<number>();
  const result: Located[] = [];
  for (const m of answers) {
    if (m.place !== null || m.via !== node || seen.has(m.user)) continue;
    seen.add(m.user);
    result.push(m);
  }
  return result;
}

// A compact avatars row for members with no place: in the node list under their first node, or one row for those
// who use no node. Clicking it lists their names.
function WithoutAPlace(props: { workspaceId: string; members: Located[]; label: string }) {
  const [open, setOpen] = createSignal(false);
  return (
    <Show when={props.members.length > 0}>
      <div class="node-without">
        <button class="node-without-row" aria-expanded={open()} onClick={() => setOpen(!open())}>
          <div class="node-without-avatars">
            <For each={props.members.slice(0, 4)}>
              {(m) => <Avatar user={member(props.workspaceId, m.user)} size={18} />}
            </For>
          </div>
          <span class="hint">{props.label}: {props.members.length}</span>
        </button>
        <Popover open={open()} onClose={() => setOpen(false)} placement="below" label={props.label}>
          <div class="node-without-names">
            <For each={props.members}>
              {(m) => (
                <div class="mw-menu-item">
                  <Avatar user={member(props.workspaceId, m.user)} size={20} />
                  <span>{member(props.workspaceId, m.user).displayName}</span>
                </div>
              )}
            </For>
          </div>
        </Popover>
      </div>
    </Show>
  );
}

function MemberMap(props: { workspaceId: string }) {
  const nodes = () => nodeList(props.workspaceId).filter((n) => n.status !== "ignored");
  // Answers come in over the next moments; you are added from this device.
  const [self, setSelf] = createSignal<Located | null>(null);
  // What the globe shows, looked at once a second (`globeEveryMs`), not on its every frame.
  const [globe, setGlobe] = createSignal<{ points: GlobePoint[]; lines: GlobeLine[] }>({ points: [], lines: [] });
  const look = () => setGlobe(untrack(() => ({ points: points(), lines: lines() })));
  onMount(() => {
    const refresh = () => {
      askMap(props.workspaceId);
      void mapSelf(props.workspaceId).then((place) => {
        setSelf(place);
        look();
      });
    };
    refresh();
    look();
    const timer = setInterval(refresh, askEveryMs);
    const looking = setInterval(look, globeEveryMs);
    onCleanup(() => {
      clearInterval(timer);
      clearInterval(looking);
    });
  });
  const located = createMemo(() => [...(self() ? [self()!] : []), ...mapAnswers(props.workspaceId)]);
  // One dot and one row per member, however many peers they answer from (globeMembers.ts); members who sent no place
  // stay off the globe and are listed under their node instead.
  const merged = createMemo(() => globeMembers({
    me: myId(props.workspaceId), ownPeer: ownPeer(), self: self(), answers: mapAnswers(props.workspaceId),
    now: Date.now(), recentMs: 2 * askEveryMs + 1_000,
  }));
  // Kept by member, so the list's and crowd cards' rows stay when answers come in again (each ask makes new objects).
  const [people, setPeople] = createStore<GlobeMember[]>([]);
  createEffect(() => setPeople(reconcile(merged().members, { key: "user" })));
  const online = () => new Set(nodePeers(props.workspaceId).map((p) => p.user));
  // Members (you too) whose first node it is, sharing their location or not.
  const usersOf = createMemo(() => {
    const users = new Map<number, Set<number>>();
    for (const m of located()) if (m.via !== null) (users.get(m.via) ?? users.set(m.via, new Set()).get(m.via)!).add(m.user);
    return users;
  });
  const nodeLabel = (n: NodeInfo) => {
    const count = usersOf().get(n.userId)?.size ?? 0;
    return `${n.name} · ${count} ${count === 1 ? "member" : "members"}`;
  };
  const points = (): GlobePoint[] => {
    const reached = online();
    return [
      ...nodes().filter((n) => n.lat !== null && n.lon !== null).map((n) => ({
        key: `node:${n.userId}`, lon: n.lon!, lat: n.lat!, kind: "node" as const, label: nodeLabel(n), online: reached.has(n.userId),
      })),
      ...people.map((m) => ({
        key: `member:${m.user}`, lon: m.place.lon, lat: m.place.lat, kind: "member" as const, self: m.self,
        label: [member(props.workspaceId, m.user).displayName, m.place.country, devicesText(m)].filter(Boolean).join(" · "),
      })),
    ];
  };
  const lines = (): GlobeLine[] => {
    const drawn = new Set(nodes().filter((n) => n.lat !== null && n.lon !== null).map((n) => n.userId));
    return [
      ...merged().nodeLines.filter((l) => drawn.has(l.node))
        .map((l): GlobeLine => ({ from: `member:${l.user}`, to: `node:${l.node}`, kind: "node", flow: l.flow })),
      ...merged().memberLines.map((l): GlobeLine => ({ from: `member:${l.from}`, to: `member:${l.to}`, kind: "member", flow: l.flow })),
    ];
  };
  const nodeName = (userId: number | null) => nodeList(props.workspaceId).find((n) => n.userId === userId)?.name;
  // The globe's points' keys back to the members they show, for its crowd cards.
  const byKey = createMemo(() => new Map(people.map((m) => [`member:${m.user}`, m])));
  const card = (card: CrowdCardProps) => <CrowdCard {...card} workspaceId={props.workspaceId} byKey={byKey()} nodeName={nodeName} />;
  return (
    <>
      <h2>Members</h2>
      <p class="hint">Only members who allowed sharing their location. Members who didn't are listed under their node.
        Only people who manage nodes see this; it isn't stored.</p>
      <NodesGlobe points={globe().points} lines={globe().lines} card={card} />
      <Show when={!shareLocation()}>
        <p class="hint">You aren't on the globe: turn on "Show my rough location to workspace admins" in Settings, Profile.</p>
      </Show>
      <Show when={people.length > 0} fallback={<p class="hint">No member online shares their location right now.</p>}>
        <ul class="node-located">
          <For each={people}>
            {(m) => (
              <li>
                <Avatar user={member(props.workspaceId, m.user)} size={20} />
                <span>{member(props.workspaceId, m.user).displayName}</span>
                <span class="hint">{memberHint(m, nodeName, true)}</span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <p class="hint node-credit">Members are placed by their time zone, nodes by their address (DB-IP). Map data from Natural Earth.</p>
    </>
  );
}

// Rows a crowd card shows while only hovered.
const peekRows = 5;

// "2 devices" for a member answering from several peers (two copies of the app, a view window), else nothing.
function devicesText(m: GlobeMember): string {
  return m.devices > 1 ? `${m.devices} devices` : "";
}

// What a member's row says after their name, in the list under the globe and in crowd cards: their country (`country`),
// their first node, and how many devices.
function memberHint(m: GlobeMember, nodeName: (userId: number | null) => string | undefined, country: boolean): string {
  return [country ? m.place.country : "", nodeName(m.via) ?? "", devicesText(m)].filter(Boolean).join(" · ");
}

// The members of a crowd who don't fit on the globe around their place: the place's country (each row's own when the
// crowd joins places of several), then a row per member; a few while hovered, all of them once clicked.
function CrowdCard(props: CrowdCardProps & {
  workspaceId: string; byKey: Map<string, GlobeMember>; nodeName: (userId: number | null) => string | undefined;
}) {
  // A row per point, which is a member (globeMembers.ts).
  const people = createMemo(() => props.keys.flatMap((key) => props.byKey.get(key) ?? []));
  const countries = createMemo(() => [...new Set(people().map((m) => m.place.country))]);
  const rows = createProgressive(() => (props.peek ? people().slice(0, peekRows) : people()), { from: "start", first: 40 });
  const more = () => (props.peek ? people().length - peekRows : 0);
  const hint = (m: GlobeMember) => memberHint(m, props.nodeName, countries().length > 1);
  return (
    <>
      <p class="nodes-globe-card-title">{countries().length === 1 ? countries()[0] : "Several places"} · {people().length} {people().length === 1 ? "member" : "members"}</p>
      <ul class="node-located">
        <For each={rows.shown()}>
          {(m) => (
            <li>
              <Avatar user={member(props.workspaceId, m.user)} size={20} />
              <span>{member(props.workspaceId, m.user).displayName}</span>
              <Show when={hint(m)}><span class="hint">{hint(m)}</span></Show>
            </li>
          )}
        </For>
      </ul>
      <Show when={more() > 0}><p class="hint">… {more()} more, click to see all</p></Show>
    </>
  );
}

// The ports the steps name: the start command asks for exactly these, so the ports to forward match what the node
// listens on. Members' call media comes in on the range's first port (node/config.ts `mediaPort`), links between nodes
// serving one call take the rest; a small range so a home router can forward it.
const callPort = 40000;
const linkPorts = `${callPort + 1}-${callPort + 100}`;
const webPort = 8080;

// A node is added from the code it prints (p2p/pair.ts): it is authorized at once and gets this workspace, with no
// invite. Its invite page shows the newest invite created with "Show on the nodes' invite pages".
function AddNode(props: { workspaceId: string }) {
  const manage = () => can(props.workspaceId, "manage_nodes");
  const [open, setOpen] = createSignal(false);
  const [code, setCode] = createSignal("");
  const [page, setPage] = createSignal("");
  const [step, setStep] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [added, setAdded] = createSignal(false);
  const add = async () => {
    setError("");
    setAdded(false);
    setBusy(true);
    try {
      await addNode(props.workspaceId, code(), page().trim(), setStep);
      setAdded(true);
      setCode("");
      setPage("");
    } catch (e) {
      setError(e instanceof Error ? e.message : userMessage(e));
    } finally {
      setBusy(false);
      setStep("");
    }
  };
  return (
    <div class="node-add">
      <h3>Add a node</h3>
      <Show when={manage()} fallback={<p class="hint">Adding a node needs Manage nodes.</p>}>
        <p class="hint">Paste the code the node printed when it started. It is added at once and needs no invite.</p>
        <div class="node-add-form">
          <input class="mw-input mw-box" placeholder="mwn1.…" aria-label="Node code" value={code()} disabled={busy()}
            onInput={(e) => setCode(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && code().trim() && !busy() && void add()} />
          <input class="mw-input mw-box" placeholder="Invite page path (optional)" aria-label="Invite page path" value={page()} disabled={busy()}
            maxLength={64} onInput={(e) => setPage(e.currentTarget.value)} />
          <button class="mw-button primary mw-box" disabled={busy() || !code().trim()} onClick={() => void add()}>Add node</button>
        </div>
        <Collapse open={busy() || !!error() || added()}>
          <Switch>
            <Match when={busy()}><p class="hint node-add-step"><span class="mw-spinner" /> {step()}</p></Match>
            <Match when={error()}><p class="warning">{error()}</p></Match>
            <Match when={added()}><p class="hint">Added. It shows under Authorized once it is online.</p></Match>
          </Switch>
        </Collapse>
        <p class="hint">
          Its invite page shows the newest invite created with "Show on the nodes' invite pages".{" "}
          <button class="node-help-toggle node-inline-link" onClick={() => showOverlay(workspacePage(props.workspaceId, "invite"))}>Open Invite settings</button>
        </p>
      </Show>
      <Disclosure class="node-help-toggle" open={open()} onToggle={() => setOpen(!open())}>How to set up a node?</Disclosure>
      <Collapse open={open()}>
        <ol class="node-steps">
          <li>
            <span>
              On a computer that stays on, install Node.js 22 or newer. Then get the node from{" "}
              <a href={downloadPage} target="_blank" rel="noopener noreferrer">makework.dev/download</a> and unpack it.
            </span>
            <Command text="tar -xzf makework-node.tar.gz" />
          </li>
          <li>
            <span>Go into the <code>makework-node</code> folder it made and install what it needs.</span>
            <Command text="npm install --omit=dev" />
          </li>
          <li>
            <span>Start it with the address its invite pages are reached at. It prints its code.</span>
            <Command text={`node makework-node.mjs start --url https://your.host --rtc-ports ${callPort}-${callPort + 100}`} />
          </li>
          <li>
            <span>If it is behind a router, forward these ports to that computer. Allow them in its firewall too.</span>
            <ul class="node-ports">
              <li><code>{callPort}</code> UDP and TCP: calls through the node.</li>
              <li><code>{linkPorts}</code> UDP: calls shared with this workspace's other nodes.</li>
              <li><code>{webPort}</code> TCP: its invite pages, unless a web server in front of it serves your address.</li>
            </ul>
            <span class="hint">Syncing and files need no open port. Without the call ports, calls stay between members.</span>
          </li>
          <li>
            <span>Paste its code above. To see it again on the node:</span>
            <Command text="node makework-node.mjs code" />
          </li>
        </ol>
        <p class="hint">
          To update it, unpack a newer download over that folder, run the install again and restart the node. Its
          workspaces and files stay: they are kept in <code>.makework-node</code> in your home folder.
        </p>
      </Collapse>
    </div>
  );
}

// A command to type, with a button that copies it.
function Command(props: { text: string }) {
  const { copied, copy: copyText } = createCopied();
  const copy = () => copyText(props.text);
  return (
    <div class="node-command">
      <code class="workspace-invite mw-box">{props.text}</code>
      <button class="mw-button mw-box" title="Copy" aria-label="Copy command" onClick={() => void copy()}>
        <Icon name={copied() ? "check" : "copy"} />
      </button>
    </div>
  );
}
