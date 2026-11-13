import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS script without types
import { publicConfig, publicReadme } from "../../scripts/pack-servers.mjs";

const repoFile = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

describe("packing the servers", () => {
  it("takes our deployment out of the user server's config", () => {
    const config = publicConfig(repoFile("user-server/wrangler.toml"));
    expect(config).toContain('database_id = "PUT-YOUR-DATABASE-ID-HERE"');
    expect(config).toContain('MAIL_FROM = "accounts@your-domain.example"');
    expect(config).not.toMatch(/^FEEDBACK_TO/m);
    expect(config).not.toContain("hello@makework.dev");
    expect(config).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("keeps the hosted web app's addresses, the web app people can use with their own server", () => {
    expect(publicConfig(repoFile("user-server/wrangler.toml"))).toContain("https://app.makework.dev");
  });

  it("takes our deployment out of the TURN server's config", () => {
    const config = publicConfig(repoFile("turn-worker/wrangler.toml"));
    expect(config).toContain('database_id = "PUT-YOUR-DATABASE-ID-HERE"');
    expect(config).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("refuses a config with something of ours it doesn't know about", () => {
    const config = 'database_id = "x"\nSOMETHING = "secret.makework.dev"\n';
    expect(() => publicConfig(config)).toThrow("would ship");
  });

  it("refuses a config whose database line it can't find", () => {
    expect(() => publicConfig('database = "889739ff-0288-4998-a1f5-7035a5d22287"\n')).toThrow("Nothing in wrangler.toml");
  });

  it.each(["user-server/README.md", "turn-worker/README.md"])("%s needs no source", (path) => {
    const readme = publicReadme(repoFile(path));
    expect(readme).toContain("## Setup");
    expect(readme).not.toContain("## With the source");
    expect(readme).not.toMatch(/put the url in|rebuild the app/i);
  });

  it("refuses a README that sends people to the source", () => {
    expect(() => publicReadme("Edit app/src/p2p/ice.ts.\n")).toThrow("source");
  });
});
