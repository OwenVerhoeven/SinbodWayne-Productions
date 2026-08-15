import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { apiRequest, jsonBody } from "../api/client";

export const creativeModuleSchema = z.enum(["overview", "idea_box", "story", "screenplay"]);
export type CreativeModule = z.infer<typeof creativeModuleSchema>;

export const creativeProgressSchema = z.object({
  projectId: z.string(),
  version: z.number().int().positive(),
  projectStatus: z.enum(["just_started", "in_progress", "writing_completed"]),
  modules: z.array(
    z.object({
      key: creativeModuleSchema,
      completed: z.boolean(),
      hasContent: z.boolean(),
      status: z.enum(["not_yet_started", "in_progress", "completed"]),
    }),
  ),
});

export type CreativeProgress = z.infer<typeof creativeProgressSchema>;

export function useCreativeProgress(projectId?: string) {
  return useQuery({
    enabled: Boolean(projectId),
    queryKey: ["creative-progress", projectId],
    queryFn: () =>
      apiRequest(
        `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/creative-progress`,
        creativeProgressSchema,
      ),
  });
}

export function useToggleCreativeCompletion(projectId?: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      moduleKey,
      completed,
      version,
    }: {
      moduleKey: CreativeModule;
      completed: boolean;
      version: number;
    }) =>
      apiRequest(
        `/api/v1/app/projects/${encodeURIComponent(projectId ?? "")}/creative-progress/${moduleKey}`,
        creativeProgressSchema,
        {
          method: "PATCH",
          headers: { "If-Match": `"${version}"` },
          body: jsonBody({ completed }),
        },
      ),
    onSuccess: (progress) => {
      queryClient.setQueryData(["creative-progress", projectId], progress);
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

export function creativeStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    just_started: "Just started",
    not_yet_started: "Not yet started",
    in_progress: "In progress",
    completed: "Completed",
    writing_completed: "Writing completed",
  };
  return labels[value] ?? value.replaceAll("_", " ");
}

export function creativeStatusTone(value: string): "neutral" | "info" | "success" {
  if (value === "completed" || value === "writing_completed") return "success";
  return value === "in_progress" ? "info" : "neutral";
}
