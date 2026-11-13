// Nodes: always-on members (`npm run node`, src/node/) that keep the workspace's files and serve them to members,
// preferably the ones closest to them. A member with "Manage nodes" adds a node by pairing with it (`add`, p2p/pair.ts):
// its row is authorized from the start, so the node needs no invite. Nodes hosted the old way add their own row,
// waiting until someone with "Manage nodes" authorizes it. Nodes split the files: each file on `copies` of them
// (nodes_settings, p2p/placement.ts), files of 20 GB and more in pieces (p2p/pieces.ts).
import { maxStripeMb, minStripeMb } from "../p2p/pieces";
import type { MockPlugin } from "./backend";
import { InvalidRequest } from "./errors";

const contentRefPattern = /^mwc:[0-9a-f]{64}$/;

export const nodeStatuses = ["pending", "authorized", "ignored"] as const;

// A node's invite page path (node/web.ts serves it): one plain path segment, or "" for no page.
export function validPagePath(page: unknown): page is string {
  return typeof page === "string" && /^[A-Za-z0-9_-]{0,64}$/.test(page) && page !== "status";
}
export const pagePathRule = "A page path is up to 64 letters, digits, - or _.";
export type NodeStatus = (typeof nodeStatuses)[number];

export const nodes: MockPlugin = {
  manifest: {
    name: "nodes",
    version: "1.0.0",
    description: "Nodes that keep the workspace's files and serve them to members.",
    tables: [
      {
        name: "nodes_nodes", parent: null,
        // key_x/key_y: the node's public key, which signs its hello so members know which peer is which node.
        // address: its public IP or host name; url and page: where its invite page is (url + "/" + page).
        columns: {
          user_id: "bigint", name: "text", key_x: "text", key_y: "text", address: "text", url: "text", page: "text",
          country: "text", city: "text", lat: "decimal", lon: "decimal", status: "text", decided_by: "bigint",
          created_at: "timestamp", updated_at: "timestamp",
        },
      },
      // One row at most: how many nodes keep each file or piece (default 2, p2p/placement.ts), files over `stripe_mb`
      // split into pieces across nodes (default and minimum 20480, 20 GB; 0 = never), and `parity` pieces per parity
      // piece instead of copies (0 = copies; p2p/pieces.ts). The `sfu_*` columns are the call settings (p2p/sfuProtocol.ts):
      // whether calls may go through a node, from how many members, how many senders one node takes, and whether they
      // always do (never the mesh).
      {
        name: "nodes_settings", parent: null,
        columns: {
          copies: "int", stripe_mb: "int", parity: "int",
          sfu_calls: "bool", sfu_min_members: "int", sfu_capacity: "int", sfu_forced: "bool",
        },
      },
      // A big file's piece list (the SHA-256 of each 4 MiB piece, content of its own), added by its uploader, so nodes
      // check each piece they take in. One per file: the first stays (policy.ts). No `size` column: node/host.ts
      // reads file sizes from every table that has one.
      { name: "nodes_pieces", parent: null, columns: { content: "text", manifest: "text", author_id: "bigint", created_at: "timestamp" } },
    ],
  },

  register({ data, onApi, onApiRead }) {
    // One more than the highest number in use, so a node added after a removal never takes a name still here.
    const nextNodeName = () => {
      const used = data.select("nodes_nodes").map((n) => Number(/^node#(\d+)$/.exec(String(n.name))?.[1] ?? 0));
      return `node#${Math.max(0, ...used) + 1}`;
    };

    // Its page path is no part of it: a member with "Manage nodes" sets it (`add`, `set-page`).
    onApi("register", "Adds or updates the signed-in node's own row; a new one waits for authorization. Returns { name }.", [
      { name: "key_x", type: "text" },
      { name: "key_y", type: "text" },
      { name: "address", type: "text", required: false },
      { name: "url", type: "text", required: false },
      { name: "country", type: "text", required: false },
      { name: "city", type: "text", required: false },
      { name: "lat", type: "decimal", required: false },
      { name: "lon", type: "decimal", required: false },
    ], (r) => {
      const now = new Date().toISOString();
      const values = { ...r.args, updated_at: now };
      const [mine] = data.select("nodes_nodes", { user_id: r.userId });
      if (mine) {
        data.update("nodes_nodes", values, { user_id: r.userId });
        return { name: String(mine.name) };
      }
      const name = nextNodeName();
      data.insert("nodes_nodes", { ...values, user_id: r.userId, name, status: "pending", decided_by: null, created_at: now });
      return { name };
    });

    onApi("add", "Adds a node paired from this app (p2p/pair.ts), authorized at once: { user_id, key_x, key_y, page }. "
      + "Adding a node that is already here authorizes it again. Returns { name }.", [
      { name: "user_id", type: "bigint" },
      { name: "key_x", type: "text" },
      { name: "key_y", type: "text" },
      { name: "page", type: "text", required: false, description: "Its invite page's path on the node's web server; empty for none." },
    ], (r) => {
      const now = new Date().toISOString();
      const page = String(r.args.page ?? "");
      const [existing] = data.select("nodes_nodes", { user_id: r.args.user_id });
      if (existing) {
        data.update("nodes_nodes", { status: "authorized", decided_by: r.userId, page }, { user_id: r.args.user_id });
        return { name: String(existing.name) };
      }
      const name = nextNodeName();
      data.insert("nodes_nodes", {
        user_id: r.args.user_id, key_x: r.args.key_x, key_y: r.args.key_y, name, page, status: "authorized", decided_by: r.userId,
        created_at: now, updated_at: now,
      });
      return { name };
    });

    onApi("set-page", "Sets a node's invite page path (letters, digits, - and _; empty for none); returns { page }.", [
      { name: "user_id", type: "bigint" },
      { name: "page", type: "text" },
    ], (r) => {
      const page = String(r.args.page ?? "").trim();
      if (!validPagePath(page)) throw new InvalidRequest(pagePathRule);
      if (data.update("nodes_nodes", { page }, { user_id: r.args.user_id }) === 0) throw new InvalidRequest("No such node.");
      return { page };
    });

    onApi("decide", "Authorizes a node, ignores it, or puts it back to waiting; returns { updated }.", [
      { name: "user_id", type: "bigint" },
      { name: "status", type: "text", description: "authorized, ignored or pending." },
    ], (r) => {
      if (!nodeStatuses.includes(r.args.status as NodeStatus)) throw new InvalidRequest(`Unknown node status '${String(r.args.status)}'.`);
      const updated = data.update("nodes_nodes", { status: r.args.status, decided_by: r.userId }, { user_id: r.args.user_id });
      return { updated: updated > 0 };
    });

    onApi("set-copies", "Sets how many nodes keep each file (1-9); returns { copies }.", [
      { name: "copies", type: "int" },
    ], (r) => {
      const copies = Number(r.args.copies);
      if (!Number.isInteger(copies) || copies < 1 || copies > 9) throw new InvalidRequest("Copies must be between 1 and 9.");
      const [row] = data.select("nodes_settings");
      if (row) data.update("nodes_settings", { copies }, { id: row.id });
      else data.insert("nodes_settings", { copies });
      return { copies };
    });

    onApi("set-storage", "Sets how nodes store files and serve calls: { copies (1-9), stripe_mb (0 = never split, else "
      + "20480-1048576: files of 20 GB and more), parity (0 or 2-16), sfu_calls (bool), sfu_min_members (2-100), "
      + "sfu_capacity (1-500), sfu_forced (bool) }, each optional; returns the settings.", [
      { name: "copies", type: "int", required: false },
      { name: "stripe_mb", type: "int", required: false },
      { name: "parity", type: "int", required: false },
      { name: "sfu_calls", type: "bool", required: false, description: "Whether calls may go through a node." },
      { name: "sfu_min_members", type: "int", required: false, description: "Members in a call before it goes through a node." },
      { name: "sfu_capacity", type: "int", required: false, description: "Members of a call one node takes; the next ones go to the next node, and the nodes link so it stays one call." },
      { name: "sfu_forced", type: "bool", required: false, description: "Always through a node, even for small calls." },
    ], (r) => {
      const [row] = data.select("nodes_settings");
      const value = (key: string, min: number, max: number) => {
        if (r.args[key] === undefined || r.args[key] === null) return undefined;
        const n = Number(r.args[key]);
        if (!Number.isInteger(n) || n < min || n > max) throw new InvalidRequest(`${key} must be between ${min} and ${max}.`);
        return n;
      };
      const changes: Record<string, number | boolean> = {};
      for (const [key, min, max] of [["copies", 1, 9], ["stripe_mb", 0, maxStripeMb], ["parity", 0, 16], ["sfu_min_members", 2, 100], ["sfu_capacity", 1, 500]] as const) {
        const n = value(key, min, max);
        if (n !== undefined) changes[key] = n;
      }
      for (const key of ["sfu_calls", "sfu_forced"] as const) {
        if (r.args[key] !== undefined && r.args[key] !== null) changes[key] = !!r.args[key];
      }
      if (changes.parity === 1) throw new InvalidRequest("parity must be 0 or between 2 and 16.");
      if (changes.stripe_mb !== undefined && changes.stripe_mb !== 0 && Number(changes.stripe_mb) < minStripeMb())
        throw new InvalidRequest(`Only files of ${Math.round(minStripeMb() / 1024)} GB and more are split: stripe_mb must be 0 or at least ${minStripeMb()}.`);
      if (row) data.update("nodes_settings", changes, { id: row.id });
      else data.insert("nodes_settings", changes);
      return { ...row, ...changes };
    });

    onApi("add-pieces", "Names a big file's piece list (content with the SHA-256 of each 4 MiB piece): { content, manifest }, "
      + "both mwc: refs. The first list for a file stays; returns { manifest } (the one that counts).", [
      { name: "content", type: "text" },
      { name: "manifest", type: "text" },
    ], (r) => {
      const content = String(r.args.content);
      const manifest = String(r.args.manifest);
      if (!contentRefPattern.test(content) || !contentRefPattern.test(manifest)) throw new InvalidRequest("content and manifest must be mwc: refs.");
      const [existing] = data.select("nodes_pieces", { content });
      if (existing) return { manifest: existing.manifest };
      data.insert("nodes_pieces", { content, manifest, author_id: r.userId, created_at: new Date().toISOString() });
      return { manifest };
    });

    onApi("remove", "Removes a node's row; it can add itself again, waiting for authorization. Returns { removed }.", [
      { name: "user_id", type: "bigint" },
    ], (r) => ({ removed: data.delete("nodes_nodes", { user_id: r.args.user_id }) > 0 }));

    onApiRead((r) => data.select(r.table, r.where));
  },
};
