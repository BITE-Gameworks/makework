// Files being copied into the content store before they are posted, per place ("<server>:<channel>"), so views
// can show their progress and a cancel button. Cancelling stops the copy and deletes what was copied.
import { createStore, produce } from "solid-js/store";

export interface RunningUpload {
  id: number;
  place: string;
  file: File;
  name: string;
  size: number;
  progress: number;
}

const [uploads, setUploads] = createStore<RunningUpload[]>([]);
const controllers = new Map<number, AbortController>();
let nextId = 1;

export function startUpload(place: string, file: File) {
  const id = nextId++;
  const controller = new AbortController();
  controllers.set(id, controller);
  setUploads(uploads.length, { id, place, file, name: file.name, size: file.size, progress: 0 });
  return {
    signal: controller.signal,
    setProgress: (progress: number) => setUploads((u) => u.id === id, "progress", progress),
    finish: () => {
      controllers.delete(id);
      setUploads(produce((list) => {
        const i = list.findIndex((u) => u.id === id);
        if (i >= 0) list.splice(i, 1);
      }));
    },
  };
}

export const uploadsIn = (place: string) => uploads.filter((u) => u.place === place);

export function cancelUpload(id: number): void {
  controllers.get(id)?.abort();
}
