// Display info for channel types, contributed by plugins. A type is the name of the workspace plugin
// behind the channel.
import { allChannelTypes, channelTypeInfo } from "../plugins/registry";
import type { ChannelTypeInfo } from "../plugins/types";
import { skeletonKind, type SkeletonKind } from "../ui/Skeleton";

export type ChannelType = ChannelTypeInfo;

export function channelType(id: string): ChannelType {
  return channelTypeInfo(id) ?? { id, label: id, icon: "channel-other" };
}

export function channelTypes(): ChannelType[] {
  return allChannelTypes();
}

// The loading shape of a channel type's view (ui/Skeleton).
export function loaderFor(type: string | undefined): SkeletonKind {
  return skeletonKind(type ? channelType(type).loader : undefined);
}
