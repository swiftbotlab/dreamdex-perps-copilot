// Chain-held stops: dreamDEX's native perp TP/SL (PerpStopOrderRegistry, one per market). The chain wakes each
// pending stop and fires it with no bot involved; this module only READS them and checks whether each one will
// actually do what the trader expects when it fires. Pure functions: venue.ts does the reads.
//
// Checks (each one reproduced live on Somnia Tokyo testnet):
// - capacity: the registry sizes a fired stop to min(stop size, effectiveReducingCapacity), and resting orders on
//   the closing side count against that capacity even when they are far from the market. Such orders make a stop
//   close only part of the position, or nothing at all (ReduceOnlyBelowMinQty), and the stop is used up.
// - fixed size: a non-zero stop quantity is fixed when the stop is armed. A position that grew afterwards is only
//   partly covered.
// - wrong side / no position: a reduce-only stop that cannot reduce the current position places nothing.
// - linked pair: when one leg of a linked TP/SL fills only partly, the registry cancels the other leg too.
import { fmtPrice, type Side } from "./parse.ts";

export interface NativeStop {
  id: string;                   // `${registry}_${orderId}`
  registry: `0x${string}`;
  orderId: string;              // uint128 decimal
  base: string;
  isBid: boolean;               // the order it places when it fires buys (closes a short) or sells (closes a long)
  qty: number;                  // base units; 0 = the whole position at trigger time
  trigger: number;              // mark price it fires at
  op: 0 | 1;                    // 0 = fires at or above the trigger, 1 = at or below
  market: boolean;              // true = slippage-bounded market order, false = limit order
  linked: boolean;              // one leg of a linked TP/SL pair
  reduceOnly: boolean;
  onChain: boolean;             // confirmed live by a registry read (false: indexer row only)
}

export interface Capacity { position: number; pendingBid: number; pendingAsk: number; effective: number }
export interface PosLite { base: string; side: Side; size: number; mark: number }
export type Level = "ok" | "warn" | "note";
export type Problem = "ok" | "opening" | "nopos" | "side" | "none" | "part" | "size";
export interface StopLine { stop: NativeStop; kind: "TP" | "SL" | "stop"; level: Level; problem: Problem; text: string; willClose?: number }
export interface PositionReport { base: string; pos?: PosLite; lines: StopLine[]; notes: string[]; level: Level }

const eps = (x: number) => Math.max(1e-12, Math.abs(x) * 1e-9);
const fmtQty = (x: number) => (Math.abs(x) >= 1000 ? x.toFixed(0) : Number(x.toPrecision(6)).toString());

/** TP or SL relative to the position it closes: a sell that fires on the way up takes profit on a long. */
export function stopKind(s: NativeStop, posSide?: Side): "TP" | "SL" | "stop" {
  const closesLong = !s.isBid;                     // a sell closes a long
  const side: Side | undefined = posSide ?? (closesLong ? "long" : "short");
  if ((side === "long") !== closesLong) return "stop"; // wrong side for this position
  if (side === "long") return s.op === 0 ? "TP" : "SL";
  return s.op === 1 ? "TP" : "SL";
}

/** The health of every chain-held stop on one market, against the position and the pool's reducing capacity. */
export function checkMarket(base: string, pos: PosLite | undefined, stops: NativeStop[], cap: Capacity | undefined, minQty: number): PositionReport {
  const lines: StopLine[] = [];
  const notes: string[] = [];
  for (const s of stops) {
    const kind = stopKind(s, pos?.side);
    const what = `${kind === "stop" ? "Stop" : kind} ${fmtPrice(s.trigger)} (${s.market ? "market" : "limit"}, ${s.qty > 0 ? `${fmtQty(s.qty)} ${base}` : "whole position"})`;
    const dist = pos ? `${(Math.abs(s.trigger - pos.mark) / pos.mark * 100).toFixed(2)}% from the mark` : undefined;
    const head = `${what}${dist ? ` · ${dist}` : ""}${s.onChain ? "" : " · indexer only, not confirmed on chain"}`;
    if (!s.reduceOnly) { lines.push({ stop: s, kind, level: "note", problem: "opening", text: `${head}: an opening stop (it can add to or open a position), not a TP/SL` }); continue; }
    if (!pos) { lines.push({ stop: s, kind, level: "warn", problem: "nopos", text: `${head}: no open ${base}-PERP position, so it places nothing if it fires and still spends its STT fee` }); continue; }
    if (kind === "stop") { lines.push({ stop: s, kind, level: "warn", problem: "side", text: `${head}: it ${s.isBid ? "buys" : "sells"}, which cannot reduce your ${pos.side}; it places nothing if it fires` }); continue; }
    const target = s.qty > 0 ? Math.min(s.qty, pos.size) : pos.size;
    const willClose = cap ? Math.max(0, Math.min(target, cap.effective)) : target;
    const reserved = cap ? (pos.side === "long" ? cap.pendingAsk : cap.pendingBid) : 0;
    if (cap && willClose + eps(target) < target) {
      const side = pos.side === "long" ? "sell" : "buy";
      if (willClose + eps(minQty) < minQty) {
        lines.push({ stop: s, kind, level: "warn", problem: "none", willClose: 0, text: `${head}: will close NOTHING when it fires. Your resting ${side} orders on ${base}-PERP (${fmtQty(reserved)} ${base}) use up the position's closing capacity, so the stop is dropped (ReduceOnlyBelowMinQty) and its fee is spent. Cancel those orders to restore it` });
      } else {
        lines.push({ stop: s, kind, level: "warn", problem: "part", willClose, text: `${head}: will close only ${fmtQty(willClose)} of ${fmtQty(target)} ${base}. Your resting ${side} orders (${fmtQty(reserved)} ${base}) reserve the rest, even far from the market; that part keeps no stop` });
      }
      continue;
    }
    if (s.qty > 0 && s.qty + eps(s.qty) < pos.size) {
      lines.push({ stop: s, kind, level: "warn", problem: "size", willClose, text: `${head}: covers ${fmtQty(s.qty)} of your ${fmtQty(pos.size)} ${base}. Its size was fixed when it was armed; the other ${fmtQty(pos.size - s.qty)} has no ${kind}` });
      continue;
    }
    lines.push({ stop: s, kind, level: "ok", problem: "ok", willClose, text: `${head}: OK, closes ${fmtQty(willClose)} ${base} when it fires` });
  }
  if (pos && stops.filter((s) => s.reduceOnly).length === 0) notes.push(`No chain-held TP/SL on this ${pos.side}. Arm one in the dreamDEX app and the chain closes it even when no bot is running`);
  if (pos && stops.some((s) => s.linked)) notes.push("Linked TP/SL pair: if one leg fills only partly, the registry cancels the other leg as well, and the rest of the position keeps no stop");
  const kinds = new Set(lines.filter((l) => l.level !== "note").map((l) => l.kind));
  if (pos && kinds.has("TP") && !kinds.has("SL")) notes.push("A chain-held take-profit but no chain-held stop-loss");
  const level: Level = lines.some((l) => l.level === "warn") ? "warn" : lines.some((l) => l.level === "ok") ? "ok" : "note";
  return { base, pos, lines, notes, level };
}

/** A stable key per (stop, problem) so the same warning is sent once, not on every check. */
export function warnKey(l: StopLine): string { return `${l.stop.id}:${l.problem}`; }
