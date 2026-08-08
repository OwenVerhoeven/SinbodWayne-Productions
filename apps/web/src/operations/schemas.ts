import { z } from "zod";

const totalsSchema = z
  .object({
    pageEighths: z.number().default(0),
    prepMs: z.number().default(0),
    setupMs: z.number().default(0),
    shootMs: z.number().default(0),
    moveMs: z.number().default(0),
    mealMs: z.number().default(0),
    totalMs: z.number().default(0),
    estimatedWrapOffsetMs: z.number().default(0),
  })
  .passthrough();

export const scheduleSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  isDefault: z.boolean(),
  currentRevisionId: z.string().nullable(),
  approvedRevisionId: z.string().nullable(),
  version: z.number(),
  archivedAt: z.number().nullable(),
  updatedAt: z.number(),
  revision: z
    .object({
      id: z.string(),
      name: z.string(),
      revisionNumber: z.number(),
      status: z.string(),
      totals: totalsSchema,
      itemCount: z.number(),
      openConflicts: z.number(),
      dayBreakItemId: z.string().nullable(),
    })
    .nullable(),
});
export const schedulesSchema = z.object({ items: z.array(scheduleSummarySchema) });

export const shootDaySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  summary: z.string().nullable().optional(),
  scheduleRevisionId: z.string().nullable(),
  revisionName: z.string().nullable(),
  scheduleStale: z.boolean(),
  shootDate: z.string().nullable(),
  unit: z.string(),
  dayCount: z.number(),
  timezone: z.string(),
  generalCallAt: z.number().nullable(),
  estimatedStartAt: z.number().nullable(),
  estimatedWrapAt: z.number().nullable(),
  readinessState: z.string(),
  openConflicts: z.number(),
  callSheetCount: z.number(),
  version: z.number(),
  archivedAt: z.number().nullable(),
  updatedAt: z.number(),
});
export const shootDaysSchema = z.object({ items: z.array(shootDaySchema) });

export const callSheetDraftSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  shootDayId: z.string().nullable(),
  sourceScheduleRevisionId: z.string().nullable(),
  callSheetType: z.string(),
  nextIssueNumber: z.number(),
  timezone: z.string(),
  paperSize: z.string(),
  layout: z.string(),
  manualWeather: z.record(z.string(), z.unknown()),
  shootDate: z.string().nullable(),
  unit: z.string().nullable(),
  dayCount: z.number().nullable(),
  recipientCount: z.number(),
  issueCount: z.number(),
  latestIssueId: z.string().nullable(),
  latestIssueNumber: z.number().nullable(),
  version: z.number(),
  archivedAt: z.number().nullable().optional(),
  updatedAt: z.number(),
});
export const recipientIssueSchema = z.object({
  recipientIssueId: z.string(),
  callSheetIssueId: z.string(),
  callSheetDraftId: z.string().nullable().optional(),
  issueNumber: z.number().nullable().optional(),
  personName: z.string(),
  label: z.string().nullable(),
  requiredConfirmation: z.boolean(),
  shareLocator: z.string().nullable().optional(),
  linkExpiresAt: z.number().nullable(),
  linkRevokedAt: z.number().nullable(),
  viewedAt: z.number().nullable(),
  confirmedAt: z.number().nullable(),
  deliveryState: z.enum(["issued", "not_configured", "viewed", "confirmed", "failed"]),
});
const callSheetContextDaySchema = z.object({
  id: z.string(),
  title: z.string(),
  shootDate: z.string().nullable(),
  unit: z.string(),
  dayCount: z.number(),
  timezone: z.string(),
  generalCallAt: z.number().nullable(),
  estimatedWrapAt: z.number().nullable(),
  scheduleRevisionId: z.string().nullable(),
  version: z.number(),
});
export const callSheetsSchema = z.object({
  drafts: z.array(callSheetDraftSchema),
  recipientIssues: z.array(recipientIssueSchema),
  people: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      email: z.string().nullable(),
      phone: z.string().nullable(),
    }),
  ),
  shootDays: z.array(callSheetContextDaySchema),
  providers: z.object({
    email: z.literal("not_configured"),
    sms: z.literal("not_configured"),
    manualFallback: z.string(),
  }),
});
export const callSheetIssueSchema = z.object({
  id: z.string(),
  draftId: z.string(),
  issueNumber: z.number(),
  title: z.string(),
  confidentiality: z.string().nullable(),
  contentHash: z.string(),
  supersedesIssueId: z.string().nullable(),
  sourceScheduleRevisionId: z.string().nullable(),
  createdAt: z.number(),
  recipients: z.array(recipientIssueSchema),
  printHref: z.string(),
  linksRevealed: z.boolean().optional(),
  recipientLinks: z
    .array(
      z.object({
        recipientIssueId: z.string(),
        displayName: z.string(),
        expiresAt: z.number(),
        url: z.string(),
      }),
    )
    .optional(),
});

export const packDraftSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  summary: z.string().nullable(),
  shootDayId: z.string().nullable(),
  paperSize: z.string(),
  confidentiality: z.string().nullable(),
  itemCount: z.number(),
  issueCount: z.number(),
  latestIssueId: z.string().nullable(),
  latestIssueNumber: z.number().nullable(),
  latestManifestHash: z.string().nullable(),
  version: z.number(),
  updatedAt: z.number(),
  zipState: z.literal("not_configured"),
});
export const productionPacksSchema = z.object({
  drafts: z.array(packDraftSchema),
  availablePins: z.array(
    z.object({
      id: z.string(),
      objectType: z.string(),
      domainId: z.string(),
      title: z.string(),
      updatedAt: z.number(),
    }),
  ),
  availableFiles: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      displayName: z.string(),
      versionNumber: z.number(),
      byteSize: z.number(),
      mimeType: z.string(),
      sha256: z.string(),
      scanState: z.string(),
    }),
  ),
  shootDays: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      shootDate: z.string().nullable(),
      unit: z.string(),
      dayCount: z.number(),
    }),
  ),
});
export const packIssueSchema = z.object({
  id: z.string(),
  draftId: z.string(),
  issueNumber: z.number(),
  title: z.string(),
  manifestHash: z.string(),
  itemCount: z.number(),
  supersedesIssueId: z.string().nullable(),
  createdAt: z.number(),
  printHref: z.string(),
  manifestHref: z.string(),
  zipState: z.enum(["available", "not_configured"]),
});

export type ScheduleSummary = z.infer<typeof scheduleSummarySchema>;
export type ShootDay = z.infer<typeof shootDaySchema>;
export type CallSheetDraft = z.infer<typeof callSheetDraftSchema>;
export type RecipientIssue = z.infer<typeof recipientIssueSchema>;
export type PackDraft = z.infer<typeof packDraftSchema>;
