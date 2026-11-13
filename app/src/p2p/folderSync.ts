// Changes made on disk in a workspace's readable folder, made into changes of its data (desktop only). The main
// process watches the folder and reports files that differ from what it wrote (electron/mirror.js scan); each is
// handed to its channel's disk layout (`apply`), and once the data has the change the file is adopted as written.
// Files deleted on disk are only deleted in the data after the user says so; otherwise they come back.
import { forgetPresent, storedBlob } from "../core/content";
import { desktop, type FolderChange } from "../core/desktop";
import { imageInfo } from "../core/files";
import { showNotice } from "../core/notices";
import { workspaceApi } from "../core/workspaces";
import type { DiskApplyContext, DiskChange } from "../plugins/types";
import { channelOfPath, diskChannels, pairMoves, type DiskChannelView, type DiskSource } from "./diskView";

export class FolderSync {
  private readonly queue: FolderChange[] = [];
  // Files deleted on disk while the user decides: not written again meanwhile (paths from the readable folder).
  readonly held = new Set<string>();
  private running: Promise<void> = Promise.resolve();
  private readonly cleanups: (() => void)[] = [];

  // `source` is null until the workspace's channels and roles are read; `after` asks for the next mirror pass (with
  // `fetch` when content should be fetched again).
  constructor(
    private readonly workspaceId: string,
    private readonly source: () => DiskSource | null,
    private readonly after: (fetch?: boolean) => void,
  ) {
    const mirror = desktop?.mirror;
    if (!mirror?.onChanges) return;
    this.cleanups.push(mirror.onChanges((key, changes) => {
      if (key !== workspaceId) return;
      this.queue.push(...changes);
      void this.process();
    }));
    const scan = () => void mirror.scan?.(workspaceId);
    window.addEventListener("focus", scan);
    this.cleanups.push(() => window.removeEventListener("focus", scan));
  }

  close(): void {
    this.cleanups.forEach((cleanup) => cleanup());
  }

  // Resolves once the changes are in the data (a mirror pass waits for it); also takes changes that arrived before
  // the workspace was ready.
  process(): Promise<void> {
    if (this.queue.length) this.running = this.running.then(() => this.apply()).catch((e) => console.warn("Folder changes not applied:", e));
    return this.running;
  }

  private async apply() {
    const source = this.source();
    if (!source || !this.queue.length) return;
    const changes = this.queue.splice(0);
    const views = diskChannels(source);
    const byChannel = new Map<DiskChannelView, DiskChange[]>();
    for (const change of changes) {
      const found = channelOfPath(views, change.path);
      if (found) (byChannel.get(found.view) ?? byChannel.set(found.view, []).get(found.view)!).push({ ...change, path: found.inner });
    }
    const problems: string[] = [];
    for (const [view, list] of byChannel) {
      // The same names as the files on disk got.
      await view.layout.entries(view.context);
      const context = this.context(view, problems);
      const paired = pairMoves(list);
      const removed = paired.filter((c) => c.kind === "removed");
      const rest = paired.filter((c) => c.kind !== "removed");
      if (rest.length && view.layout.apply) {
        try {
          await view.layout.apply(rest, context);
        } catch (e) {
          problems.push(`#${view.channel.name}: ${(e as Error).message}`);
        }
      }
      if (removed.length) await this.askRemoval(view, removed, context);
    }
    if (problems.length)
      showNotice("Some changes on disk weren't saved", `${problems.join("\n")}\nThe files stay as they are on this computer.`);
    this.after();
  }

  private context(view: DiskChannelView, problems: string[]): DiskApplyContext {
    const full = (inner: string[]) => [...view.base, ...inner].join("/");
    return {
      ...view.context,
      api: (plugin) => workspaceApi(this.workspaceId).plugin(plugin),
      adopt: async (change, moveTo, text = false) => !!(await desktop?.mirror?.adopt?.(this.workspaceId, full(change.path), {
        hash: text ? undefined : change.hash, size: change.size ?? 0, mtimeMs: change.mtimeMs ?? 0,
      }, moveTo && full(moveTo))),
      imageInfo: async (hash, mime) => {
        const blob = await storedBlob(hash);
        return imageInfo(blob ? blob.slice(0, blob.size, mime) : new Blob());
      },
      problem: (change, message) => problems.push(`${change.path.at(-1)} in #${view.channel.name}: ${message}`),
    };
  }

  private async askRemoval(view: DiskChannelView, removed: DiskChange[], context: DiskApplyContext) {
    const removal = await view.layout.removal?.(removed, context);
    const paths = removed.map((c) => [...view.base, ...c.path].join("/"));
    const release = () => paths.forEach((p) => this.held.delete(p));
    const bringBack = () => {
      release();
      for (const change of removed) if (change.base && !change.base.startsWith("text:")) forgetPresent(change.base);
      this.after(true);
    };
    if (!removal) return bringBack();
    paths.forEach((p) => this.held.add(p));
    showNotice(`Deleted in the folder of #${view.channel.name}`,
      `${removal.what} deleted on disk. Delete for everyone in the workspace too, or bring back?`, [
        { label: "Delete for everyone", run: () => void removal.remove().then(release, (e) => showNotice("Not deleted", (e as Error).message)).then(() => this.after()) },
        { label: "Bring back", run: bringBack },
      ]);
  }
}
