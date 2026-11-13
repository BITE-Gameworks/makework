import type { PresenceStatus } from "../core/onlineStatus";
import "./StatusDot.css";

const labels: Partial<Record<PresenceStatus, string>> = {
  online: "Online",
  away: "Away",
  dnd: "Do not disturb",
};

export default function StatusDot(props: { status: PresenceStatus | null; class?: string }) {
  const label = () => props.status ? labels[props.status] : undefined;
  return label() ? (
    <span class={`mw-status-dot ${props.class ?? ""}`} classList={{
      online: props.status === "online", away: props.status === "away", dnd: props.status === "dnd",
    }} title={label()} role="img" aria-label={label()} />
  ) : null;
}
