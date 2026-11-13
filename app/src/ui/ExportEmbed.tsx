import { Show, onCleanup, onMount, createSignal } from "solid-js";
import { findChannel, findCategory } from "../core/workspaces";
import { linkContext, linkUrl, openLink, parseLink } from "../core/links";
import { exportProviderFor } from "../plugins/registry";
import { Icon } from "../theme/icons";
import LinkChip from "./LinkChip";
import Skeleton from "./Skeleton";
import "./ExportEmbed.css";

export default function ExportEmbed(props: { url: string; label: string }) {
  const ref = () => parseLink(props.url);
  const target = () => ref()?.target;
  const channel = () => {
    const r = ref();
    return r && findChannel(r.workspaceId, r.channelId);
  };
  const [state, setState] = createSignal<"waiting" | "loading" | "ready" | "unavailable">("waiting");
  let root!: HTMLElement;
  // The provider draws into `mount` only; the loading and "unavailable" boxes beside it belong to Solid.
  let mount!: HTMLDivElement;
  let cleanup: (() => void) | undefined;
  let generation = 0;

  const unmountPreview = () => {
    generation++;
    cleanup?.();
    cleanup = undefined;
    mount.replaceChildren();
  };

  const mountPreview = async () => {
    const r = ref();
    const c = channel();
    const t = target();
    if (!r || !c || !t) return setState("unavailable");
    const provider = exportProviderFor(c.type);
    if (!provider) return setState("unavailable");
    unmountPreview();
    const current = generation;
    setState("loading");
    try {
      const mounted = await provider.render(t.id, "image", linkContext(r.workspaceId, c), mount);
      if (current !== generation) {
        if (typeof mounted === "function") mounted();
        return;
      }
      cleanup = typeof mounted === "function" ? mounted : undefined;
      setState("ready");
    } catch {
      if (current === generation) {
        mount.replaceChildren();
        setState("unavailable");
      }
    }
  };

  onMount(() => {
    if (typeof IntersectionObserver === "undefined") {
      void mountPreview();
      return;
    }
    let visible = false;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        if (!visible) {
          visible = true;
          void mountPreview();
        }
      } else if (visible) {
        visible = false;
        unmountPreview();
        setState("waiting");
      }
    }, { rootMargin: "160px" });
    observer.observe(root);
    onCleanup(() => observer.disconnect());
  });
  onCleanup(unmountPreview);

  const source = () => {
    const r = ref();
    const c = channel();
    if (!r || !c) return null;
    const category = findCategory(r.workspaceId, c.categoryId)?.name;
    return {
      url: linkUrl({ workspaceId: r.workspaceId, channelId: r.channelId }),
      label: `${category ? `${category} / ` : ""}${c.name}`,
    };
  };

  return (
    <figure class="mw-export-embed mw-box" ref={root}>
      <div class="mw-export-embed-preview">
        <div class="mw-export-embed-mount" classList={{ ready: state() === "ready" }} ref={mount} />
        <Show when={state() === "loading" || state() === "waiting"}>
          <div class="mw-export-embed-skeleton"><Skeleton header={false} /></div>
        </Show>
        <Show when={state() === "unavailable"}>
          <div class="mw-export-embed-unavailable"><Icon name="warning" /> {props.label || "Export"} is hidden or unavailable.</div>
        </Show>
      </div>
      <figcaption>
        <Icon name="image" /> {props.label || "Export"}
        <Show when={source()}>{(s) => <LinkChip url={s().url} label={s().label} />}</Show>
      </figcaption>
      <a class="mw-export-embed-open" href={source()?.url ?? "#"} aria-label="Open source channel"
        onClick={(e) => {
          e.preventDefault();
          const url = source()?.url;
          if (url) openLink(url, e.ctrlKey || e.metaKey);
        }} />
    </figure>
  );
}
