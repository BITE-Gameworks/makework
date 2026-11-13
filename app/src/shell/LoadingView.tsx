// The main view's placeholder while the app starts or a workspace connects: the shape of the channel being opened
// (ui/Skeleton, from its type's `loader`), with what is happening in small text. The real view replaces it.
import Skeleton, { type SkeletonKind } from "../ui/Skeleton";
import "./LoadingView.css";

export const connectingNote = "Connecting to the workspace's members. It loads as soon as one of them is online.";

export default function LoadingView(props: { status: string; kind?: SkeletonKind }) {
  return (
    <div class="loading-view mw-fade-in" role="status" aria-live="polite" aria-label={props.status}>
      <Skeleton kind={props.kind} />
      <p class="loading-status">{props.status}</p>
    </div>
  );
}
