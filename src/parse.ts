// Pure command parsing and validation. Every user-supplied token passes through here first.
export type Side = "long" | "short";

export interface OpenCmd { kind: "open"; side: Side; base: string; margin: number; leverage: number; tp?: Level; sl?: Level }
export interface Level { price?: number; pct?: number }

const BASE_RE = /^[A-Z0-9]{1,12}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export function cleanBase(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim().toUpperCase().replace(/-PERP$/, "").replace(/\/USDSO.*$/, "");
  return BASE_RE.test(s) ? s : undefined;
}

export function isAddress(s: string | undefined): s is `0x${string}` {
  return !!s && ADDR_RE.test(s);
}

/** A plain positive decimal, at most `maxDp` decimals, no exponent, no sign, no hex. */
export function parseAmount(raw: string | undefined, min: number, max: number, maxDp = 6): number | undefined {
  if (!raw || raw.length > 16) return undefined;
  const s = raw.replace(/,/g, "");
  const re = maxDp > 0 ? new RegExp(`^\\d{1,9}(\\.\\d{1,${maxDp}})?$`) : /^\d{1,9}$/;
  if (!re.test(s)) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
}

export function parseLeverage(raw: string | undefined, max: number): number | undefined {
  if (!raw) return undefined;
  const m = /^(\d{1,3}(?:\.\d)?)x?$/i.exec(raw.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 1 && n <= max ? n : undefined;
}

/** "2500" = absolute price, "5%" / "+5%" / "-2%" = distance from entry/mark. */
export function parseLevel(raw: string | undefined): Level | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  const pct = /^[+-]?(\d{1,2}(?:\.\d{1,2})?)%$/.exec(s);
  if (pct) {
    const v = Number(pct[1]);
    return v >= 0.1 && v <= 90 ? { pct: v } : undefined;
  }
  const p = parseAmount(s, 1e-9, 1e9, 9);
  return p === undefined ? undefined : { price: p };
}

/** Split a Telegram command: "/long@Bot ETH 20 5x" -> { cmd: "long", args: ["ETH","20","5x"] }. */
export function splitCommand(text: string, botUsername: string): { cmd: string; args: string[] } | undefined {
  const t = text.trim();
  if (!t.startsWith("/")) return undefined;
  const parts = t.split(/\s+/).slice(0, 12);
  const head = parts[0]!.slice(1);
  const [cmd, at] = head.split("@");
  if (at && at.toLowerCase() !== botUsername.toLowerCase()) return undefined;
  if (!cmd || !/^[a-z_]{1,20}$/i.test(cmd)) return undefined;
  return { cmd: cmd.toLowerCase(), args: parts.slice(1) };
}

/**
 * /long ETH 20 5x [tp 4%] [sl 2%]   (margin in USDso, leverage multiplier; notional = margin x leverage)
 * Returns an error string the user can act on, or the parsed command.
 */
export function parseOpen(side: Side, args: string[], maxLeverageFor: (base: string) => number | undefined): OpenCmd | string {
  const usage = `Usage: /${side} ETH 20 5x  (20 USDso margin at 5x = 100 USDso position). Optional: tp 4% sl 2%`;
  const base = cleanBase(args[0]);
  if (!base) return usage;
  const maxLev = maxLeverageFor(base);
  if (maxLev === undefined) return `Unknown market "${args[0]!.slice(0, 12)}". Send /markets for the list.`;
  const margin = parseAmount(args[1], 1, 5_000, 2);
  if (margin === undefined) return `Margin must be a number of USDso between 1 and 5000 (max 2 decimals).\n${usage}`;
  const levRaw = args[2] ?? "1x";
  const leverage = parseLeverage(levRaw, maxLev);
  if (leverage === undefined) return `Leverage must be between 1x and ${maxLev}x on ${base}-PERP.`;
  const out: OpenCmd = { kind: "open", side, base, margin, leverage };
  for (let i = 3; i < args.length; i += 2) {
    const k = args[i]!.toLowerCase();
    const lv = parseLevel(args[i + 1]);
    if ((k !== "tp" && k !== "sl") || !lv) return `Could not read "${args.slice(3).join(" ").slice(0, 40)}". Use tp 4% sl 2% or tp 2500 sl 2300.`;
    out[k] = lv;
  }
  return out;
}

/** Resolve a TP/SL level to an absolute trigger price and check it is on the right side of `ref`. */
export function resolveLevel(kind: "tp" | "sl", side: Side, lv: Level, ref: number): number | string {
  const up = (kind === "tp") === (side === "long");
  const price = lv.price ?? (up ? ref * (1 + lv.pct! / 100) : ref * (1 - lv.pct! / 100));
  if (!(price > 0)) return `${kind.toUpperCase()} must be above 0.`;
  if (up && price <= ref) return `${kind.toUpperCase()} for a ${side} must be above ${fmtPrice(ref)}.`;
  if (!up && price >= ref) return `${kind.toUpperCase()} for a ${side} must be below ${fmtPrice(ref)}.`;
  return price;
}

/** A level already crossed by the current mark would fire at once: refuse it with a reason. */
export function checkVsMark(kind: "tp" | "sl", side: Side, price: number, mark: number): string | undefined {
  const up = (kind === "tp") === (side === "long");
  if (up && price <= mark) return `${kind.toUpperCase()} ${fmtPrice(price)} is already at or below the mark ${fmtPrice(mark)}; it would fire at once.`;
  if (!up && price >= mark) return `${kind.toUpperCase()} ${fmtPrice(price)} is already at or above the mark ${fmtPrice(mark)}; it would fire at once.`;
  return undefined;
}

/** Does the mark trigger this rule? */
export function triggered(kind: "tp" | "sl", side: Side, trigger: number, mark: number): boolean {
  const up = (kind === "tp") === (side === "long");
  return up ? mark >= trigger : mark <= trigger;
}

/** Distance from mark to the liquidation price, as % of mark (always >= 0), or undefined. */
export function liqDistancePct(side: Side, mark: number, liq: number | undefined): number | undefined {
  if (!liq || !(liq > 0) || !(mark > 0)) return undefined;
  const d = side === "long" ? (mark - liq) / mark : (liq - mark) / mark;
  return Math.max(0, d * 100);
}

export function fmtPrice(p: number): string {
  if (!Number.isFinite(p)) return "-";
  const a = Math.abs(p);
  const dp = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.01 ? 5 : 7;
  return p.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function fmtUsd(v: number, signed = false): string {
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < 0 ? "-" : signed && v > 0 ? "+" : "") + s;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
