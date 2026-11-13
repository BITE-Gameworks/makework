// GitHub-like generated avatars: a 5x5 grid mirrored left to right, cells picked from a hash of a seed.
const paths = new Map<string, string>();

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

// An SVG path in a 5x5 box.
export function identiconPath(seed: string): string {
  let path = paths.get(seed);
  if (path !== undefined) return path;
  const bits = hash(seed);
  path = "";
  for (let x = 0; x < 3; x++)
    for (let y = 0; y < 5; y++) {
      if (!(bits & (1 << (x * 5 + y)))) continue;
      path += `M${x} ${y}h1v1h-1z`;
      if (x < 2) path += `M${4 - x} ${y}h1v1h-1z`;
    }
  paths.set(seed, path);
  return path;
}

export function randomSeed(): string {
  return crypto.getRandomValues(new Uint32Array(2)).reduce((s, n) => s + n.toString(36), "");
}
