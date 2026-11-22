import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeContextMenu, contextMenu, openContextMenu, pressOnOpener } from "../../src/ui/contextMenu";

class FakeElement {
  children: FakeElement[] = [];
  constructor(readonly tagName: string) {}
  contains(other: unknown): boolean {
    return other === this || this.children.some((child) => child.contains(other));
  }
  getBoundingClientRect() {
    return { left: 0, bottom: 0 };
  }
}

function event(type: string, currentTarget: FakeElement, at = { x: 10, y: 20 }): MouseEvent {
  return {
    type, currentTarget, detail: 1, clientX: at.x, clientY: at.y, preventDefault() {}, stopPropagation() {},
  } as unknown as MouseEvent;
}

const entries = [{ label: "Reply", action: () => {} }];

beforeEach(() => vi.stubGlobal("Element", FakeElement));
afterEach(() => {
  closeContextMenu();
  vi.unstubAllGlobals();
});

describe("openContextMenu", () => {
  it("closes the menu on a second click on the button that opened it", () => {
    const button = new FakeElement("BUTTON");
    openContextMenu(event("click", button), entries);
    expect(contextMenu()).not.toBeNull();
    openContextMenu(event("click", button), entries);
    expect(contextMenu()).toBeNull();
  });

  it("opens another button's menu in place of the open one", () => {
    const first = new FakeElement("BUTTON");
    const second = new FakeElement("BUTTON");
    openContextMenu(event("click", first), entries);
    openContextMenu(event("click", second, { x: 50, y: 60 }), entries);
    expect(contextMenu()).toMatchObject({ x: 50, y: 60, opener: second });
  });

  it("opens again where a second right click was made", () => {
    const card = new FakeElement("ARTICLE");
    openContextMenu(event("contextmenu", card), entries);
    openContextMenu(event("contextmenu", card, { x: 70, y: 80 }), entries);
    expect(contextMenu()).toMatchObject({ x: 70, y: 80, opener: null });
  });
});

describe("pressOnOpener", () => {
  it("tells a press on the opening button, or its icon, from one elsewhere", () => {
    const button = new FakeElement("BUTTON");
    const icon = new FakeElement("SVG");
    button.children.push(icon);
    openContextMenu(event("click", button), entries);
    expect(pressOnOpener(icon as unknown as Node)).toBe(true);
    expect(pressOnOpener(new FakeElement("DIV") as unknown as Node)).toBe(false);
  });

  it("is false for a menu a right click opened", () => {
    const card = new FakeElement("ARTICLE");
    openContextMenu(event("contextmenu", card), entries);
    expect(pressOnOpener(card as unknown as Node)).toBe(false);
  });
});
