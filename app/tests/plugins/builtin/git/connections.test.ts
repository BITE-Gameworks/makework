import { beforeEach, describe, expect, it } from "vitest";
import { forgetToken, getToken, setToken } from "../../../../src/core/secrets";
import {
  addConnection, allConnections, channelToken, connectionUses, connectionsFor, findWorkingConnection, folderCredentials, forgetConnection,
  forgetOwnConnection, hasOwnConnection, nameGitHubSignIn, renameConnection, useConnection,
} from "../../../../src/plugins/builtin/git/connections";

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

  it("lets each submodule have its own pick, which never changes the channel's", async () => {
    const mine = await addConnection({ host: "github.com", provider: "github", token: "mine", name: "Mine" }, silent);
    const org = await addConnection({ host: "github.com", provider: "github", token: "org", name: "Org" }, silent);
    const lab = await addConnection({ host: "gitlab.com", provider: "gitlab", token: "lab-token", name: "Lab" }, silent);
    useConnection("ws", 1, mine.key);
    // Without a pick of its own a submodule follows the channel's, for the same host.
    expect(await channelToken("ws", 1, "github.com", "homepage")).toBe("mine");
    expect(hasOwnConnection("ws", 1, "homepage")).toBe(false);
    useConnection("ws", 1, org.key, "homepage");
    expect([await channelToken("ws", 1, "github.com", "homepage"), await channelToken("ws", 1, "github.com")]).toEqual(["org", "mine"]);
    expect(await channelToken("ws", 1, "github.com", "makework")).toBe("mine");
    // On another host it has a pick of its own from the start.
    expect(await channelToken("ws", 1, "gitlab.com", "tool")).toBe("lab-token");
    expect(hasOwnConnection("ws", 1, "tool")).toBe(true);
    expect(await channelToken("ws", 1, "github.com")).toBe("mine");
    expect(connectionUses().get(lab.key)).toBe(1);
    forgetOwnConnection("ws", 1, "homepage");
    expect(await channelToken("ws", 1, "github.com", "homepage")).toBe("mine");
    await forgetConnection(lab.key);
    expect(await channelToken("ws", 1, "gitlab.com", "tool")).toBeNull();
  });

  it("finds one of the member's connections that can read a submodule the channel's can't", async () => {
    const mine = await addConnection({ host: "github.com", provider: "github", token: "mine", name: "Mine" }, silent);
    await addConnection({ host: "github.com", provider: "github", token: "org", name: "Org" }, silent);
    await addConnection({ host: "gitlab.com", provider: "gitlab", token: "lab", name: "Lab" }, silent);
    useConnection("ws", 1, mine.key);
    const asked: string[] = [];
    // GitHub shows the private repository only to the org's token; a public one to anyone.
    const github = (readable: (auth: string | undefined) => boolean) => (async (url: string | URL | Request, init?: RequestInit) => {
      const auth = ((init?.headers ?? {}) as Record<string, string>).Authorization;
      asked.push(`${new URL(String(url)).host} ${auth ?? "none"}`);
      return readable(auth) ? Response.json({ default_branch: "main" }) : new Response("{}", { status: 404 });
    }) as typeof fetch;
    const repo = { provider: "github" as const, host: "github.com", path: "Org/private" };
    expect(await findWorkingConnection("ws", 1, "homepage", repo, { fetchFn: github((auth) => auth === "Bearer org") })).toMatch(/^github\.com#/);
    expect(asked).toEqual(["api.github.com Bearer org"]);
    expect(await channelToken("ws", 1, "github.com", "homepage")).toBe("org");
    expect(await channelToken("ws", 1, "github.com")).toBe("mine");

    // A public repository: none of the tokens is needed, unless none isn't allowed (it couldn't push).
    asked.length = 0;
    const publicRepo = { ...repo, path: "Org/public" };
    expect(await findWorkingConnection("ws", 1, "makework", publicRepo, { allowNone: false, fetchFn: github((auth) => auth === undefined) })).toBeNull();
    expect(asked).toEqual(["api.github.com Bearer org"]);
    expect(hasOwnConnection("ws", 1, "makework")).toBe(false);
    asked.length = 0;
    expect(await findWorkingConnection("ws", 1, "makework", publicRepo, { fetchFn: github((auth) => auth === undefined) })).toBe("none");
    expect(asked).toEqual(["api.github.com Bearer org", "api.github.com none"]);
    expect(await channelToken("ws", 1, "github.com", "makework")).toBeNull();

    // Nothing reads it: the pick stays as it was.
    expect(await findWorkingConnection("ws", 1, "webapp", { ...repo, path: "Org/secret" }, { fetchFn: github(() => false) })).toBeNull();
    expect(hasOwnConnection("ws", 1, "webapp")).toBe(false);
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

  it("give a submodule's folder its own pick or the channel's, also before it is cloned", async () => {
    const work = await addConnection({ host: "github.com", provider: "github", token: "work-token", name: "Work" }, silent);
    const org = await addConnection({ host: "github.com", provider: "github", token: "org-token", name: "Org" }, silent);
    useConnection("ws", 1, work.key);
    useConnection("ws", 1, org.key, "homepage");
    useConnection("ws", 1, "none", "vendor/public");
    expect(folderCredentials([
      { workspaceId: "ws", channelId: 1, folder: "/repo" },
      { workspaceId: "ws", channelId: 1, folder: "/repo/lib", sub: "lib" },
      { workspaceId: "ws", channelId: 1, folder: "/repo/homepage", sub: "homepage" },
    ])).toEqual({ "/repo": work.key, "/repo/lib": work.key, "/repo/homepage": org.key, "/repo/vendor/public": "" });
    // Written as the desktop app joins it on Windows.
    expect(folderCredentials([{ workspaceId: "ws", channelId: 1, folder: "C:\\code\\repo" }])).toEqual({
      "C:\\code\\repo": work.key, "C:\\code\\repo\\homepage": org.key, "C:\\code\\repo\\vendor\\public": "",
    });
  });

  it("give a folder two channels share the pick made for it, the latest when both made one", async () => {
    const mine = await addConnection({ host: "github.com", provider: "github", token: "mine", name: "Mine" }, silent);
    const org = await addConnection({ host: "github.com", provider: "github", token: "org", name: "Org" }, silent);
    const pushing = await addConnection({ host: "github.com", provider: "github", token: "push", name: "Push" }, silent);
    // Channel 1 holds the repository as its submodule, channel 2 is that repository's own channel, in the same folder.
    const shared = [
      { workspaceId: "ws", channelId: 2, folder: "/repo/lib" },
      { workspaceId: "ws", channelId: 1, folder: "/repo" },
      { workspaceId: "ws", channelId: 1, folder: "/repo/lib", sub: "lib" },
    ];
    useConnection("ws", 2, org.key);
    useConnection("ws", 1, mine.key);
    // The submodule only takes channel 1's pick: channel 2's own pick wins, whichever comes first.
    expect(folderCredentials(shared)["/repo/lib"]).toBe(org.key);
    expect(folderCredentials([...shared].reverse())["/repo/lib"]).toBe(org.key);
    // Both picked one: the one picked last.
    useConnection("ws", 1, pushing.key, "lib");
    expect(folderCredentials(shared)["/repo/lib"]).toBe(pushing.key);
    useConnection("ws", 2, org.key);
    expect(folderCredentials([...shared].reverse())["/repo/lib"]).toBe(org.key);
  });
});
