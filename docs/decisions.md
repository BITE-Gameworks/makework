# Design decisions

The decisions that shape the code, with what was rejected and why. Code comments cite them as "ADR nnnn". Numbers
are never reused; 0018 was never used here. A new decision gets the next number and a short section in the same
shape: what was decided, why, what was considered, what follows.

## 0001 Map answers from members who don't share their location

Everyone in a workspace answers the Nodes page's map ask (a signed `map-place` message) with their primary node and
direct peers. Only members who opted in to sharing their rough location include a `place`. The opt-in is about
location, and node use or direct links aren't location; the asker still needs Manage nodes and every answer is
signed. An absent place is an empty segment in the signed text, so older apps' signatures stay valid.

## 0002 Forgotten channels are device-local only

"Remove from this device" marks a channel forgotten on this device: its sync marks are cleared, its content is freed
once nothing else keeps it, readable-folder copies the app wrote are removed, nothing more is fetched, and the channel
stays dimmed in the bar until it is synced again. The signed rows are never touched: every member replays the whole
log to check permissions, so deleting commits would fork the workspace.

## 0003 Preferences follow the account

The profile (display name, color, avatar) and a set of preferences follow the account to every computer. The profile
carries `updatedAt` and the user server keeps the newest. Preferences live in the encrypted `prefs` vault document
(`core/vault.ts`, `core/syncedPrefs.ts`): theme, icon and sound packs, volume, editor mode, notifications, typing and
online indicators, workspace order and groups. Only changed keys are written, two seconds after a change stops, so
two computers never overwrite each other's unrelated changes. Device-bound choices (audio devices, per-member
volumes, panel widths, readable-folder setup) stay on the computer.

## 0004 All rooms pin one relay list

Every Trystero room uses the same fixed relay list from `p2p/relays.ts`. Trystero's defaults differ per app id and
version, and two devices that share no relay never meet. The list is shared state on purpose; the mesh test reads the
same file.

## 0005 Calls through a self-hosted SFU on nodes

Calls above a size (default 5) or in a workspace that asks for it go through a mediasoup SFU on an authorized node,
not a full mesh or a hosted media service. Nodes are always on and every member already reaches them. The node is the
single arbiter of a call's mode, so all callers agree on the transport; the node is picked by rendezvous hashing of
the channel id over the authorized nodes. Rejected: LiveKit or Cloudflare Calls (a hosted dependency that sees
everyone's media) and a mesh at every size (uploads grow with callers). A call through a node isn't end to end: the
node terminates SRTP.

## 0006 Screen-share quality is tuned on the sender

Splitting media into parallel streams adds no bandwidth: a call's streams share one connection and congestion
controller. The share is tuned where it is encoded, through the `MediaLink` seam, so a mesh call and a call through a
node apply the same model. Through a node the sharer uploads one copy, which is the way to many viewers. Partly
superseded by 0011 and 0025.

## 0007 A call split across nodes is bridged

A node serves at most `sfu_capacity` members of a call; the next ones go to the next node in the call's order. The
nodes serving a call link to each other with mediasoup pipe transports (plain RTP over the `--rtc-ports` range, RTX,
SRTP), and each node pipes only its own members' producers, so nothing loops and a node going away takes only its own
members. Capacity is counted and the member joined in one step. When every node a member reaches is full, the first
takes it anyway (`SfuJoin.last`): capacity decides where members go first, not whether they get in. Nodes talk over
`sfu-bridge` (`serving`, `link`, `pipe`, `unpipe`, `unlink`); the node with the smaller user number links. A node
without a public address doesn't bridge. Rejected: a mesh fallback over capacity, capacity for new calls only, and a
cascade through one primary node.

## 0008 Policy rules read the commit's time

Every member replays each commit through the same policy and must reach the same verdict, so a rule never reads the
clock. `PolicyContext.time` is the commit's signed time; a local write stamps it once and signs the same time. The time
is the author's claim and is only checked to be a number, so a future time can at most stretch a rule for someone who
already has the permission.

## 0009 Windows are independent app instances

Each desktop window runs the same client and connects as its own peer; windows share no renderer state. A popped-out
tab becomes a view window that attaches only its own workspace and hands everything else to the main window, which
alone owns account-wide effects (notifications, sounds, badge, private messages, calls, bots) and the saved tabs. A view
window takes no part in call presence, and voice channels never pop out. A code channel's terminal can move to a
terminal window, which opens no workspace and takes over the running process from the main process. Two windows on
one channel are two peers, so presence and typing show twice.

## 0010 Channel views are kept

Channel views stay mounted, hidden, after the member leaves the channel, so coming back doesn't refetch and replay the
gradual reveal. At most eight are kept (least recently shown go first, ones with an open tab never); a type may opt
out. A hidden view goes quiet: events only mark it stale, and showing it refreshes it once. Panels still close on
leave.

## 0011 Voice goes first in calls

Every sender carries a priority: microphones high, a share's sound medium, pictures low, in a mesh and through a node
alike (`voice/shareQuality.ts`). The copies of a shared picture share an upload budget (8 Mbit/s), since a congested
upload delays every packet whatever its priority.

## 0012 Custom emoji are workspace content

A custom emoji is a small image stored as workspace content (`mwc:` ref) with a row in the `emoji` plugin; its
shortcode name is what travels in text and reactions. Names are 2 to 32 of `a-z0-9_`, never a standard shortcode, and
stay reserved after removal (removing hides it, so old messages still render). Managing them needs `manage_emojis`.

## 0013 Workspace order follows the account

The workspace bar order is a personal preference in the `prefs` vault document (and on each device under the account),
never in the signed log. Left workspaces keep their slot, unknown ones go after. The category order uses the same path.

## 0014 Workspace groups follow the account

Workspaces can be folded into groups in the bar: one tile, opening inline, no nesting, a workspace in at most one
group. Groups are personal (`mw.workspaceGroups` in `prefs`); a group's place in the order is a `group:<id>` token.
Whether a group is open is a device setting.

## 0015 Routes carry their whole path

Members reach each other through more than one go-between (node groups, the grid). Peers that relay (`shareRoutes`)
send their route table: each peer with the go-betweens on the way. A receiver takes a route only when it names no peer
twice, doesn't name the receiver, leads to a peer it doesn't reach directly, and has at most three go-betweens; it keeps
the shortest. Lists are numbered and sent as changes (`base`, `add`, `remove`), with a periodic "nothing changed" and a
full list on a mismatch. A route that went round is visible and dropped, which ended the ghost members of the earlier
far lists.

## 0016 Conflicts are resolved before the merge

A merge from a version control channel that would conflict is resolved before the working copy changes: the member
picks lines or sides per conflict from the three versions, then the merge tree is built on a scratch index, committed
with `commit-tree` and the branch fast-forwarded. The working copy is never left half merged. Merges started outside
the app are left to the member's own tools.

## 0017 A reading place is a message the reader chose

A message list opens at its newest message and follows growth until the member scrolls up themselves. From then on
the reading place is the message at the top of the view and its offset, and every growth puts it back. A place is
remembered for the session only once the list has settled; a pixel offset was wrong whenever the list was rebuilt.

## 0019 P2p calls go only over direct links between callers

Nobody passes media on, member or node: a stream goes only over the direct link to its receiver. A go-between had to
decode and encode every copy and overloaded. The call's room links every pair of callers, with TURN. Pictures go only
to their viewers (callers whose call view shows them, kept 10 s after looking away); the others get the share's sound.
A screen's copies share 8 Mbit/s (at least 0.5 each), a camera's 3 Mbit/s. Messages still pass through go-betweens.
A pair with neither a direct path nor TURN hears nothing.

## 0020 Component instances are linked copies

A design component instance is a frame (`props.instanceOf`) whose layers are ordinary rows copying the main's layers
(`props.master`, `props.overrides`). Whoever changes a document brings every instance up to date (`planSync`,
`design/components.ts`); the sync is idempotent and runs after each change, undo and redo of that member. Rejected:
drawing instances from their main at render time (every row-based feature would need a second path).

## 0021 Chat is encrypted with channel keys

Every member device gets all of a workspace's data, so chat text (and poll answers, attachment names and previews, a
bot's steps) is sealed with its channel's key (AES-256-GCM, bound to channel and author) before it enters the ledger.
Keys come in epochs (`chat_keys`), each granted to the members who may read the channel, sealed to their account key
(`chat_key_grants`). Any member who can read a channel keeps its keys moving (`p2p/chatKeyring.ts`) and starts a new
epoch when someone loses access. Guests (`members_invites.guest`) only get epochs from after they joined. Attached
files themselves aren't encrypted; nodes can't read chat.

## 0022 Artboards fold into design

Artboard features (notes, arrange, normalize, rotate) moved into design channels, and the artboard view and type are
gone. Old artboard channels aren't converted; the data side (`system/artboard.ts`) and its policy rule stay, because
every member replays the commits in the signed history.

## 0023 Release builds from any project

A git channel's New release page builds from the chosen branch as committed, in a temporary worktree. Common project
kinds are known (`electron/release.js`); anything else uses build configurations saved in the channel (`git_builds`).
They run commands on other members' computers, so every device asks before running one someone else changed last
(`core/approvedCommands.ts`).

## 0024 Watch parties play local copies

A watch party plays video files from a files channel on every member's device and only keeps the copies in step. The
party is a synced row (`watch` plugin); while it plays, members keep in step through the voice channel's events. The
playing member with the lowest id answers newcomers; copies more than 0.75 s off jump back in step.

## 0025 A share's chosen bitrate is its whole upload

A member picks resolution (720p, 1080p, 1440p), frame rate (30, 60), what to favour, and a bitrate (Auto, or 1 to 30
Mbit/s). In a mesh a chosen bitrate is the whole upload, split between the copies (each at least 0.5 Mbit/s); Auto
keeps 0019's per-copy rates within 8 Mbit/s. Through a node the one copy gets all of it (no simulcast yet).

## 0026 Recovery copies are opt-in, and accounts can be deleted

A recovery copy (the account key encrypted with the user server's `RECOVERY_SECRET`) lets whoever runs the server act
as the account, so no account gets one unless its owner turns it on. A forgotten password then needs the recovery key
or another computer still signed in. Accounts can be deleted (`DELETE /me`); the id stays in `deleted_accounts` so it
can't be published again.

## 0027 Password sign-ins need a second step

The password alone doesn't get an account's key from the user server. A password sign-in on a computer that doesn't
hold the account also takes a code from the account's authenticator app (TOTP, RFC 6238, with ten one-time backup
codes) when the owner turned one on, else a code mailed to the account's email. With an authenticator app the recovery
copy takes its code too, or the email alone would get the key. Sign-ins on a computer that already holds the account
are local and ask for nothing. Google and GitHub sign-ins are left to those providers. Accounts from before emails,
without an authenticator app, have nowhere to send a code and sign in with the password.
