import { BaseRoomConfig, JoinRoom, JoinRoomConfig, TopicStrategyAdapter } from "./types.mjs";
//#region src/topic-strategy.d.ts
declare function _default<TRelay, TConfig extends BaseRoomConfig = JoinRoomConfig>({ steadyAnnounceIntervalMs, reannounceOnDisconnect, init, subscribeTopic, publishTopic, unpublishTopic }: TopicStrategyAdapter<TRelay, TConfig>): JoinRoom<TConfig>;
//#endregion
export { _default as default };
