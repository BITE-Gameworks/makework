// Up in an empty message box edits your last message there: the box asks, the card in the same place answers.
import { createSignal } from "solid-js";

const [request, setRequest] = createSignal<{ place: string; id: string | number } | null>(null);
export const editRequest = request;

export function requestEdit(place: string, id: string | number): void {
  setRequest({ place, id });
}

export function clearEditRequest(): void {
  setRequest(null);
}
