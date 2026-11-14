// A repository's submodules: reading its `.gitmodules` file, and where a submodule's link leads.
import { trimEnd } from "../../../core/text";

export interface ListedSubmodule {
  // Inside the repository that lists it.
  path: string;
  // As written: it can be relative to the repository's own link.
  url: string;
}

// The most submodules read from one repository.
export const maxListed = 200;

const insideRepository = (path: string) => path !== "" && !path.startsWith("-") && !/^[A-Za-z]:/.test(path)
  && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

const unquoted = (value: string) => (value.length > 1 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value);

// The submodules a `.gitmodules` file lists, by path. Entries without a path, or with one outside the repository,
// are left out.
export function parseGitmodules(text: string): ListedSubmodule[] {
  const sections: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      current = /^\[submodule\s+".*"\]$/i.test(line) ? {} : null;
      if (current) sections.push(current);
      continue;
    }
    const at = line.indexOf("=");
    if (!current || at < 0) continue;
    current[line.slice(0, at).trim().toLowerCase()] = unquoted(line.slice(at + 1).trim());
  }
  const byPath = new Map<string, ListedSubmodule>();
  for (const section of sections) {
    const path = trimEnd((section.path ?? "").replaceAll("\\", "/"), "/");
    if (insideRepository(path) && byPath.size < maxListed) byPath.set(path, { path, url: section.url ?? "" });
  }
  return [...byPath.values()];
}

// A submodule's link made whole: one starting with "./" or "../" is relative to its repository's own link, as git
// reads it. "" when it is relative and the repository has no link.
export function resolveSubmoduleUrl(parentUrl: string, url: string): string {
  const link = url.trim();
  if (!link.startsWith("./") && !link.startsWith("../")) return link;
  const parent = trimEnd(parentUrl.trim(), "/");
  if (!parent) return "";
  // git@host:group/repo.git has no slash before its path.
  const scp = /^([\w.-]+@[\w.-]+:)(?!\/)(.*)$/.exec(parent);
  if (!scp) {
    try {
      return new URL(link, `${parent}/`).href;
    } catch {
      return "";
    }
  }
  const parts = scp[2].split("/").filter(Boolean);
  let rest = link;
  for (;;) {
    if (rest.startsWith("./")) rest = rest.slice(2);
    else if (rest.startsWith("../")) {
      rest = rest.slice(3);
      parts.pop();
    } else break;
  }
  return `${scp[1]}${[...parts, rest].join("/")}`;
}
