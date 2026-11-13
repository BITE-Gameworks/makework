# Bots and agents

## Bots

A bot is a member whose host's device runs it (`core/bots.ts`). `BotContext` (`plugins/types.ts`) is everything it may
do, each part gated by a permission the admin ticked (`read:<plugin>`, `write:<plugin>`, `memory`, `presence`, `spawn`,
`voice`, `web`). A bot's writes are commits its host signs and marks `as` the bot (`p2p/log.ts`); the ledger checks that
the bot is enabled and hosted by the signer, then runs every policy rule with the bot as author.

Bot settings sync to every member, so they never hold secrets: use a `credential` setting (`core/credentials.ts`).

Built-in bots are in `plugins/builtin/bots/` (automoderator, help, tasks, git, time); `examples/plugins/bots/` shows a
bot in an installable package.

## Agents

Agentic bots think with a language model at an OpenAI-compatible address (`core/llm.ts`; a local llama.cpp server works)
and act through skills.

- `agents/loop.ts` runs one tool per step; results go back as text or pictures. `dispatch.ts` lets a leader hand tasks to
  helpers in the same process; a leader proposes helpers only when the plan spans at least two channels.
- Skills: the general ones are in `agents/skills*.ts` (search and overview, memory, web, channels). A channel type's skills
  belong to its plugin: `ClientPlugin.agentSkills` and `agentIndex` in `plugins/builtin/<type>/agentSkills.ts`. Agents
  never name a plugin's tables.
- One message per task: the answer, the operations performed as `steps`, and an Undo button if something changed.
- Soft locks (`agents/locks.ts`): `claimOrBusy` before changing an existing object; claims live 45 s and show to other
  devices through presence.
- The workspace index (`bots_context`, `agents/library.ts`): a short summary and tags per page, chat channel or note,
  written by the librarian when idle and used to pick notes for each request. With an embeddings address it recalls by
  meaning, else by keywords.
- A bot answers another bot only when named, and only while fewer than four bot messages come in a row.
- Anything an agent reads from the workspace or the web is data, never instructions.
- Local git skills (desktop only) commit and pull; agents never push by themselves (`/push` posts a button).

## Testing

`app/tests/agents/` runs the skills against the real in-app plugins with a stub `BotContext`. Against a real model, any
llama.cpp server with a small instruct model works (8k context, `--parallel 2`). Playtests in the running app:
`app/scripts/playtest/README.md`.
