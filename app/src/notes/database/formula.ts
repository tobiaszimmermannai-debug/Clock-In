// Formeln: eigener Parser + Auswertung (kein eval). Beispiel: if(prop("Fällig") < today(), "überfällig", "ok")
//
// Werte: Zahl, Text, Wahr/Falsch, Datum, Liste, leer (null)
// Operatoren: + - * / % ^, == != < > <= >=, && || ! (auch and/or/not), Bedingung ? a : b

export type FValue = number | string | boolean | Date | FValue[] | null;

export class FormulaError extends Error {}

type Node =
  | { k: "lit"; v: FValue }
  | { k: "call"; name: string; args: Node[] }
  | { k: "unary"; op: string; arg: Node }
  | { k: "binary"; op: string; a: Node; b: Node }
  | { k: "cond"; c: Node; a: Node; b: Node };

type Token = { t: "num" | "str" | "id" | "op" | "end"; v: string; pos: number };

const OPS = ["==", "!=", "<=", ">=", "&&", "||", "+", "-", "*", "/", "%", "^", "<", ">", "!", "?", ":", "(", ")", ",", "="];

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = src.slice(i).match(/^\d*\.?\d+(?:[eE][+-]?\d+)?/)!;
      out.push({ t: "num", v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'" || c === "“" || c === "„") {
      const close = c === "„" ? "“" : c === "“" ? "”" : c;
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== close && !(c === "“" && src[j] === "“")) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const n = src[j + 1];
          s += n === "n" ? "\n" : n === "t" ? "\t" : n;
          j += 2;
        } else s += src[j++];
      }
      if (j >= src.length) throw new FormulaError(`Text ab Zeichen ${i + 1} ist nicht geschlossen.`);
      out.push({ t: "str", v: s, pos: i });
      i = j + 1;
      continue;
    }
    if (/[\p{L}_]/u.test(c)) {
      const m = src.slice(i).match(/^[\p{L}_][\p{L}\p{N}_]*/u)!;
      out.push({ t: "id", v: m[0], pos: i });
      i += m[0].length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new FormulaError(`Unbekanntes Zeichen „${c}“ an Stelle ${i + 1}.`);
    out.push({ t: "op", v: op === "=" ? "==" : op, pos: i });
    i += op.length;
  }
  out.push({ t: "end", v: "", pos: src.length });
  return out;
}

const BINARY: Record<string, [number, "l" | "r"]> = {
  "||": [2, "l"],
  or: [2, "l"],
  "&&": [3, "l"],
  and: [3, "l"],
  "==": [4, "l"],
  "!=": [4, "l"],
  "<": [5, "l"],
  ">": [5, "l"],
  "<=": [5, "l"],
  ">=": [5, "l"],
  "+": [6, "l"],
  "-": [6, "l"],
  "*": [7, "l"],
  "/": [7, "l"],
  "%": [7, "l"],
  "^": [8, "r"],
};

function parse(src: string): Node {
  const tokens = tokenize(src);
  let p = 0;
  const peek = () => tokens[p];
  const next = () => tokens[p++];
  const expect = (v: string) => {
    const t = next();
    if (t.v !== v) throw new FormulaError(`„${v}“ erwartet an Stelle ${t.pos + 1}${t.v ? ` statt „${t.v}“` : ""}.`);
  };
  const opOf = (t: Token) => (t.t === "op" ? t.v : t.t === "id" && ["and", "or"].includes(t.v.toLowerCase()) ? t.v.toLowerCase() : null);

  function expr(min = 0): Node {
    let left = unary();
    for (;;) {
      const t = peek();
      if (t.t === "op" && t.v === "?" && min <= 1) {
        next();
        const a = expr(0);
        expect(":");
        const b = expr(1);
        left = { k: "cond", c: left, a, b };
        continue;
      }
      const op = opOf(t);
      const info = op ? BINARY[op] : undefined;
      if (!op || !info || info[0] < min) return left;
      next();
      const right = expr(info[1] === "l" ? info[0] + 1 : info[0]);
      left = { k: "binary", op: op === "and" ? "&&" : op === "or" ? "||" : op, a: left, b: right };
    }
  }

  function unary(): Node {
    const t = peek();
    if ((t.t === "op" && (t.v === "-" || t.v === "!" || t.v === "+")) || (t.t === "id" && t.v.toLowerCase() === "not" && tokens[p + 1]?.v !== "(")) {
      next();
      return { k: "unary", op: t.v === "+" ? "+" : t.v === "-" ? "-" : "!", arg: expr(9) };
    }
    return primary();
  }

  function primary(): Node {
    const t = next();
    if (t.t === "num") return { k: "lit", v: Number(t.v) };
    if (t.t === "str") return { k: "lit", v: t.v };
    if (t.t === "op" && t.v === "(") {
      const e = expr(0);
      expect(")");
      return e;
    }
    if (t.t === "id") {
      const low = t.v.toLowerCase();
      if (peek().v === "(") {
        next();
        const args: Node[] = [];
        if (peek().v !== ")") {
          do args.push(expr(0));
          while (peek().v === "," && next());
        }
        expect(")");
        return { k: "call", name: low, args };
      }
      if (low === "true" || low === "wahr") return { k: "lit", v: true };
      if (low === "false" || low === "falsch") return { k: "lit", v: false };
      if (low === "pi") return { k: "lit", v: Math.PI };
      throw new FormulaError(`„${t.v}“ ist unbekannt. Eigenschaften mit prop("Name") verwenden.`);
    }
    throw new FormulaError(t.t === "end" ? "Formel endet unerwartet." : `Unerwartetes „${t.v}“ an Stelle ${t.pos + 1}.`);
  }

  const node = expr(0);
  if (peek().t !== "end") throw new FormulaError(`Unerwartetes „${peek().v}“ an Stelle ${peek().pos + 1}.`);
  return node;
}

const cache = new Map<string, Node | FormulaError>();

export function compile(src: string): Node {
  let hit = cache.get(src);
  if (!hit) {
    try {
      hit = parse(src);
    } catch (e) {
      hit = e instanceof FormulaError ? e : new FormulaError(String(e));
    }
    if (cache.size > 500) cache.clear();
    cache.set(src, hit);
  }
  if (hit instanceof FormulaError) throw hit;
  return hit;
}

// ---------------- Auswertung ----------------

export type FormulaEnv = { prop: (name: string) => FValue; now?: () => Date };

const isDate = (v: FValue): v is Date => v instanceof Date;
export const isEmptyValue = (v: FValue) => v === null || v === "" || (Array.isArray(v) && v.length === 0) || (typeof v === "number" && Number.isNaN(v));

export function toText(v: FValue): string {
  if (v === null) return "";
  if (Array.isArray(v)) return v.map(toText).filter(Boolean).join(", ");
  if (isDate(v)) return formatDateValue(v);
  if (typeof v === "boolean") return v ? "Ja" : "Nein";
  if (typeof v === "number") return Number.isFinite(v) ? v.toLocaleString("de-DE", { maximumFractionDigits: 10 }) : "";
  return v;
}

function toNum(v: FValue): number {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (isDate(v)) return v.getTime();
  if (v === null || v === "") return 0;
  if (Array.isArray(v)) return v.length;
  const n = Number(String(v).replace(/\s/g, "").replace(",", "."));
  return Number.isNaN(n) ? NaN : n;
}

const truthy = (v: FValue) => !(v === null || v === false || v === 0 || v === "" || (Array.isArray(v) && v.length === 0));

function toDate(v: FValue): Date | null {
  if (isDate(v)) return v;
  if (typeof v === "number") return new Date(v);
  if (typeof v === "string" && v) {
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0));
    const de = v.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (de) return new Date(+de[3], +de[2] - 1, +de[1]);
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function formatDateValue(d: Date): string {
  const date = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
  return d.getHours() || d.getMinutes() ? `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
}

const UNITS: Record<string, string> = {
  years: "y", year: "y", jahre: "y", jahr: "y",
  quarters: "q", quarter: "q", quartale: "q", quartal: "q",
  months: "M", month: "M", monate: "M", monat: "M",
  weeks: "w", week: "w", wochen: "w", woche: "w",
  days: "d", day: "d", tage: "d", tag: "d",
  hours: "h", hour: "h", stunden: "h", stunde: "h",
  minutes: "m", minute: "m", minuten: "m",
};

function unitOf(v: FValue): string {
  const u = UNITS[String(v ?? "days").toLowerCase()];
  if (!u) throw new FormulaError(`Unbekannte Einheit „${String(v)}“ (z. B. "days", "weeks", "months").`);
  return u;
}

function addTo(d: Date, n: number, unit: string): Date {
  const r = new Date(d);
  if (unit === "y") r.setFullYear(r.getFullYear() + n);
  else if (unit === "q") r.setMonth(r.getMonth() + 3 * n);
  else if (unit === "M") r.setMonth(r.getMonth() + n);
  else if (unit === "w") r.setDate(r.getDate() + 7 * n);
  else if (unit === "d") r.setDate(r.getDate() + n);
  else if (unit === "h") r.setHours(r.getHours() + n);
  else r.setMinutes(r.getMinutes() + n);
  return r;
}

function between(a: Date, b: Date, unit: string): number {
  const ms = a.getTime() - b.getTime();
  if (unit === "y" || unit === "q" || unit === "M") {
    let months = (a.getFullYear() - b.getFullYear()) * 12 + (a.getMonth() - b.getMonth());
    if (months > 0 && a.getDate() < b.getDate()) months--;
    if (months < 0 && a.getDate() > b.getDate()) months++;
    return unit === "y" ? Math.trunc(months / 12) : unit === "q" ? Math.trunc(months / 3) : months;
  }
  const div = { w: 6048e5, d: 864e5, h: 36e5, m: 6e4 }[unit as "w" | "d" | "h" | "m"];
  return Math.trunc(ms / div);
}

function formatPattern(d: Date, pattern: string): string {
  const map: Record<string, string> = {
    YYYY: String(d.getFullYear()),
    YY: String(d.getFullYear()).slice(2),
    MM: pad(d.getMonth() + 1),
    M: String(d.getMonth() + 1),
    DD: pad(d.getDate()),
    D: String(d.getDate()),
    HH: pad(d.getHours()),
    H: String(d.getHours()),
    mm: pad(d.getMinutes()),
    dddd: d.toLocaleDateString("de-DE", { weekday: "long" }),
    ddd: d.toLocaleDateString("de-DE", { weekday: "short" }),
    MMMM: d.toLocaleDateString("de-DE", { month: "long" }),
    MMM: d.toLocaleDateString("de-DE", { month: "short" }),
  };
  return pattern.replace(/YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D|HH|H|mm/g, (t) => map[t]);
}

const flat = (args: FValue[]): FValue[] => args.flatMap((a) => (Array.isArray(a) ? flat(a) : [a]));

function compare(a: FValue, b: FValue): number {
  if (isDate(a) || isDate(b)) return (toDate(a)?.getTime() ?? NaN) - (toDate(b)?.getTime() ?? NaN);
  if (typeof a === "number" || typeof b === "number") return toNum(a) - toNum(b);
  return toText(a).localeCompare(toText(b), "de");
}

function equals(a: FValue, b: FValue): boolean {
  if (isDate(a) || isDate(b)) {
    const da = toDate(a);
    const db = toDate(b);
    return Boolean(da && db && da.getTime() === db.getTime());
  }
  if (typeof a === "number" || typeof b === "number") return toNum(a) === toNum(b);
  if (typeof a === "boolean" || typeof b === "boolean") return truthy(a) === truthy(b);
  return toText(a) === toText(b);
}

type Fn = (args: FValue[], env: FormulaEnv) => FValue;

const n0 = (a: FValue[], i = 0) => toNum(a[i] ?? null);
const t0 = (a: FValue[], i = 0) => toText(a[i] ?? null);
const d0 = (a: FValue[], i = 0) => {
  const d = toDate(a[i] ?? null);
  if (!d) throw new FormulaError("Datum erwartet.");
  return d;
};
const startOfToday = (env: FormulaEnv) => {
  const n = env.now?.() ?? new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
};

const FUNCS: Record<string, Fn> = {
  // Logik
  not: (a) => !truthy(a[0] ?? null),
  and: (a) => a.every(truthy),
  or: (a) => a.some(truthy),
  empty: (a) => isEmptyValue(a[0] ?? null),
  // Text
  length: (a) => (Array.isArray(a[0]) ? a[0].length : t0(a).length),
  concat: (a) => (a.some(Array.isArray) ? flat(a) : a.map(toText).join("")),
  join: (a) => (Array.isArray(a[0]) ? a[0].map(toText).join(t0(a, 1)) : a.slice(1).map(toText).join(t0(a))),
  contains: (a) => (Array.isArray(a[0]) ? a[0].some((x) => equals(x, a[1] ?? null)) : t0(a).toLowerCase().includes(t0(a, 1).toLowerCase())),
  test: (a) => {
    try {
      return new RegExp(t0(a, 1), "i").test(t0(a));
    } catch {
      throw new FormulaError("Ungültiges Suchmuster in test().");
    }
  },
  replace: (a) => t0(a).replace(t0(a, 1), t0(a, 2)),
  replaceall: (a) => t0(a).split(t0(a, 1)).join(t0(a, 2)),
  lower: (a) => t0(a).toLowerCase(),
  upper: (a) => t0(a).toUpperCase(),
  trim: (a) => t0(a).trim(),
  slice: (a) => (Array.isArray(a[0]) ? a[0].slice(n0(a, 1), a[2] === undefined ? undefined : n0(a, 2)) : t0(a).slice(n0(a, 1), a[2] === undefined ? undefined : n0(a, 2))),
  repeat: (a) => t0(a).repeat(Math.max(0, Math.min(1000, n0(a, 1)))),
  format: (a) => t0(a),
  tostring: (a) => t0(a),
  tonumber: (a) => toNum(a[0] ?? null),
  // Zahlen
  round: (a) => {
    const f = 10 ** (a[1] === undefined ? 0 : n0(a, 1));
    return Math.round(n0(a) * f) / f;
  },
  floor: (a) => Math.floor(n0(a)),
  ceil: (a) => Math.ceil(n0(a)),
  abs: (a) => Math.abs(n0(a)),
  sqrt: (a) => Math.sqrt(n0(a)),
  pow: (a) => n0(a) ** n0(a, 1),
  sign: (a) => Math.sign(n0(a)),
  mod: (a) => n0(a) % n0(a, 1),
  min: (a) => Math.min(...flat(a).filter((x) => !isEmptyValue(x)).map(toNum)),
  max: (a) => Math.max(...flat(a).filter((x) => !isEmptyValue(x)).map(toNum)),
  sum: (a) => flat(a).reduce<number>((s, x) => s + (isEmptyValue(x) ? 0 : toNum(x)), 0),
  mean: (a) => {
    const list = flat(a).filter((x) => !isEmptyValue(x)).map(toNum);
    return list.length ? list.reduce((s, x) => s + x, 0) / list.length : null;
  },
  // Listen
  count: (a) => flat(a).filter((x) => !isEmptyValue(x)).length,
  first: (a) => (Array.isArray(a[0]) ? (a[0][0] ?? null) : (a[0] ?? null)),
  last: (a) => (Array.isArray(a[0]) ? (a[0][a[0].length - 1] ?? null) : (a[0] ?? null)),
  // Datum
  now: (_a, env) => env.now?.() ?? new Date(),
  today: (_a, env) => startOfToday(env),
  date: (a) => toDate(a[0] ?? null),
  dateadd: (a) => addTo(d0(a), n0(a, 1), unitOf(a[2] ?? "days")),
  datesubtract: (a) => addTo(d0(a), -n0(a, 1), unitOf(a[2] ?? "days")),
  datebetween: (a) => between(d0(a), d0(a, 1), unitOf(a[2] ?? "days")),
  formatdate: (a) => (a[1] === undefined ? formatDateValue(d0(a)) : formatPattern(d0(a), t0(a, 1))),
  year: (a) => d0(a).getFullYear(),
  month: (a) => d0(a).getMonth() + 1,
  day: (a) => d0(a).getDate(),
  weekday: (a) => ((d0(a).getDay() + 6) % 7) + 1,
  hour: (a) => d0(a).getHours(),
  minute: (a) => d0(a).getMinutes(),
};

// Deutsche Namen als Alias
const ALIASES: Record<string, string> = {
  wenn: "if",
  nicht: "not",
  und: "and",
  oder: "or",
  leer: "empty",
  länge: "length",
  enthält: "contains",
  verketten: "concat",
  runden: "round",
  summe: "sum",
  mittelwert: "mean",
  anzahl: "count",
  heute: "today",
  jetzt: "now",
  eigenschaft: "prop",
};

export const FUNCTION_NAMES = ["prop", "if", "ifs", ...Object.keys(FUNCS)].sort();

function evalNode(node: Node, env: FormulaEnv): FValue {
  switch (node.k) {
    case "lit":
      return node.v;
    case "cond":
      return truthy(evalNode(node.c, env)) ? evalNode(node.a, env) : evalNode(node.b, env);
    case "unary": {
      const v = evalNode(node.arg, env);
      if (node.op === "!") return !truthy(v);
      return node.op === "-" ? -toNum(v) : toNum(v);
    }
    case "binary": {
      if (node.op === "&&") return truthy(evalNode(node.a, env)) && truthy(evalNode(node.b, env));
      if (node.op === "||") return truthy(evalNode(node.a, env)) || truthy(evalNode(node.b, env));
      const a = evalNode(node.a, env);
      const b = evalNode(node.b, env);
      switch (node.op) {
        case "+":
          if (typeof a === "string" || typeof b === "string") return toText(a) + toText(b);
          if (isDate(a) && typeof b === "number") return addTo(a, b, "d");
          return toNum(a) + toNum(b);
        case "-":
          if (isDate(a) && isDate(b)) return between(a, b, "d");
          if (isDate(a) && typeof b === "number") return addTo(a, -b, "d");
          return toNum(a) - toNum(b);
        case "*":
          return toNum(a) * toNum(b);
        case "/": {
          const d = toNum(b);
          if (d === 0) throw new FormulaError("Division durch 0.");
          return toNum(a) / d;
        }
        case "%":
          return toNum(a) % toNum(b);
        case "^":
          return toNum(a) ** toNum(b);
        case "==":
          return equals(a, b);
        case "!=":
          return !equals(a, b);
        case "<":
          return compare(a, b) < 0;
        case ">":
          return compare(a, b) > 0;
        case "<=":
          return compare(a, b) <= 0;
        case ">=":
          return compare(a, b) >= 0;
      }
      throw new FormulaError(`Operator ${node.op} unbekannt.`);
    }
    case "call": {
      const name = ALIASES[node.name] ?? node.name;
      if (name === "prop") {
        const arg = node.args[0];
        if (!arg || arg.k !== "lit" || typeof arg.v !== "string") throw new FormulaError('prop() braucht den Namen in Anführungszeichen, z. B. prop("Preis").');
        return env.prop(arg.v);
      }
      // Bedingungen werten nur den gewählten Zweig aus
      if (name === "if") {
        if (node.args.length < 2) throw new FormulaError("if(Bedingung, dann, sonst) braucht mindestens 2 Angaben.");
        return truthy(evalNode(node.args[0], env)) ? evalNode(node.args[1], env) : node.args[2] ? evalNode(node.args[2], env) : null;
      }
      if (name === "ifs") {
        for (let i = 0; i + 1 < node.args.length; i += 2) if (truthy(evalNode(node.args[i], env))) return evalNode(node.args[i + 1], env);
        return node.args.length % 2 ? evalNode(node.args[node.args.length - 1], env) : null;
      }
      const fn = FUNCS[name];
      if (!fn) throw new FormulaError(`Funktion „${node.name}“ gibt es nicht.`);
      return fn(node.args.map((a) => evalNode(a, env)), env);
    }
  }
}

/** Formel auswerten; Fehler werden als Text zurückgegeben statt geworfen */
export function evaluateFormula(src: string, env: FormulaEnv): { value: FValue; error?: string } {
  if (!src.trim()) return { value: null };
  try {
    const value = evalNode(compile(src), env);
    if (typeof value === "number" && !Number.isFinite(value)) return { value: null, error: "Ergebnis ist keine gültige Zahl." };
    return { value };
  } catch (e) {
    return { value: null, error: e instanceof Error && e.message ? e.message : "Formel konnte nicht ausgewertet werden." };
  }
}

/** Datumswert als ISO-Text (für Filter, Sortierung, Kalender) */
export function dateToIso(d: Date): string {
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return d.getHours() || d.getMinutes() ? `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}
