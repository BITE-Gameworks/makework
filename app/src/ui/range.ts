// How much of a slider's track is filled, for the themed range style in base.css.
export function rangeFill(value: number, min: number, max: number): { "--fill": string } {
  const share = max > min ? (value - min) / (max - min) : 0;
  return { "--fill": `${Math.min(100, Math.max(0, share * 100))}%` };
}
