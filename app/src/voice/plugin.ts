import { solidView } from "../plugins/solid";
import type { ClientPlugin } from "../plugins/types";
import VoiceView from "./VoiceView";
import { partyLinkKind, watchApi } from "../watch/data";

// Voice itself is built in; this only puts its view on voice channels.
export const voicePlugin: ClientPlugin = {
  manifest: {
    id: "makework.voice",
    icon: "channel-voice",
    name: "Voice",
    version: "1.0.0",
    description: "Voice channels: calls, screen sharing and camera.",
    author: "MakeWork",
  },
  channelViews: { voice: solidView(VoiceView) },
  links: {
    voice: {
      async resolve(target, ctx) {
        if (target.kind !== partyLinkKind) return null;
        const { party } = await watchApi(ctx.workspace.id).call<{ party: { title: string } }>("get-party", { party_id: Number(target.id) });
        return { title: `Watch party: ${party.title}`, icon: "watch-party" };
      },
    },
  },
};
