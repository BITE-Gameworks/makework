import { createResource, onCleanup } from "solid-js";
import type { FileContext } from "../plugins/types";

// Where media plays from: the file's own address when it has one, else an object URL of its content.
export function createMediaUrl(file: FileContext) {
  if (file.src) return () => file.src!() ?? undefined;
  return createObjectUrl(file);
}

// An object URL for the file's content, revoked when the viewer closes.
export function createObjectUrl(file: FileContext) {
  let url: string | undefined;
  const [resource] = createResource(async () => (url = URL.createObjectURL(await file.read())));
  onCleanup(() => url && URL.revokeObjectURL(url));
  return resource;
}

export function createText(file: FileContext) {
  const [resource] = createResource(async () => (await file.read()).text());
  return resource;
}
