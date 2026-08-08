import {
  calculateScheduleTotals,
  detectResourceConflicts,
  opaqueIdSchema,
  projectCallSheetForRecipient,
  type IssuedCallSheet,
} from "@swp/domain";

import { sha256 } from "../idempotency";

export interface ScheduleArtifactItem {
  readonly id: string;
  readonly unit: string;
  readonly pageEighths: number;
  readonly prepDurationMs: number;
  readonly setupDurationMs: number;
  readonly shootDurationMs: number;
  readonly moveDurationMs: number;
  readonly mealDurationMs: number;
  readonly startAt?: number;
  readonly endAt?: number;
}

export interface ScheduleArtifactTotals {
  readonly pageEighths: number;
  readonly prepMs: number;
  readonly setupMs: number;
  readonly shootMs: number;
  readonly moveMs: number;
  readonly mealMs: number;
  readonly totalMs: number;
  readonly estimatedWrapOffsetMs: number;
}

export function calculateRevisionTotals(
  items: readonly ScheduleArtifactItem[],
): ScheduleArtifactTotals {
  let cursor = 0;
  const timings = items.map((item) => {
    const duration =
      item.prepDurationMs +
      item.setupDurationMs +
      item.shootDurationMs +
      item.moveDurationMs +
      item.mealDurationMs;
    const startMs = item.startAt ?? cursor;
    const endMs = item.endAt ?? startMs + Math.max(1, duration);
    cursor = Math.max(cursor, endMs);
    return {
      itemId: opaqueIdSchema.parse(item.id),
      unit: item.unit,
      startMs,
      endMs,
      pageEighths: item.pageEighths,
      prepMs: item.prepDurationMs,
      setupMs: item.setupDurationMs,
      shootMs: item.shootDurationMs,
      moveMs: item.moveDurationMs,
      mealMs: item.mealDurationMs,
    };
  });
  const totals = calculateScheduleTotals(timings, 0);
  return {
    pageEighths: totals.pageEighths,
    prepMs: totals.prepMs,
    setupMs: totals.setupMs,
    shootMs: totals.shootMs,
    moveMs: totals.moveMs,
    mealMs: totals.mealMs,
    totalMs: totals.totalMs,
    estimatedWrapOffsetMs: totals.estimatedWrapMs,
  };
}

export function calculateRevisionConflicts(input: {
  readonly assignments: readonly {
    readonly assignmentId: string;
    readonly scheduleItemId: string;
    readonly resourceType: "cast" | "crew" | "location" | "equipment" | "vehicle";
    readonly resourceId: string;
    readonly startMs: number;
    readonly endMs: number;
    readonly locationId?: string;
    readonly unit: string;
    readonly minimumTurnaroundMs: number;
  }[];
  readonly availability: readonly {
    readonly resourceType: "cast" | "crew" | "location" | "equipment" | "vehicle";
    readonly resourceId: string;
    readonly startMs: number;
    readonly endMs: number;
  }[];
  readonly travelDurations: readonly {
    readonly fromLocationId: string;
    readonly toLocationId: string;
    readonly durationMs: number;
  }[];
}) {
  return detectResourceConflicts({
    assignments: input.assignments.map((assignment) => ({
      assignmentId: opaqueIdSchema.parse(assignment.assignmentId),
      scheduleItemId: opaqueIdSchema.parse(assignment.scheduleItemId),
      resourceType: assignment.resourceType,
      resourceId: opaqueIdSchema.parse(assignment.resourceId),
      startMs: assignment.startMs,
      endMs: assignment.endMs,
      unit: assignment.unit,
      minimumTurnaroundMs: assignment.minimumTurnaroundMs,
      ...(assignment.locationId ? { locationId: opaqueIdSchema.parse(assignment.locationId) } : {}),
    })),
    availability: input.availability.map((window) => ({
      resourceType: window.resourceType,
      resourceId: opaqueIdSchema.parse(window.resourceId),
      startMs: window.startMs,
      endMs: window.endMs,
    })),
    travelDurations: input.travelDurations.map((duration) => ({
      fromLocationId: opaqueIdSchema.parse(duration.fromLocationId),
      toLocationId: opaqueIdSchema.parse(duration.toLocationId),
      durationMs: duration.durationMs,
    })),
  });
}

export interface CallSheetSectionInput {
  readonly key: string;
  readonly title: string;
  readonly body: string;
}

export interface CallSheetRecipientInput {
  readonly recipientId: string;
  readonly recipientIssueId: string;
  readonly displayName: string;
  readonly roleLabel: string;
  readonly email?: string;
  readonly phone?: string;
  readonly calls: readonly { readonly label: string; readonly time: string }[];
  readonly privateNote: string;
  readonly attachments?: readonly {
    readonly fileVersionId: string;
    readonly displayName: string;
  }[];
}

export async function buildCallSheetIssue(input: {
  readonly issueId: string;
  readonly issueNumber: number;
  readonly projectTitle: string;
  readonly companyName: string;
  readonly shootDate: string;
  readonly confidentiality: string;
  readonly sections: readonly CallSheetSectionInput[];
  readonly recipients: readonly CallSheetRecipientInput[];
}): Promise<{
  readonly canonical: IssuedCallSheet;
  readonly canonicalJson: string;
  readonly contentHash: string;
  readonly variants: ReadonlyMap<string, { readonly json: string; readonly hash: string }>;
}> {
  const provisional: IssuedCallSheet = {
    issueId: opaqueIdSchema.parse(input.issueId),
    issueNumber: input.issueNumber,
    contentHash: "0".repeat(64),
    projectTitle: input.projectTitle,
    companyName: input.companyName,
    shootDate: input.shootDate,
    confidentiality: input.confidentiality,
    publicSections: input.sections.map((section) => ({
      key: section.key,
      title: section.title,
      body: section.body,
    })),
    recipients: input.recipients.map((recipient) => ({
      recipientId: opaqueIdSchema.parse(recipient.recipientId),
      recipientIssueId: opaqueIdSchema.parse(recipient.recipientIssueId),
      displayName: recipient.displayName,
      roleLabel: recipient.roleLabel,
      ...(recipient.email ? { email: recipient.email } : {}),
      ...(recipient.phone ? { phone: recipient.phone } : {}),
      calls: [...recipient.calls],
      privateNote: recipient.privateNote,
      attachments: (recipient.attachments ?? []).map((attachment) => ({
        ...attachment,
        fileVersionId: opaqueIdSchema.parse(attachment.fileVersionId),
      })),
    })),
    producerPrivateNotes: "",
    legalPrivateNotes: "",
  };
  const contentHash = await sha256(canonicalJson(provisional));
  const canonical: IssuedCallSheet = { ...provisional, contentHash };
  const encoded = canonicalJson(canonical);
  const variants = new Map<string, { json: string; hash: string }>();
  for (const recipient of canonical.recipients) {
    const projection = projectCallSheetForRecipient(
      canonical,
      opaqueIdSchema.parse(recipient.recipientIssueId),
    );
    const json = canonicalJson(projection);
    variants.set(recipient.recipientIssueId, { json, hash: await sha256(json) });
  }
  return { canonical, canonicalJson: encoded, contentHash, variants };
}

export interface ProductionPackManifestEntry {
  readonly id: string;
  readonly sectionType: string;
  readonly title: string;
  readonly relativePath: string;
  readonly sortRank: string;
  readonly objectId: string | null;
  readonly fileVersionId: string | null;
  readonly revisionOrIssueId: string | null;
  readonly byteSize: number | null;
  readonly mimeType: string | null;
  readonly sha256: string | null;
}

export interface ProductionPackManifest {
  readonly schemaVersion: "swp-production-pack-v1";
  readonly issueId: string;
  readonly issueNumber: number;
  readonly projectId: string;
  readonly draftId: string;
  readonly createdAt: number;
  readonly entries: readonly ProductionPackManifestEntry[];
}

export async function buildProductionPackManifest(input: {
  readonly issueId: string;
  readonly issueNumber: number;
  readonly projectId: string;
  readonly draftId: string;
  readonly createdAt: number;
  readonly entries: readonly ProductionPackManifestEntry[];
}): Promise<{
  readonly manifest: ProductionPackManifest;
  readonly json: string;
  readonly hash: string;
}> {
  const manifest: ProductionPackManifest = {
    schemaVersion: "swp-production-pack-v1",
    issueId: input.issueId,
    issueNumber: input.issueNumber,
    projectId: input.projectId,
    draftId: input.draftId,
    createdAt: input.createdAt,
    entries: [...input.entries].sort(
      (left, right) =>
        left.sortRank.localeCompare(right.sortRank) || left.id.localeCompare(right.id),
    ),
  };
  const json = canonicalJson(manifest);
  return { manifest, json, hash: await sha256(json) };
}

export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function safeRelativePath(sectionType: string, title: string, suffix = ".pdf"): string {
  const section = safeSegment(sectionType) || "documents";
  const name = safeSegment(title) || "untitled";
  return `${section}/${name}${suffix}`;
}

function safeSegment(value: string): string {
  return value
    .normalize("NFKD")
    .split("")
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f ? "-" : character;
    })
    .join("")
    .replace(/[\\/:*?"<>|]/gu, "-")
    .replace(/\.\.+/gu, "-")
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[. -]+|[. -]+$/gu, "")
    .slice(0, 96)
    .toLocaleLowerCase("en-GB");
}
