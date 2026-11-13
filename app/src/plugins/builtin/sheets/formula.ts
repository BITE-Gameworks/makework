export type CellValue = string | number | boolean | Date | null | FormulaError;

export class FormulaError {
  constructor(readonly code: string) {}
  toString() { return this.code; }
}

interface SheetInput {
  id: number;
  name: string;
}

interface CellInput {
  sheetId: number;
  row: number;
  col: number;
  value: string | null;
}

type Ref = { type: "ref"; sheet: string | null; row: number; col: number };
type Range = { type: "range"; sheet: string | null; from: Ref; to: Ref };
type Expr =
  | { type: "literal"; value: CellValue }
  | Ref
  | Range
  | { type: "call"; name: string; args: Expr[] }
  | { type: "unary"; op: string; value: Expr }
  | { type: "binary"; op: string; left: Expr; right: Expr };
type Token = { kind: "number" | "string" | "word" | "quotedSheet" | "error" | "op" | "eof"; value: string };
interface GridValue { grid: Evaluated[][] }
type Evaluated = CellValue | GridValue;

const error = (code: string) => new FormulaError(code);
const errorValue = (value: Evaluated): value is FormulaError => value instanceof FormulaError;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < source.length;) {
    const char = source[i];
    if (/\s/.test(char)) { i++; continue; }
    const errorToken = /^#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|CYCLE!|ERROR!)/.exec(source.slice(i).toUpperCase());
    if (errorToken) {
      tokens.push({ kind: "error", value: errorToken[0] });
      i += errorToken[0].length;
      continue;
    }
    if (char === '"') {
      let text = "";
      for (i++; i < source.length; i++) {
        if (source[i] !== '"') { text += source[i]; continue; }
        if (source[i + 1] === '"') { text += '"'; i++; continue; }
        i++;
        break;
      }
      if (source[i - 1] !== '"') throw new Error("Unclosed string.");
      tokens.push({ kind: "string", value: text });
      continue;
    }
    if (char === "'") {
      let name = "";
      for (i++; i < source.length; i++) {
        if (source[i] !== "'") { name += source[i]; continue; }
        if (source[i + 1] === "'") { name += "'"; i++; continue; }
        i++;
        break;
      }
      if (source[i - 1] !== "'") throw new Error("Unclosed sheet name.");
      tokens.push({ kind: "quotedSheet", value: name });
      continue;
    }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i));
    if (number) {
      tokens.push({ kind: "number", value: number[0] });
      i += number[0].length;
      continue;
    }
    const word = /^\$?[A-Za-z_][A-Za-z0-9_.$]*/.exec(source.slice(i));
    if (word) {
      tokens.push({ kind: "word", value: word[0] });
      i += word[0].length;
      continue;
    }
    if (char === "$") {
      const ref = /^\$?[A-Za-z]{1,3}\$?[1-9]\d*/.exec(source.slice(i));
      if (ref) {
        tokens.push({ kind: "word", value: ref[0] });
        i += ref[0].length;
        continue;
      }
    }
    const op = ["<=", ">=", "<>", "!="].find((candidate) => source.startsWith(candidate, i));
    if (op) { tokens.push({ kind: "op", value: op }); i += op.length; continue; }
    if ("+-*/^%=<>:&(),!".includes(char)) {
      tokens.push({ kind: "op", value: char });
      i++;
      continue;
    }
    throw new Error(`Unexpected character '${char}'.`);
  }
  tokens.push({ kind: "eof", value: "" });
  return tokens;
}

const precedence: Record<string, number> = { "=": 1, "<>": 1, "!=": 1, "<": 1, ">": 1, "<=": 1, ">=": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4, "^": 5 };

function parse(source: string): Expr {
  const tokens = tokenize(source.startsWith("=") ? source.slice(1) : source);
  let at = 0;
  const peek = () => tokens[at];
  const take = () => tokens[at++];
  const expect = (value: string) => {
    if (take().value !== value) throw new Error(`Expected '${value}'.`);
  };
  const reference = (sheet: string | null, token: Token): Ref => {
    const match = /^\$?([A-Za-z]{1,3})\$?([1-9]\d*)$/.exec(token.value);
    if (!match) throw new Error(`'${token.value}' is not a cell reference.`);
    let col = 0;
    for (const char of match[1].toUpperCase()) col = col * 26 + char.charCodeAt(0) - 64;
    return { type: "ref", sheet, row: Number(match[2]) - 1, col: col - 1 };
  };
  const primary = (): Expr => {
    const token = take();
    if (token.kind === "number") return { type: "literal", value: Number(token.value) };
    if (token.kind === "string") return { type: "literal", value: token.value };
    if (token.kind === "error") return { type: "literal", value: error(token.value) };
    if (token.value === "(") {
      const expression = parseExpression(0);
      expect(")");
      return expression;
    }
    if (token.value === "+" || token.value === "-") return { type: "unary", op: token.value, value: primary() };
    if (token.kind === "quotedSheet" || (token.kind === "word" && tokens[at]?.value === "!")) {
      const sheet = token.value;
      expect("!");
      return reference(sheet, take());
    }
    if (token.kind === "word") {
      if (tokens[at]?.value === "!") {
        take();
        return reference(token.value, take());
      }
      if (tokens[at]?.value === "(") {
        take();
        const args: Expr[] = [];
        if (peek().value !== ")") {
          do {
            args.push(parseExpression(0));
            if (peek().value !== ",") break;
            take();
          } while (true);
        }
        expect(")");
        return { type: "call", name: token.value.toUpperCase(), args };
      }
      if (/^TRUE$/i.test(token.value)) return { type: "literal", value: true };
      if (/^FALSE$/i.test(token.value)) return { type: "literal", value: false };
      return reference(null, token);
    }
    throw new Error(`Unexpected '${token.value || "end of formula"}'.`);
  };
  const parseExpression = (min: number): Expr => {
    let left = primary();
    if (left.type === "ref" && peek().value === ":") {
      take();
      const end = primary();
      if (end.type === "literal" && errorValue(end.value)) left = end;
      else if (end.type !== "ref") throw new Error("A range needs two cell references.");
      else left = { type: "range", sheet: end.sheet ?? left.sheet, from: left, to: end };
    }
    while (true) {
      if (peek().value === "%" && 6 >= min) {
        take();
        left = { type: "binary", op: "%", left, right: { type: "literal", value: 100 } };
        continue;
      }
      if (peek().kind !== "op" || (precedence[peek().value] ?? -1) < min) break;
      const op = take().value;
      const power = precedence[op];
      const right = parseExpression(power + (op === "^" ? 0 : 1));
      left = { type: "binary", op, left, right };
    }
    return left;
  };
  const result = parseExpression(0);
  if (peek().kind !== "eof") throw new Error(`Unexpected '${peek().value}'.`);
  return result;
}

export function columnName(col: number): string {
  let n = col + 1;
  let label = "";
  while (n > 0) {
    const rest = (n - 1) % 26;
    label = String.fromCodePoint(65 + rest) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

export class FormulaBook {
  private readonly byName = new Map<string, SheetInput>();
  private readonly cells = new Map<string, string | null>();
  private readonly cache = new Map<string, Evaluated>();
  private readonly active = new Set<string>();
  private readonly parsed = new Map<string, Expr | FormulaError>();

  constructor(sheets: SheetInput[], cells: CellInput[]) {
    for (const sheet of sheets) this.byName.set(sheet.name.toLowerCase(), sheet);
    for (const cell of cells) this.cells.set(this.key(cell.sheetId, cell.row, cell.col), cell.value);
  }

  get(sheetId: number, row: number, col: number): CellValue {
    return this.evaluate(this.key(sheetId, row, col)) as CellValue;
  }

  private key(sheetId: number, row: number, col: number) { return `${sheetId}:${row}:${col}`; }

  private evaluate(key: string): Evaluated {
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const formula = this.cells.get(key);
    if (!formula?.startsWith("=")) return parseCellValue(formula);
    if (this.active.has(key)) return error("#CYCLE!");
    this.active.add(key);
    let result: Evaluated;
    try {
      let tree = this.parsed.get(formula);
      if (!tree) {
        try { tree = parse(formula); }
        catch { tree = error("#ERROR!"); }
        this.parsed.set(formula, tree);
      }
      result = tree instanceof FormulaError ? tree : this.evalExpr(tree, key.split(":").map(Number)[0]);
    } finally {
      this.active.delete(key);
    }
    this.cache.set(key, result!);
    return result!;
  }

  private evalExpr(expr: Expr, currentSheet: number): Evaluated {
    if (expr.type === "literal") return expr.value;
    if (expr.type === "ref") {
      const sheetId = expr.sheet === null ? currentSheet : this.byName.get(expr.sheet.toLowerCase())?.id;
      return sheetId === undefined ? error("#REF!") : this.evaluate(this.key(sheetId, expr.row, expr.col));
    }
    if (expr.type === "range") {
      const sheetId = expr.sheet === null ? currentSheet : this.byName.get(expr.sheet.toLowerCase())?.id;
      if (sheetId === undefined) return error("#REF!");
      const rows = Math.abs(expr.to.row - expr.from.row) + 1;
      const cols = Math.abs(expr.to.col - expr.from.col) + 1;
      if (rows * cols > 10_000) return error("#VALUE!");
      const result: Evaluated[][] = [];
      for (let r = Math.min(expr.from.row, expr.to.row); r <= Math.max(expr.from.row, expr.to.row); r++)
        result.push(Array.from({ length: cols }, (_, i) => this.evaluate(this.key(sheetId, r, Math.min(expr.from.col, expr.to.col) + i))));
      return { grid: result };
    }
    if (expr.type === "unary") {
      const value = this.evalExpr(expr.value, currentSheet);
      if (errorValue(value)) return value;
      const n = numeric(value);
      return n === null ? error("#VALUE!") : expr.op === "-" ? -n : n;
    }
    if (expr.type === "binary") {
      const left = this.evalExpr(expr.left, currentSheet);
      if (errorValue(left)) return left;
      const right = this.evalExpr(expr.right, currentSheet);
      if (errorValue(right)) return right;
      return binary(expr.op, first(left), first(right));
    }
    if (expr.name === "IF") {
      const condition = this.evalExpr(expr.args[0] ?? { type: "literal", value: false }, currentSheet);
      if (errorValue(condition)) return condition;
      return this.evalExpr(expr.args[truth(first(condition)) ? 1 : 2] ?? { type: "literal", value: false }, currentSheet);
    }
    if (expr.name === "IFERROR") {
      const value = this.evalExpr(expr.args[0] ?? { type: "literal", value: null }, currentSheet);
      return errorValue(value)
        ? this.evalExpr(expr.args[1] ?? { type: "literal", value: "" }, currentSheet)
        : value;
    }
    if (expr.name === "IFS") {
      for (let i = 0; i + 1 < expr.args.length; i += 2) {
        const condition = this.evalExpr(expr.args[i], currentSheet);
        if (errorValue(condition)) return condition;
        if (truth(first(condition))) return this.evalExpr(expr.args[i + 1], currentSheet);
      }
      return error("#N/A");
    }
    return this.call(expr.name, expr.args.map((arg) => this.evalExpr(arg, currentSheet)));
  }

  private call(name: string, args: Evaluated[]): Evaluated {
    const values = args.flatMap(flatten);
    const firstError = values.find(errorValue);
    if (firstError && !["IFERROR", "IF", "IFS"].includes(name)) return firstError;
    const numbers = values.filter((value): value is number => typeof value === "number");
    const text = (v: Evaluated | undefined) => v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
    const n = (v: Evaluated | undefined) => numeric(v ?? null);
    const at = (index: number) => args[index] ?? null;
    switch (name) {
      case "IF": return truth(at(0)) ? at(1) ?? false : at(2) ?? false;
      case "IFS": for (let i = 0; i + 1 < args.length; i += 2) if (truth(args[i])) return args[i + 1]; return error("#N/A");
      case "IFERROR": return errorValue(at(0)!) ? at(1) ?? "" : at(0)!;
      case "AND": return values.every(truth);
      case "OR": return values.some(truth);
      case "NOT": return !truth(at(0));
      case "SUM": return numbers.reduce((sum, value) => sum + value, 0);
      case "AVERAGE": return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : error("#DIV/0!");
      case "MIN": return numbers.length ? Math.min(...numbers) : 0;
      case "MAX": return numbers.length ? Math.max(...numbers) : 0;
      case "COUNT": return numbers.length;
      case "COUNTA": return values.filter((value) => value !== null && value !== "").length;
      case "ROUND": return n(at(0)) === null ? error("#VALUE!") : round(n(at(0))!, n(at(1)) ?? 0);
      case "ABS": return n(at(0)) === null ? error("#VALUE!") : Math.abs(n(at(0))!);
      case "CONCAT": case "CONCATENATE": return values.map(text).join("");
      case "TEXTJOIN": return values.slice(2).filter((value) => value !== "" && value !== null).map(text).join(text(at(0)));
      case "LEFT": return text(at(0)).slice(0, Math.max(0, n(at(1)) ?? 1));
      case "RIGHT": return text(at(0)).slice(-Math.max(0, n(at(1)) ?? 1));
      case "MID": return text(at(0)).slice(Math.max(0, (n(at(1)) ?? 1) - 1), Math.max(0, (n(at(1)) ?? 1) - 1) + Math.max(0, n(at(2)) ?? 0));
      case "LEN": return [...text(at(0))].length;
      case "UPPER": return text(at(0)).toUpperCase();
      case "LOWER": return text(at(0)).toLowerCase();
      case "TRIM": return text(at(0)).trim().replace(/\s+/g, " ");
      case "TODAY": return new Date(new Date().toISOString().slice(0, 10));
      case "NOW": return new Date();
      case "DATE": return new Date(Date.UTC(n(at(0)) ?? 1900, (n(at(1)) ?? 1) - 1, n(at(2)) ?? 1));
      case "YEAR": return date(at(0))?.getUTCFullYear() ?? error("#VALUE!");
      case "MONTH": return date(at(0)) ? date(at(0))!.getUTCMonth() + 1 : error("#VALUE!");
      case "DAY": return date(at(0))?.getUTCDate() ?? error("#VALUE!");
      case "WEEKDAY": {
        const d = date(at(0));
        const type = n(at(1)) ?? 1;
        return d ? type === 2 ? ((d.getUTCDay() + 6) % 7) + 1 : d.getUTCDay() + 1 : error("#VALUE!");
      }
      case "VLOOKUP": return lookup(args, truth(at(3)));
      case "XLOOKUP": return lookup(args, false);
      case "INDEX": {
        const source = at(0);
        const grid = source && typeof source === "object" && "grid" in source ? source.grid : [[source]];
        const row = Math.max(0, (n(at(1)) ?? 1) - 1);
        const col = Math.max(0, (n(at(2)) ?? 1) - 1);
        return grid[row]?.[col] ?? error("#REF!");
      }
      case "MATCH": {
        const range = flatten(at(1) ?? null);
        const found = range.findIndex((value) => same(value, at(0) ?? null));
        return found < 0 ? error("#N/A") : found + 1;
      }
      case "SUMIF": {
        const range = flatten(at(0) ?? null);
        const sumRange = at(2) == null ? range : flatten(at(2)!);
        let total = 0;
        range.forEach((value, i) => { if (matches(value, at(1))) total += numeric(sumRange[i] ?? null) ?? 0; });
        return total;
      }
      case "COUNTIF": {
        const range = flatten(at(0) ?? null);
        return range.filter((value) => matches(value, at(1))).length;
      }
      default: return error("#NAME?");
    }
  }
}

function numeric(value: Evaluated): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function parseCellValue(value: string | null | undefined): CellValue {
  if (value == null) return null;
  const trimmed = value.trim();
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) return Number(trimmed);
  return value;
}

function truth(value: Evaluated | undefined): boolean {
  if (value instanceof FormulaError) return false;
  return typeof value === "string" ? value.length > 0 : Boolean(value);
}

function first(value: Evaluated): CellValue {
  if (value && typeof value === "object" && "grid" in value) return first(value.grid[0]?.[0] ?? null);
  return value as CellValue;
}

function flatten(value: Evaluated): CellValue[] {
  if (value && typeof value === "object" && "grid" in value) return value.grid.flatMap((row) => row.flatMap(flatten));
  return [value as CellValue];
}

function binary(op: string, a: CellValue, b: CellValue): CellValue {
  const left = numeric(a);
  const right = numeric(b);
  switch (op) {
    case "&": return `${a ?? ""}${b ?? ""}`;
    case "=": return same(a, b);
    case "<>": case "!=": return !same(a, b);
    case "<": case ">": case "<=": case ">=": {
      const compare = left !== null && right !== null ? left - right : String(a ?? "").localeCompare(String(b ?? ""));
      return op === "<" ? compare < 0 : op === ">" ? compare > 0 : op === "<=" ? compare <= 0 : compare >= 0;
    }
    case "+": return left === null || right === null ? error("#VALUE!") : left + right;
    case "-": return left === null || right === null ? error("#VALUE!") : left - right;
    case "*": return left === null || right === null ? error("#VALUE!") : left * right;
    case "/": return right === 0 ? error("#DIV/0!") : left === null || right === null ? error("#VALUE!") : left / right;
    case "^": return left === null || right === null ? error("#VALUE!") : left ** right;
    case "%": return left === null || right === null ? error("#VALUE!") : left / right;
    default: return error("#VALUE!");
  }
}

function same(a: Evaluated, b: Evaluated): boolean {
  return a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;
}

function round(value: number, places: number): number {
  const factor = 10 ** Math.trunc(places);
  return Math.round(value * factor) / factor;
}

function date(value: Evaluated | undefined): Date | null {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") {
    const result = new Date(value);
    return Number.isNaN(result.getTime()) ? null : result;
  }
  return null;
}

function matches(value: Evaluated, criterion: Evaluated | undefined): boolean {
  const text = String(criterion ?? "");
  const operator = /^(>=|<=|<>|>|<|=)(.*)$/.exec(text);
  if (!operator) return same(value, criterion ?? null);
  const expected = operator[2];
  const compare = numeric(value) !== null && Number.isFinite(Number(expected))
    ? numeric(value)! - Number(expected)
    : String(value ?? "").localeCompare(expected, undefined, { sensitivity: "base" });
  switch (operator[1]) {
    case ">": return compare > 0;
    case "<": return compare < 0;
    case ">=": return compare >= 0;
    case "<=": return compare <= 0;
    case "<>": return compare !== 0;
    default: return compare === 0;
  }
}

function lookup(args: Evaluated[], approximate: boolean): Evaluated {
  if (args[1] && typeof args[1] === "object" && "grid" in args[1]) {
    const matchGrid = (args[1] as GridValue).grid;
    if (args[2] && typeof args[2] === "object" && "grid" in args[2]) {
      const lookupValues = matchGrid.flat();
      const returnValues = (args[2] as GridValue).grid.flat();
      let found = lookupValues.findIndex((value) => same(value, args[0] ?? null));
      if (found < 0 && approximate) found = lookupValues.findIndex((value) => matches(value, args[0]));
      return found < 0 ? args[3] ?? error("#N/A") : returnValues[found] ?? args[3] ?? error("#N/A");
    }
    const table = matchGrid;
    const col = Math.max(0, (numeric(args[2]) ?? 1) - 1);
    for (const row of table) {
      if (same(row[0] ?? null, args[0] ?? null) || (approximate && matches(row[0] ?? null, args[0])))
        return row[col] ?? error("#REF!");
    }
  }
  return error("#N/A");
}

export function columnIndex(label: string): number {
  let value = 0;
  for (const char of label.toUpperCase()) value = value * 26 + char.charCodeAt(0) - 64;
  return value - 1;
}

export function cellAddress(row: number, col: number): string {
  return `${columnName(col)}${row + 1}`;
}
