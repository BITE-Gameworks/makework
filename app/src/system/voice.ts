// Who is in which voice channel and their mute and share state. A local plugin: these rows stay on this device
// (p2p/plugins.ts `localPlugins`); calls themselves run in p2p/voice.ts.
import type { MockPlugin } from "./backend";

export const voice: MockPlugin = {
  manifest: {
    name: "voice",
    version: "1.0.0",
    description: "Voice channel presence.",
    tables: [
      {
        name: "voice_participants", parent: null,
        columns: { channel_id: "bigint", user_id: "bigint", muted: "bool", deafened: "bool", sharing: "text", camera: "bool", sound_only: "bool" },
      },
    ],
  },

  register({ data, onApi, onApiRead, onApiInsert }) {
    const leave = (userId: number) => data.delete("voice_participants", { user_id: userId });

    onApi("join", "Joins a voice channel as the signed-in user, leaving any other; returns { id }.",
      [{ name: "channel_id", type: "bigint", description: "The voice channel." }],
      (r) => {
        leave(r.userId);
        return {
          id: data.insert("voice_participants", {
            channel_id: r.args.channel_id, user_id: r.userId, muted: false, deafened: false, sharing: null, camera: false, sound_only: false,
          }),
        };
      });

    onApi("leave", "Leaves the current voice channel; returns { left }.", [], (r) => ({ left: leave(r.userId) > 0 }));

    onApi("set-state", "Updates the signed-in user's mute, deafen, share and camera state; returns { updated }.",
      [
        { name: "muted", type: "bool" },
        { name: "deafened", type: "bool" },
        { name: "sharing", type: "text", required: false, description: "What is being shared, or nothing." },
        { name: "camera", type: "bool" },
        { name: "sound_only", type: "bool", required: false, description: "The share is sound without a picture." },
      ],
      (r) => ({ updated: data.update("voice_participants", { ...r.args, sound_only: r.args.sound_only === true }, { user_id: r.userId }) }));

    onApiRead((r) => data.select(r.table, r.where));
    onApiInsert((r) => data.insert(r.table, r.values));
  },
};
