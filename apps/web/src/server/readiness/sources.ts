import { hashCanonicalJson, type JsonValue } from "@swp/domain";

import type { RuleRuntime, SourceObservation } from "./engine";

interface ProjectReadinessContext {
  readonly db: D1Database;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly shootDayId: string | null;
  readonly projectOwnerId: string;
  readonly now: number;
}

interface ObservationDraft {
  readonly present: boolean;
  readonly satisfied: boolean;
  readonly description: string;
  readonly sourceLabel: string | null;
  readonly evidence: string | null;
  readonly ownerId?: string | null;
  readonly dueAt?: number | null;
  readonly fingerprint: JsonValue;
}

const COMPLETE_STATUSES = new Set([
  "approved",
  "booked",
  "complete",
  "completed",
  "confirmed",
  "executed",
  "ready",
]);
const RESOURCE_READY_STATUSES = new Set([
  "approved",
  "available",
  "booked",
  "complete",
  "completed",
  "confirmed",
  "ready",
  "reserved",
  "sourced",
]);

export async function loadReadinessSources(
  input: ProjectReadinessContext,
  rules: readonly RuleRuntime[],
): Promise<ReadonlyMap<string, SourceObservation>> {
  // This is a fixed, bounded rule fan-out rather than a query per returned record.
  const observations = await Promise.all(
    rules.map(async (rule) => [rule.id, await observeRule(input, rule.code)] as const),
  );
  return new Map(observations);
}

async function observeRule(
  input: ProjectReadinessContext,
  code: string,
): Promise<SourceObservation> {
  const draft = await observationDraft(input, code);
  const payload: JsonValue = {
    code,
    present: draft.present,
    satisfied: draft.satisfied,
    description: draft.description,
    sourceLabel: draft.sourceLabel,
    evidence: draft.evidence,
    ownerId: draft.ownerId ?? input.projectOwnerId,
    dueAt: draft.dueAt ?? null,
    fingerprint: draft.fingerprint,
  };
  return {
    loaded: true,
    present: draft.present,
    satisfied: draft.satisfied,
    description: draft.description,
    sourceLabel: draft.sourceLabel,
    evidence: draft.evidence,
    ownerId: draft.ownerId ?? input.projectOwnerId,
    dueAt: draft.dueAt ?? null,
    sourceHash: await hashCanonicalJson(payload),
    snapshot: payload,
  };
}

async function observationDraft(
  input: ProjectReadinessContext,
  code: string,
): Promise<ObservationDraft> {
  switch (code) {
    case "development_approved":
      return developmentObservation(input);
    case "writing_approved_synced":
      return writingObservation(input);
    case "breakdown_complete":
      return breakdownObservation(input);
    case "cast_ready":
      return castObservation(input);
    case "crew_ready":
      return crewObservation(input);
    case "locations_ready":
      return locationsObservation(input);
    case "budget_ready":
      return budgetObservation(input);
    case "legal_rights_clearance":
      return legalObservation(input);
    case "legal_hold":
      return legalHoldObservation(input);
    case "insurance_current":
      return insuranceObservation(input);
    case "safety_ready":
      return safetyObservation(input);
    case "equipment_ready":
      return equipmentObservation(input);
    case "department_resources_ready":
      return departmentResourcesObservation(input);
    case "logistics_ready":
      return logisticsObservation(input);
    case "schedule_ready":
      return scheduleObservation(input);
    case "visual_plan_ready":
      return visualObservation(input);
    case "issued_documents_ready":
      return issuedDocumentsObservation(input);
    case "archive_integrity":
      return archiveObservation(input);
    case "workspace_security":
      return workspaceSecurityObservation(input);
    default:
      return {
        present: false,
        satisfied: false,
        description: "This profile rule has no configured evaluator.",
        sourceLabel: "Evaluator not configured",
        evidence: null,
        fingerprint: { code, evaluator: "missing" },
      };
  }
}

interface DevelopmentRow {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly current_revision_id: string | null;
  readonly version: number;
  readonly updated_at: number;
  readonly owner_user_id: string | null;
}

async function developmentObservation(input: ProjectReadinessContext): Promise<ObservationDraft> {
  const [briefs, treatments, outlines] = await Promise.all([
    input.db
      .prepare(
        `SELECT id, 'brief' AS kind, status, current_revision_id, version, updated_at, owner_user_id
           FROM project_briefs WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL`,
      )
      .bind(input.workspaceId, input.projectId)
      .all<DevelopmentRow>(),
    input.db
      .prepare(
        `SELECT id, document_type AS kind, status, current_revision_id, version, updated_at, owner_user_id
           FROM development_documents WHERE workspace_id = ?1 AND project_id = ?2
            AND document_type = 'treatment' AND archived_at IS NULL`,
      )
      .bind(input.workspaceId, input.projectId)
      .all<DevelopmentRow>(),
    input.db
      .prepare(
        `SELECT id, 'outline' AS kind, status, NULL AS current_revision_id, version, updated_at, owner_user_id
           FROM outlines WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL`,
      )
      .bind(input.workspaceId, input.projectId)
      .all<DevelopmentRow>(),
  ]);
  const rows = [...briefs.results, ...treatments.results, ...outlines.results];
  const approved = (kind: string) =>
    rows.some(
      (row) =>
        row.kind === kind &&
        row.status === "approved" &&
        (kind === "outline" || row.current_revision_id !== null),
    );
  const missing = [
    ...(approved("brief") ? [] : ["brief"]),
    ...(approved("treatment") ? [] : ["treatment"]),
    ...(approved("outline") ? [] : ["outline"]),
  ];
  return {
    present: rows.length > 0,
    satisfied: missing.length === 0,
    description:
      missing.length === 0
        ? "The brief, treatment and outline are approved."
        : `Approval is still required for: ${missing.join(", ")}.`,
    sourceLabel: rows.length > 0 ? "Development approvals" : "No development package",
    evidence: `${3 - missing.length} of 3 required development records approved`,
    ownerId: rows.find((row) => !COMPLETE_STATUSES.has(row.status))?.owner_user_id ?? null,
    fingerprint: rows
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        status: row.status,
        revisionId: row.current_revision_id,
        version: row.version,
        updatedAt: row.updated_at,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

interface WritingRow {
  readonly id: string;
  readonly kind: "screenplay" | "av_script";
  readonly status: string;
  readonly current_revision_id: string | null;
  readonly approved_revision_id: string | null;
  readonly version: number;
  readonly updated_at: number;
}

interface SyncRow {
  readonly id: string;
  readonly status: string;
  readonly to_revision_id: string;
  readonly unresolved: number;
  readonly updated_at: number;
}

async function writingObservation(input: ProjectReadinessContext): Promise<ObservationDraft> {
  const [screenplays, avScripts, syncs] = await Promise.all([
    input.db
      .prepare(
        `SELECT id, 'screenplay' AS kind, status, current_revision_id, approved_revision_id, version, updated_at
           FROM screenplays WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL`,
      )
      .bind(input.workspaceId, input.projectId)
      .all<WritingRow>(),
    input.db
      .prepare(
        `SELECT id, 'av_script' AS kind, status, current_revision_id,
                CASE WHEN status = 'approved' THEN current_revision_id ELSE NULL END AS approved_revision_id,
                version, updated_at
           FROM av_scripts WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL`,
      )
      .bind(input.workspaceId, input.projectId)
      .all<WritingRow>(),
    input.db
      .prepare(
        `SELECT ss.id, ss.status, ss.to_revision_id, ss.updated_at,
                COALESCE(SUM(CASE WHEN sm.mapping_kind IN ('ambiguous', 'removed')
                                  AND sm.resolution IS NULL THEN 1 ELSE 0 END), 0) AS unresolved
           FROM script_syncs ss LEFT JOIN scene_mappings sm ON sm.script_sync_id = ss.id
          WHERE ss.workspace_id = ?1 AND ss.project_id = ?2
          GROUP BY ss.id, ss.status, ss.to_revision_id, ss.updated_at`,
      )
      .bind(input.workspaceId, input.projectId)
      .all<SyncRow>(),
  ]);
  const rows = [...screenplays.results, ...avScripts.results];
  const approvedAv = rows.some(
    (row) =>
      row.kind === "av_script" && row.status === "approved" && row.current_revision_id !== null,
  );
  const approvedScreenplays = rows.filter(
    (row) =>
      row.kind === "screenplay" &&
      row.current_revision_id !== null &&
      row.current_revision_id === row.approved_revision_id,
  );
  const screenplaySynced = approvedScreenplays.some((screenplay) =>
    syncs.results.some(
      (sync) =>
        sync.status === "applied" &&
        sync.to_revision_id === screenplay.approved_revision_id &&
        sync.unresolved === 0,
    ),
  );
  const satisfied = approvedAv || screenplaySynced;
  const unresolved = syncs.results.reduce((total, sync) => total + sync.unresolved, 0);
  return {
    present: rows.some((row) => row.current_revision_id !== null),
    satisfied,
    description: satisfied
      ? approvedAv
        ? "The current AV-script revision is approved."
        : "The current screenplay revision is approved, applied and has no unresolved mappings."
      : unresolved > 0
        ? `${unresolved} script mapping ${unresolved === 1 ? "decision is" : "decisions are"} unresolved.`
        : "Approve the current writing revision and apply its production sync.",
    sourceLabel: rows.length > 0 ? "Current writing revision" : "No writing revision",
    evidence: `${rows.length} writing document(s); ${unresolved} unresolved mapping(s)`,
    fingerprint: {
      writing: rows
        .map((row) => ({
          id: row.id,
          kind: row.kind,
          status: row.status,
          currentRevisionId: row.current_revision_id,
          approvedRevisionId: row.approved_revision_id,
          version: row.version,
          updatedAt: row.updated_at,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      syncs: syncs.results
        .map((row) => ({
          id: row.id,
          status: row.status,
          revisionId: row.to_revision_id,
          unresolved: row.unresolved,
          updatedAt: row.updated_at,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    },
  };
}

interface BreakdownRow {
  readonly scene_id: string;
  readonly scene_revision_id: string | null;
  readonly scene_version: number;
  readonly breakdown_id: string | null;
  readonly source_scene_revision_id: string | null;
  readonly status: string | null;
  readonly readiness_state: string | null;
  readonly breakdown_version: number | null;
}

async function breakdownObservation(input: ProjectReadinessContext): Promise<ObservationDraft> {
  const result = await input.db
    .prepare(
      `SELECT s.id AS scene_id, s.current_scene_revision_id AS scene_revision_id,
              s.version AS scene_version, sb.id AS breakdown_id,
              sb.source_scene_revision_id, sb.status, sb.readiness_state,
              sb.version AS breakdown_version
         FROM scenes s LEFT JOIN scene_breakdowns sb
           ON sb.scene_id = s.id AND sb.archived_at IS NULL
        WHERE s.workspace_id = ?1 AND s.project_id = ?2 AND s.archived_at IS NULL AND s.omitted = 0
        ORDER BY s.sort_rank, s.id`,
    )
    .bind(input.workspaceId, input.projectId)
    .all<BreakdownRow>();
  const incomplete = result.results.filter(
    (row) =>
      row.breakdown_id === null ||
      row.readiness_state !== "ready" ||
      !COMPLETE_STATUSES.has(row.status ?? "") ||
      row.source_scene_revision_id !== row.scene_revision_id,
  );
  return {
    present: result.results.length > 0,
    satisfied: result.results.length > 0 && incomplete.length === 0,
    description:
      incomplete.length === 0 && result.results.length > 0
        ? "Every active scene has a current, ready breakdown."
        : `${incomplete.length || result.results.length} scene breakdown(s) need completion or revision sync.`,
    sourceLabel: result.results.length > 0 ? "Canonical scene breakdowns" : "No active scenes",
    evidence: `${result.results.length - incomplete.length} of ${result.results.length} scenes ready`,
    fingerprint: result.results.map((row) => ({
      sceneId: row.scene_id,
      sceneRevisionId: row.scene_revision_id,
      sceneVersion: row.scene_version,
      breakdownId: row.breakdown_id,
      breakdownRevisionId: row.source_scene_revision_id,
      status: row.status,
      readiness: row.readiness_state,
      breakdownVersion: row.breakdown_version,
    })),
  };
}

interface CastRow {
  readonly character_id: string;
  readonly character_version: number;
  readonly assignment_id: string | null;
  readonly assignment_status: string | null;
  readonly confirmed_at: number | null;
  readonly requirement_id: string | null;
  readonly requirement_status: string | null;
  readonly signed_state: string | null;
  readonly assignment_version: number | null;
}

async function castObservation(input: ProjectReadinessContext): Promise<ObservationDraft> {
  const result = await input.db
    .prepare(
      `SELECT c.id AS character_id, c.version AS character_version,
              ca.id AS assignment_id, ca.status AS assignment_status, ca.confirmed_at,
              ca.agreement_requirement_id AS requirement_id, r.status AS requirement_status,
              r.signed_executed_state AS signed_state, ca.version AS assignment_version
         FROM characters c LEFT JOIN cast_assignments ca
           ON ca.character_id = c.id AND ca.archived_at IS NULL
         LEFT JOIN requirements r ON r.id = ca.agreement_requirement_id AND r.archived_at IS NULL
        WHERE c.workspace_id = ?1 AND c.project_id = ?2 AND c.archived_at IS NULL AND c.speaking = 1
        ORDER BY c.id, ca.updated_at DESC`,
    )
    .bind(input.workspaceId, input.projectId)
    .all<CastRow>();
  const byCharacter = new Map<string, CastRow[]>();
  for (const row of result.results) {
    byCharacter.set(row.character_id, [...(byCharacter.get(row.character_id) ?? []), row]);
  }
  const characterReady = (rows: readonly CastRow[]) =>
    rows.some(
      (row) =>
        ["booked", "confirmed"].includes(row.assignment_status ?? "") &&
        row.confirmed_at !== null &&
        row.requirement_id !== null &&
        COMPLETE_STATUSES.has(row.requirement_status ?? "") &&
        ["signed", "executed", "complete", "completed"].includes(row.signed_state ?? ""),
    );
  const readyCount = [...byCharacter.values()].filter(characterReady).length;
  return {
    present: byCharacter.size > 0,
    satisfied: byCharacter.size > 0 && readyCount === byCharacter.size,
    description:
      byCharacter.size > 0 && readyCount === byCharacter.size
        ? "All speaking characters have confirmed booked cast and completed agreements."
        : `${byCharacter.size - readyCount} speaking role(s) still need booking, confirmation or agreement evidence.`,
    sourceLabel: byCharacter.size > 0 ? "Cast assignments" : "No speaking-character assignments",
    evidence: `${readyCount} of ${byCharacter.size} speaking roles ready`,
    fingerprint: result.results.map((row) => ({ ...row })),
  };
}

interface CrewRow {
  readonly id: string;
  readonly department_code: string | null;
  readonly department_title: string | null;
  readonly booking_status: string;
  readonly confirmation_status: string;
  readonly availability_status: string | null;
  readonly deal_memo_status: string | null;
  readonly version: number;
  readonly updated_at: number;
}

const REQUIRED_CREW_DEPARTMENTS = [
  "production",
  "directing",
  "camera",
  "sound",
  "art",
  "safety",
] as const;

async function crewObservation(input: ProjectReadinessContext): Promise<ObservationDraft> {
  const result = await input.db
    .prepare(
      `SELECT ppr.id, lower(d.code) AS department_code, d.title AS department_title,
              ppr.booking_status, ppr.confirmation_status, ppr.availability_status,
              ppr.deal_memo_status, ppr.version, ppr.updated_at
         FROM person_project_roles ppr
         LEFT JOIN departments d ON d.id = ppr.department_id
        WHERE ppr.workspace_id = ?1 AND ppr.project_id = ?2 AND ppr.archived_at IS NULL
        ORDER BY ppr.id`,
    )
    .bind(input.workspaceId, input.projectId)
    .all<CrewRow>();
  const isReady = (row: CrewRow) =>
    ["booked", "confirmed"].includes(row.booking_status) &&
    row.confirmation_status === "confirmed" &&
    ["available", "confirmed"].includes(row.availability_status ?? "") &&
    ["approved", "complete", "completed", "executed", "not_required", "signed"].includes(
      row.deal_memo_status ?? "",
    );
  const missing = REQUIRED_CREW_DEPARTMENTS.filter(
    (code) => !result.results.some((row) => row.department_code === code && isReady(row)),
  );
  return {
    present: result.results.length > 0,
    satisfied: missing.length === 0,
    description:
      missing.length === 0
        ? "Required production, directing, camera, sound, art and safety crew are confirmed."
        : `Confirmed crew are missing for: ${missing.join(", ")}.`,
    sourceLabel: result.results.length > 0 ? "Project crew bookings" : "No crew bookings",
    evidence: `${REQUIRED_CREW_DEPARTMENTS.length - missing.length} of ${REQUIRED_CREW_DEPARTMENTS.length} required departments covered`,
    fingerprint: result.results.map((row) => ({ ...row })),
  };
}

interface LocationRow {
  readonly id: string;
  readonly status: string;
  readonly availability_state: string;
  readonly legal_state: string;
  readonly safety_state: string;
  readonly approval_state: string;
  readonly version: number;
  readonly updated_at: number;
  readonly confirmed_windows: number;
}

async function locationsObservation(input: ProjectReadinessContext): Promise<ObservationDraft> {
  const result = await input.db
    .prepare(
      `SELECT l.id, l.status, l.availability_state, l.legal_state, l.safety_state,
              l.approval_state, l.version, l.updated_at,
              (SELECT COUNT(*) FROM location_availability la
                WHERE la.location_id = l.id AND la.archived_at IS NULL
                  AND la.state = 'confirmed') AS confirmed_windows
         FROM locations l
        WHERE l.workspace_id = ?1 AND l.project_id = ?2 AND l.archived_at IS NULL
          AND (NOT EXISTS (
                SELECT 1 FROM location_scene_links any_link
                 WHERE any_link.project_id = ?2 AND any_link.archived_at IS NULL
              ) OR EXISTS (
                SELECT 1 FROM location_scene_links link
                 WHERE link.location_id = l.id AND link.archived_at IS NULL
              ))
        ORDER BY l.id`,
    )
    .bind(input.workspaceId, input.projectId)
    .all<LocationRow>();
  const ready = result.results.filter(
    (row) =>
      ["approved", "confirmed"].includes(row.status) &&
      ["available", "confirmed", "ready"].includes(row.availability_state) &&
      ["approved", "complete", "confirmed", "ready"].includes(row.legal_state) &&
      ["approved", "complete", "confirmed", "ready"].includes(row.safety_state) &&
      ["approved", "confirmed"].includes(row.approval_state) &&
      row.confirmed_windows > 0,
  ).length;
  return {
    present: result.results.length > 0,
    satisfied: result.results.length > 0 && ready === result.results.length,
    description:
      result.results.length > 0 && ready === result.results.length
        ? "All selected locations are approved, safe, legally cleared and available."
        : `${result.results.length - ready} location(s) have an availability, legal, safety or approval gap.`,
    sourceLabel: result.results.length > 0 ? "Selected project locations" : "No selected locations",
    evidence: `${ready} of ${result.results.length} locations ready`,
    fingerprint: result.results.map((row) => ({ ...row })),
  };
}

interface BudgetRow {
  readonly id: string;
  readonly approved_version_id: string | null;
  readonly status: string;
  readonly version: number;
  readonly updated_at: number;
  readonly version_status: string | null;
  readonly approved_minor: number | null;
  readonly committed_minor: number | null;
  readonly content_hash: string | null;
  readonly owner_user_id: string | null;
}

async function budgetObservation(input: ProjectReadinessContext): Promise<ObservationDraft> {
  const result = await input.db
    .prepare(
      `SELECT b.id, b.approved_version_id, b.status, b.version, b.updated_at,
              bv.status AS version_status, bv.total_approved_minor AS approved_minor,
              bv.total_committed_minor AS committed_minor, bv.content_hash, b.owner_user_id
         FROM budgets b LEFT JOIN budget_versions bv ON bv.id = b.approved_version_id
        WHERE b.workspace_id = ?1 AND b.project_id = ?2 AND b.archived_at IS NULL
        ORDER BY b.updated_at DESC, b.id DESC`,
    )
    .bind(input.workspaceId, input.projectId)
    .all<BudgetRow>();
  const approved = result.results.find(
    (row) =>
      row.approved_version_id !== null &&
      row.version_status === "approved" &&
      (row.committed_minor ?? 0) <= (row.approved_minor ?? 0),
  );
  return {
    present: result.results.length > 0,
    satisfied: approved !== undefined,
    description:
      approved === undefined
        ? "Approve a budget version and resolve commitments above the approved amount."
        : "An approved budget is current and commitments remain within its approved total.",
    sourceLabel: approved ? "Approved budget version" : "No policy-compliant approved budget",
    evidence: approved
      ? `${approved.committed_minor ?? 0} committed of ${approved.approved_minor ?? 0} approved minor units`
      : null,
    ownerId: result.results[0]?.owner_user_id ?? null,
    fingerprint: result.results.map((row) => ({ ...row })),
  };
}

interface RequirementRow {
  readonly id: string;
  readonly requirement_type: string;
  readonly status: string;
  readonly is_blocking: number;
  readonly expires_at: number | null;
  readonly signed_executed_state: string;
  readonly current_file_version_id: string | null;
  readonly approval_status: string | null;
  readonly version: number;
  readonly updated_at: number;
  readonly owner_user_id: string | null;
  readonly due_at: number | null;
}

function requirementComplete(row: RequirementRow, now: number): boolean {
  const statusComplete = ["approved", "complete", "completed", "executed", "not_required"].includes(
    row.status,
  );
  const signatureComplete = [
    "executed",
    "not_required",
    "signed",
    "complete",
    "completed",
  ].includes(row.signed_executed_state);
  return (
    statusComplete &&
    signatureComplete &&
    (row.expires_at === null || row.expires_at > now) &&
    (row.approval_status === null || row.approval_status === "approved")
  );
}

async function legalObservation(input: ProjectReadinessContext): Promise<ObservationDraft> {
  const result = await input.db
    .prepare(
      `SELECT r.id, r.requirement_type, r.status, r.is_blocking, r.expires_at,
              r.signed_executed_state, r.current_file_version_id,
              a.status AS approval_status, r.version, r.updated_at, r.owner_user_id, r.due_at
         FROM requirements r LEFT JOIN approvals a ON a.id = r.approval_id
        WHERE r.workspace_id = ?1 AND r.project_id = ?2 AND r.archived_at IS NULL
          AND lower(r.requirement_type) NOT LIKE '%insurance%'
        ORDER BY r.sort_rank, r.id`,
    )
    .bind(input.workspaceId, input.projectId)
    .all<RequirementRow>();
  const blocking = result.results.filter((row) => row.is_blocking === 1);
  const incomplete = blocking.filter((row) => !requirementComplete(row, input.now));
  const satisfied = blocking.length > 0 && incomplete.length === 0;
  return {
    present: result.results.length > 0,
    satisfied,
    description: satisfied
      ? "All blocking legal, rights and clearance requirements are complete and current."
      : blocking.length === 0
        ? "Register at least one blocking legal, rights or clearance requirement and complete it."
        : `${incomplete.length} blocking legal requirement(s) are incomplete or expired.`,
    sourceLabel:
      result.results.length > 0 ? "Requirement register" : "No legal requirements registered",
    evidence: `${blocking.length - incomplete.length} of ${blocking.length} blocking requirements complete`,
    ownerId: incomplete[0]?.owner_user_id ?? null,
    dueAt:
      incomplete
        .map((row) => row.due_at)
        .filter((value): value is number => value !== null)
        .sort()[0] ?? null,
    fingerprint: result.results.map((row) => ({ ...row })),
  };
}

interface LegalHoldRow {
  readonly id: string;
  readonly scope: string;
  readonly reason: string;
  readonly placed_at: number;
}

async function legalHoldObservation(input: ProjectReadinessContext): Promise<ObservationDraft> {
  const result = await input.db
    .prepare(
      `SELECT id, scope, reason, placed_at FROM legal_holds
        WHERE workspace_id = ?1 AND released_at IS NULL
          AND (project_id IS NULL OR project_id = ?2)
        ORDER BY placed_at, id`,
    )
    .bind(input.workspaceId, input.projectId)
    .all<LegalHoldRow>();
  return {
    present: true,
    satisfied: result.results.length === 0,
    description:
      result.results.length === 0
        ? "No active workspace or project legal hold restricts this readiness issue."
        : `${result.results.length} active legal hold(s) require owner review or an explicit owner override.`,
    sourceLabel: "Legal-hold register",
    evidence: `${result.results.length} active hold(s)`,
    fingerprint: result.results.map((row) => ({ ...row })),
  };
}

interface InsuranceRow {
  readonly id: string;
  readonly requirement_id: string;
  readonly valid_from: string | null;
  readonly valid_until: string | null;
  readonly version: number;
  readonly updated_at: number;
  readonly requirement_status: string;
  readonly expires_at: number | null;
  readonly approval_status: string | null;
}

async function insuranceObservation(input: ProjectReadinessContext): Promise<ObservationDraft> {
  const result = await input.db
    .prepare(
      `SELECT ir.id, ir.requirement_id, ir.valid_from, ir.valid_until, ir.version, ir.updated_at,
              r.status AS requirement_status, r.expires_at, a.status AS approval_status
         FROM insurance_records ir
         JOIN requirements r ON r.id = ir.requirement_id AND r.archived_at IS NULL
         LEFT JOIN approvals a ON a.id = r.approval_id
        WHERE ir.workspace_id = ?1 AND ir.project_id = ?2
        ORDER BY ir.updated_at DESC, ir.id`,
    )
    .bind(input.workspaceId, input.projectId)
    .all<InsuranceRow>();
  const today = new Date(input.now).toISOString().slice(0, 10);
  const current = result.results.filter(
    (row) =>
      COMPLETE_STATUSES.has(row.requirement_status) &&
      (row.approval_status === null || row.approval_status === "approved") &&
      (row.valid_from === null || row.valid_from <= today) &&
      row.valid_until !== null &&
      row.valid_until >= today &&
      (row.expires_at === null || row.expires_at > input.now),
  );
  return {
    present: result.results.length > 0,
    satisfied: current.length > 0,
    description:
      current.length > 0
        ? "At least one approved insurance record is current for the planned shoot."
        : "A current, approved insurance record with a valid end date is required.",
    sourceLabel: result.results.length > 0 ? "Insurance register" : "No insurance record",
    evidence: `${current.length} of ${result.results.length} insurance record(s) current`,
    fingerprint: result.results.map((row) => ({ ...row })),
  };
}

interface SafetyPlanRow {
  readonly id: string;
  readonly kind: "risk" | "safety";
  readonly status: string;
  readonly approval_status: string | null;
  readonly complete_details: number;
  readonly version: number;
  readonly updated_at: number;
}

interface HazardRow {
  readonly id: string;
  readonly status: string;
  readonly residual_score: number | null;
  readonly version: number;
  readonly updated_at: number;
  readonly incomplete_controls: number;
}

async function safetyObservation(input: ProjectReadinessContext): Promise<ObservationDraft> {
  const [risks, plans, hazards] = await Promise.all([
    input.db
      .prepare(
        `SELECT ra.id, 'risk' AS kind, ra.status, a.status AS approval_status,
                1 AS complete_details, ra.version, ra.updated_at
           FROM risk_assessments ra LEFT JOIN approvals a ON a.id = ra.approval_id
          WHERE ra.workspace_id = ?1 AND ra.project_id = ?2 AND ra.archived_at IS NULL`,
      )
      .bind(input.workspaceId, input.projectId)
      .all<SafetyPlanRow>(),
    input.db
      .prepare(
        `SELECT sp.id, 'safety' AS kind, sp.status, a.status AS approval_status,
                CASE WHEN length(trim(COALESCE(sp.emergency_plan, ''))) > 0
                           AND length(trim(COALESCE(sp.medical_hospital, ''))) > 0
                           AND length(trim(COALESCE(sp.evacuation, ''))) > 0
                           AND length(trim(COALESCE(sp.weather_contingencies, ''))) > 0
                     THEN 1 ELSE 0 END AS complete_details,
                sp.version, sp.updated_at
           FROM safety_plans sp LEFT JOIN approvals a ON a.id = sp.approval_id
          WHERE sp.workspace_id = ?1 AND sp.project_id = ?2 AND sp.archived_at IS NULL`,
      )
      .bind(input.workspaceId, input.projectId)
      .all<SafetyPlanRow>(),
    input.db
      .prepare(
        `SELECT h.id, h.status, h.residual_score, h.version, h.updated_at,
                (SELECT COUNT(*) FROM control_measures cm
                  WHERE cm.hazard_id = h.id AND cm.archived_at IS NULL
                    AND cm.status NOT IN ('approved', 'complete', 'completed', 'implemented')) AS incomplete_controls
           FROM hazards h JOIN risk_assessments ra ON ra.id = h.risk_assessment_id
          WHERE h.workspace_id = ?1 AND h.project_id = ?2 AND h.archived_at IS NULL
            AND ra.archived_at IS NULL`,
      )
      .bind(input.workspaceId, input.projectId)
      .all<HazardRow>(),
  ]);
  const planRows = [...risks.results, ...plans.results];
  const approvedRisk = risks.results.some(
    (row) => row.status === "approved" && row.approval_status === "approved",
  );
  const approvedPlan = plans.results.some(
    (row) =>
      row.status === "approved" && row.approval_status === "approved" && row.complete_details === 1,
  );
  const uncontrolled = hazards.results.filter(
    (row) =>
      !["accepted", "closed", "controlled", "resolved"].includes(row.status) ||
      row.residual_score === null ||
      row.residual_score > 12 ||
      row.incomplete_controls > 0,
  );
  const satisfied =
    approvedRisk && approvedPlan && hazards.results.length > 0 && uncontrolled.length === 0;
  return {
    present: risks.results.length > 0 || plans.results.length > 0,
    satisfied,
    description: satisfied
      ? "Risk assessment and safety plan are approved; every hazard has acceptable residual risk and controls."
      : "Approve risk and safety plans and resolve every uncontrolled or high-residual-risk hazard.",
    sourceLabel: planRows.length > 0 ? "Safety and risk register" : "No safety plan",
    evidence: `${uncontrolled.length} uncontrolled hazard(s)`,
    fingerprint: {
      plans: planRows.map((row) => ({ ...row })),
      hazards: hazards.results.map((row) => ({ ...row })),
    },
  };
}

interface ReservationRow {
  readonly id: string;
  readonly status: string;
  readonly version: number;
  readonly updated_at: number;
  readonly equipment_id: string | null;
  readonly equipment_status: string | null;
  readonly condition: string | null;
}

async function equipmentObservation(input: ProjectReadinessContext): Promise<ObservationDraft> {
  const [reservations, conflicts] = await Promise.all([
    input.db
      .prepare(
        `SELECT r.id, r.status, r.version, r.updated_at,
                COALESCE(ei.id, ek.id) AS equipment_id,
                COALESCE(ei.status, ek.status) AS equipment_status,
                CASE
                  WHEN ei.id IS NOT NULL THEN ei.condition
                  WHEN ek.id IS NOT NULL
                    AND EXISTS (SELECT 1 FROM kit_members km WHERE km.equipment_kit_id = ek.id)
                    AND NOT EXISTS (
                      SELECT 1 FROM kit_members km
                      JOIN equipment_items child ON child.id = km.equipment_item_id
                      WHERE km.equipment_kit_id = ek.id
                        AND (child.archived_at IS NOT NULL
                          OR child.status NOT IN ('available', 'ready', 'reserved')
                          OR length(trim(COALESCE(child.condition, ''))) = 0)
                    ) THEN 'kit_verified'
                  ELSE NULL
                END AS condition
           FROM reservations r
           LEFT JOIN equipment_items ei ON ei.id = r.equipment_item_id
           LEFT JOIN equipment_kits ek ON ek.id = r.equipment_kit_id AND ek.archived_at IS NULL
          WHERE r.workspace_id = ?1 AND r.project_id = ?2 AND r.archived_at IS NULL
          ORDER BY r.id`,
      )
      .bind(input.workspaceId, input.projectId)
      .all<ReservationRow>(),
    input.db
      .prepare(
        `SELECT id, status, severity, fingerprint, version, updated_at
           FROM resource_conflicts WHERE workspace_id = ?1 AND project_id = ?2
            AND conflict_type = 'equipment'
            AND (?3 IS NULL OR shoot_day_id IS NULL OR shoot_day_id = ?3)
          ORDER BY id`,
      )
      .bind(input.workspaceId, input.projectId, input.shootDayId)
      .all<{
        id: string;
        status: string;
        severity: string;
        fingerprint: string;
        version: number;
        updated_at: number;
      }>(),
  ]);
  const unready = reservations.results.filter(
    (row) =>
      !["confirmed", "ready", "reserved"].includes(row.status) ||
      !["active", "available", "ready", "reserved"].includes(row.equipment_status ?? "") ||
      row.condition === null ||
      row.condition.trim().length === 0,
  );
  const blockers = conflicts.results.filter(
    (row) => row.severity === "blocker" && row.status === "open",
  );
  const satisfied =
    reservations.results.length > 0 && unready.length === 0 && blockers.length === 0;
  return {
    present: reservations.results.length > 0,
    satisfied,
    description: satisfied
      ? "Equipment reservations are ready, condition-recorded and free of blocking conflicts."
      : `${unready.length} reservation(s) are not ready and ${blockers.length} blocking conflict(s) remain.`,
    sourceLabel:
      reservations.results.length > 0 ? "Equipment reservations" : "No equipment reservations",
    evidence: `${reservations.results.length - unready.length} of ${reservations.results.length} reservations ready`,
    fingerprint: {
      reservations: reservations.results.map((row) => ({ ...row })),
      conflicts: conflicts.results.map((row) => ({ ...row })),
    },
  };
}

interface DepartmentResourceRow {
  readonly id: string;
  readonly category_code: string | null;
  readonly status: string;
  readonly procurement_status: string | null;
  readonly version: number;
  readonly updated_at: number;
  readonly procurement_states: string | null;
}

const DEPARTMENT_RESOURCE_CATEGORIES = [
  "props",
  "wardrobe",
  "hair_makeup",
  "hair-makeup",
  "set_dressing",
  "set-dressing",
] as const;

async function departmentResourcesObservation(
  input: ProjectReadinessContext,
): Promise<ObservationDraft> {
  const result = await input.db
    .prepare(
      `SELECT e.id, lower(ec.code) AS category_code, e.status, e.procurement_status,
              e.version, e.updated_at,
              (SELECT group_concat(pr.status, ',') FROM procurement_records pr
                WHERE pr.element_id = e.id AND pr.archived_at IS NULL) AS procurement_states
         FROM elements e JOIN element_categories ec ON ec.id = e.category_id
        WHERE e.workspace_id = ?1 AND e.project_id = ?2 AND e.archived_at IS NULL
          AND lower(ec.code) IN ('props', 'wardrobe', 'hair_makeup', 'hair-makeup', 'set_dressing', 'set-dressing')
        ORDER BY e.id`,
    )
    .bind(input.workspaceId, input.projectId)
    .all<DepartmentResourceRow>();
  const isReady = (row: DepartmentResourceRow) => {
    const procurementStates = row.procurement_states?.split(",").filter(Boolean) ?? [];
    return (
      RESOURCE_READY_STATUSES.has(row.status) &&
      RESOURCE_READY_STATUSES.has(row.procurement_status ?? "") &&
      procurementStates.every((status) => RESOURCE_READY_STATUSES.has(status))
    );
  };
  const ready = result.results.filter(isReady).length;
  const represented = new Set(result.results.map((row) => row.category_code).filter(Boolean));
  const present = result.results.length > 0 && represented.size > 0;
  return {
    present,
    satisfied: present && ready === result.results.length,
    description:
      present && ready === result.results.length
        ? "All tracked props, wardrobe, makeup and set-dressing resources are sourced and ready."
        : `${result.results.length - ready || 1} departmental resource(s) still need sourcing or readiness confirmation.`,
    sourceLabel: present ? "Departmental resource register" : "No departmental resources",
    evidence: `${ready} of ${result.results.length} tracked resource(s) ready`,
    fingerprint: {
      configuredCategories: [...DEPARTMENT_RESOURCE_CATEGORIES],
      rows: result.results.map((row) => ({ ...row })),
    },
  };
}

interface LogisticsRow {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly version: number;
  readonly updated_at: number;
}

async function logisticsObservation(input: ProjectReadinessContext): Promise<ObservationDraft> {
  const result = await input.db
    .prepare(
      `SELECT id, 'logistics' AS kind, status, version, updated_at FROM logistics_plans
        WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL
       UNION ALL
       SELECT id, 'transport' AS kind, status, version, updated_at FROM transport_plans
        WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL
       UNION ALL
       SELECT id, 'catering' AS kind, status, version, updated_at FROM catering_plans
        WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL
       UNION ALL
       SELECT id, 'travel' AS kind, status, version, updated_at FROM travel_records
        WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL
       UNION ALL
       SELECT id, 'accommodation' AS kind, status, version, updated_at FROM accommodation_records
        WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL
       ORDER BY kind, id`,
    )
    .bind(input.workspaceId, input.projectId)
    .all<LogisticsRow>();
  const requiredKinds = ["logistics", "transport", "catering"];
  const missingKinds = requiredKinds.filter(
    (kind) => !result.results.some((row) => row.kind === kind),
  );
  const unready = result.results.filter((row) => !RESOURCE_READY_STATUSES.has(row.status));
  return {
    present: result.results.length > 0,
    satisfied: missingKinds.length === 0 && unready.length === 0,
    description:
      missingKinds.length === 0 && unready.length === 0
        ? "Core logistics, transport and catering plans are ready; optional travel records are resolved."
        : `Resolve ${unready.length} unready logistics record(s) and missing plans: ${missingKinds.join(", ") || "none"}.`,
    sourceLabel: result.results.length > 0 ? "Shoot logistics plans" : "No logistics plan",
    evidence: `${result.results.length - unready.length} of ${result.results.length} logistics record(s) ready`,
    fingerprint: result.results.map((row) => ({ ...row })),
  };
}

interface ScheduleRow {
  readonly id: string;
  readonly approved_revision_id: string | null;
  readonly status: string;
  readonly version: number;
  readonly updated_at: number;
  readonly revision_status: string | null;
  readonly content_hash: string | null;
}

async function scheduleObservation(input: ProjectReadinessContext): Promise<ObservationDraft> {
  const [schedules, days, conflicts] = await Promise.all([
    input.db
      .prepare(
        `SELECT s.id, s.approved_revision_id, s.status, s.version, s.updated_at,
                sr.status AS revision_status, sr.content_hash
           FROM schedules s LEFT JOIN schedule_revisions sr ON sr.id = s.approved_revision_id
          WHERE s.workspace_id = ?1 AND s.project_id = ?2 AND s.archived_at IS NULL
          ORDER BY s.is_default DESC, s.updated_at DESC, s.id`,
      )
      .bind(input.workspaceId, input.projectId)
      .all<ScheduleRow>(),
    input.db
      .prepare(
        `SELECT id, schedule_revision_id, shoot_date, general_call_at
           FROM shoot_days WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL
            AND (?3 IS NULL OR id = ?3)
          ORDER BY shoot_date, id`,
      )
      .bind(input.workspaceId, input.projectId, input.shootDayId)
      .all<{
        id: string;
        schedule_revision_id: string | null;
        shoot_date: string | null;
        general_call_at: number | null;
      }>(),
    input.db
      .prepare(
        `SELECT id, schedule_revision_id, shoot_day_id, severity, status, fingerprint, version, updated_at
           FROM resource_conflicts WHERE workspace_id = ?1 AND project_id = ?2
            AND (?3 IS NULL OR shoot_day_id IS NULL OR shoot_day_id = ?3)
          ORDER BY id`,
      )
      .bind(input.workspaceId, input.projectId, input.shootDayId)
      .all<{
        id: string;
        schedule_revision_id: string;
        shoot_day_id: string | null;
        severity: string;
        status: string;
        fingerprint: string;
        version: number;
        updated_at: number;
      }>(),
  ]);
  const approved = schedules.results.find(
    (row) => row.approved_revision_id !== null && row.revision_status === "approved",
  );
  const validDays = days.results.filter(
    (day) =>
      day.schedule_revision_id === approved?.approved_revision_id &&
      day.shoot_date !== null &&
      day.general_call_at !== null,
  );
  const blockers = conflicts.results.filter(
    (row) => row.severity === "blocker" && row.status === "open",
  );
  const satisfied = approved !== undefined && validDays.length > 0 && blockers.length === 0;
  return {
    present: schedules.results.length > 0,
    satisfied,
    description: satisfied
      ? "An approved schedule revision has a configured shoot day and no open blocking conflicts."
      : `Approve a schedule, complete its shoot day and resolve ${blockers.length} blocking conflict(s).`,
    sourceLabel: approved ? "Approved schedule revision" : "No approved schedule",
    evidence: `${validDays.length} configured shoot day(s); ${blockers.length} blocking conflict(s)`,
    fingerprint: {
      schedules: schedules.results.map((row) => ({ ...row })),
      shootDays: days.results.map((row) => ({ ...row })),
      conflicts: conflicts.results.map((row) => ({ ...row })),
    },
  };
}

interface VisualRow {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly version: number;
  readonly updated_at: number;
}

async function visualObservation(input: ProjectReadinessContext): Promise<ObservationDraft> {
  const [plans, shots] = await Promise.all([
    input.db
      .prepare(
        `SELECT id, 'storyboard' AS kind, status, version, updated_at FROM storyboards
          WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL
         UNION ALL
         SELECT id, 'shot_list' AS kind, status, version, updated_at FROM shot_lists
          WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL
         UNION ALL
         SELECT id, 'technical_look' AS kind, status, version, updated_at FROM technical_look_plans
          WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL
         UNION ALL
         SELECT id, 'camera_setup' AS kind, status, version, updated_at FROM camera_setups
          WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL
         ORDER BY kind, id`,
      )
      .bind(input.workspaceId, input.projectId)
      .all<VisualRow>(),
    input.db
      .prepare(
        `SELECT id, status, scene_id, camera_setup_id, version, updated_at FROM shots
          WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL ORDER BY id`,
      )
      .bind(input.workspaceId, input.projectId)
      .all<{
        id: string;
        status: string;
        scene_id: string | null;
        camera_setup_id: string | null;
        version: number;
        updated_at: number;
      }>(),
  ]);
  const requiredKinds = ["storyboard", "shot_list", "technical_look", "camera_setup"];
  const approvedKinds = requiredKinds.filter((kind) =>
    plans.results.some((row) => row.kind === kind && row.status === "approved"),
  );
  const unapprovedShots = shots.results.filter(
    (row) => !["approved", "must_have", "nice_to_have"].includes(row.status),
  );
  const satisfied =
    approvedKinds.length === requiredKinds.length &&
    shots.results.length > 0 &&
    unapprovedShots.length === 0;
  return {
    present: plans.results.length > 0 || shots.results.length > 0,
    satisfied,
    description: satisfied
      ? "Storyboard, shot list, setups and technical look are approved with reviewed shots."
      : "Approve the storyboard, shot list, camera setup and technical look plan, then review every shot.",
    sourceLabel: plans.results.length > 0 ? "Visual planning approvals" : "No visual plan",
    evidence: `${approvedKinds.length} of ${requiredKinds.length} planning types approved; ${unapprovedShots.length} shot gap(s)`,
    fingerprint: {
      plans: plans.results.map((row) => ({ ...row })),
      shots: shots.results.map((row) => ({ ...row })),
    },
  };
}

interface IssueCountRow {
  readonly id: string;
  readonly kind: string;
  readonly source_revision_id: string | null;
  readonly content_hash: string;
  readonly created_at: number;
  readonly required_recipients: number;
  readonly confirmed_recipients: number;
  readonly source_current: number;
}

async function issuedDocumentsObservation(
  input: ProjectReadinessContext,
): Promise<ObservationDraft> {
  const result = await input.db
    .prepare(
      `SELECT si.id, 'sides' AS kind, si.script_revision_id AS source_revision_id,
              si.content_hash, si.created_at, 0 AS required_recipients, 0 AS confirmed_recipients,
              CASE WHEN EXISTS (
                SELECT 1 FROM screenplays s WHERE s.project_id = si.project_id
                  AND s.approved_revision_id = si.script_revision_id AND s.archived_at IS NULL
              ) THEN 1 ELSE 0 END AS source_current
         FROM sides_issues si
        WHERE si.workspace_id = ?1 AND si.project_id = ?2
       UNION ALL
       SELECT ci.id, 'call_sheet' AS kind, ci.source_schedule_revision_id AS source_revision_id,
              ci.content_hash, ci.created_at,
              (SELECT COUNT(*) FROM call_sheet_recipient_issues cri
                JOIN call_sheet_recipients cr ON cr.id = cri.call_sheet_recipient_id
               WHERE cri.call_sheet_issue_id = ci.id AND cr.required_confirmation = 1) AS required_recipients,
              (SELECT COUNT(*) FROM call_sheet_recipient_issues cri
                JOIN call_sheet_recipients cr ON cr.id = cri.call_sheet_recipient_id
               WHERE cri.call_sheet_issue_id = ci.id AND cr.required_confirmation = 1
                 AND EXISTS (SELECT 1 FROM confirmations c
                              WHERE c.call_sheet_recipient_issue_id = cri.id)) AS confirmed_recipients,
              CASE WHEN EXISTS (
                SELECT 1 FROM schedules s WHERE s.project_id = ci.project_id
                  AND s.approved_revision_id = ci.source_schedule_revision_id AND s.archived_at IS NULL
              ) THEN 1 ELSE 0 END AS source_current
         FROM call_sheet_issues ci
        WHERE ci.workspace_id = ?1 AND ci.project_id = ?2
          AND (?3 IS NULL OR ci.shoot_day_id = ?3)
       UNION ALL
       SELECT ppi.id, 'production_pack' AS kind, NULL AS source_revision_id,
              ppi.manifest_hash AS content_hash, ppi.created_at,
              0 AS required_recipients, 0 AS confirmed_recipients, 1 AS source_current
         FROM production_pack_issues ppi
        WHERE ppi.workspace_id = ?1 AND ppi.project_id = ?2
       ORDER BY kind, created_at DESC, id DESC`,
    )
    .bind(input.workspaceId, input.projectId, input.shootDayId)
    .all<IssueCountRow>();
  const latest = (kind: string) => result.results.find((row) => row.kind === kind);
  const sides = latest("sides");
  const callSheet = latest("call_sheet");
  const pack = latest("production_pack");
  const callConfirmed =
    callSheet !== undefined &&
    callSheet.source_current === 1 &&
    callSheet.required_recipients > 0 &&
    callSheet.confirmed_recipients === callSheet.required_recipients;
  const satisfied =
    sides?.source_current === 1 &&
    /^[0-9a-f]{64}$/u.test(sides.content_hash) &&
    callConfirmed &&
    /^[0-9a-f]{64}$/u.test(callSheet?.content_hash ?? "") &&
    pack !== undefined &&
    /^[0-9a-f]{64}$/u.test(pack.content_hash);
  return {
    present: result.results.length > 0,
    satisfied,
    description: satisfied
      ? "Sides, a fully confirmed call sheet and a production pack are issued."
      : "Issue sides, confirm every required call-sheet recipient and issue the production pack.",
    sourceLabel:
      result.results.length > 0 ? "Immutable issued documents" : "No issued production documents",
    evidence: `${sides ? 1 : 0}/1 sides; ${callSheet?.confirmed_recipients ?? 0}/${callSheet?.required_recipients ?? 0} confirmations; ${pack ? 1 : 0}/1 pack`,
    fingerprint: result.results.map((row) => ({ ...row })),
  };
}

interface ArchiveRow {
  readonly snapshot_id: string;
  readonly snapshot_state: string;
  readonly manifest_hash: string | null;
  readonly content_hash: string | null;
  readonly completed_at: number | null;
  readonly archive_job_id: string | null;
  readonly archive_status: string | null;
  readonly verified_at: number | null;
  readonly updated_at: number | null;
}

async function archiveObservation(input: ProjectReadinessContext): Promise<ObservationDraft> {
  const result = await input.db
    .prepare(
      `SELECT es.id AS snapshot_id, es.state AS snapshot_state, es.manifest_hash,
              es.content_hash, es.completed_at, aj.id AS archive_job_id,
              aj.status AS archive_status, aj.verified_at, aj.updated_at
         FROM export_snapshots es
         LEFT JOIN archive_jobs aj ON aj.export_snapshot_id = es.id
        WHERE es.workspace_id = ?1 AND es.project_id = ?2
        ORDER BY es.created_at DESC, aj.created_at DESC, es.id DESC LIMIT 1`,
    )
    .bind(input.workspaceId, input.projectId)
    .all<ArchiveRow>();
  const row = result.results[0];
  const validHash = (value: string | null | undefined) => /^[0-9a-f]{64}$/u.test(value ?? "");
  const snapshotHealthy =
    row?.snapshot_state === "complete" &&
    validHash(row.manifest_hash) &&
    validHash(row.content_hash) &&
    row.completed_at !== null;
  const archiveHealthy = row?.archive_job_id === null || row?.archive_status === "verified";
  const satisfied = snapshotHealthy && archiveHealthy;
  return {
    present: row !== undefined,
    satisfied,
    description: satisfied
      ? row?.archive_status === "verified"
        ? "The complete export snapshot and NAS archive are checksum-verified."
        : "The complete export snapshot is healthy; no NAS archive has failed or remains unverified."
      : "Create a complete checksummed export and resolve any requested, failed or unverified archive job.",
    sourceLabel: row ? "Latest project export/archive" : "No complete project export",
    evidence: row
      ? `Export ${row.snapshot_state}; archive ${row.archive_status ?? "not requested"}`
      : null,
    fingerprint: row ? { ...row } : { snapshot: null },
  };
}

interface WorkspaceSecurityRow {
  readonly active_users: number;
  readonly credentialed_users: number;
  readonly active_memberships: number;
  readonly owner_users: number;
  readonly producer_users: number;
  readonly viewer_users: number;
  readonly role_mismatches: number;
  readonly identity_watermark: number;
  readonly membership_watermark: number;
}

async function workspaceSecurityObservation(
  input: ProjectReadinessContext,
): Promise<ObservationDraft> {
  const row = await input.db
    .prepare(
      `SELECT
          (SELECT COUNT(*) FROM user_identities u
            WHERE u.workspace_id = ?1 AND u.status = 'active' AND u.archived_at IS NULL) AS active_users,
          (SELECT COUNT(*) FROM user_identities u
            WHERE u.workspace_id = ?1 AND u.status = 'active' AND u.archived_at IS NULL
              AND EXISTS (
                SELECT 1 FROM password_credentials pc
                 WHERE pc.id = u.current_password_credential_id
                   AND pc.workspace_id = u.workspace_id AND pc.user_id = u.id
              )) AS credentialed_users,
          (SELECT COUNT(*) FROM workspace_memberships wm
            WHERE wm.workspace_id = ?1 AND wm.status = 'active' AND wm.archived_at IS NULL) AS active_memberships,
          (SELECT COUNT(*) FROM user_identities u
            WHERE u.workspace_id = ?1 AND u.status = 'active' AND u.archived_at IS NULL
              AND u.role = 'workspace_owner') AS owner_users,
          (SELECT COUNT(*) FROM user_identities u
            WHERE u.workspace_id = ?1 AND u.status = 'active' AND u.archived_at IS NULL
              AND u.role = 'producer') AS producer_users,
          (SELECT COUNT(*) FROM user_identities u
            WHERE u.workspace_id = ?1 AND u.status = 'active' AND u.archived_at IS NULL
              AND u.access_mode = 'viewer') AS viewer_users,
          (SELECT COUNT(*) FROM workspace_memberships wm
            JOIN user_identities u ON u.id = wm.user_id AND u.workspace_id = wm.workspace_id
            WHERE wm.workspace_id = ?1 AND wm.status = 'active' AND wm.archived_at IS NULL
              AND wm.role <> u.role) AS role_mismatches,
          COALESCE((SELECT MAX(updated_at) FROM user_identities u WHERE u.workspace_id = ?1), 0) AS identity_watermark,
          COALESCE((SELECT MAX(updated_at) FROM workspace_memberships wm WHERE wm.workspace_id = ?1), 0) AS membership_watermark`,
    )
    .bind(input.workspaceId)
    .first<WorkspaceSecurityRow>();
  const satisfied =
    row !== null &&
    row.active_users === 3 &&
    row.credentialed_users === 3 &&
    row.active_memberships === 3 &&
    row.owner_users === 1 &&
    row.producer_users === 2 &&
    row.viewer_users === 1 &&
    row.role_mismatches === 0;
  return {
    present: row !== null,
    satisfied,
    description: satisfied
      ? "Exactly three credentialed active accounts share the workspace: one owner, one producer and one view-only guest."
      : "Workspace security requires exactly three credentialed active accounts: one owner, one producer and one view-only guest.",
    sourceLabel: "Workspace identity boundary",
    evidence: row
      ? `${row.active_users} active account(s), ${row.owner_users} owner(s), ${row.producer_users - row.viewer_users} editing producer(s), ${row.viewer_users} viewer(s)`
      : null,
    fingerprint: row ? { ...row } : { workspace: "unavailable" },
  };
}
