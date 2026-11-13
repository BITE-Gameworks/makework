// A small language-agnostic highlighter for C-like languages, Python, shell and similar. Good enough for
// chat snippets; a real one can replace it later.

export type TokenKind = "keyword" | "string" | "comment" | "number" | "function" | "plain";
export interface Token {
  kind: TokenKind;
  text: string;
}

const keywords = new Set((
  "abstract as async await break case catch class const continue def default delete do elif else enum export " +
  "extends false final finally fn for foreach from func function go if impl implements import in interface is " +
  "let match mod mut namespace new nil none null override package pass private protected pub public raise " +
  "readonly return self static struct super switch this throw true try type typeof use using var virtual void " +
  "while with yield int long float double bool string char byte"
).split(" "));

const pattern = new RegExp([
  String.raw`(?<comment>\/\/[^\n]*|#(?![\w{[])[^\n]*|\/\*[\s\S]*?\*\/)`,
  String.raw`(?<string>"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\x60(?:[^\x60\\]|\\.)*\x60)`,
  String.raw`(?<number>\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b|\b0x[\da-f]+\b)`,
  String.raw`(?<word>[A-Za-z_][\w]*)`,
].join("|"), "gi");

export function highlight(code: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  const push = (kind: TokenKind, text: string) => {
    const prev = tokens.at(-1);
    if (prev?.kind === kind) prev.text += text;
    else tokens.push({ kind, text });
  };
  for (const match of code.matchAll(pattern)) {
    if (match.index > last) push("plain", code.slice(last, match.index));
    const groups = match.groups!;
    const text = match[0];
    if (groups.comment) push("comment", text);
    else if (groups.string) push("string", text);
    else if (groups.number) push("number", text);
    else if (keywords.has(text)) push("keyword", text);
    else if (code[match.index + text.length] === "(") push("function", text);
    else push("plain", text);
    last = match.index + text.length;
  }
  if (last < code.length) push("plain", code.slice(last));
  return tokens;
}
