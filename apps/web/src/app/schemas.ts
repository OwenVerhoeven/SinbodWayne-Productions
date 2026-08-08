import { z } from "zod";

export const projectSchema = z.object({
  id: z.string(),
  code: z.string(),
  title: z.string(),
  workingTitle: z.string().nullable(),
  type: z.string(),
  phase: z.string(),
  status: z.string(),
  readinessState: z.string(),
  readinessScore: z.number(),
  timezone: z.string(),
  updatedAt: z.number(),
  version: z.number(),
  archivedAt: z.number().nullable(),
});

export const projectListSchema = z.object({
  items: z.array(projectSchema),
  nextCursor: z.string().nullable(),
});

export type ProjectSummary = z.infer<typeof projectSchema>;

export const domainRecordSchema = z.object({
  id: z.string(),
  recordType: z.string(),
  title: z.string(),
  status: z.string(),
  summary: z.string().nullable(),
  ownerDisplayName: z.string().nullable(),
  sortRank: z.string(),
  details: z.record(z.string(), z.unknown()),
  createdAt: z.number(),
  updatedAt: z.number(),
  version: z.number(),
  archivedAt: z.number().nullable(),
});

export const domainRecordListSchema = z.object({
  items: z.array(domainRecordSchema),
  nextCursor: z.string().nullable(),
  total: z.number(),
});

export type DomainRecord = z.infer<typeof domainRecordSchema>;
