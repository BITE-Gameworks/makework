import { createResource, onCleanup } from "solid-js";
import type { FileContext } from "../plugins/types";

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
