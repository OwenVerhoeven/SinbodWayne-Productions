import Dexie, { type EntityTable } from "dexie";
import { z } from "zod";

import { ApiError, apiRequest, jsonBody } from "../api/client";
import { domainRecordSchema, type DomainRecord } from "../app/schemas";

export const OFFLINE_DRAFTS_CHANGED = "swp:offline-drafts-changed";

const offlineRecordTypes = new Set([
  "development_document",
  "location",
  "task_card",
  "board",
  "storyboard",
  "shot_list",
]);

export type OfflineDraftState = "queued" | "syncing" | "conflict" | "failed";

export interface OfflineDraft {
  id: string;
  projectId: string;
  recordType: string;
  recordId?: string;
  endpoint: string;
  operation: "create" | "update";
  baseVersion?: number;
  payload: {
    title: string;
    status: string;
    summary: string;
    details: Record<string, unknown>;
  };
  state: OfflineDraftState;
  createdAt: number;
  updatedAt: number;
  error?: string | undefined;
  serverRecord?: DomainRecord | undefined;
}

class ProductionOfflineDatabase extends Dexie {
  drafts!: EntityTable<OfflineDraft, "id">;

  constructor() {
    super("sinbod-wayne-productions-offline");
    this.version(1).stores({
      drafts: "id, [projectId+recordType], state, updatedAt",
    });
  }
}

const database = new ProductionOfflineDatabase();

function notifyDraftChange(): void {
  window.dispatchEvent(new Event(OFFLINE_DRAFTS_CHANGED));
}

export function supportsOfflineDraft(recordType: string): boolean {
  return offlineRecordTypes.has(recordType);
}

export async function queueOfflineDraft(input: {
  projectId: string;
  recordType: string;
  endpoint: string;
  recordId?: string;
  baseVersion?: number;
  payload: OfflineDraft["payload"];
}): Promise<OfflineDraft> {
  if (!supportsOfflineDraft(input.recordType)) {
    throw new Error("This module does not support offline drafts.");
  }

  const now = Date.now();
  const existing = input.recordId
    ? await database.drafts
        .where("[projectId+recordType]")
        .equals([input.projectId, input.recordType])
        .and((draft) => draft.recordId === input.recordId && draft.state !== "conflict")
        .first()
    : undefined;
  const draft: OfflineDraft = {
    id: existing?.id ?? crypto.randomUUID(),
    projectId: input.projectId,
    recordType: input.recordType,
    ...(input.recordId ? { recordId: input.recordId } : {}),
    endpoint: input.endpoint,
    operation: input.recordId ? "update" : "create",
    ...(input.baseVersion === undefined ? {} : { baseVersion: input.baseVersion }),
    payload: input.payload,
    state: "queued",
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await database.drafts.put(draft);
  notifyDraftChange();
  return draft;
}

export async function listOfflineDrafts(
  projectId?: string,
  recordType?: string,
): Promise<OfflineDraft[]> {
  const drafts = await database.drafts.orderBy("updatedAt").reverse().toArray();
  return drafts.filter(
    (draft) =>
      (!projectId || draft.projectId === projectId) &&
      (!recordType || draft.recordType === recordType),
  );
}

export async function discardOfflineDraft(id: string): Promise<void> {
  await database.drafts.delete(id);
  notifyDraftChange();
}

export async function rebaseOfflineDraft(
  id: string,
  serverVersion: number,
): Promise<OfflineDraft | undefined> {
  const draft = await database.drafts.get(id);
  if (!draft || draft.operation !== "update") return undefined;
  const rebased: OfflineDraft = {
    ...draft,
    baseVersion: serverVersion,
    state: "queued",
    error: undefined,
    serverRecord: undefined,
    updatedAt: Date.now(),
  };
  await database.drafts.put(rebased);
  notifyDraftChange();
  return rebased;
}

export async function syncOfflineDraft(
  draft: OfflineDraft,
): Promise<"applied" | "conflict" | "retry"> {
  await database.drafts.update(draft.id, {
    state: "syncing",
    error: undefined,
    updatedAt: Date.now(),
  });
  notifyDraftChange();

  try {
    const path = draft.recordId
      ? `${draft.endpoint}/${encodeURIComponent(draft.recordId)}`
      : draft.endpoint;
    await apiRequest(path, domainRecordSchema, {
      method: draft.operation === "update" ? "PATCH" : "POST",
      ...(draft.operation === "update"
        ? { headers: { "If-Match": `"${draft.baseVersion ?? 0}"` } }
        : {}),
      body: jsonBody(draft.payload),
    });
    await database.drafts.delete(draft.id);
    notifyDraftChange();
    return "applied";
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      const parsedServer = extractServerRecord(error.details);
      await database.drafts.update(draft.id, {
        state: "conflict",
        error:
          "The server changed after this draft was created. Review both versions before choosing what to keep.",
        ...(parsedServer ? { serverRecord: parsedServer } : {}),
        updatedAt: Date.now(),
      });
      notifyDraftChange();
      return "conflict";
    }

    await database.drafts.update(draft.id, {
      state: navigator.onLine ? "failed" : "queued",
      error: navigator.onLine
        ? "The draft could not be synced. It remains on this device for retry."
        : undefined,
      updatedAt: Date.now(),
    });
    notifyDraftChange();
    return "retry";
  }
}

export async function syncQueuedDrafts(): Promise<{
  applied: number;
  conflicts: number;
  retry: number;
}> {
  if (!navigator.onLine) return { applied: 0, conflicts: 0, retry: 0 };
  const drafts = await database.drafts.where("state").anyOf("queued", "failed").sortBy("createdAt");
  const result = { applied: 0, conflicts: 0, retry: 0 };
  for (const draft of drafts) {
    const state = await syncOfflineDraft(draft);
    result[state === "applied" ? "applied" : state === "conflict" ? "conflicts" : "retry"] += 1;
    if (state === "retry") break;
  }
  return result;
}

const conflictDetailsSchema = z
  .object({
    current: domainRecordSchema.optional(),
  })
  .passthrough();

function extractServerRecord(value: unknown): DomainRecord | undefined {
  const parsed = conflictDetailsSchema.safeParse(value);
  return parsed.success ? parsed.data.current : undefined;
}
