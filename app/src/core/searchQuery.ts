// Search text with operators, like Slack's: `in:channel` and `by:member` narrow the words that follow.
import type { Member } from "./members";
import { matchMembers } from "./members";

export type SearchOperator = "in" | "by";

export interface SearchQuery {
  words: string[];
  channels: string[];
  authors: string[];
}

export const operatorHints: Record<SearchOperator, string> = { in: "a channel", by: "a member" };

export function parseSearch(text: string): SearchQuery {
  const query: SearchQuery = { words: [], channels: [], authors: [] };
  for (const token of text.toLowerCase().split(/\s+/).filter(Boolean)) {
    const match = /^(in|by):(.*)$/.exec(token);
    if (!match) query.words.push(token);
    else if (match[2]) (match[1] === "in" ? query.channels : query.authors).push(match[2].replace(/^[#@]/, ""));
  }
  return query;
}

// Whether the text holds every word (lowercase words, as parseSearch gives them).
export const holdsWords = (text: string, words: string[]) => {
  const lower = text.toLowerCase();
  return words.every((w) => lower.includes(w));
};

export const isEmptySearch = (q: SearchQuery) => q.words.length + q.channels.length + q.authors.length === 0;

// The last token of the text, which autocomplete completes.
export function lastToken(text: string): { operator: SearchOperator | null; value: string; start: number } {
  let start = text.length;
  while (start > 0 && !/\s/.test(text[start - 1])) start--;
  const token = text.slice(start);
  const match = /^(in|by):(.*)$/i.exec(token);
  return match ? { operator: match[1].toLowerCase() as SearchOperator, value: match[2].replace(/^[#@]/, ""), start } : { operator: null, value: token, start };
}

export const handleOf = (member: Pick<Member, "username">) => member.username;

// Whether a member is meant by the `by:` value: their username or display name (spaces left out) contains it.
export const memberMatches = (member: Pick<Member, "username" | "displayName">, value: string) =>
  member.username.toLowerCase().includes(value) || member.displayName.toLowerCase().replace(/\s+/g, "").includes(value);

export interface Suggestion {
  // What replaces the token.
  insert: string;
  label: string;
  hint?: string;
}

export function suggestions(text: string, operators: readonly SearchOperator[], channels: string[], people: Member[]): Suggestion[] {
  const token = lastToken(text);
  if (token.operator === "in" && operators.includes("in")) {
    const q = token.value.toLowerCase();
    return channels.filter((c) => c.toLowerCase().includes(q)).slice(0, 8).map((c) => ({ insert: `in:${c} `, label: `#${c}` }));
  }
  if (token.operator === "by" && operators.includes("by")) {
    return matchMembers(people, token.value).slice(0, 8)
      .map((m) => ({ insert: `by:${handleOf(m)} `, label: m.displayName, hint: `@${handleOf(m)}` }));
  }
  const typed = token.value.toLowerCase();
  if (!typed) return [];
  return operators.filter((o) => o.startsWith(typed) && o !== typed).map((o) => ({ insert: `${o}:`, label: `${o}:`, hint: operatorHints[o] }));
}
