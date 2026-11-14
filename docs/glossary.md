# MakeWork

MakeWork is an extensible communication and collaboration platform: the client app, its serverless
workspaces (signed, peer-to-peer), and two Cloudflare workers. This glossary covers concepts unique to the
project; general programming terms don't belong here.

## Language

**place**:
The rough location (`{lat, lon, country}`) a member optionally shares with the Nodes page. Sent only
when the member opted in. A map answer always has a place field, but it is `null` when not shared.
_Avoid_: location, position

**crowd**:
The members and nodes the Nodes page globe draws around one place (or a few places too close to tell apart at
the current zoom), each on a spot of its own, scattered but always a little apart.
_Avoid_: cluster, group

**crowd badge**:
The "+N" marker standing in for a crowd's members who don't fit around its place. Zooming in fits more.

**crowd card**:
The table a crowd badge opens on the globe: a few of its members while hovered, all of them once clicked.

**map ask**:
The signed mesh message ("map-ask") the Nodes page broadcasts to collect each member's place, primary
node, direct peers and (when shared) traffic. Every member answers (signed), even without opting in.

**map answer**:
A peer's signed reply ("map-place") to a map ask; a member running several peers sends several, and the globe
draws the member once. When the peer shares its place the answer includes it; otherwise the place field is `null`
and only the primary node and direct peers are sent.

**primary node**:
The authorized node a member is reached through with the lowest RTT. Reported in map answers as `via`;
the NodeLink's `closest()`.
_Avoid_: first node, closest node

**peer**:
One running copy of the app (a main window, a view window or a browser tab) connected to a workspace, known by its
peer id for as long as its page lives. A member can have several at once (two devices, a view window), and a
restart or reload makes a new one; the old one is gone once the others notice.
_Avoid_: device (one device can run several peers), session (a room session is one stay in one room)

**direct peer**:
Another peer this one is connected to directly (no go-between). Map answers carry a peer's direct peers as peer
ids.

**relayed peer**:
A peer this one reaches through one or more go-betweens (its route) instead of directly.

**go-between**:
The node or member that passes messages on for a relayed peer. Never media: a call's streams go only over the
callers' direct links.
_Avoid_: relay (that word is for Nostr relays), middle member

**route**:
The go-betweens, in order, that a device's messages to a relayed peer pass through; at most three.
_Avoid_: relay path, relay link

**route table**:
A device's routes, one for each relayed peer it reaches.
_Avoid_: relay table

**route list**:
What a node or a grid member tells its direct peers of its route table. The receiver's copy always stands for the
sender's latest list, so a route nobody tells any more is gone.
_Avoid_: relay list (that is the Nostr relays every room uses)

**Nostr relay**:
A public server where devices announce the rooms they are in so they can find each other and set up their
connections. Workspace data never goes through it.
_Avoid_: relay (alone), signaling server

**joiner**:
A device holding an invite code whose account isn't a member of the workspace yet. It becomes a member when its join
is accepted.
_Avoid_: invitee, guest

### Rooms

**room**:
A meeting point where devices of a workspace find each other and connect peer to peer. Every room of a workspace is
named and locked by its room secret (an invite room by its invite instead).
_Avoid_: channel (a workspace's conversation or tool), server

**room secret**:
The workspace's shared secret that names and locks its rooms. It changes when a member is removed or an invite is
revoked; the old ones are kept so recovery rooms can be found.

**hub**:
The workspace's main room under the current room secret, where members reach the workspace's nodes.
_Avoid_: main room, server room

**member room**:
The room where members connect to each other directly, used while no node is reachable.
_Avoid_: fallback room

**invite room**:
An open invite's own room, where a joiner holding that invite code finds a node or member to let it in.

**recovery room**:
The hub of an earlier room secret, kept so a device that missed a room secret change still finds the others.

**group room**:
The room of one node group: its nodes are active there, and the members nearest to that group wait there.

**call room**:
A voice channel's own room, where the call's participants connect to each other directly (members otherwise reach
only the nodes). Locked by the room secret like the other rooms.

**active**, **passive**:
How a device is in a room. An active device announces itself and connects to everyone there; a passive one only
answers active ones, so two passive devices never connect.

**room session**:
One stay of a device in a room, from joining to leaving. Leaving and joining the same room again starts a new room
session, which the other devices see as a new arrival.
_Avoid_: membership (being a member of the workspace)

### Invites

**invite**:
A code someone with Manage invites shares so a joiner can be let into the workspace. An invite can carry an expiry
and a use limit (both optional), and it has its own invite room while it is open.
_Avoid_: invite link (the code is what a joiner pastes), key

**open invite**:
An invite that can still let someone in: not revoked, not expired and with uses left.
_Avoid_: valid invite, active invite

**closed invite**:
An invite that can no longer let anyone in, because it was revoked, expired or used up (its use limit reached).
_Avoid_: dead invite, spent invite

**revoke** (an invite):
To close an invite early, before it expires or runs out of uses. The room secret changes (as when a member is
removed), so the code can no longer reach the workspace's rooms.
_Avoid_: delete (a delete is permanent)

**permanently delete** (an invite):
To remove a closed invite from the workspace for good, so it is gone from every member's invite list. Only a closed
invite can be permanently deleted. Who was let in through it stays on record.
_Avoid_: revoke (that only closes the invite)

### Calls

**call node**:
The authorized node serving a voice channel's call through its SFU. It is the single arbiter of the
channel's call mode, so every participant reaches the same node (the first authorized node that answers
in the deterministic order everyone computes).
_Avoid_: SFU node, primary node (that is only the lowest-RTT node)

**mesh call**:
A call where every participant sends media directly to every other participant, over a direct link between each
pair, never through another member. Used while no call node serves the channel.
_Avoid_: peer call, direct call

**SFU call**:
A call routed through a call node: each participant sends its media once to the node and receives the
others' from it.
_Avoid_: server call, hosted call

**media port**:
The one port (UDP and TCP) of a call node where every participant's call media arrives.
_Avoid_: RTC server, RTC port, media server

**call mode**:
Whether a voice channel's call is a mesh call or an SFU call. Chosen by the call node so no two
participants use different modes; switching mid-call is make before break, so a participant's call connection
stays on the mesh until its own media reaches the call node.
_Avoid_: call type, call path

**call connection**:
This device's media path into a voice channel's call. Joining a call puts you in it; you are connected
once its other members who can be heard (not muted, and not voice-muted by a moderator) are audible. In an SFU call
it goes through the call node once this device's media reaches the node's media port, over the mesh until then.
_Avoid_: session, call session

**call presence**:
A peer's word on which call it is in, sent peer to peer: again every 20 s while in a call, and three times after
leaving one. A member that stops sending it is taken out of the call after a few missed refreshes. It also says how
many members the peer counts in its call.
_Avoid_: voice presence (presence is the online status), voice state

**call size**:
How many members a voice channel shows in its call: the members this device lists, or more when a member of that
call recently said it counts more (members this device hasn't heard from yet). A count stops counting once its
member goes quiet for a few refreshes.
_Avoid_: member count (the workspace's members), participants count

**sound share**:
A member sharing their device's sound with no picture. The call shows it as a visualizer around the sharer's picture.
_Avoid_: audio stream, shared audio

**share sound**:
The sound that comes with a member's screen share and plays with its picture.
_Avoid_: screen audio, shared audio

**share quality**:
The resolution, frame rate, favour (what gives way when bandwidth runs short) and bitrate a member picks for their
screen share. A per-device setting, like the audio devices.
_Avoid_: profile, stream settings

**copy**:
One viewer's stream of a member's picture (a screen share or a camera) in a mesh call; through a call node there is
one copy, which the node passes on.
_Avoid_: stream, sender

**upload budget**:
The most all copies of a member's share or camera may use together. A share's chosen bitrate is its upload budget;
on Auto it is a fixed one.
_Avoid_: cap, limit

**input mode**:
How a device decides when its microphone sends: voice activation (a noise gate) or push to talk. A
per-device setting, like the audio devices themselves.
_Avoid_: mic mode, talk mode

**push to talk**:
An input mode where the microphone sends only while its key is held (plus a short release tail). Others
see the member as unmuted; they simply hear nothing between presses. The key is chosen per device and
works while the window has focus.
_Avoid_: PTT (fine as an abbreviation in code), walkie-talkie mode

**sync mark**:
A per-device, per-account, per-workspace mark (kinds: channel, folder, file, attachment) saying this device
wants that content kept and fetched. Stored in the per-workspace `mw.sync.<account>.<server>` list.

**forgotten channel**:
A channel this device is told to hold no local data for: its sync mark is cleared, its stored content is
freed, its readable-folder copies are removed, and it stops fetching. The signed rows always
stay — every member replays the whole log to check permissions. Shows dimmed until re-synced.
_Avoid_: deleted channel, unfollowed, removed from workspace

**ghost**:
Content referenced in a channel's rows but not fetched to this device. Fetched when opened or when the
auto-download size allows; a forgotten channel's content stays a ghost.

**custom emoji**:
A workspace's own emoji: a small image uploaded under a shortcode name (`:party_parrot:`), kept as workspace content
and drawn wherever the workspace's markdown is rendered: messages, comments, documents and reactions. Its name stays
reserved after removal; removed emoji leave the picker but stay on old messages and reactions.
_Avoid_: server emoji, sticker, emote

**readable folder**:
The folder on this device mirroring a workspace's channel files and uploads so members can browse them from
their file manager. The mirror only ever changes files it wrote and nobody edited.
_Avoid_: mirror, disk view (implementation names)

**account**:
A person's identity: an ECDSA key pair (the id is made from the public key), a profile, and optional
ways to sign in (password, Google, GitHub). Kept on each computer's own storage and published to a user
server, so others can find it and send it private messages. Workspaces, roles and messages key on the id,
never on the display name.

**sign-in code**:
The 6-digit code the user server mails to an account's email when someone signs in with its email and password
on a computer that doesn't hold the account. The user server hands out the account's locked key only with it.
Sign-ins with Google or GitHub, with an account already on the computer, and accounts without an email have none.
_Avoid_: 2FA code, OTP, verification code (the code that confirms a new email is a different one)

**profile**:
The public part of an account (display name, color, avatar) that follows it to every signed-in computer.
Carries an `updatedAt` stamp (the client keeps it as `profileUpdatedAt`); the user server keeps the newest,
so a device signing in with an old local copy can't overwrite a newer one.

**synced preference**:
A setting kept in the account's encrypted `prefs` vault document so every computer signed in to the
account shares it: theme and its user themes, icon pack, sound pack, sound volume, editor markdown mode,
notification switch, "is typing", "show online", the workspace order, the category order and the workspace
groups. Settings tied to the device (audio devices, call volumes, panel widths, the readable-folder setup) stay
local on purpose.

**stream quality**:
What a member's screen share favours on this device (smooth motion, balanced or sharp detail) and the most
bandwidth each copy of it may use. A setting of the device, not a synced preference; it only shapes the share,
never the microphone or camera.
_Avoid_: share settings, video quality

**viewer**:
A participant whose call view shows another participant's shared screen or camera. In a mesh call only viewers get a
copy of the picture; a share's sound goes to every participant.

**upload budget**:
What all copies of one participant's shared screen, or of their camera, share in a mesh call: 8 Mbit/s for a screen,
3 Mbit/s for a camera, split between its viewers down to a floor per copy. A call through a node uploads one copy and
is never held to it.
_Avoid_: viewer cap

### Workspace bar

**workspace order**:
The order a member arranges workspaces and workspace groups in the workspace bar. Personal to the account and
synced like a preference, never part of a workspace's data. A workspace that is left keeps its place for a later
return, also inside a group.
_Avoid_: server order, connection order

**workspace group**:
Several workspaces folded under one tile in the workspace bar, which opens to show them in place. A personal
arrangement of the account, synced like a preference; one level only (a group holds workspaces, never another
group), and a group that loses its last workspace is gone. Which groups are open is a setting of the device.
_Avoid_: workspace folder, server category, workspace category

### Views

**kept view**:
A channel's view that stays loaded after the member leaves the channel, so coming back shows it as it was instead of loading its content again. Kept for the session only; the least recently shown is let go when many are kept, except channels with an open tab.
_Avoid_: cached channel, kept channel

**reading place**:
Where a member left a message list (a chat channel, a thread, a private conversation) while reading its history: the message at the top of the view and how far down the screen it was. Only the member's own scrolling (or a jump to a message) sets one, and it is remembered only once the list has finished loading; scrolling back to the newest message clears it. Coming back puts that message where it was; a list without one opens at its newest message. Kept for the session only.
_Avoid_: scroll position, saved scroll, place (that is the location shared with the Nodes page)

**fill**:
The part of a long list (a big folder) added a little at a time after its first screenful shows, so opening it never holds up the app or its animations. It stops at a set size; past that, more comes only as the member scrolls toward it. Message lists have none: they show a screenful (or down to the reading place), and older messages come only once the member scrolls up, as the top comes near.
_Avoid_: lazy load, progressive loading, background load

### Chat and members

**guest**:
A member who joined with a guest invite: in the Guest role, with its permissions instead of @everyone's, and unable
to read chat from before they joined, until someone makes them a full member.
_Avoid_: visitor, limited member

**chat key**:
A channel's key for one epoch, sealed to each member who may read it (ADR 0021). A new epoch starts when someone loses
access to the channel or a guest arrives.
_Avoid_: channel password, room secret (that is the workspace's room key)

**notes**:
Your own conversation under private messages, synced to your other computers through the account's vault.
_Avoid_: saved messages, memo

### Design

**main component**:
A frame in a design document marked to be reused (`props.main`). Changing it changes its instances.
_Avoid_: master component, symbol

**instance**:
A frame that copies a main component (`props.instanceOf`). Its layers are copies that follow the main's layers
except for their overrides (ADR 0020).
_Avoid_: clone, linked frame

**override**:
A property or field changed on an instance or a layer in it; it no longer follows the main until reset.

**variant set**:
A frame holding main components that are variants of one component, each named by its properties
("State=Hover, Size=Large"). An instance of one picks another by those properties.
_Avoid_: component set (Figma's name), states

**constraints**:
Where a layer goes when its frame is resized: kept to a side, both sides, centered, or scaled.

**overlay**:
A page-level frame opened over the frame shown in play mode, closed with Close overlay, Back or a click outside.

**play mode**:
The design view's prototype player: one page-level frame at a time, going to others as its layers' interactions say.
_Avoid_: preview, presentation mode

**smart animate**:
A transition in play mode that moves, resizes and recolors the layers two frames share by name path.

### Diagrams

**connector**:
A line in a diagram from one shape to another (or to a free point), with a head at each end and labels in the middle
and at its ends. Its kind (generalization, composition, one to many, ...) is the pair of heads and its dash.
_Avoid_: edge (the code's word), arrow, link, wire

**cardinality**:
How many of one entity go with one of another, drawn as an ER connector's ends (crow's feet): one, exactly one, many,
one or many, zero or one, zero or many.
_Avoid_: multiplicity (UML's, written as text), crow's foot (one way of drawing it)

**multiplicity**:
The text at a UML connector's end saying how many take part there ("1", "0..*", "1..n"), sometimes with a role name.
_Avoid_: cardinality (the ER ends)

**relationship**:
An ER connector between two entities, its cardinality at each end.
_Avoid_: relation (a table, in database terms)

**row**:
One line of a structured shape: a column of an entity, an attribute or method of a class, a row of a table. The view
names it by the shape it is in; connectors can end on a row (a foreign key on its primary key).
_Avoid_: field, line

**structured shape**:
A diagram shape made of a header and compartments of rows: a UML class (and abstract class, interface, enumeration,
object, data type) or a database table (and view, junction table). Its rows are typed the usual way and kept one by
one; it is as tall as its rows.
_Avoid_: table shape, class box

**compartment**:
One part of a structured shape below its header, holding the rows of one kind: attributes, operations, literals or
columns.
_Avoid_: section (the code's word), panel

**stereotype**:
The kind written above a structured shape's name in guillemets: «interface», «enumeration», «datatype», «view».
_Avoid_: tag, label

### Windows and tabs

**quick switcher**:
The dialog opened with Ctrl+K or Ctrl+P, also shown on a tab with nothing open: goes to channels and commands, and searches things in channels and messages.
_Avoid_: command palette, global search

**tab**:
One place kept open in a window: a channel, private messages, or a workspace's empty view. A tab carries its own
back/forward history, and the main window's tabs are remembered across restarts.
_Avoid_: page, sheet

**main window**:
The app's primary window: it holds the tab bar and the workspace and channel bars, and it alone shows notifications,
plays sounds, sets the app badge and keeps the private-message mailbox up to date. Closing it puts the app in the
background without closing the view windows.
_Avoid_: primary window, host window

**view window**:
A window raised for a single tab (desktop only): that tab shows alone, with no workspace or channel bars. It
connects only to that tab's workspace, and anything pointing at another workspace opens in the main window. Closing
it closes its tab. Only a channel whose type can stand alone gets one; a voice channel stays in the main window. It
is never in a call and says nothing about calls to the other members, so a call in the main window goes on as before.
_Avoid_: popout window, detached tab, popup, secondary window

**terminal window**:
A window holding one terminal of a code channel (desktop only), popped out of the channel's terminal panel. It shows
only that terminal and connects to no workspace. The terminal keeps running and keeps its output while it moves.
Closing the window returns the terminal to the panel, where its tab waited; if the window it came from is gone, the
terminal ends.
_Avoid_: view window (that one shows a tab and connects to its workspace), detached terminal, floating terminal

**pop out** (a tab or a terminal):
To give a tab its own view window, or a terminal its own terminal window: the tab leaves its window's tab bar, and the
terminal leaves its panel (its tab stays there, marked as away). The reverse is to return it: a tab by dragging it from
the view window back onto the main window, a terminal by closing its window or moving it back.
_Avoid_: detach, tear off, undock, float

### Version control

**receiving branch**:
The branch a merge lands on: the current branch for a pull or "merge into the current one", the other branch for
"switch to it and merge the current one in".
_Avoid_: ours, current (it isn't always the one checked out), target

**incoming branch**:
The branch whose commits a merge brings in: origin's copy of the branch on a pull, otherwise the branch being merged.
_Avoid_: theirs, source, remote

**conflict**:
One place in a file where the receiving and incoming branches changed the same lines differently since the last
commit they share. A file can hold several; a file deleted on one side and changed on the other is one conflict.
_Avoid_: merge error, hunk, chunk

**resolve** (a conflict):
To decide what a conflict becomes: some lines of either side, both, neither, or a result written by hand; a whole file
can also take one side's version. A merge with conflicts is made only once every one is resolved.
_Avoid_: fix

**host connection**:
A member's named token for a git host (github.com, a GitLab server) on one computer, from MakeWork's GitHub sign-in
or pasted in; a member can have several per host, and each version control channel uses one of them on that
computer. Each of its submodules can use another, since one host holds repositories of owners one token can't read;
a submodule's fetches and pushes never borrow the main repository's. Releases are offered only with one that may write to the repository; a MakeWork account signed in with
GitHub is not one.
_Avoid_: login, GitHub account, credentials, saved token

**main repository**:
The repository a version control channel was connected to, as opposed to the submodules imported with it.
_Avoid_: root repository, parent repository (a submodule inside another submodule has a parent too)

**submodule**:
A repository that another repository includes at a path, as git's submodules; a version control channel shows its
main repository's submodules, at every level, each named by its path from the main repository's root.
_Avoid_: subrepo, nested repository, child repository

**pinned commit**:
The commit a repository records for one of its submodules on its default branch: what that submodule is at for
anyone who checks the repository out.
_Avoid_: submodule head, recorded sha

**release file**:
A file attached to a release, built for it or added by hand: an installer, a package, a program or a zip.
_Avoid_: binary, asset, attachment

**build configuration**:
A named, channel-wide way to build a branch's release files: the commands, the folder they run in, where the files
land and which of them to take. Each member's computer asks before running one that someone else last changed.
_Avoid_: build plan, recipe, build settings, build script

**usual build**:
The build the app knows for a kind of project, recognized from its files (a Cargo.toml, a package.json with
electron-builder), used when the channel has no build configuration for it.
_Avoid_: detected build, auto build, default build
**watch party**:
Members watching video files from a files channel together in a voice channel, each playing their own copy at full
quality in step (play, pause and seek for everyone). Planned from the file viewer, announced by a chat message.
_Avoid_: watch together, stream, screening

**thread reply in the channel**:
A reply in a thread that was also sent in the channel ("Also send in #channel"); it stays part of its thread.
_Avoid_: cross-post, broadcast reply
