# Explore MakeWork preset

The workspace a new user gets from **Add workspace > Explore MakeWork** (and automatically on first start).
`preset.json` lists the categories and channels; `channels/*.zip` is one channel per file.

## The archives

Each `.zip` holds a single `channel.json`, the format `core/channelArchive.ts` reads and writes:

```json
{
  "format": "makework-channel",
  "version": 1,
  "channel": { "name": "welcome", "type": "chat" },
  "tables": { "chat_messages": [ { "id": 1, "channel_id": 1, "author_id": 1, "body": "Hello" } ] },
  "profiles": [ { "user_id": 1, "username": "makework", "display_name": "MakeWork" } ]
}
```

- `channel.type` is the plugin that backs the channel (`chat`, `docs`, `tasks`, `voice`, ...).
- `tables` holds the rows that plugin keeps, exactly as its manifest in `src/system/*.ts` describes them:
  the column names must match and the values must fit their types (text, bigint, timestamp, ...).
- `channel_id: 1` and references between rows (`parent_id`, `thread_id`, `message_id`, ...) are placeholders;
  importing a channel gives everything a fresh id.
- `profiles` names the people the rows point at (`author_id`, `user_id`, ...). The preset uses one fake member,
  user id 1, "MakeWork Guide", so the example messages, tasks and pages have an author, and the example bots (ids 2
  and 3, matching `bots` in `preset.json`).
- `content/<sha256>` holds the bytes of each file a row points at as `mwc:<sha256>` (pictures, the example plugins).
- Row ids are unique within an archive.
- Text links to other preset channels as `makework://explore/<channel>`, or to a row in one as
  `makework://explore/<channel>/<kind>/<row id>` (archive ids, e.g. `/export/table:1`). `core/explorePreset.ts`
  picks the new ids before importing and writes these as real links.
- Calendar sheets put their items in the month of `calendar.month`; the import moves them by whole weeks to the
  current month.

`preset.json` also names the welcome channel and the example bots (registered as in Workspace settings > Bots,
`channel` resolved to that channel's id). Their bot types come from `examples/plugins/bots.mwp`, which the
shared-files channel carries for people to install.

## Changing it

Edit the content in `app/scripts/make-explore-preset.mjs` and run it from `app/`:

```
node scripts/make-explore-preset.mjs
```

It also copies `examples/plugins/bots.mwp` and `pingpong.mwp` into the shared-files channel, so run it again after
changing those. Then `npm test` (see `tests/core/explorePreset.test.ts`) checks every archive against its plugin
(columns, value types, references, content, links), so a mistake is caught before anyone creates the preset. To read a built archive by hand, unzip it
and open `channel.json`.
