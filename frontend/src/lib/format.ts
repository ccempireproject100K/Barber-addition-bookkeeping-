import { ApiError } from "./api";

let config = { currency: "USD", timezone: "UTC", locale: "en-US" };
export function configureFormats(value?: Partial<typeof config>): void {
  config = { currency: value?.currency ?? "USD", timezone: value?.timezone ?? "UTC", locale: value?.locale ?? "en-US" };
}
export const businessToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
export const fmtMoney = (v: number, currency = config.currency) => new Intl.NumberFormat(config.locale, { style: "currency", currency }).format(v);
export const fmtMoneyCompact = (v: number) => new Intl.NumberFormat(config.locale, { style: "currency", currency: config.currency, notation: "compact", maximumFractionDigits: 1 }).format(v);
export const fmtNum = (v: number) => new Intl.NumberFormat(config.locale).format(v);
export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(config.locale, { timeZone: config.timezone, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
export function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const dateOnly = iso.length === 10;
  return new Date(dateOnly ? `${iso}T00:00:00Z` : iso).toLocaleDateString(config.locale, { timeZone: dateOnly ? "UTC" : config.timezone, month: "short", day: "numeric", year: "numeric" });
}

export function errMsg(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { detail?: unknown } | null;
    if (typeof body?.detail === "string") return body.detail;
    if (Array.isArray(body?.detail) && body.detail.length) {
      const first = body.detail[0] as { msg?: string; loc?: unknown[] };
      const field = Array.isArray(first.loc) ? String(first.loc[first.loc.length - 1]) : "";
      return `${field ? field + ": " : ""}${first.msg ?? "Invalid input"}`;
    }
    return `Request failed (${e.status})`;
  }
  return "Something went wrong";
}
