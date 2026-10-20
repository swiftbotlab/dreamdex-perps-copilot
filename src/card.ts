// Shareable PnL card: an SVG built only from numbers and validated symbols, rasterised with
// resvg compiled to WebAssembly (no native code, no system font lookup, no network).
import { readFileSync } from "node:fs";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { PATHS } from "./config.ts";
import { fmtPrice, fmtUsd, type Side } from "./parse.ts";

export interface CardData {
  base: string;          // validated [A-Z0-9]{1,12}
  side: Side;
  leverage?: number;     // what the user asked for when opening through the bot
  entry: number;
  price: number;         // mark (open) or exit (closed)
  pnl: number;           // USDso
  open: boolean;
  spark?: number[];      // recent marks, oldest first
  botUsername: string;   // validated [A-Za-z0-9_]
  ref: string;           // hex share code
  when: Date;
}

let fonts: Uint8Array[] | undefined;
let ready: Promise<void> | undefined;

export function initCard(): Promise<void> {
  ready ??= (async () => {
    await initWasm(readFileSync(PATHS.wasm));
    fonts = [PATHS.fontRegular, PATHS.fontBold, PATHS.fontMono].map((p) => new Uint8Array(readFileSync(p)));
  })();
  return ready;
}

const x = (s: string) => s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** ROE on the margin the user committed when we know it, otherwise the plain price move. */
export function returnPct(d: Pick<CardData, "side" | "entry" | "price" | "leverage">): { pct: number; levered: boolean } {
  const move = ((d.price - d.entry) / d.entry) * (d.side === "long" ? 1 : -1) * 100;
  return d.leverage ? { pct: move * d.leverage, levered: true } : { pct: move, levered: false };
}

function sparkPath(v: number[], w: number, h: number): string {
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  return v.map((p, i) => `${i ? "L" : "M"}${((i / (v.length - 1)) * w).toFixed(1)},${(h - ((p - lo) / span) * h).toFixed(1)}`).join(" ");
}

export function cardSvg(d: CardData): string {
  if (!/^[A-Z0-9]{1,12}$/.test(d.base) || !/^[A-Za-z0-9_]{5,32}$/.test(d.botUsername) || !/^[0-9a-f]{6,16}$/.test(d.ref)) {
    throw new Error("card input rejected");
  }
  const { pct, levered } = returnPct(d);
  const up = pct >= 0;
  const accent = up ? "#22c55e" : "#ef4444";
  const sideLabel = `${d.side.toUpperCase()}${d.leverage ? ` ${d.leverage}x` : ""}`;
  const pctText = `${up ? "+" : ""}${pct.toFixed(Math.abs(pct) >= 100 ? 0 : 2)}%`;
  const link = `t.me/${d.botUsername}?start=r_${d.ref}`;
  const spark = d.spark && d.spark.length >= 8 ? d.spark.slice(-120) : undefined;
  const date = d.when.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const sideX = 88 + (d.base.length + 5) * 22 + 28;
  const pillW = sideX - 64 + sideLabel.length * 19 + 28;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0b1020"/><stop offset="1" stop-color="#151b33"/></linearGradient>
    <linearGradient id="glow" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${accent}" stop-opacity="0.35"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="1200" height="675" fill="url(#bg)"/>
  <rect x="0" y="0" width="1200" height="8" fill="${accent}"/>
  <text x="64" y="92" font-family="Noto Sans" font-weight="700" font-size="30" fill="#e2e8f0" letter-spacing="3">PERPS COPILOT</text>
  <text x="64" y="128" font-family="Noto Sans" font-size="22" fill="#94a3b8">dreamDEX on ${x("Somnia Tokyo testnet")} · paper USDso</text>
  <rect x="64" y="172" rx="12" ry="12" width="${pillW}" height="64" fill="#1e293b"/>
  <text x="88" y="216" font-family="Noto Sans" font-weight="700" font-size="34" fill="#f8fafc">${x(d.base)}-PERP</text>
  <text x="${sideX}" y="216" font-family="Noto Sans" font-weight="700" font-size="30" fill="${accent}">${x(sideLabel)}</text>
  <text x="60" y="400" font-family="Noto Sans Mono" font-weight="700" font-size="150" fill="${accent}">${x(pctText)}</text>
  <text x="68" y="458" font-family="Noto Sans" font-size="30" fill="#cbd5e1">${x(fmtUsd(d.pnl, true))} USDso ${d.open ? "unrealised" : "realised"}${levered ? " · return on margin" : " · price move"}</text>
  <text x="68" y="530" font-family="Noto Sans" font-size="24" fill="#94a3b8">ENTRY</text>
  <text x="68" y="566" font-family="Noto Sans Mono" font-weight="700" font-size="32" fill="#f1f5f9">${x(fmtPrice(d.entry))}</text>
  <text x="380" y="530" font-family="Noto Sans" font-size="24" fill="#94a3b8">${d.open ? "MARK" : "EXIT"}</text>
  <text x="380" y="566" font-family="Noto Sans Mono" font-weight="700" font-size="32" fill="#f1f5f9">${x(fmtPrice(d.price))}</text>
  ${spark ? `<g transform="translate(760,170)"><path d="${sparkPath(spark, 380, 230)} L380,230 L0,230 Z" fill="url(#glow)"/><path d="${sparkPath(spark, 380, 230)}" fill="none" stroke="${accent}" stroke-width="4" stroke-linejoin="round"/></g>
  <text x="760" y="440" font-family="Noto Sans" font-size="20" fill="#64748b">live mark via Somnia Reactivity</text>` : ""}
  <rect x="0" y="603" width="1200" height="72" fill="#0f172a"/>
  <text x="64" y="648" font-family="Noto Sans" font-size="26" fill="#e2e8f0">Trade perps from Telegram: <tspan font-weight="700" fill="#38bdf8">${x(link)}</tspan></text>
  <text x="1136" y="92" text-anchor="end" font-family="Noto Sans" font-size="20" fill="#64748b">${x(date)}</text>
</svg>`;
}

export async function renderCard(d: CardData): Promise<Uint8Array> {
  await initCard();
  const r = new Resvg(cardSvg(d), { font: { fontBuffers: fonts!, loadSystemFonts: false, defaultFontFamily: "Noto Sans" }, fitTo: { mode: "width", value: 1200 } });
  const img = r.render();
  const png = img.asPng();
  img.free(); r.free();
  return png;
}
