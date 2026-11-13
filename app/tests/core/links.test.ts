import { describe, expect, it } from "vitest";
import { appLink, isLink, linkUrl, parseLink, webLink } from "../../src/core/links";

describe("makework links", () => {
  it("round-trips numeric object links", () => {
    const ref = { workspaceId: "work", channelId: 42, target: { kind: "task", id: 19 } };
    expect(parseLink(linkUrl(ref))).toEqual(ref);
  });

  it("round-trips string export ids", () => {
    const ref = { workspaceId: "work space", channelId: 42, target: { kind: "export", id: "hero card/1" } };
    expect(parseLink(linkUrl(ref))).toEqual(ref);
  });

  it("rejects malformed encoded refs", () => {
    expect(parseLink("makework://%ZZ/42")).toBeNull();
    expect(parseLink("makework://work/42/export/%ZZ")).toBeNull();
  });

  it("reads the web form as the same link", () => {
    const app = "makework://h1AA00m2eFu5XRDsE98oKg/3670584461472067/message/3675006407490025";
    const web = webLink(app);
    expect(web).toBe("https://app.makework.dev/open/h1AA00m2eFu5XRDsE98oKg/3670584461472067/message/3675006407490025");
    expect(isLink(web)).toBe(true);
    expect(appLink(web)).toBe(app);
    expect(parseLink(web)).toEqual(parseLink(app));
  });

  it("drops a web link's query and fragment, and leaves other addresses alone", () => {
    expect(appLink("https://app.makework.dev/open/work/42?utm=x#top")).toBe("makework://work/42");
    expect(webLink("https://example.com/a")).toBe("https://example.com/a");
    expect(isLink("https://app.makework.dev/assets/x.js")).toBe(false);
  });
});
