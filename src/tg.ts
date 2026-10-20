// Minimal Telegram Bot API client over fetch (long polling; no webhook, no open port).
// The token lives only in this object; errors are reported without the URL (it contains the token).
export interface TgUser { id: number; is_bot?: boolean; first_name?: string; username?: string; language_code?: string }
export interface TgChat { id: number; type: string }
export interface TgMessage { message_id: number; from?: TgUser; chat: TgChat; date: number; text?: string }
export interface TgCallback { id: string; from: TgUser; message?: TgMessage; data?: string }
export interface TgUpdate { update_id: number; message?: TgMessage; callback_query?: TgCallback }
export type Button = { text: string; callback_data?: string; url?: string };

export class Telegram {
  private readonly base: string;
  constructor(token: string) {
    if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error("bad bot token format");
    this.base = `https://api.telegram.org/bot${token}`;
  }

  private async call<T>(method: string, body: Record<string, unknown> | FormData, timeoutMs = 30_000): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const init: RequestInit = body instanceof FormData
        ? { method: "POST", body, signal: ctl.signal }
        : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal };
      const r = await fetch(`${this.base}/${method}`, init);
      const j = (await r.json()) as { ok: boolean; result?: T; description?: string; parameters?: { retry_after?: number } };
      if (!j.ok) {
        const e = new Error(`telegram ${method}: ${String(j.description ?? r.status).slice(0, 160)}`) as Error & { retryAfter?: number };
        e.retryAfter = j.parameters?.retry_after;
        throw e;
      }
      return j.result as T;
    } catch (e) {
      if ((e as Error).name === "AbortError") throw new Error(`telegram ${method}: timeout`);
      throw e instanceof Error && e.message.startsWith("telegram ") ? e : new Error(`telegram ${method}: ${(e as Error).message?.slice(0, 120)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  getMe() { return this.call<TgUser>("getMe", {}); }
  getUpdates(offset: number) {
    return this.call<TgUpdate[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, 40_000);
  }
  setMyCommands(commands: { command: string; description: string }[]) { return this.call("setMyCommands", { commands }); }
  setDescription(description: string, short: string) {
    return Promise.all([this.call("setMyDescription", { description }), this.call("setMyShortDescription", { short_description: short })]);
  }

  sendMessage(chatId: number, html: string, buttons?: Button[][]) {
    return this.call<TgMessage>("sendMessage", {
      chat_id: chatId, text: html.slice(0, 4000), parse_mode: "HTML", link_preview_options: { is_disabled: true },
      ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
  }

  sendPhoto(chatId: number, png: Uint8Array, captionHtml: string, buttons?: Button[][]) {
    const fd = new FormData();
    fd.set("chat_id", String(chatId));
    fd.set("caption", captionHtml.slice(0, 1000));
    fd.set("parse_mode", "HTML");
    if (buttons) fd.set("reply_markup", JSON.stringify({ inline_keyboard: buttons }));
    fd.set("photo", new Blob([Buffer.from(png)], { type: "image/png" }), "pnl-card.png");
    return this.call<TgMessage>("sendPhoto", fd, 60_000);
  }

  answerCallback(id: string, text?: string) {
    return this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text: text.slice(0, 190) } : {}) });
  }
}
