import { z } from "zod";

const nullableText = z.string().nullable();
const nullableNumber = z.number().nullable();

export const budgetLineViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  notes: nullableText,
  quantityMilli: z.number(),
  durationMilli: z.number(),
  unit: nullableText,
  rateMinor: z.number(),
  subtotalMinor: z.number(),
  fringeBps: z.number(),
  taxBps: z.number(),
  markupBps: z.number(),
  estimateMinor: z.number(),
  approvedMinor: z.number(),
  committedMinor: z.number(),
  actualMinor: z.number(),
  paidMinor: z.number(),
  currency: z.string(),
});
const budgetAccountSchema = z.object({
  id: z.string(),
  parentAccountId: z.string().nullable(),
  code: z.string(),
  title: z.string(),
  lines: z.array(budgetLineViewSchema),
});
const budgetVersionSchema = z.object({
  id: z.string(),
  versionNumber: z.number(),
  name: z.string(),
  status: z.string(),
  currency: z.string(),
  exchangeRateNote: nullableText,
  contingencyBps: z.number(),
  totalEstimateMinor: z.number(),
  totalApprovedMinor: z.number(),
  totalCommittedMinor: z.number(),
  totalActualMinor: z.number(),
  totalPaidMinor: z.number(),
  contentHash: z.string(),
  createdAt: z.number(),
  isCurrentApproved: z.boolean(),
  varianceMinor: z.number(),
  accounts: z.array(budgetAccountSchema),
});
export const budgetViewSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  currency: z.string(),
  workingVersionId: z.string().nullable(),
  approvedVersionId: z.string().nullable(),
  version: z.number(),
  archivedAt: nullableNumber,
  versions: z.array(budgetVersionSchema),
});

const requirementSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  summary: nullableText,
  requirementType: z.string(),
  jurisdiction: nullableText,
  dueAt: nullableNumber,
  expiresAt: nullableNumber,
  priority: z.string(),
  isBlocking: z.boolean(),
  signedExecutedState: z.string(),
  currentFileVersionId: z.string().nullable(),
  restricted: z.boolean(),
  version: z.number(),
  archivedAt: nullableNumber,
  updatedAt: z.number(),
});
const controlSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: nullableText,
  status: z.string(),
  dueAt: nullableNumber,
  version: z.number(),
  archivedAt: nullableNumber,
});
const hazardSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: nullableText,
  affectedPeople: nullableText,
  likelihood: z.number(),
  impact: z.number(),
  initialScore: z.number(),
  residualLikelihood: nullableNumber,
  residualImpact: nullableNumber,
  residualScore: nullableNumber,
  status: z.string(),
  version: z.number(),
  archivedAt: nullableNumber,
  controls: z.array(controlSchema),
});
const riskSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  summary: nullableText,
  reviewAt: nullableNumber,
  version: z.number(),
  archivedAt: nullableNumber,
  hazards: z.array(hazardSchema),
});
const legalHoldSchema = z.object({
  id: z.string(),
  title: z.string(),
  reason: z.string(),
  scope: z.string(),
  placedAt: z.number(),
  releasedAt: nullableNumber,
  releaseReason: nullableText,
  placedBy: z.string(),
  releasedBy: nullableText,
});

const equipmentSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  summary: nullableText,
  ownershipType: z.string(),
  category: z.string(),
  manufacturer: nullableText,
  model: nullableText,
  serialAssetId: nullableText,
  condition: nullableText,
  valueMinor: nullableNumber,
  currency: nullableText,
  storageLocation: nullableText,
  version: z.number(),
  archivedAt: nullableNumber,
});
const kitSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  summary: nullableText,
  version: z.number(),
  archivedAt: nullableNumber,
  members: z.array(
    z.object({ equipmentItemId: z.string(), title: z.string(), quantity: z.number() }),
  ),
});
const reservationSchema = z.object({
  id: z.string(),
  equipmentItemId: z.string().nullable(),
  equipmentKitId: z.string().nullable(),
  resourceTitle: z.string(),
  startsAt: z.number(),
  endsAt: z.number(),
  timezone: z.string(),
  status: z.string(),
  version: z.number(),
  archivedAt: nullableNumber,
});
const reservationConflictSchema = z.object({
  resourceItemId: z.string(),
  resourceTitle: z.string(),
  reservationIds: z.tuple([z.string(), z.string()]),
  overlapMs: z.number(),
  severity: z.literal("blocker"),
});

const logisticsPlanSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  summary: nullableText,
  baseCamp: nullableText,
  holding: nullableText,
  greenRoom: nullableText,
  toilets: nullableText,
  powerCharging: nullableText,
  waste: nullableText,
  security: nullableText,
  accessNotes: nullableText,
  emergencyNotes: nullableText,
  version: z.number(),
  archivedAt: nullableNumber,
});
const transportSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  summary: nullableText,
  routeMapUrl: nullableText,
  version: z.number(),
  archivedAt: nullableNumber,
});
const cateringSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  summary: nullableText,
  headCount: z.number(),
  mealTimes: z.array(z.string()),
  costMinor: nullableNumber,
  currency: nullableText,
  version: z.number(),
  archivedAt: nullableNumber,
});
const providerSchema = z.object({
  state: z.string(),
  notice: z.string().optional(),
  manualFallback: z.string().optional(),
});

export const planningControlsSchema = z.object({
  project: z.object({ currency: z.string(), timezone: z.string(), paperSize: z.string() }),
  budget: z.object({ budgets: z.array(budgetViewSchema) }),
  legalSafety: z.object({
    requirements: z.array(requirementSchema),
    risks: z.array(riskSchema),
    legalHolds: z.array(legalHoldSchema),
    providers: z.object({ externalSignature: providerSchema, legalDetermination: providerSchema }),
  }),
  equipment: z.object({
    items: z.array(equipmentSchema),
    kits: z.array(kitSchema),
    reservations: z.array(reservationSchema),
    conflicts: z.array(reservationConflictSchema),
  }),
  logistics: z.object({
    plans: z.array(logisticsPlanSchema),
    transport: z.array(transportSchema),
    catering: z.array(cateringSchema),
    readiness: z.object({
      state: z.enum(["not_loaded", "blocked", "ready"]),
      missing: z.array(z.string()),
    }),
    providers: z.object({ maps: providerSchema, booking: providerSchema }),
  }),
});

export type PlanningControls = z.infer<typeof planningControlsSchema>;
export type BudgetView = z.infer<typeof budgetViewSchema>;
export type BudgetLineView = z.infer<typeof budgetLineViewSchema>;
