import { onCleanup, onMount } from "solid-js";
import type { Mount } from "./types";

// Hands a plain element to plugin code and calls its cleanup on unmount.
export default function MountPoint(props: { mount: Mount; class?: string }) {
  let element!: HTMLDivElement;
  onMount(() => {
    const cleanup = props.mount(element);
    if (typeof cleanup === "function") onCleanup(cleanup);
  });
  return <div ref={element} class={`plugin-mount ${props.class ?? ""}`} />;
}
