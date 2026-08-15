import type { DomainRecord } from "../app/schemas";

export function detailText(record: DomainRecord | undefined, key: string): string {
  const value = record?.details[key];
  return typeof value === "string" ? value : "";
}

export function detailList(record: DomainRecord | undefined, key: string): string[] {
  const value = record?.details[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function titleFromNote(note: string): string {
  const firstLine = note
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "Untitled idea";
  return firstLine.length > 72 ? `${firstLine.slice(0, 69).trimEnd()}…` : firstLine;
}

export function countWords(value: string): number {
  return value.trim() ? value.trim().split(/\s+/u).length : 0;
}

export function formatRelativeTime(timestamp: number): string {
  const elapsed = timestamp - Date.now();
  const minute = 60_000;
  const hour = minute * 60;
  const day = hour * 24;
  const formatter = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });
  if (Math.abs(elapsed) < hour) return formatter.format(Math.round(elapsed / minute), "minute");
  if (Math.abs(elapsed) < day) return formatter.format(Math.round(elapsed / hour), "hour");
  return formatter.format(Math.round(elapsed / day), "day");
}
