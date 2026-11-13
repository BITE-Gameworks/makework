# MakeWork documentation

MakeWork is an extensible communication and collaboration app. People meet in **workspaces** with channels of many
kinds: chat, voice and video calls, files, tasks, sheets, docs, designs, diagrams, code, version control and a shared
browser. Like Discord, one app connects to many independent workspaces, but no workspace has a server: members keep
the workspace's data themselves as a log of signed changes and sync it peer to peer. Optional **nodes** (always-on
headless members) keep files and serve large calls.

| Document | What it covers |
|---|---|
| [development.md](development.md) | Setting up, running, building packages, versions and releases |
| [modules.md](modules.md) | Where the code is and how the parts fit |
| [architecture.md](architecture.md) | Workspaces without a server: the signed log, sync, who connects to whom, nodes, files |
| [accounts.md](accounts.md) | Accounts, sign-in and two-step sign-in, recovery, the user server and the TURN worker |
| [plugins.md](plugins.md) | Writing plugins: client plugins, workspace UI, bots |
| [agents.md](agents.md) | Bots and agentic bots |
| [nodes.md](nodes.md) | Running a node |
| [desktop.md](desktop.md) | The desktop app, browsers and operating systems |
| [testing.md](testing.md) | Unit tests, the mesh test, playtests |
| [decisions.md](decisions.md) | Design decisions and their reasons ("ADR nnnn" in code comments) |
| [glossary.md](glossary.md) | The project's own terms |

Working on the code (people and coding agents alike): [`../AGENTS.md`](../AGENTS.md).
