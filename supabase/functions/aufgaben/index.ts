// @ts-nocheck
// AUTOMATISCH ERZEUGT mit `npm run build:server` – nicht von Hand ändern.
// Quelle: server/aufgaben.ts (+ src/notes/daily, gemeinsam mit der App). Im Supabase-Editor komplett einfügen.
// src/notes/gamification/focus.ts
const FOCUS_KEY = "__focus";
const MAX_FOCUS = 3;
const mapOf = (props) => {
	const raw = props[FOCUS_KEY];
	return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
};
/** Eintrag einer Person für einen Tag (null = nicht angepinnt) */
function focusEntry(row, userId, day) {
	const v = mapOf(row.props)[userId];
	if (typeof v !== "string") return null;
	const [d, r, flag] = v.split(":");
	const rank = Number(r);
	return d === day && rank >= 1 ? {
		rank,
		pending: flag === "?"
	} : null;
}
/** Fokus-Aufgaben einer Person für einen Tag, nach Rang */
function focusTasks(rows, userId, day) {
	return rows.map((row) => ({
		row,
		entry: focusEntry(row, userId, day)
	})).filter((x) => x.entry !== null).map(({ row, entry }) => ({
		row,
		...entry
	})).sort((a, b) => a.rank - b.rank).slice(0, 3);
}

// src/notes/util.ts
const COLORS = [
	"default",
	"gray",
	"brown",
	"orange",
	"yellow",
	"green",
	"blue",
	"purple",
	"pink",
	"red"
];
const untitled = (p) => p?.title.trim() || "Ohne Titel";
const pad$1 = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getFullYear()}-${pad$1(d.getMonth() + 1)}-${pad$1(d.getDate())}`;
const today = () => isoDay(/* @__PURE__ */ new Date());
const WEEKDAYS = [
	"So",
	"Mo",
	"Di",
	"Mi",
	"Do",
	"Fr",
	"Sa"
];
const MONTHS = [
	"Januar",
	"Februar",
	"März",
	"April",
	"Mai",
	"Juni",
	"Juli",
	"August",
	"September",
	"Oktober",
	"November",
	"Dezember"
];
/** "2026-10-29" oder "2026-10-29T14:30" → "29. Okt. 2026" / "Heute 14:30" */
function formatDate(value, opts = {}) {
	const [day, time] = value.split("T");
	const [y, m, d] = day.split("-").map(Number);
	if (!y || !m || !d) return value;
	const t = time ? ` ${time.slice(0, 5)}` : "";
	if (opts.relative !== false) {
		const diff = Math.round((new Date(y, m - 1, d).getTime() - new Date((/* @__PURE__ */ new Date()).toDateString()).getTime()) / 864e5);
		if (diff === 0) return `Heute${t}`;
		if (diff === 1) return `Morgen${t}`;
		if (diff === -1) return `Gestern${t}`;
	}
	const date = new Date(y, m - 1, d);
	const sameYear = y === (/* @__PURE__ */ new Date()).getFullYear();
	return `${WEEKDAYS[date.getDay()]}, ${d}. ${MONTHS[m - 1].slice(0, 3)}${m === 5 ? "" : "."}${sameYear ? "" : ` ${y}`}${t}`;
}
function formatTimestamp(iso) {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return `${formatDate(isoDay(d))}, ${pad$1(d.getHours())}:${pad$1(d.getMinutes())}`;
}

// src/notes/database/formula.ts
var FormulaError = class extends Error {};
const OPS = [
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"+",
	"-",
	"*",
	"/",
	"%",
	"^",
	"<",
	">",
	"!",
	"?",
	":",
	"(",
	")",
	",",
	"="
];
function tokenize(src) {
	const out = [];
	let i = 0;
	while (i < src.length) {
		const c = src[i];
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		if (/[0-9]/.test(c) || c === "." && /[0-9]/.test(src[i + 1] ?? "")) {
			const m = src.slice(i).match(/^\d*\.?\d+(?:[eE][+-]?\d+)?/);
			out.push({
				t: "num",
				v: m[0],
				pos: i
			});
			i += m[0].length;
			continue;
		}
		if (c === "\"" || c === "'" || c === "“" || c === "„") {
			const close = c === "„" ? "“" : c === "“" ? "”" : c;
			let j = i + 1;
			let s = "";
			while (j < src.length && src[j] !== close && !(c === "“" && src[j] === "“")) if (src[j] === "\\" && j + 1 < src.length) {
				const n = src[j + 1];
				s += n === "n" ? "\n" : n === "t" ? "	" : n;
				j += 2;
			} else s += src[j++];
			if (j >= src.length) throw new FormulaError(`Text ab Zeichen ${i + 1} ist nicht geschlossen.`);
			out.push({
				t: "str",
				v: s,
				pos: i
			});
			i = j + 1;
			continue;
		}
		if (/[\p{L}_]/u.test(c)) {
			const m = src.slice(i).match(/^[\p{L}_][\p{L}\p{N}_]*/u);
			out.push({
				t: "id",
				v: m[0],
				pos: i
			});
			i += m[0].length;
			continue;
		}
		const op = OPS.find((o) => src.startsWith(o, i));
		if (!op) throw new FormulaError(`Unbekanntes Zeichen „${c}“ an Stelle ${i + 1}.`);
		out.push({
			t: "op",
			v: op === "=" ? "==" : op,
			pos: i
		});
		i += op.length;
	}
	out.push({
		t: "end",
		v: "",
		pos: src.length
	});
	return out;
}
const BINARY = {
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
	"^": [8, "r"]
};
function parse(src) {
	const tokens = tokenize(src);
	let p = 0;
	const peek = () => tokens[p];
	const next = () => tokens[p++];
	const expect = (v) => {
		const t = next();
		if (t.v !== v) throw new FormulaError(`„${v}“ erwartet an Stelle ${t.pos + 1}${t.v ? ` statt „${t.v}“` : ""}.`);
	};
	const opOf = (t) => t.t === "op" ? t.v : t.t === "id" && ["and", "or"].includes(t.v.toLowerCase()) ? t.v.toLowerCase() : null;
	function expr(min = 0) {
		let left = unary();
		for (;;) {
			const t = peek();
			if (t.t === "op" && t.v === "?" && min <= 1) {
				next();
				const a = expr(0);
				expect(":");
				const b = expr(1);
				left = {
					k: "cond",
					c: left,
					a,
					b
				};
				continue;
			}
			const op = opOf(t);
			const info = op ? BINARY[op] : void 0;
			if (!op || !info || info[0] < min) return left;
			next();
			const right = expr(info[1] === "l" ? info[0] + 1 : info[0]);
			left = {
				k: "binary",
				op: op === "and" ? "&&" : op === "or" ? "||" : op,
				a: left,
				b: right
			};
		}
	}
	function unary() {
		const t = peek();
		if (t.t === "op" && (t.v === "-" || t.v === "!" || t.v === "+") || t.t === "id" && t.v.toLowerCase() === "not" && tokens[p + 1]?.v !== "(") {
			next();
			return {
				k: "unary",
				op: t.v === "+" ? "+" : t.v === "-" ? "-" : "!",
				arg: expr(9)
			};
		}
		return primary();
	}
	function primary() {
		const t = next();
		if (t.t === "num") return {
			k: "lit",
			v: Number(t.v)
		};
		if (t.t === "str") return {
			k: "lit",
			v: t.v
		};
		if (t.t === "op" && t.v === "(") {
			const e = expr(0);
			expect(")");
			return e;
		}
		if (t.t === "id") {
			const low = t.v.toLowerCase();
			if (peek().v === "(") {
				next();
				const args = [];
				if (peek().v !== ")") do
					args.push(expr(0));
				while (peek().v === "," && next());
				expect(")");
				return {
					k: "call",
					name: low,
					args
				};
			}
			if (low === "true" || low === "wahr") return {
				k: "lit",
				v: true
			};
			if (low === "false" || low === "falsch") return {
				k: "lit",
				v: false
			};
			if (low === "pi") return {
				k: "lit",
				v: Math.PI
			};
			throw new FormulaError(`„${t.v}“ ist unbekannt. Eigenschaften mit prop("Name") verwenden.`);
		}
		throw new FormulaError(t.t === "end" ? "Formel endet unerwartet." : `Unerwartetes „${t.v}“ an Stelle ${t.pos + 1}.`);
	}
	const node = expr(0);
	if (peek().t !== "end") throw new FormulaError(`Unerwartetes „${peek().v}“ an Stelle ${peek().pos + 1}.`);
	return node;
}
const cache = /* @__PURE__ */ new Map();
function compile(src) {
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
const isDate = (v) => v instanceof Date;
const isEmptyValue = (v) => v === null || v === "" || Array.isArray(v) && v.length === 0 || typeof v === "number" && Number.isNaN(v);
function toText(v) {
	if (v === null) return "";
	if (Array.isArray(v)) return v.map(toText).filter(Boolean).join(", ");
	if (isDate(v)) return formatDateValue(v);
	if (typeof v === "boolean") return v ? "Ja" : "Nein";
	if (typeof v === "number") return Number.isFinite(v) ? v.toLocaleString("de-DE", { maximumFractionDigits: 10 }) : "";
	return v;
}
function toNum(v) {
	if (typeof v === "number") return v;
	if (typeof v === "boolean") return v ? 1 : 0;
	if (isDate(v)) return v.getTime();
	if (v === null || v === "") return 0;
	if (Array.isArray(v)) return v.length;
	const n = Number(String(v).replace(/\s/g, "").replace(",", "."));
	return Number.isNaN(n) ? NaN : n;
}
const truthy = (v) => !(v === null || v === false || v === 0 || v === "" || Array.isArray(v) && v.length === 0);
function toDate(v) {
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
const pad = (n) => String(n).padStart(2, "0");
function formatDateValue(d) {
	const date = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
	return d.getHours() || d.getMinutes() ? `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}` : date;
}
const UNITS = {
	years: "y",
	year: "y",
	jahre: "y",
	jahr: "y",
	quarters: "q",
	quarter: "q",
	quartale: "q",
	quartal: "q",
	months: "M",
	month: "M",
	monate: "M",
	monat: "M",
	weeks: "w",
	week: "w",
	wochen: "w",
	woche: "w",
	days: "d",
	day: "d",
	tage: "d",
	tag: "d",
	hours: "h",
	hour: "h",
	stunden: "h",
	stunde: "h",
	minutes: "m",
	minute: "m",
	minuten: "m"
};
function unitOf(v) {
	const u = UNITS[String(v ?? "days").toLowerCase()];
	if (!u) throw new FormulaError(`Unbekannte Einheit „${String(v)}“ (z. B. "days", "weeks", "months").`);
	return u;
}
function addTo(d, n, unit) {
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
function between(a, b, unit) {
	const ms = a.getTime() - b.getTime();
	if (unit === "y" || unit === "q" || unit === "M") {
		let months = (a.getFullYear() - b.getFullYear()) * 12 + (a.getMonth() - b.getMonth());
		if (months > 0 && a.getDate() < b.getDate()) months--;
		if (months < 0 && a.getDate() > b.getDate()) months++;
		return unit === "y" ? Math.trunc(months / 12) : unit === "q" ? Math.trunc(months / 3) : months;
	}
	const div = {
		w: 6048e5,
		d: 864e5,
		h: 36e5,
		m: 6e4
	}[unit];
	return Math.trunc(ms / div);
}
function formatPattern(d, pattern) {
	const map = {
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
		MMM: d.toLocaleDateString("de-DE", { month: "short" })
	};
	return pattern.replace(/YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D|HH|H|mm/g, (t) => map[t]);
}
const flat = (args) => args.flatMap((a) => Array.isArray(a) ? flat(a) : [a]);
function compare(a, b) {
	if (isDate(a) || isDate(b)) return (toDate(a)?.getTime() ?? NaN) - (toDate(b)?.getTime() ?? NaN);
	if (typeof a === "number" || typeof b === "number") return toNum(a) - toNum(b);
	return toText(a).localeCompare(toText(b), "de");
}
function equals(a, b) {
	if (isDate(a) || isDate(b)) {
		const da = toDate(a);
		const db = toDate(b);
		return Boolean(da && db && da.getTime() === db.getTime());
	}
	if (typeof a === "number" || typeof b === "number") return toNum(a) === toNum(b);
	if (typeof a === "boolean" || typeof b === "boolean") return truthy(a) === truthy(b);
	return toText(a) === toText(b);
}
const n0 = (a, i = 0) => toNum(a[i] ?? null);
const t0 = (a, i = 0) => toText(a[i] ?? null);
const d0 = (a, i = 0) => {
	const d = toDate(a[i] ?? null);
	if (!d) throw new FormulaError("Datum erwartet.");
	return d;
};
const startOfToday = (env) => {
	const n = env.now?.() ?? /* @__PURE__ */ new Date();
	return new Date(n.getFullYear(), n.getMonth(), n.getDate());
};
const FUNCS = {
	not: (a) => !truthy(a[0] ?? null),
	and: (a) => a.every(truthy),
	or: (a) => a.some(truthy),
	empty: (a) => isEmptyValue(a[0] ?? null),
	length: (a) => Array.isArray(a[0]) ? a[0].length : t0(a).length,
	concat: (a) => a.some(Array.isArray) ? flat(a) : a.map(toText).join(""),
	join: (a) => Array.isArray(a[0]) ? a[0].map(toText).join(t0(a, 1)) : a.slice(1).map(toText).join(t0(a)),
	contains: (a) => Array.isArray(a[0]) ? a[0].some((x) => equals(x, a[1] ?? null)) : t0(a).toLowerCase().includes(t0(a, 1).toLowerCase()),
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
	slice: (a) => Array.isArray(a[0]) ? a[0].slice(n0(a, 1), a[2] === void 0 ? void 0 : n0(a, 2)) : t0(a).slice(n0(a, 1), a[2] === void 0 ? void 0 : n0(a, 2)),
	repeat: (a) => t0(a).repeat(Math.max(0, Math.min(1e3, n0(a, 1)))),
	format: (a) => t0(a),
	tostring: (a) => t0(a),
	tonumber: (a) => toNum(a[0] ?? null),
	round: (a) => {
		const f = 10 ** (a[1] === void 0 ? 0 : n0(a, 1));
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
	sum: (a) => flat(a).reduce((s, x) => s + (isEmptyValue(x) ? 0 : toNum(x)), 0),
	mean: (a) => {
		const list = flat(a).filter((x) => !isEmptyValue(x)).map(toNum);
		return list.length ? list.reduce((s, x) => s + x, 0) / list.length : null;
	},
	count: (a) => flat(a).filter((x) => !isEmptyValue(x)).length,
	first: (a) => Array.isArray(a[0]) ? a[0][0] ?? null : a[0] ?? null,
	last: (a) => Array.isArray(a[0]) ? a[0][a[0].length - 1] ?? null : a[0] ?? null,
	now: (_a, env) => env.now?.() ?? /* @__PURE__ */ new Date(),
	today: (_a, env) => startOfToday(env),
	date: (a) => toDate(a[0] ?? null),
	dateadd: (a) => addTo(d0(a), n0(a, 1), unitOf(a[2] ?? "days")),
	datesubtract: (a) => addTo(d0(a), -n0(a, 1), unitOf(a[2] ?? "days")),
	datebetween: (a) => between(d0(a), d0(a, 1), unitOf(a[2] ?? "days")),
	formatdate: (a) => a[1] === void 0 ? formatDateValue(d0(a)) : formatPattern(d0(a), t0(a, 1)),
	year: (a) => d0(a).getFullYear(),
	month: (a) => d0(a).getMonth() + 1,
	day: (a) => d0(a).getDate(),
	weekday: (a) => (d0(a).getDay() + 6) % 7 + 1,
	hour: (a) => d0(a).getHours(),
	minute: (a) => d0(a).getMinutes()
};
const ALIASES = {
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
	eigenschaft: "prop"
};
const FUNCTION_NAMES = [
	"prop",
	"if",
	"ifs",
	...Object.keys(FUNCS)
].sort();
function evalNode(node, env) {
	switch (node.k) {
		case "lit": return node.v;
		case "cond": return truthy(evalNode(node.c, env)) ? evalNode(node.a, env) : evalNode(node.b, env);
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
				case "*": return toNum(a) * toNum(b);
				case "/": {
					const d = toNum(b);
					if (d === 0) throw new FormulaError("Division durch 0.");
					return toNum(a) / d;
				}
				case "%": return toNum(a) % toNum(b);
				case "^": return toNum(a) ** toNum(b);
				case "==": return equals(a, b);
				case "!=": return !equals(a, b);
				case "<": return compare(a, b) < 0;
				case ">": return compare(a, b) > 0;
				case "<=": return compare(a, b) <= 0;
				case ">=": return compare(a, b) >= 0;
			}
			throw new FormulaError(`Operator ${node.op} unbekannt.`);
		}
		case "call": {
			const name = ALIASES[node.name] ?? node.name;
			if (name === "prop") {
				const arg = node.args[0];
				if (!arg || arg.k !== "lit" || typeof arg.v !== "string") throw new FormulaError("prop() braucht den Namen in Anführungszeichen, z. B. prop(\"Preis\").");
				return env.prop(arg.v);
			}
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
function evaluateFormula(src, env) {
	if (!src.trim()) return { value: null };
	try {
		const value = evalNode(compile(src), env);
		if (typeof value === "number" && !Number.isFinite(value)) return {
			value: null,
			error: "Ergebnis ist keine gültige Zahl."
		};
		return { value };
	} catch (e) {
		return {
			value: null,
			error: e instanceof Error && e.message ? e.message : "Formel konnte nicht ausgewertet werden."
		};
	}
}
/** Datumswert als ISO-Text (für Filter, Sortierung, Kalender) */
function dateToIso(d) {
	const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
	return d.getHours() || d.getMinutes() ? `${day}T${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
}

// src/notes/database/logic.ts
const MAX_DEPTH = 6;
const schemaOf = (row, ctx) => (row.parentId ? ctx.pages.get(row.parentId)?.schema : void 0) ?? void 0;
const deeper = (ctx) => ({
	...ctx,
	depth: (ctx.depth ?? 0) + 1
});
/** Verknüpfte, nicht gelöschte Einträge */
function relatedRows(row, prop, ctx) {
	const ids = row.props[prop.id];
	if (!Array.isArray(ids)) return [];
	return ids.map((id) => ctx.pages.get(id)).filter((p) => Boolean(p && !p.archivedAt));
}
function toDateObj(v) {
	const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/);
	return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0)) : new Date(v);
}
/** Wert als Formel-Wert (Zahl, Text, Datum, Liste …) – Grundlage für Formeln, Rollups und Anzeige berechneter Werte */
function richValue(row, prop, ctx) {
	if ((ctx.depth ?? 0) > MAX_DEPTH) return null;
	const raw = row.props[prop.id] ?? null;
	switch (prop.type) {
		case "title": return row.title;
		case "number": return raw === null || raw === "" ? null : Number(raw);
		case "checkbox": return Boolean(raw);
		case "date": return raw ? toDateObj(String(raw)) : null;
		case "created_time": return new Date(row.createdAt);
		case "last_edited_time": return new Date(row.updatedAt);
		case "created_by": return ctx.members.find((m) => m.id === row.createdBy)?.name ?? null;
		case "select":
		case "status": return optionById(prop, raw)?.name ?? null;
		case "multi_select": return (Array.isArray(raw) ? raw : []).map((id) => optionById(prop, id)?.name ?? "").filter(Boolean);
		case "person": return (Array.isArray(raw) ? raw : []).map((id) => ctx.members.find((m) => m.id === id)?.name ?? "").filter(Boolean);
		case "relation": return relatedRows(row, prop, ctx).map((r) => untitled(r));
		case "formula": return formulaResult(row, prop, ctx).value;
		case "rollup": return rollupValue(row, prop, ctx);
		default: return raw === null ? null : String(raw);
	}
}
function formulaResult(row, prop, ctx) {
	if ((ctx.depth ?? 0) > MAX_DEPTH) return {
		value: null,
		error: "Formel verweist im Kreis auf sich selbst."
	};
	const schema = schemaOf(row, ctx);
	const inner = deeper(ctx);
	return evaluateFormula(prop.formula ?? "", { prop: (name) => {
		if (name.toLowerCase() === "titel" || name.toLowerCase() === "title") return row.title;
		const target = schema?.properties.find((p) => p.name.toLowerCase() === name.toLowerCase());
		if (!target) throw new Error(`Eigenschaft „${name}“ gibt es nicht.`);
		return richValue(row, target, inner);
	} });
}
function rollupValue(row, prop, ctx) {
	const cfg = prop.rollup;
	const rel = schemaOf(row, ctx)?.properties.find((p) => p.id === cfg?.relationPropId && p.type === "relation");
	if (!cfg || !rel?.relation) return null;
	const target = ctx.pages.get(rel.relation.dbId)?.schema?.properties.find((p) => p.id === cfg.targetPropId);
	const rows = relatedRows(row, rel, ctx);
	if (!target) return cfg.fn === "count" ? rows.length : null;
	const inner = deeper(ctx);
	const perRow = rows.map((r) => richValue(r, target, inner));
	const values = perRow.flatMap((v) => Array.isArray(v) ? v : [v]);
	const present = values.filter((v) => !isEmptyValue(v) && v !== false);
	const nums = values.filter((v) => typeof v === "number" && Number.isFinite(v));
	const dates = values.filter((v) => v instanceof Date).map((d) => d.getTime());
	switch (cfg.fn) {
		case "show": return values.filter((v) => !isEmptyValue(v)).map((v) => v instanceof Date ? v : typeof v === "boolean" ? v ? "✓" : "–" : v);
		case "count": return rows.length;
		case "count_values": return present.length;
		case "count_unique": return new Set(present.map(toText)).size;
		case "empty": return perRow.filter((v) => isEmptyValue(v)).length;
		case "not_empty": return perRow.filter((v) => !isEmptyValue(v)).length;
		case "sum": return nums.reduce((s, x) => s + x, 0);
		case "average": return nums.length ? nums.reduce((s, x) => s + x, 0) / nums.length : null;
		case "min": return nums.length ? Math.min(...nums) : null;
		case "max": return nums.length ? Math.max(...nums) : null;
		case "range":
			if (dates.length) return Math.round((Math.max(...dates) - Math.min(...dates)) / 864e5);
			return nums.length ? Math.max(...nums) - Math.min(...nums) : null;
		case "earliest": return dates.length ? new Date(Math.min(...dates)) : null;
		case "latest": return dates.length ? new Date(Math.max(...dates)) : null;
		case "checked": return values.filter((v) => v === true).length;
		case "unchecked": return values.filter((v) => v === false).length;
		case "percent_checked": return values.length ? Math.round(values.filter((v) => v === true).length / values.length * 100) : null;
	}
}
/** Berechneter Wert als speicherbarer Wert (Zahl, Text, Wahr/Falsch, ISO-Datum, Liste) */
function computedToProp(v) {
	if (v === null) return null;
	if (v instanceof Date) return dateToIso(v);
	if (Array.isArray(v)) return v.map(toText).filter(Boolean);
	return v;
}
/** Wert einer Eigenschaft für eine Zeile (inkl. berechneter Werte, wenn ctx vorhanden) */
function getValue(row, prop, ctx) {
	switch (prop.type) {
		case "title": return row.title;
		case "created_time": return row.createdAt;
		case "last_edited_time": return row.updatedAt;
		case "created_by": return row.createdBy;
		case "formula":
		case "rollup": return ctx ? computedToProp(richValue(row, prop, ctx)) : null;
		default: return row.props[prop.id] ?? null;
	}
}
const optionById = (prop, id) => prop.options?.find((o) => o.id === id);
/** Textdarstellung (Suche, Sortierung, Export) */
function displayValue(row, prop, ctx) {
	if (prop.type === "formula" || prop.type === "rollup" || prop.type === "relation") {
		const v = richValue(row, prop, ctx);
		if (typeof v === "number" && prop.format) return formatNumber(v, prop.format);
		return toText(v);
	}
	const v = getValue(row, prop, ctx);
	if (v === null || v === void 0 || v === "") return "";
	switch (prop.type) {
		case "select":
		case "status": return optionById(prop, v)?.name ?? "";
		case "multi_select": return (Array.isArray(v) ? v : []).map((id) => optionById(prop, id)?.name ?? "").filter(Boolean).join(", ");
		case "person": return (Array.isArray(v) ? v : []).map((id) => ctx.members.find((m) => m.id === id)?.name ?? "").filter(Boolean).join(", ");
		case "created_by": return ctx.members.find((m) => m.id === v)?.name ?? "";
		case "checkbox": return v ? "Ja" : "Nein";
		case "date": return formatDate(String(v), { relative: false });
		case "created_time":
		case "last_edited_time": return formatTimestamp(String(v));
		case "number": return formatNumber(Number(v), prop.format);
		default: return String(v);
	}
}
function formatNumber(n, format) {
	if (!Number.isFinite(n)) return "";
	if (format === "euro") return n.toLocaleString("de-DE", {
		style: "currency",
		currency: "EUR"
	});
	if (format === "percent") return `${n.toLocaleString("de-DE")} %`;
	return n.toLocaleString("de-DE", { maximumFractionDigits: 10 });
}
/** Status-Gruppe "erledigt"? (für "Meine Aufgaben") */
function isDone(row, schema) {
	const status = schema.properties.find((p) => p.type === "status");
	if (status) return optionById(status, row.props[status.id])?.group === "done";
	const check = schema.properties.find((p) => p.type === "checkbox");
	return check ? Boolean(row.props[check.id]) : false;
}

// src/notes/gamification/tasks.ts
/** Alle Einträge aller Datenbanken (nur lebende); filter grenzt die Datenbanken ein */
function allTasks(pages, isLive, filter = () => true, day = today()) {
	const dbs = /* @__PURE__ */ new Map();
	for (const p of pages.values()) if (p.kind === "database" && p.schema && isLive(p.id) && filter(p)) dbs.set(p.id, p);
	const out = [];
	for (const row of pages.values()) {
		const db = row.parentId ? dbs.get(row.parentId) : void 0;
		if (!db || row.archivedAt || row.deletedAt) continue;
		const dateProp = db.schema.properties.find((p) => p.type === "date");
		const due = dateProp ? row.props[dateProp.id] ?? null : null;
		const done = isDone(row, db.schema);
		out.push({
			row,
			db,
			due,
			done,
			overdue: !done && Boolean(due) && due.slice(0, 10) < day
		});
	}
	return out;
}
function assigneesOf(row, schema) {
	return schema.properties.filter((p) => p.type === "person").flatMap((p) => {
		const v = getValue(row, p);
		return Array.isArray(v) ? v : [];
	});
}
/** Aufgaben einer Person: ihr zugewiesen – oder ohne Zuständige in ihrer eigenen privaten Liste */
function tasksOf(items, userId) {
	return items.filter(({ row, db }) => {
		const who = assigneesOf(row, db.schema);
		return who.includes(userId) || !who.length && db.space === "private" && db.ownerId === userId;
	});
}

// src/notes/daily/status.ts
/** Lebt eine Seite noch (nicht archiviert/gelöscht, auch keine ihrer Eltern)? */
function liveCheck(pages) {
	const cache = /* @__PURE__ */ new Map();
	const check = (id, depth = 0) => {
		const known = cache.get(id);
		if (known !== void 0) return known;
		const p = pages.get(id);
		const ok = Boolean(p && !p.archivedAt && !p.deletedAt && (!p.parentId || depth < 50 && check(p.parentId, depth + 1)));
		cache.set(id, ok);
		return ok;
	};
	return (id) => check(id);
}
function dailyStatus(input) {
	const { day, plan } = input;
	const isLive = input.isLive ?? liveCheck(input.pages);
	const items = allTasks(input.pages, isLive, () => true, day);
	const byRow = new Map(items.map((t) => [t.row.id, t]));
	const rows = items.map((t) => t.row);
	const absentSet = new Set(plan?.absent ?? []);
	const plannedSet = new Set(plan?.planned ?? []);
	const studio = input.studioName ?? (() => "");
	const all = input.members.filter((m) => !m.device).map((member) => {
		const focus = focusTasks(rows, member.id, day).map((f) => ({
			...byRow.get(f.row.id),
			rank: f.rank,
			pending: f.pending
		}));
		const absent = absentSet.has(member.id);
		const planned = plannedSet.has(member.id);
		const done = focus.filter((f) => f.done).length;
		const open = absent ? 0 : focus.length - done;
		const due = absent ? [] : tasksOf(items, member.id).filter((t) => !t.done && t.due !== null && t.due.slice(0, 10) <= day);
		const state = absent ? "absent" : !focus.length ? "none" : open ? "open" : "done";
		return {
			member,
			absent,
			planned,
			relevant: plan === null || planned || absent || focus.length > 0,
			focus,
			open,
			done,
			due,
			state
		};
	});
	const people = all.filter((p) => p.relevant).sort((a, b) => studio(a.member.studioId).localeCompare(studio(b.member.studioId), "de") || a.member.name.localeCompare(b.member.name, "de"));
	const present = people.filter((p) => !p.absent);
	return {
		day,
		all,
		people,
		absent: people.filter((p) => p.absent),
		outstanding: present.filter((p) => p.state === "open" || p.state === "none"),
		finished: present.filter((p) => p.state === "done"),
		withoutFocus: present.filter((p) => p.state === "none"),
		pending: people.flatMap((person) => person.focus.filter((f) => f.pending).map((item) => ({
			person,
			item
		}))),
		dueToday: present.reduce((n, p) => n + p.due.filter((t) => t.due.slice(0, 10) === day).length, 0),
		overdue: present.reduce((n, p) => n + p.due.filter((t) => t.due.slice(0, 10) < day).length, 0)
	};
}

// src/notes/daily/telegram.ts
const WEEKDAY_INDEX = {
	Mon: 1,
	Tue: 2,
	Wed: 3,
	Thu: 4,
	Fri: 5,
	Sat: 6,
	Sun: 7
};
/** Berliner Kalendertag, Stunde (0–23) und Wochentag – unabhängig von der Server-Zeitzone (UTC) */
function berlinNow(date = /* @__PURE__ */ new Date()) {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: "Europe/Berlin",
		hourCycle: "h23",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		weekday: "short"
	}).formatToParts(date);
	const get = (type) => parts.find((p) => p.type === type)?.value ?? "";
	const hour = Number(get("hour"));
	const weekday = WEEKDAY_INDEX[get("weekday")];
	if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !weekday) throw new Error(`Berliner Zeit nicht lesbar: ${JSON.stringify(parts)}`);
	return {
		day: `${get("year")}-${get("month")}-${get("day")}`,
		hour,
		weekday
	};
}
function parseHours(env) {
	const read = (key, fallback) => {
		const n = Number(env(key) ?? fallback);
		return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
	};
	return {
		frueh: read("AUFGABEN_STUNDE_FRUEH", 6),
		mittag: read("AUFGABEN_STUNDE_MITTAG", 14),
		abend: read("AUFGABEN_STUNDE_ABEND", 20)
	};
}
/** Welcher Reminder ist jetzt dran? Nur Montag–Freitag zur jeweiligen Berliner Stunde. */
function dueReminder(now, hours) {
	if (now.weekday > 5) return null;
	return Object.keys(hours).find((k) => hours[k] === now.hour) ?? null;
}
/** AUFGABEN_EMPFAENGER: [{"id":123456789,"kz":"TZ","name":"Tobias"}, …] */
function parseRecipients(raw) {
	if (!raw?.trim()) return {
		recipients: [],
		errors: ["AUFGABEN_EMPFAENGER ist leer"]
	};
	let data;
	try {
		data = JSON.parse(raw);
	} catch {
		return {
			recipients: [],
			errors: ["AUFGABEN_EMPFAENGER ist kein gültiges JSON"]
		};
	}
	if (!Array.isArray(data)) return {
		recipients: [],
		errors: ["AUFGABEN_EMPFAENGER muss eine Liste sein"]
	};
	const recipients = [];
	const errors = [];
	data.forEach((r, i) => {
		const o = r;
		if (typeof o?.id === "number" && Number.isFinite(o.id) && typeof o.name === "string" && o.name.trim()) recipients.push({
			id: o.id,
			kz: String(o.kz ?? "").trim(),
			name: o.name.trim()
		});
		else errors.push(`Eintrag ${i + 1} braucht id (Zahl) und name`);
	});
	return {
		recipients,
		errors
	};
}
/** Kürzel aus Vor- und Nachname: "Tobias Zimmermann" → "TZ" */
const initialsOf = (name) => name.split(/\s+/).filter(Boolean).map((w) => w[0].toUpperCase()).join("");
/**
* Ist dieser Empfänger der Absender? Sicher über die Telegram-Verknüpfung aus ClockIn (chat_id);
* sonst nur, wenn Vorname UND Kürzel passen – kein Raten über den Vornamen allein.
*/
function isSender(r, sender) {
	if (sender.chatIds.includes(r.id)) return true;
	const first = sender.name.split(/\s+/)[0]?.toLowerCase() ?? "";
	return Boolean(r.kz) && r.kz.toUpperCase() === initialsOf(sender.name) && r.name.split(/\s+/)[0].toLowerCase() === first;
}
const WD = [
	"",
	"Mo",
	"Di",
	"Mi",
	"Do",
	"Fr",
	"Sa",
	"So"
];
function dayLabel(day) {
	const [y, m, d] = day.split("-").map(Number);
	const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
	return `${WD[wd]} ${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.`;
}
const shorten = (text, max = 120) => {
	const t = text.replace(/\s+/g, " ").trim();
	return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
};
/** Link zu einer Aufgabe: AUFGABEN_APP_URL mit {id} oder als Basis (dann …#/p/<id>) */
function entryLink(base, id) {
	if (!base?.trim()) return null;
	const b = base.trim();
	return b.includes("{id}") ? b.replace("{id}", encodeURIComponent(id)) : `${b.replace(/\/+$/, "")}/#/p/${encodeURIComponent(id)}`;
}
/** Titel und die ersten Felder einer Aufgabe, gekürzt auf 120 Zeichen */
function entrySummary(row, db, ctx) {
	const parts = [row.title.trim() || "Ohne Titel"];
	for (const prop of db?.schema?.properties ?? []) {
		if (prop.type === "title" || prop.type === "created_by" || prop.type === "created_time" || prop.type === "last_edited_time") continue;
		const v = displayValue(row, prop, ctx);
		if (v) parts.push(`${prop.name}: ${v}`);
		if (parts.length >= 4) break;
	}
	return shorten(parts.join(" · "), 120);
}
function focusMessage(m) {
	const self = m.actor === m.target;
	return [
		m.pending ? `🙋 Freigabe Tagesaufgabe\n${m.target} (${m.source}) möchte als Nr. ${m.rank}:` : `📌 Neue Tagesaufgabe\n${m.actor} (${m.source}) → ${self ? "für sich" : m.target}, Nr. ${m.rank}:`,
		m.summary,
		m.link
	].filter(Boolean).join("\n");
}
const first = (p) => p.member.name.split(" ")[0] || p.member.name;
const names = (list) => list.map((p) => p.member.name).join(", ");
const focusLine = (f) => `${f.done ? "✅" : `${f.rank})`} ${shorten(f.row.title.trim() || "Ohne Titel", 60)}${f.pending ? " ⏳" : ""}`;
/** Zeile mit den Abwesenden – entfällt, wenn niemand abwesend ist */
const absentLine = (s) => s.absent.length ? `Krank, Schule oder Urlaub: ${names(s.absent)}` : null;
function reminderText(kind, s, studioName) {
	const lines = [`${{
		frueh: "☀️ Tagesaufgaben",
		mittag: "⏳ Zwischenstand",
		abend: "🌙 Tagesabschluss"
	}[kind]} · ${dayLabel(s.day)}`];
	if (kind === "frueh") {
		let studio = null;
		for (const p of s.people) {
			const st = studioName(p.member.studioId);
			if (st !== studio) {
				studio = st;
				lines.push("", st);
			}
			const what = p.absent ? "-" : p.focus.length ? p.focus.map(focusLine).join("  ") : "noch keine Tagesaufgabe";
			lines.push(`• ${first(p)}: ${what}`);
		}
		if (!s.people.length) lines.push("", "Heute ist niemand eingeplant.");
		lines.push("");
		if (s.dueToday || s.overdue) lines.push(`Fällig heute: ${s.dueToday}${s.overdue ? ` · überfällig: ${s.overdue}` : ""}`);
		if (s.pending.length) lines.push(`Warten auf Freigabe: ${s.pending.length}`);
	} else if (kind === "mittag") {
		lines.push("");
		const open = s.outstanding.filter((p) => p.state === "open");
		lines.push(open.length ? `Noch offen: ${open.map((p) => `${first(p)} (${p.done}/${p.focus.length})`).join(", ")}` : "Alle Tagesaufgaben erledigt 🎉");
		if (s.withoutFocus.length) lines.push(`Ohne Tagesaufgabe: ${s.withoutFocus.map(first).join(", ")}`);
		if (s.finished.length) lines.push(`Fertig: ${s.finished.map(first).join(", ")} ✅`);
		if (s.pending.length) lines.push(`Warten auf Freigabe: ${s.pending.length}`);
	} else {
		lines.push("");
		const open = s.outstanding.filter((p) => p.state === "open");
		if (open.length) {
			lines.push("Nicht erledigt:");
			for (const p of open) lines.push(`• ${first(p)}: ${p.focus.filter((f) => !f.done).map((f) => shorten(f.row.title || "Ohne Titel", 60)).join(", ")}`);
		} else lines.push("Alle Tagesaufgaben erledigt 🎉");
		if (s.withoutFocus.length) lines.push(`Ohne Tagesaufgabe: ${s.withoutFocus.map(first).join(", ")}`);
		if (s.finished.length) lines.push(`Alles erledigt: ${s.finished.map(first).join(", ")}`);
		if (s.overdue) lines.push(`Überfällige Aufgaben im Team: ${s.overdue}`);
	}
	const absent = absentLine(s);
	if (absent) lines.push(absent);
	return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// src/notes/store/rows.ts
const META_COLUMNS = "id, parent_id, space, owner_id, kind, title, icon, cover, props, schema, options, position, archived_at, created_at, created_by, updated_at, updated_by, deleted_at, deleted_by";
const toMeta = (r) => ({
	id: r.id,
	parentId: r.parent_id,
	space: r.space,
	ownerId: r.owner_id,
	kind: r.kind,
	title: r.title ?? "",
	icon: r.icon,
	cover: r.cover,
	props: r.props ?? {},
	schema: r.schema,
	options: r.options ?? {},
	position: r.position,
	archivedAt: r.archived_at,
	createdAt: r.created_at,
	createdBy: r.created_by,
	updatedAt: r.updated_at,
	updatedBy: r.updated_by,
	deletedAt: r.deleted_at ?? null,
	deletedBy: r.deleted_by ?? null
});
const colorFor = (id) => {
	let h = 0;
	for (const c of id) h = h * 31 + c.charCodeAt(0) >>> 0;
	return COLORS[1 + h % (COLORS.length - 1)];
};
const memberFromUser = (u) => ({
	id: u.auth_user_id,
	name: `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || "Unbekannt",
	color: colorFor(u.auth_user_id),
	role: u.role ?? void 0,
	studioId: u.home_location_id ?? null
});

// server/aufgaben.ts
function config() {
	const env = (key) => Deno.env.get(key)?.trim() || void 0;
	const ownBot = env("AUFGABEN_TELEGRAM_TOKEN");
	return {
		url: env("CLOCKIN_SUPABASE_URL") ?? env("SUPABASE_URL"),
		key: env("CLOCKIN_SERVICE_KEY") ?? env("SUPABASE_SERVICE_ROLE_KEY"),
		notifySecret: env("NOTIFY_SECRET"),
		token: ownBot ?? env("TELEGRAM_BOT_TOKEN"),
		ownBot: Boolean(ownBot),
		webhookSecret: env("AUFGABEN_WEBHOOK_SECRET"),
		/** Schalter: alle automatischen Nachrichten aus (von Hand bleibt es auslösbar) */
		off: /^(1|true|ja|aus|an)$/i.test(env("AUFGABEN_TELEGRAM_AUS") ?? ""),
		appUrl: env("AUFGABEN_APP_URL"),
		hours: parseHours(env),
		recipients: parseRecipients(env("AUFGABEN_EMPFAENGER"))
	};
}
const json = (data, status = 200) => new Response(JSON.stringify(data, null, 2), {
	status,
	headers: { "Content-Type": "application/json; charset=utf-8" }
});
function safeEqual(a, b) {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}
var Db = class {
	url;
	key;
	constructor(url, key) {
		this.url = url;
		this.key = key;
	}
	headers(extra = {}) {
		return {
			apikey: this.key,
			Authorization: `Bearer ${this.key}`,
			"Content-Type": "application/json",
			...extra
		};
	}
	async get(path) {
		const res = await fetch(`${this.url}/rest/v1/${path}`, { headers: this.headers() });
		if (!res.ok) throw new Error(`Lesen ${path.split("?")[0]} fehlgeschlagen: ${res.status} ${(await res.text()).slice(0, 200)}`);
		return await res.json();
	}
	async rpc(fn, args) {
		const res = await fetch(`${this.url}/rest/v1/rpc/${fn}`, {
			method: "POST",
			headers: this.headers(),
			body: JSON.stringify(args)
		});
		if (!res.ok) throw new Error(`${fn} fehlgeschlagen: ${res.status} ${(await res.text()).slice(0, 200)}`);
		return await res.json();
	}
	/** Einfügen; "exists" bei Doppel (Primärschlüssel) */
	async insert(table, row) {
		const res = await fetch(`${this.url}/rest/v1/${table}`, {
			method: "POST",
			headers: this.headers({ Prefer: "return=minimal" }),
			body: JSON.stringify(row)
		});
		if (res.status === 409) return "exists";
		if (!res.ok) throw new Error(`Schreiben ${table} fehlgeschlagen: ${res.status} ${(await res.text()).slice(0, 200)}`);
		return "ok";
	}
};
const COLUMNS = META_COLUMNS.replace(/\s+/g, "");
async function loadPages(db) {
	const pages = /* @__PURE__ */ new Map();
	for (let offset = 0; offset < 2e5; offset += 1e3) {
		const rows = await db.get(`note_pages?select=${COLUMNS}&order=id&limit=1000&offset=${offset}`);
		for (const r of rows) pages.set(r.id, toMeta(r));
		if (rows.length < 1e3) break;
	}
	return pages;
}
const loadMembers = async (db) => (await db.get("users?select=auth_user_id,first_name,last_name,role,home_location_id&is_active=eq.true&auth_user_id=not.is.null&order=first_name")).map(memberFromUser);
async function loadPlan(db, day) {
	const rows = await db.rpc("note_day_plan", { p_day: day });
	return {
		planned: rows.filter((r) => r.planned).map((r) => r.user_id),
		absent: rows.filter((r) => r.absent).map((r) => r.user_id)
	};
}
/** Reminder-Text aus dem Tagesstand */
async function buildReminder(db, kind, day) {
	const [pages, members, studios, plan] = await Promise.all([
		loadPages(db),
		loadMembers(db),
		db.get("locations?select=id,name"),
		loadPlan(db, day)
	]);
	const studioName = (id) => studios.find((s) => s.id === id)?.name ?? "Ohne Studio";
	const status = dailyStatus({
		day,
		pages,
		members,
		plan,
		studioName
	});
	const seen = /* @__PURE__ */ new Map();
	for (const m of members) seen.set(m.name, (seen.get(m.name) ?? 0) + 1);
	const notes = [...seen].filter(([, n]) => n > 1).map(([name, n]) => `Name ${n}× vorhanden, im Text nicht eindeutig: ${name}`);
	return {
		text: reminderText(kind, status, studioName),
		status,
		notes
	};
}
async function telegram(cfg, method, body) {
	if (!cfg.token) return {
		ok: false,
		status: 0,
		text: "kein Bot-Token gesetzt"
	};
	const res = await fetch(`https://api.telegram.org/bot${cfg.token}/${method}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body)
	});
	return {
		ok: res.ok,
		status: res.status,
		text: await res.text()
	};
}
async function sendTo(cfg, recipients, text, keyboard) {
	const results = [];
	for (const r of recipients) {
		const res = await telegram(cfg, "sendMessage", {
			chat_id: r.id,
			text,
			disable_web_page_preview: true,
			...keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}
		});
		if (!res.ok) console.error(`Telegram-Zustellung abgelehnt: ${r.name} (${r.kz || "–"}, id ${r.id}) – ${res.status} ${res.text.slice(0, 200)}`);
		results.push({
			to: r.name,
			ok: res.ok,
			status: res.status
		});
	}
	return results;
}
const shortId = (uuid) => btoa(String.fromCharCode(...(uuid.replace(/-/g, "").match(/../g) ?? []).map((h) => parseInt(h, 16)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const longId = (s) => {
	const hex = [...atob(s.replace(/-/g, "+").replace(/_/g, "/"))].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
async function focusNew(cfg, db, b) {
	if (cfg.off) return { skipped: "AUFGABEN_TELEGRAM_AUS ist gesetzt" };
	const [rows] = await Promise.all([db.get(`note_pages?select=${COLUMNS}&id=eq.${encodeURIComponent(b.page_id)}`)]);
	const page = rows[0] ? toMeta(rows[0]) : null;
	if (!page || page.deletedAt) return { skipped: "Aufgabe gibt es nicht mehr" };
	const entry = focusEntry(page, b.user_id, b.day);
	if (!entry) return { skipped: "Tagesaufgabe wurde wieder entfernt" };
	const parentRows = page.parentId ? await db.get(`note_pages?select=${COLUMNS}&id=eq.${page.parentId}`) : [];
	const parent = parentRows[0] ? toMeta(parentRows[0]) : void 0;
	const members = await loadMembers(db);
	const target = members.find((m) => m.id === b.user_id);
	if (!target) return { skipped: "Person nicht aktiv" };
	let actorName = target.name;
	let source = "App";
	let chatIds = [];
	if (b.actor) {
		const actor = members.find((m) => m.id === b.actor);
		if (actor) {
			actorName = actor.name;
			const ids = await db.get(`users?select=id&auth_user_id=eq.${b.actor}`);
			if (ids[0]) chatIds = (await db.get(`telegram_links?select=chat_id&user_id=eq.${ids[0].id}`)).map((l) => Number(l.chat_id));
		} else if ((await db.get(`kiosk_devices?select=kind,name&auth_user_id=eq.${b.actor}`))[0]?.kind === "pc") source = "Studio-PC";
	}
	const ctx = {
		pages: new Map([page, ...parent ? [parent] : []].map((p) => [p.id, p])),
		members
	};
	const link = entryLink(cfg.appUrl, page.id);
	const text = focusMessage({
		pending: entry.pending,
		actor: actorName,
		target: target.name,
		source,
		rank: entry.rank,
		summary: entrySummary(page, parent, ctx),
		link
	});
	const to = cfg.recipients.recipients.filter((r) => !isSender(r, {
		chatIds,
		name: actorName
	}));
	const keyboard = entry.pending ? cfg.ownBot ? [[{
		text: "✅ Freigeben",
		callback_data: `fa:${shortId(page.id)}:${shortId(b.user_id)}`
	}, {
		text: "❌ Ablehnen",
		callback_data: `fr:${shortId(page.id)}:${shortId(b.user_id)}`
	}]] : link ? [[{
		text: "In der App freigeben",
		url: link
	}]] : void 0 : void 0;
	return {
		text,
		to: to.map((r) => r.name),
		sent: await sendTo(cfg, to, text, keyboard)
	};
}
async function tick(cfg, db, at) {
	if (cfg.off) return { skipped: "AUFGABEN_TELEGRAM_AUS ist gesetzt" };
	const now = berlinNow(at ? new Date(at) : /* @__PURE__ */ new Date());
	const kind = dueReminder(now, cfg.hours);
	if (!kind) return { skipped: `${now.weekday > 5 ? "Wochenende" : "keine Reminder-Stunde"} (Berlin ${now.day}, ${now.hour} Uhr)` };
	if (await db.insert("note_notify_log", {
		kind,
		day: now.day
	}) === "exists") return { skipped: `${kind} am ${now.day} schon gesendet` };
	const r = await buildReminder(db, kind, now.day);
	return {
		kind,
		day: now.day,
		text: r.text,
		sent: await sendTo(cfg, cfg.recipients.recipients, r.text)
	};
}
async function manualReminder(cfg, db, b) {
	const kind = b.kind === "mittag" || b.kind === "abend" ? b.kind : "frueh";
	const day = /^\d{4}-\d{2}-\d{2}$/.test(b.day ?? "") ? b.day : berlinNow().day;
	const r = await buildReminder(db, kind, day);
	const dryRun = b.dryRun !== false;
	const notes = [
		...cfg.recipients.errors,
		...r.notes,
		...cfg.token ? [] : ["Kein Bot-Token gesetzt (AUFGABEN_TELEGRAM_TOKEN)"],
		...cfg.appUrl ? [] : ["AUFGABEN_APP_URL fehlt – Nachrichten ohne Link"],
		...cfg.off ? ["Hinweis: automatische Nachrichten sind aus (AUFGABEN_TELEGRAM_AUS)"] : []
	];
	const out = {
		kind,
		day,
		dryRun,
		text: r.text,
		recipients: cfg.recipients.recipients.map((x) => x.name),
		notes
	};
	if (dryRun) {
		console.log(`Trockenlauf ${kind} ${day}:\n${r.text}`);
		return out;
	}
	return {
		...out,
		sent: await sendTo(cfg, cfg.recipients.recipients, r.text)
	};
}
/** Freigeben/Ablehnen per Knopf (nur eigener Bot mit Webhook) */
async function telegramUpdate(cfg, db, update) {
	const cq = update.callback_query;
	if (!cq) return { ok: true };
	const m = /^(fa|fr):([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{22})$/.exec(cq.data ?? "");
	const who = cfg.recipients.recipients.find((r) => r.id === cq.from.id);
	if (!m || !who) {
		await telegram(cfg, "answerCallbackQuery", {
			callback_query_id: cq.id,
			text: "Keine Berechtigung",
			show_alert: true
		});
		return { ok: false };
	}
	const result = await db.rpc("note_focus_decide", {
		p_page: longId(m[2]),
		p_user: longId(m[3]),
		p_ok: m[1] === "fa"
	});
	const label = {
		approved: `✅ Freigegeben von ${who.name}`,
		rejected: `❌ Abgelehnt von ${who.name}`,
		already: "ℹ️ War schon entschieden"
	}[result] ?? "ℹ️ Diese Tagesaufgabe gibt es nicht mehr";
	await telegram(cfg, "answerCallbackQuery", {
		callback_query_id: cq.id,
		text: label
	});
	if (cq.message) {
		const res = await telegram(cfg, "editMessageText", {
			chat_id: cq.message.chat.id,
			message_id: cq.message.message_id,
			text: `${cq.message.text ?? ""}\n\n${label}`
		});
		if (!res.ok) console.error(`Nachricht nicht aktualisiert (${who.name}): ${res.status} ${res.text.slice(0, 200)}`);
	}
	return {
		ok: true,
		result
	};
}
async function handle(req) {
	if (req.method !== "POST") return new Response("ok");
	const cfg = config();
	if (!cfg.url || !cfg.key) return json({ error: "Supabase-Zugang fehlt (SUPABASE_URL / Service-Schlüssel)" }, 500);
	const db = new Db(cfg.url, cfg.key);
	try {
		const tgSecret = req.headers.get("x-telegram-bot-api-secret-token");
		if (tgSecret !== null) {
			if (!cfg.ownBot || !cfg.webhookSecret || !safeEqual(tgSecret, cfg.webhookSecret)) return json({ error: "unauthorized" }, 401);
			return json(await telegramUpdate(cfg, db, await req.json()));
		}
		const notify = req.headers.get("x-notify-secret") ?? "";
		if (!cfg.notifySecret || !safeEqual(notify, cfg.notifySecret)) return json({ error: "unauthorized" }, 401);
		const body = await req.json();
		switch (body.action) {
			case "tick": return json(await tick(cfg, db, typeof body.at === "string" ? body.at : void 0));
			case "reminder": return json(await manualReminder(cfg, db, body));
			case "focus_new": return json(await focusNew(cfg, db, body));
			default: return json({ error: "unbekannte Aktion" }, 400);
		}
	} catch (e) {
		console.error("aufgaben:", e.message);
		return json({ error: e.message }, 500);
	}
}
Deno.serve(handle);

export { handle };