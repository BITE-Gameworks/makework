// "/roll" arguments: "20", "2d6", "d20+3", "3d8-1", "4d6 5d4". Up to 20 dice of up to 1000 sides per roll.
export interface Roll { notation: string; dice: number[]; modifier: number; total: number }

const pattern = /^(\d*)d(\d+)([+-]\d+)?$|^(\d+)$/i;

export function parseRoll(word: string): { count: number; sides: number; modifier: number } | null {
  const match = pattern.exec(word);
  if (!match) return null;
  if (match[4] !== undefined) return { count: 1, sides: Number(match[4]), modifier: 0 };
  const count = match[1] === "" ? 1 : Number(match[1]);
  const sides = Number(match[2]);
  const modifier = match[3] ? Number(match[3]) : 0;
  if (count < 1 || count > 20 || sides < 2 || sides > 1000) return null;
  return { count, sides, modifier };
}

export function roll(word: string, random: () => number = Math.random): Roll | null {
  const parsed = parseRoll(word);
  if (!parsed || parsed.sides < 2 || parsed.sides > 1000) return null;
  const dice = Array.from({ length: parsed.count }, () => 1 + Math.floor(random() * parsed.sides));
  return { notation: word, dice, modifier: parsed.modifier, total: dice.reduce((a, b) => a + b, 0) + parsed.modifier };
}

export function describeRoll(r: Roll): string {
  const mod = r.modifier ? ` ${r.modifier > 0 ? "+" : "-"} ${Math.abs(r.modifier)}` : "";
  return r.dice.length === 1 && !mod ? `**${r.total}**` : `${r.dice.join(" + ")}${mod} = **${r.total}**`;
}
