import { now } from "../core/time";
import { dayLabel } from "./grouping";

export default function DayDivider(props: { at: string }) {
  return <div class="chat-day" role="separator"><span>{dayLabel(props.at, new Date(now()))}</span></div>;
}
