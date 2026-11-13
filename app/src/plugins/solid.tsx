import type { JSX } from "solid-js";
import { render } from "solid-js/web";
import type { ChannelContext, ChannelView, FileContext, FileViewer, Mount } from "./types";

// Lets built-in plugins written in Solid use the framework-free mount contract.
export function solidView(Component: (props: { context: ChannelContext }) => JSX.Element): ChannelView {
  return (element, context) => render(() => <Component context={context} />, element);
}

export function solidMount(view: () => JSX.Element): Mount {
  return (element) => render(view, element);
}

export function solidViewer(Component: (props: { file: FileContext }) => JSX.Element): FileViewer {
  return (element, file) => render(() => <Component file={file} />, element);
}
