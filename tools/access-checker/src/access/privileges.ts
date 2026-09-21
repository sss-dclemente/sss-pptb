/** Privilege naming, depth and access-mask parsing. Pure. */
import { DEPTH_LABEL, RIGHTS, type Depth, type Right } from "./types";

/** Dataverse privilege name for a right on a table, lower-cased: prvReadAccount → "prvreadaccount". */
export const privilegeName = (right: Right, tableLogicalName: string): string => `prv${right}${tableLogicalName}`.toLowerCase();

const DEPTH_BY_NAME: Record<string, Depth> = { basic: 0, user: 0, local: 1, businessunit: 1, deep: 2, parentchild: 2, parentchildbusinessunit: 2, global: 3, organization: 3 };

/** Depth from the Web API: numeric code or enum string ("Basic", "Local", "Deep", "Global"). */
export function parseDepth(v: unknown): Depth | null {
  if (typeof v === "number") return v >= 0 && v <= 3 ? (v as Depth) : null;
  if (typeof v === "string") {
    const n = Number(v);
    if (!Number.isNaN(n)) return parseDepth(n);
    const d = DEPTH_BY_NAME[v.trim().toLowerCase()];
    return d === undefined ? null : d;
  }
  return null;
}

export const depthLabel = (d: Depth | null): string => (d == null ? "—" : DEPTH_LABEL[d]);

/** "ReadAccess, WriteAccess" (or numeric AccessRights mask) → rights list. */
export function parseAccessMask(v: unknown): Right[] {
  if (typeof v === "number") return RIGHTS.filter((r) => (v & MASK[r]) !== 0);
  if (typeof v !== "string") return [];
  const out = new Set<Right>();
  for (const part of v.split(",")) {
    const p = part.trim();
    if (!p || p === "None") continue;
    const n = Number(p);
    if (!Number.isNaN(n)) {
      for (const r of parseAccessMask(n)) out.add(r);
      continue;
    }
    const name = p.replace(/Access$/, "");
    const r = RIGHTS.find((x) => x.toLowerCase() === name.toLowerCase());
    if (r) out.add(r);
  }
  return RIGHTS.filter((r) => out.has(r));
}

/** AccessRights enum bit values. */
export const MASK: Record<Right, number> = { Read: 1, Write: 2, Append: 4, AppendTo: 16, Create: 32, Delete: 65536, Share: 262144, Assign: 524288 };

export const maxDepth = (a: Depth | null, b: Depth | null): Depth | null => (a == null ? b : b == null ? a : a > b ? a : b);
