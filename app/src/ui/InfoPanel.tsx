// The side panel that describes one thing (a channel, a member): a header with its picture and name, short facts
// with icons, titled sections and the actions that fit it. Use it for every such panel.
import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { Icon } from "../theme/icons";
import "./InfoPanel.css";

export default function InfoPanel(props: { children: JSX.Element }) {
  return <div class="info-panel mw-fade-in">{props.children}</div>;
}

// `accent`: a color for the band behind the picture (a member's color), else the theme's.
export function InfoHeader(props: { media: JSX.Element; title: JSX.Element; subtitle?: JSX.Element; accent?: string }) {
  return (
    <header class="info-header mw-box" style={props.accent ? { "--info-accent": props.accent } : undefined}>
      <div class="info-media">{props.media}</div>
      <div class="info-titles">
        <h2 class="info-title">{props.title}</h2>
        <Show when={props.subtitle}><div class="info-subtitle">{props.subtitle}</div></Show>
      </div>
    </header>
  );
}

export function InfoRow(props: { icon: string; children: JSX.Element; action?: JSX.Element }) {
  return (
    <div class="info-row">
      <Icon name={props.icon} />
      <span class="info-row-text">{props.children}</span>
      {props.action}
    </div>
  );
}

export function InfoSection(props: { title: string; children: JSX.Element }) {
  return (
    <section class="info-section">
      <h3>{props.title}</h3>
      {props.children}
    </section>
  );
}

export function InfoActions(props: { children: JSX.Element }) {
  return <div class="info-actions">{props.children}</div>;
}
