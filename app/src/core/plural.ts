// "1 file", "3 files": a count and a word that takes an s. No imports, so the node and plugins can use it.
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
