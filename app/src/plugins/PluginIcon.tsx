// A plugin's icon in the theme's text color: a built-in's icon name or an installed package's SVG, else the icon
// of its first channel type.
import { createResource } from "solid-js";
import { Icon } from "../theme/icons";
import { pluginAsset } from "./registry";
import type { PluginManifest } from "./types";
import "./PluginIcon.css";

export default function PluginIcon(props: { manifest?: PluginManifest; installed: boolean; size?: number }) {
  const [asset] = createResource(
    () => props.installed && props.manifest?.icon ? [props.manifest.id, props.manifest.icon] as const : null,
    ([id, path]) => pluginAsset(id, path),
  );
  const name = () => asset()
    || (!props.installed && props.manifest?.icon)
    || props.manifest?.contributes?.channelTypes?.[0]?.icon
    || "plugin";
  return <span class="plugin-icon mw-box"><Icon name={name()} size={props.size} /></span>;
}
