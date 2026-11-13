import { Show, createResource, createSignal } from "solid-js";
import { Icon } from "../theme/icons";
import VideoPlayer from "../ui/VideoPlayer";
import { videoInfo, type VideoEmbed } from "./embeds";

// A linked video plays only after a click. Its title and picture come from the site first.
export function VideoEmbedView(props: { embed: VideoEmbed }) {
  const [playing, setPlaying] = createSignal(false);
  const [info] = createResource(() => props.embed, videoInfo);
  return (
    <div class="chat-embed mw-box mw-fade-in">
      <Show when={playing()} fallback={
        <button class="chat-embed-cover" classList={{ pictured: !!info()?.thumbnail }} title={`Play ${props.embed.url}`}
          onClick={() => setPlaying(true)}>
          <Show when={info()?.thumbnail}>
            {(src) => <img class="chat-embed-thumb mw-fade-in" src={src()} alt="" loading="lazy" referrerpolicy="no-referrer" />}
          </Show>
          <span class="chat-embed-play"><Icon name="play" size={28} /></span>
          <span class="chat-embed-label">
            <span class="chat-embed-provider">{info()?.title || props.embed.provider}</span>
            <span class="muted">{info() ? [info()!.author, props.embed.provider].filter(Boolean).join(" · ") : props.embed.url}</span>
          </span>
        </button>
      }>
        <Show when={props.embed.kind === "frame"} fallback={
          <VideoPlayer src={props.embed.src} autoplay fallback={
            <a class="mw-button mw-box" href={props.embed.url} target="_blank" rel="noreferrer"><Icon name="link" /> Open link</a>
          } />
        }>
          <iframe src={props.embed.src} title={`${props.embed.provider} video`} allowfullscreen
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen" referrerpolicy="strict-origin-when-cross-origin" />
        </Show>
      </Show>
    </div>
  );
}
