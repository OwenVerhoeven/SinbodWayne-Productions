import { useCallback, useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import {
  OFFLINE_DRAFTS_CHANGED,
  discardOfflineDraft,
  listOfflineDrafts,
  rebaseOfflineDraft,
  syncOfflineDraft,
  syncQueuedDrafts,
  type OfflineDraft,
} from "./database";

export function useOfflineDrafts(projectId?: string, recordType?: string) {
  const queryClient = useQueryClient();
  const [online, setOnline] = useState(() => navigator.onLine);
  const [drafts, setDrafts] = useState<OfflineDraft[]>([]);

  const refresh = useCallback(async () => {
    setDrafts(await listOfflineDrafts(projectId, recordType));
  }, [projectId, recordType]);

  useEffect(() => {
    void refresh();
    const changed = () => void refresh();
    const wentOffline = () => setOnline(false);
    const wentOnline = async () => {
      setOnline(true);
      const result = await syncQueuedDrafts();
      if (result.applied > 0) await queryClient.invalidateQueries();
      await refresh();
    };
    window.addEventListener(OFFLINE_DRAFTS_CHANGED, changed);
    window.addEventListener("offline", wentOffline);
    window.addEventListener("online", wentOnline);
    return () => {
      window.removeEventListener(OFFLINE_DRAFTS_CHANGED, changed);
      window.removeEventListener("offline", wentOffline);
      window.removeEventListener("online", wentOnline);
    };
  }, [queryClient, refresh]);

  const retry = useCallback(
    async (draft: OfflineDraft) => {
      const result = await syncOfflineDraft(draft);
      if (result === "applied") await queryClient.invalidateQueries();
      await refresh();
    },
    [queryClient, refresh],
  );

  const discard = useCallback(
    async (id: string) => {
      await discardOfflineDraft(id);
      await refresh();
    },
    [refresh],
  );

  const keepLocal = useCallback(
    async (draft: OfflineDraft) => {
      if (!draft.serverRecord) return;
      const rebased = await rebaseOfflineDraft(draft.id, draft.serverRecord.version);
      if (rebased && navigator.onLine) {
        const result = await syncOfflineDraft(rebased);
        if (result === "applied") await queryClient.invalidateQueries();
      }
      await refresh();
    },
    [queryClient, refresh],
  );

  return { online, drafts, retry, discard, keepLocal, refresh };
}
