import { beforeEach, describe, expect, it } from "vitest";
import { forgetToken, getToken, setToken } from "../../../../src/core/secrets";
import { addConnection, allConnections, channelToken, connectionUses, connectionsFor, folderCredentials, forgetConnection, nameGitHubSignIn, renameConnection, useConnection } from "../../../../src/plugins/builtin/git/connections";

// core/storage reads localStorage, which node doesn't have.
beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
});

// A host that never says whose a token is.
const silent = (async () => new Response("", { status: 500 })) as typeof fetch;

describe("host connections", () => {
  it("keeps several for one host, the latest first", async () => {
    await addConnection({ host: "github.com", provider: "github", token: "work-token", name: "Work" }, silent);
    await addConnection({ host: "github.com", provider: "github", token: "home-token", name: "Personal" }, silent);
    await addConnection({ host: "gitlab.com", provider: "gitlab", token: "lab-token", name: "Lab" }, silent);
    expect((await connectionsFor("github.com")).map((c) => c.name)).toEqual(["Personal", "Work"]);
  });

  it("are named after the user the host says the token is for, unless named", async () => {
    // GitHub answers /user to its token with the login, GitLab /api/v4/user with the username.
    const hosts = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (String(url) === "https://api.github.com/user" && headers.Authorization === "Bearer gh-token") return Response.json({ login: "octocat" });
      if (String(url) === "https://gitlab.example.com/api/v4/user" && headers["PRIVATE-TOKEN"] === "lab-token") return Response.json({ username: "lab-user" });
      return new Response("", { status: 401 });
    }) as typeof fetch;
    expect((await addConnection({ host: "github.com", provider: "github", token: "gh-token" }, hosts)).name).toBe("octocat on github.com");
    expect((await addConnection({ host: "gitlab.example.com", provider: "gitlab", token: "lab-token" }, hosts)).name).toBe("lab-user on gitlab.example.com");
    expect((await addConnection({ host: "github.com", provider: "github", token: "a", name: "  " }, silent)).name).toBe("github.com token");
    expect((await addConnection({ host: "github.com", provider: "github", token: "b" }, silent)).name).toBe("github.com token 2");
  });

  it("are all listed for managing, by host, a GitHub sign-in no channel used yet included", async () => {
    await addConnection({ host: "gitlab.example.com", provider: "gitlab", token: "lab", name: "Lab" }, silent);
    await addConnection({ host: "github.com", provider: "github", token: "work", name: "Work" }, silent);
    await setToken("github.com", "signed-in");
    expect((await allConnections()).map((c) => c.name)).toEqual(["Work", "github.com", "Lab"]);
  });

  it("hold a token once: saving it again gives the same connection", async () => {
    const first = await addConnection({ host: "github.com", provider: "github", token: "same", name: "Work" }, silent);
    const again = await addConnection({ host: "github.com", provider: "github", token: "same", name: "Other" }, silent);
    expect(again.key).toBe(first.key);
    expect((await connectionsFor("github.com")).map((c) => c.name)).toEqual(["Work"]);
  });

  it("show the GitHub sign-in by its login, and take new names", async () => {
    // The desktop app keeps a GitHub sign-in in the github.com slot itself.
    await setToken("github.com", "signed-in");
    nameGitHubSignIn("octocat");
    const [signIn] = await connectionsFor("github.com");
    expect(signIn).toMatchObject({ key: "github.com", name: "GitHub sign-in (octocat)" });
    renameConnection(signIn.key, " Mine ");
    renameConnection(signIn.key, "   ");
    expect((await connectionsFor("github.com"))[0].name).toBe("Mine");
  });

  it("include a token kept before connections had names, under its host's name, while it is there", async () => {
    await setToken("gitlab.example.com", "old-token");
    expect(await connectionsFor("gitlab.example.com")).toMatchObject([{ key: "gitlab.example.com", name: "gitlab.example.com" }]);
    renameConnection("gitlab.example.com", "Old");
    // A moment the token can't be read (a locked keychain) only hides it: its name stays.
    await forgetToken("gitlab.example.com");
    expect(await connectionsFor("gitlab.example.com")).toEqual([]);
    await setToken("gitlab.example.com", "old-token");
    expect((await connectionsFor("gitlab.example.com"))[0].name).toBe("Old");
  });
});

describe("a channel's connection on this computer", () => {
  it("is the one picked for it, or none", async () => {
    const work = await addConnection({ host: "github.com", provider: "github", token: "work-token", name: "Work" }, silent);
    await addConnection({ host: "github.com", provider: "github", token: "home-token", name: "Personal" }, silent);
    useConnection("ws", 1, work.key);
    useConnection("ws", 2, "none");
    expect(await channelToken("ws", 1, "github.com")).toBe("work-token");
    expect(await channelToken("ws", 2, "github.com")).toBeNull();
    // Picking one makes it the first offered.
    expect((await connectionsFor("github.com"))[0].name).toBe("Work");
  });

  it("without a pick keeps the token kept before connections had names, else takes the latest, and stays on it", async () => {
    // A channel made before connections had names, first opened here after a named one was added: still the token
    // kept for its host then.
    await setToken("github.com", "old-token");
    await addConnection({ host: "github.com", provider: "github", token: "new-token", name: "New" }, silent);
    expect(await channelToken("ws", 1, "github.com")).toBe("old-token");
    // Without one: the latest, kept when another is added later.
    await addConnection({ host: "gitlab.com", provider: "gitlab", token: "lab-1", name: "One" }, silent);
    expect(await channelToken("ws", 2, "gitlab.com")).toBe("lab-1");
    await addConnection({ host: "gitlab.com", provider: "gitlab", token: "lab-2", name: "Two" }, silent);
    expect(await channelToken("ws", 2, "gitlab.com")).toBe("lab-1");
    expect(await channelToken("ws", 3, "gitlab.com")).toBe("lab-2");
  });

  it("follows the repository to another host: a pick for the old host counts as none made", async () => {
    const github = await addConnection({ host: "github.com", provider: "github", token: "gh-token", name: "GitHub" }, silent);
    await addConnection({ host: "gitlab.com", provider: "gitlab", token: "lab-token", name: "Lab" }, silent);
    useConnection("ws", 1, github.key);
    // The channel's repository was changed to a GitLab one.
    expect(await channelToken("ws", 1, "gitlab.com")).toBe("lab-token");
  });

  it("keeps its pick while a submodule on another host gets one of its own", async () => {
    const github = await addConnection({ host: "github.com", provider: "github", token: "gh-token", name: "GitHub" }, silent);
    const lab = await addConnection({ host: "gitlab.com", provider: "gitlab", token: "lab-token", name: "Lab" }, silent);
    await addConnection({ host: "gitlab.com", provider: "gitlab", token: "lab-2", name: "Lab 2" }, silent);
    useConnection("ws", 1, github.key);
    // The submodule's host takes its latest connection and stays on it; the channel's own pick is untouched.
    expect(await channelToken("ws", 1, "gitlab.com", true)).toBe("lab-2");
    expect(await channelToken("ws", 1, "github.com")).toBe("gh-token");
    useConnection("ws", 1, lab.key, "gitlab.com");
    expect(await channelToken("ws", 1, "gitlab.com", true)).toBe("lab-token");
    expect(await channelToken("ws", 1, "github.com")).toBe("gh-token");
    expect(connectionUses().get(lab.key)).toBe(1);
    await forgetConnection(lab.key);
    expect(await channelToken("ws", 1, "gitlab.com", true)).toBeNull();
  });

  it("is none once forgotten, never another one in its place, a new GitHub sign-in included", async () => {
    const work = await addConnection({ host: "github.com", provider: "github", token: "work-token", name: "Work" }, silent);
    await addConnection({ host: "github.com", provider: "github", token: "home-token", name: "Personal" }, silent);
    useConnection("ws", 1, work.key);
    useConnection("ws", 2, work.key);
    expect(connectionUses().get(work.key)).toBe(2);
    await forgetConnection(work.key);
    expect(await channelToken("ws", 1, "github.com")).toBeNull();
    expect((await connectionsFor("github.com")).map((c) => c.name)).toEqual(["Personal"]);
    expect(await getToken(work.key)).toBeNull();
    // The GitHub sign-in's slot is filled again by the next sign-in; channels that used the forgotten one don't take it.
    await setToken("github.com", "signed-in");
    useConnection("ws", 3, "github.com");
    await forgetConnection("github.com");
    await setToken("github.com", "signed-in-again");
    expect(await channelToken("ws", 3, "github.com")).toBeNull();
  });
});

describe("working copies' connections", () => {
  it("tell the desktop app which token each folder's fetch, pull and push get", async () => {
    const work = await addConnection({ host: "github.com", provider: "github", token: "work-token", name: "Work" }, silent);
    const gone = await addConnection({ host: "github.com", provider: "github", token: "gone-token", name: "Gone" }, silent);
    useConnection("ws", 1, work.key);
    useConnection("ws", 2, "none");
    useConnection("ws", 3, gone.key);
    await forgetConnection(gone.key);
    useConnection("ws", 4, "github.com");
    const copies = [1, 2, 3, 4, 5].map((channelId) => ({ workspaceId: "ws", channelId, folder: `/repos/${channelId}` }));
    // No token for none or a forgotten one; the GitHub sign-in by its slot; a channel without a pick is left to the
    // host's own slot.
    expect(folderCredentials(copies)).toEqual({ "/repos/1": work.key, "/repos/2": "", "/repos/3": "", "/repos/4": "github.com" });
  });

  it("give a submodule's folder its channel's connection, or the channel's pick for its own host", async () => {
    const work = await addConnection({ host: "github.com", provider: "github", token: "work-token", name: "Work" }, silent);
    const lab = await addConnection({ host: "gitlab.com", provider: "gitlab", token: "lab-token", name: "Lab" }, silent);
    useConnection("ws", 1, work.key);
    useConnection("ws", 1, lab.key, "gitlab.com");
    expect(folderCredentials([
      { workspaceId: "ws", channelId: 1, folder: "/repo" },
      { workspaceId: "ws", channelId: 1, folder: "/repo/lib" },
      { workspaceId: "ws", channelId: 1, folder: "/repo/tool", ownHost: "gitlab.com" },
      { workspaceId: "ws", channelId: 1, folder: "/repo/other", ownHost: "example.org" },
    ])).toEqual({ "/repo": work.key, "/repo/lib": work.key, "/repo/tool": lab.key });
  });
});
