import { describe, expect, it, vi } from "vitest";

// The desktop bridge as the page sees it: main answers a fetch that couldn't sign in with an "[auth host]" refusal.
const calls: (string | null)[] = [];
vi.mock("../../../../src/core/account", () => ({ account: () => ({ id: "acct-1" }) }));
vi.mock("../../../../src/core/desktop", async (original) => ({
  ...(await original<typeof import("../../../../src/core/desktop")>()),
  desktop: {
    git: {
      useAccount: async (id: string | null) => void calls.push(id),
      fetch: async () => {
        throw new Error("Error invoking remote method 'git:fetch': Error: [auth github.com] GitHub needs you to sign in to MakeWork's GitHub connection to reach this repository.");
      },
      status: async () => {
        throw new Error("Error invoking remote method 'git:status': Error: Not a git repository");
      },
    },
  },
}));

const { GitAuthError, gitCall } = await import("../../../../src/plugins/builtin/git/local");

describe("gitCall", () => {
  it("tells main which account signs in, and turns an auth refusal into a sign-in request", async () => {
    const error = await gitCall((git) => git.fetch("/repo")).catch((e) => e);
    expect(calls).toEqual(["acct-1"]);
    expect(error).toBeInstanceOf(GitAuthError);
    expect(error.host).toBe("github.com");
    expect(error.message).toBe("GitHub needs you to sign in to MakeWork's GitHub connection to reach this repository.");
  });

  it("leaves other errors as they are", async () => {
    const error = await gitCall((git) => git.status("/repo")).catch((e) => e);
    expect(error).not.toBeInstanceOf(GitAuthError);
    expect(error.message).toBe("Not a git repository");
  });
});
