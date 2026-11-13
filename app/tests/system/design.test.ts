// The design plugin, through ApiClient.
import { describe, expect, it } from "vitest";
import { ApiClient, ApiRequestError } from "../../src/api/client";
import { MockBackend } from "../../src/system/backend";
import { design } from "../../src/system/design";
import { MockTransport } from "../../src/mock/transport";

function client() {
  const backend = new MockBackend();
  backend.load(design);
  return new ApiClient(new MockTransport(backend, 0)).plugin("design");
}

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (e) {
    return (e as ApiRequestError).code;
  }
  throw new Error("expected an error");
}

const box = { x: 0, y: 0, width: 100, height: 50 };
type Row = { id: number; parent_id: number | null; name: string; z: number; deleted: boolean };
const list = async (api: ReturnType<typeof client>) => (await api.call<{ rows: Row[] }>("list-nodes", { channel_id: 1 })).rows;

describe("design plugin", () => {
  it("adds nested layers in one call, stacks them, and checks parents", async () => {
    const api = client();
    const { ids } = await api.call<{ ids: number[] }>("add-nodes", {
      channel_id: 1,
      nodes: JSON.stringify([
        { ref: "f", kind: "frame", name: "Frame 1", ...box },
        { parent_ref: "f", kind: "rect", name: "A", ...box },
        { parent_ref: "f", kind: "text", name: "B", ...box, props: JSON.stringify({ text: "hi" }) },
      ]),
    });
    const rows = await list(api);
    expect(rows.map((r) => r.parent_id)).toEqual([null, ids[0], ids[0]]);
    expect(rows[2].z).toBeGreaterThan(rows[1].z);
    expect(await errorCode(api.call("add-nodes", { channel_id: 1, nodes: JSON.stringify([{ kind: "blob", name: "x", ...box }]) }))).toBe("invalid_request");
    expect(await errorCode(api.call("add-nodes", { channel_id: 1, nodes: JSON.stringify([{ parent_id: ids[1], kind: "rect", name: "x", ...box }]) })))
      .toBe("invalid_request");
    expect(await errorCode(api.call("update-nodes", { changes: JSON.stringify([{ id: ids[0], parent_id: ids[0] }]) }))).toBe("invalid_request");
  });

  it("updates several layers, and removes and restores them", async () => {
    const api = client();
    const { ids } = await api.call<{ ids: number[] }>("add-nodes", {
      channel_id: 1, nodes: JSON.stringify([{ kind: "rect", name: "A", ...box }, { kind: "ellipse", name: "B", ...box }]),
    });
    expect(await api.call("update-nodes", { changes: JSON.stringify([{ id: ids[0], name: "C", x: 5 }, { id: ids[1], z: 0 }]) })).toEqual({ updated: 2 });
    expect((await list(api)).find((r) => r.id === ids[0])!.name).toBe("C");
    await api.call("remove-nodes", { ids: JSON.stringify(ids) });
    expect(await list(api)).toEqual([]);
    await api.call("restore-nodes", { ids: JSON.stringify([ids[1]]) });
    expect((await list(api)).map((r) => r.id)).toEqual([ids[1]]);
  });

  it("keeps colors with a value per palette", async () => {
    const api = client();
    type Lists = { colors: { id: number }[]; palettes: { id: number }[]; values: { palette_id: number; color_id: number; value: string }[] };
    const { id: brand } = await api.call<{ id: number }>("add-color", { channel_id: 1, name: "Brand", value: "#FF0000" });
    let lists = await api.call<Lists>("list-palettes", { channel_id: 1 });
    expect(lists.palettes).toHaveLength(1);
    const light = lists.palettes[0].id;
    const { id: dark } = await api.call<{ id: number }>("add-palette", { channel_id: 1, name: "Dark", copy_from: light });
    await api.call("set-color", { palette_id: dark, color_id: brand, value: "#00ff00" });
    lists = await api.call<Lists>("list-palettes", { channel_id: 1 });
    const value = (p: number) => lists.values.find((v) => v.palette_id === p && v.color_id === brand)?.value;
    expect([value(light), value(dark)]).toEqual(["#ff0000", "#00ff00"]);
    // The palette shown is the document's, kept with the page.
    await api.call("set-palette", { channel_id: 1, palette_id: dark });
    expect((await api.call<{ page: { palette_id: number } }>("get-page", { channel_id: 1 })).page.palette_id).toBe(dark);
    await api.call("remove-palette", { id: dark });
    expect((await api.call<Lists>("list-palettes", { channel_id: 1 })).palettes.map((p) => p.id)).toEqual([light]);
    expect(await errorCode(api.call("set-color", { palette_id: light, color_id: brand, value: "red" }))).toBe("invalid_request");
  });

  it("moves colors in their list", async () => {
    const api = client();
    const { id: a } = await api.call<{ id: number }>("add-color", { channel_id: 1, name: "A", value: "#000000" });
    const { id: b } = await api.call<{ id: number }>("add-color", { channel_id: 1, name: "B", value: "#ffffff" });
    await api.call("move-color", { id: b, z: 0.5 });
    const { colors } = await api.call<{ colors: { id: number; z: number }[] }>("list-palettes", { channel_id: 1 });
    expect(colors.slice().sort((x, y) => x.z - y.z).map((c) => c.id)).toEqual([b, a]);
  });

  it("lets groups hold layers and keeps the page background", async () => {
    const api = client();
    const { ids } = await api.call<{ ids: number[] }>("add-nodes", {
      channel_id: 1, nodes: JSON.stringify([{ ref: "g", kind: "group", name: "Group 1", ...box }, { parent_ref: "g", kind: "rect", name: "A", ...box }]),
    });
    expect((await list(api)).find((r) => r.id === ids[1])!.parent_id).toBe(ids[0]);
    await api.call("set-page", { channel_id: 1, background: "ref:7" });
    expect((await api.call<{ page: { background: string } }>("get-page", { channel_id: 1 })).page.background).toBe("ref:7");
    await api.call("set-page", { channel_id: 1, background: "" });
    expect((await api.call<{ page: { background: string } }>("get-page", { channel_id: 1 })).page.background).toBe("");
    expect(await errorCode(api.call("set-page", { channel_id: 1, background: "blue" }))).toBe("invalid_request");
  });
});
