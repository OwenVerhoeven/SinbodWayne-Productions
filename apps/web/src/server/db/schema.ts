import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const utcMs = (name: string) => integer(name);
const jsonText = (name: string) => text(name);

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  companyName: text("company_name").notNull(),
  timezone: text("timezone").notNull(),
  locale: text("locale").notNull(),
  currency: text("currency").notNull(),
  unitSystem: text("unit_system").notNull(),
  paperSize: text("paper_size").notNull(),
  retentionSettingsJson: jsonText("retention_settings_json").notNull(),
  version: integer("version").notNull(),
  archivedAt: utcMs("archived_at"),
  createdAt: utcMs("created_at").notNull(),
  updatedAt: utcMs("updated_at").notNull(),
});

export const userIdentities = sqliteTable(
  "user_identities",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    username: text("username", { mode: "text" }).notNull(),
    displayName: text("display_name").notNull(),
    role: text("role", { enum: ["workspace_owner", "producer"] }).notNull(),
    status: text("status", { enum: ["active", "suspended", "archived"] }).notNull(),
    authEpoch: integer("auth_epoch").notNull(),
    currentPasswordCredentialId: text("current_password_credential_id"),
    failedLoginCount: integer("failed_login_count").notNull(),
    backoffUntil: utcMs("backoff_until"),
    version: integer("version").notNull(),
    archivedAt: utcMs("archived_at"),
    createdAt: utcMs("created_at").notNull(),
    updatedAt: utcMs("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("user_identities_workspace_username_idx").on(table.workspaceId, table.username),
  ],
);

export const passwordCredentials = sqliteTable(
  "password_credentials",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => userIdentities.id, { onDelete: "restrict" }),
    kdf: text("kdf", { enum: ["argon2id", "scrypt", "pbkdf2-sha256"] }).notNull(),
    parametersJson: jsonText("parameters_json").notNull(),
    encodedHash: text("encoded_hash").notNull(),
    createdAt: utcMs("created_at").notNull(),
    supersededAt: utcMs("superseded_at"),
  },
  (table) => [
    index("password_credentials_workspace_user_idx").on(
      table.workspaceId,
      table.userId,
      table.createdAt,
    ),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => userIdentities.id, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull().unique(),
    csrfHash: text("csrf_hash").notNull(),
    authEpoch: integer("auth_epoch").notNull(),
    deviceLabel: text("device_label"),
    userAgentSummary: text("user_agent_summary"),
    ipHash: text("ip_hash"),
    createdAt: utcMs("created_at").notNull(),
    lastSeenAt: utcMs("last_seen_at").notNull(),
    idleExpiresAt: utcMs("idle_expires_at").notNull(),
    absoluteExpiresAt: utcMs("absolute_expires_at").notNull(),
    revokedAt: utcMs("revoked_at"),
    revokedByUserId: text("revoked_by_user_id").references(() => userIdentities.id, {
      onDelete: "restrict",
    }),
    revokeReason: text("revoke_reason"),
  },
  (table) => [
    index("sessions_user_active_idx").on(
      table.workspaceId,
      table.userId,
      table.revokedAt,
      table.absoluteExpiresAt,
    ),
  ],
);

export const workspaceMemberships = sqliteTable(
  "workspace_memberships",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => userIdentities.id, { onDelete: "restrict" }),
    role: text("role", { enum: ["workspace_owner", "producer"] }).notNull(),
    status: text("status", { enum: ["active", "suspended", "archived"] }).notNull(),
    version: integer("version").notNull(),
    createdAt: utcMs("created_at").notNull(),
    updatedAt: utcMs("updated_at").notNull(),
    archivedAt: utcMs("archived_at"),
  },
  (table) => [
    uniqueIndex("workspace_memberships_workspace_user_idx").on(table.workspaceId, table.userId),
  ],
);

export const permissionGrants = sqliteTable("permission_grants", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "restrict" }),
  userId: text("user_id")
    .notNull()
    .references(() => userIdentities.id, { onDelete: "restrict" }),
  projectId: text("project_id"),
  module: text("module"),
  objectType: text("object_type"),
  objectId: text("object_id"),
  action: text("action").notNull(),
  fieldScope: text("field_scope"),
  effect: text("effect", { enum: ["allow", "deny"] }).notNull(),
  grantedByUserId: text("granted_by_user_id")
    .notNull()
    .references(() => userIdentities.id, { onDelete: "restrict" }),
  expiresAt: utcMs("expires_at"),
  revokedAt: utcMs("revoked_at"),
  createdAt: utcMs("created_at").notNull(),
});

export const shareLinks = sqliteTable("share_links", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "restrict" }),
  projectId: text("project_id"),
  publicLocator: text("public_locator").notNull().unique(),
  secretDigest: text("secret_digest").notNull().unique(),
  purpose: text("purpose").notNull(),
  objectType: text("object_type").notNull(),
  objectId: text("object_id").notNull(),
  allowedActionsJson: jsonText("allowed_actions_json").notNull(),
  fieldProjectionJson: jsonText("field_projection_json").notNull(),
  createdByUserId: text("created_by_user_id")
    .notNull()
    .references(() => userIdentities.id, { onDelete: "restrict" }),
  expiresAt: utcMs("expires_at").notNull(),
  revokedAt: utcMs("revoked_at"),
  lastUsedAt: utcMs("last_used_at"),
  createdAt: utcMs("created_at").notNull(),
});

export const serviceCredentials = sqliteTable("service_credentials", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  secretDigest: text("secret_digest").notNull().unique(),
  scopesJson: jsonText("scopes_json").notNull(),
  expiresAt: utcMs("expires_at"),
  rotatedAt: utcMs("rotated_at"),
  revokedAt: utcMs("revoked_at"),
  createdByUserId: text("created_by_user_id")
    .notNull()
    .references(() => userIdentities.id, { onDelete: "restrict" }),
  createdAt: utcMs("created_at").notNull(),
});

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    projectId: text("project_id"),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    objectType: text("object_type"),
    objectId: text("object_id"),
    requestId: text("request_id"),
    ipPrefix: text("ip_prefix"),
    metadataJson: jsonText("metadata_json").notNull(),
    createdAt: utcMs("created_at").notNull(),
  },
  (table) => [
    index("audit_events_workspace_cursor_idx").on(table.workspaceId, table.createdAt, table.id),
  ],
);

export const notifications = sqliteTable("notifications", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "restrict" }),
  projectId: text("project_id"),
  recipientUserId: text("recipient_user_id")
    .notNull()
    .references(() => userIdentities.id, { onDelete: "restrict" }),
  type: text("type").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  objectType: text("object_type"),
  objectId: text("object_id"),
  createdAt: utcMs("created_at").notNull(),
  readAt: utcMs("read_at"),
  archivedAt: utcMs("archived_at"),
});

export const idempotencyRecords = sqliteTable(
  "idempotency_records",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    actorFingerprint: text("actor_fingerprint").notNull(),
    operation: text("operation").notNull(),
    idempotencyKeyDigest: text("idempotency_key_digest").notNull(),
    requestHash: text("request_hash").notNull(),
    responseStatus: integer("response_status"),
    responseRef: text("response_ref"),
    state: text("state", { enum: ["running", "completed", "failed"] }).notNull(),
    expiresAt: utcMs("expires_at").notNull(),
    createdAt: utcMs("created_at").notNull(),
    updatedAt: utcMs("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("idempotency_records_scope_key_idx").on(
      table.workspaceId,
      table.actorFingerprint,
      table.operation,
      table.idempotencyKeyDigest,
    ),
  ],
);

export const loginAttempts = sqliteTable("login_attempts", {
  keyHash: text("key_hash").primaryKey(),
  failCount: integer("fail_count").notNull(),
  blockedUntil: utcMs("blocked_until"),
  updatedAt: utcMs("updated_at").notNull(),
});

export const optimisticMutationGuards = sqliteTable("optimistic_mutation_guards", {
  id: text("id").primaryKey(),
  expectedVersion: integer("expected_version").notNull(),
  actualVersion: integer("actual_version").notNull(),
  createdAt: utcMs("created_at").notNull(),
});

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    seriesId: text("series_id"),
    seasonId: text("season_id"),
    title: text("title").notNull(),
    workingTitle: text("working_title"),
    code: text("code").notNull(),
    type: text("type").notNull(),
    phase: text("phase").notNull(),
    status: text("status").notNull(),
    company: text("company").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => userIdentities.id, { onDelete: "restrict" }),
    logline: text("logline"),
    targetRuntimeMs: integer("target_runtime_ms"),
    aspectRatio: text("aspect_ratio"),
    resolution: text("resolution"),
    frameRateNumerator: integer("frame_rate_numerator").notNull(),
    frameRateDenominator: integer("frame_rate_denominator").notNull(),
    dropFrame: integer("drop_frame").notNull(),
    timezone: text("timezone").notNull(),
    locale: text("locale").notNull(),
    currency: text("currency").notNull(),
    unitSystem: text("unit_system").notNull(),
    paperSize: text("paper_size").notNull(),
    enabledModulesJson: jsonText("enabled_modules_json").notNull(),
    readinessState: text("readiness_state").notNull(),
    readinessScore: integer("readiness_score").notNull(),
    version: integer("version").notNull(),
    archivedAt: utcMs("archived_at"),
    createdAt: utcMs("created_at").notNull(),
    updatedAt: utcMs("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("projects_workspace_code_idx").on(table.workspaceId, table.code),
    index("projects_workspace_cursor_idx").on(
      table.workspaceId,
      table.archivedAt,
      table.updatedAt,
      table.id,
    ),
  ],
);

export const projectMemberships = sqliteTable(
  "project_memberships",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => userIdentities.id, { onDelete: "restrict" }),
    role: text("role", { enum: ["owner", "producer"] }).notNull(),
    status: text("status", { enum: ["active", "archived"] }).notNull(),
    version: integer("version").notNull(),
    createdAt: utcMs("created_at").notNull(),
    updatedAt: utcMs("updated_at").notNull(),
    archivedAt: utcMs("archived_at"),
  },
  (table) => [
    uniqueIndex("project_memberships_project_user_idx").on(table.projectId, table.userId),
  ],
);

export const objectRegistry = sqliteTable(
  "object_registry",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "restrict" }),
    objectType: text("object_type").notNull(),
    domainTable: text("domain_table").notNull(),
    domainId: text("domain_id").notNull(),
    title: text("title"),
    version: integer("version").notNull(),
    archivedAt: utcMs("archived_at"),
    createdAt: utcMs("created_at").notNull(),
    updatedAt: utcMs("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("object_registry_domain_idx").on(table.domainTable, table.domainId),
    index("object_registry_tenant_type_idx").on(
      table.workspaceId,
      table.projectId,
      table.objectType,
      table.archivedAt,
      table.updatedAt,
      table.id,
    ),
  ],
);

export const objectLinks = sqliteTable(
  "object_links",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    projectId: text("project_id").references(() => projects.id, { onDelete: "restrict" }),
    sourceObjectId: text("source_object_id")
      .notNull()
      .references(() => objectRegistry.id, { onDelete: "restrict" }),
    targetObjectId: text("target_object_id")
      .notNull()
      .references(() => objectRegistry.id, { onDelete: "restrict" }),
    relationType: text("relation_type").notNull(),
    sortRank: text("sort_rank").notNull(),
    metadataJson: jsonText("metadata_json").notNull(),
    createdByUserId: text("created_by_user_id").references(() => userIdentities.id, {
      onDelete: "restrict",
    }),
    createdAt: utcMs("created_at").notNull(),
    archivedAt: utcMs("archived_at"),
  },
  (table) => [
    uniqueIndex("object_links_relation_idx").on(
      table.sourceObjectId,
      table.targetObjectId,
      table.relationType,
    ),
  ],
);

function projectRecordColumns() {
  return {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    status: text("status").notNull(),
    summary: text("summary"),
    ownerUserId: text("owner_user_id").references(() => userIdentities.id, {
      onDelete: "restrict",
    }),
    sortRank: text("sort_rank").notNull(),
    detailsJson: jsonText("details_json").notNull(),
    createdBy: text("created_by").references(() => userIdentities.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    archivedAt: utcMs("archived_at"),
    createdAt: utcMs("created_at").notNull(),
    updatedAt: utcMs("updated_at").notNull(),
  };
}

export const ideas = sqliteTable("ideas", {
  ...projectRecordColumns(),
  type: text("type"),
  source: text("source"),
  promotedAt: utcMs("promoted_at"),
});
export const projectBriefs = sqliteTable("project_briefs", {
  ...projectRecordColumns(),
  purpose: text("purpose"),
  creativeIntent: text("creative_intent"),
  targetAudience: text("target_audience"),
  currency: text("currency").notNull(),
  currentRevisionId: text("current_revision_id"),
});
export const developmentDocuments = sqliteTable("development_documents", {
  ...projectRecordColumns(),
  documentType: text("document_type").notNull(),
  currentRevisionId: text("current_revision_id"),
});
export const lookbooks = sqliteTable("lookbooks", {
  ...projectRecordColumns(),
  kind: text("kind").notNull(),
});
export const avScripts = sqliteTable("av_scripts", {
  ...projectRecordColumns(),
  templateKind: text("template_kind").notNull(),
  frameRateNumerator: integer("frame_rate_numerator").notNull(),
  frameRateDenominator: integer("frame_rate_denominator").notNull(),
  currentRevisionId: text("current_revision_id"),
});
export const documents = sqliteTable("documents", {
  ...projectRecordColumns(),
  folderId: text("folder_id"),
  documentType: text("document_type").notNull(),
  currentRevisionId: text("current_revision_id"),
});
export const sceneBreakdowns = sqliteTable("scene_breakdowns", {
  ...projectRecordColumns(),
  sceneId: text("scene_id"),
  sourceSceneRevisionId: text("source_scene_revision_id"),
  pageEighths: integer("page_eighths").notNull(),
  readinessState: text("readiness_state").notNull(),
});
export const elements = sqliteTable("elements", {
  ...projectRecordColumns(),
  categoryId: text("category_id"),
  quantity: integer("quantity").notNull(),
  costMinor: integer("cost_minor"),
  currency: text("currency"),
});
export const reportDefinitions = sqliteTable("report_definitions", {
  ...projectRecordColumns(),
  reportType: text("report_type").notNull(),
  configurationJson: jsonText("configuration_json").notNull(),
});
export const boards = sqliteTable("boards", {
  ...projectRecordColumns(),
  boardType: text("board_type").notNull(),
  layout: text("layout").notNull(),
});
export const storyboards = sqliteTable("storyboards", {
  ...projectRecordColumns(),
  groupingMode: text("grouping_mode").notNull(),
});
export const shotLists = sqliteTable("shot_lists", {
  ...projectRecordColumns(),
  groupingMode: text("grouping_mode").notNull(),
});
export const technicalLookPlans = sqliteTable("technical_look_plans", {
  ...projectRecordColumns(),
  frameRateNumerator: integer("frame_rate_numerator").notNull(),
  frameRateDenominator: integer("frame_rate_denominator").notNull(),
  currentRevisionId: text("current_revision_id"),
});
export const people = sqliteTable("people", {
  ...projectRecordColumns(),
  givenName: text("given_name"),
  familyName: text("family_name"),
  pronouns: text("pronouns"),
  consentStatus: text("consent_status").notNull(),
});
export const castingRoles = sqliteTable("casting_roles", {
  ...projectRecordColumns(),
  characterId: text("character_id"),
  playingAge: text("playing_age"),
  requiredSkills: text("required_skills"),
});
export const locations = sqliteTable("locations", {
  ...projectRecordColumns(),
  addressJson: jsonText("address_json").notNull(),
  latitude: real("latitude"),
  longitude: real("longitude"),
  timezone: text("timezone").notNull(),
  feeMinor: integer("fee_minor"),
  currency: text("currency").notNull(),
  readinessState: text("approval_state").notNull(),
});
export const budgets = sqliteTable("budgets", {
  ...projectRecordColumns(),
  currency: text("currency").notNull(),
  workingVersionId: text("working_version_id"),
  approvedVersionId: text("approved_version_id"),
});
export const requirements = sqliteTable("requirements", {
  ...projectRecordColumns(),
  requirementType: text("requirement_type").notNull(),
  dueAt: utcMs("due_at"),
  expiresAt: utcMs("expires_at"),
  isBlocking: integer("is_blocking").notNull(),
  currentFileVersionId: text("current_file_version_id"),
});
export const equipmentItems = sqliteTable("equipment_items", {
  ...projectRecordColumns(),
  ownershipType: text("ownership_type").notNull(),
  category: text("category").notNull(),
  serialAssetId: text("serial_asset_id"),
  valueMinor: integer("value_minor"),
  currency: text("currency"),
});
export const logisticsPlans = sqliteTable("logistics_plans", {
  ...projectRecordColumns(),
  baseCamp: text("base_camp"),
  holding: text("holding"),
  emergencyNotes: text("emergency_notes"),
});
export const taskCards = sqliteTable("task_cards", {
  ...projectRecordColumns(),
  taskBoardId: text("task_board_id"),
  taskColumnId: text("task_column_id"),
  linkedObjectId: text("linked_object_id"),
  priority: text("priority").notNull(),
  startsAt: utcMs("starts_at"),
  dueAt: utcMs("due_at"),
  isBlocking: integer("is_blocking").notNull(),
});
export const calendarEvents = sqliteTable("calendar_events", {
  ...projectRecordColumns(),
  calendarId: text("calendar_id"),
  linkedObjectId: text("linked_object_id"),
  eventType: text("event_type").notNull(),
  startsAt: utcMs("starts_at"),
  endsAt: utcMs("ends_at"),
  timezone: text("timezone").notNull(),
  icsUid: text("ics_uid"),
  icsSequence: integer("ics_sequence").notNull(),
});
export const schedules = sqliteTable("schedules", {
  ...projectRecordColumns(),
  isDefault: integer("is_default").notNull(),
  currentRevisionId: text("current_revision_id"),
  approvedRevisionId: text("approved_revision_id"),
});
export const shootDays = sqliteTable("shoot_days", {
  ...projectRecordColumns(),
  scheduleRevisionId: text("schedule_revision_id"),
  shootDate: text("shoot_date"),
  unit: text("unit").notNull(),
  dayCount: integer("day_count").notNull(),
  timezone: text("timezone").notNull(),
  readinessState: text("readiness_state").notNull(),
});
export const messages = sqliteTable("messages", {
  ...projectRecordColumns(),
  messageType: text("message_type").notNull(),
  senderUserId: text("sender_user_id"),
  body: text("body").notNull(),
  provider: text("provider"),
});
export const callSheetDrafts = sqliteTable("call_sheet_drafts", {
  ...projectRecordColumns(),
  shootDayId: text("shoot_day_id"),
  sourceScheduleRevisionId: text("source_schedule_revision_id"),
  callSheetType: text("call_sheet_type").notNull(),
  timezone: text("timezone").notNull(),
  paperSize: text("paper_size").notNull(),
  layout: text("layout").notNull(),
});
export const productionPackDrafts = sqliteTable("production_pack_drafts", {
  ...projectRecordColumns(),
  shootDayId: text("shoot_day_id"),
  paperSize: text("paper_size").notNull(),
  confidentialityMarking: text("confidentiality_marking"),
});

export const approvals = sqliteTable("approvals", {
  ...projectRecordColumns(),
  objectId: text("object_id")
    .notNull()
    .references(() => objectRegistry.id, { onDelete: "restrict" }),
  approverUserId: text("approver_user_id"),
  pinnedVersionId: text("pinned_version_id"),
  requestedAt: utcMs("requested_at").notNull(),
  dueAt: utcMs("due_at"),
});
export const approvalDecisions = sqliteTable("approval_decisions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  approvalId: text("approval_id")
    .notNull()
    .references(() => approvals.id, { onDelete: "restrict" }),
  decision: text("decision").notNull(),
  actorUserId: text("actor_user_id"),
  shareLinkId: text("share_link_id").references(() => shareLinks.id, { onDelete: "restrict" }),
  actorLabel: text("actor_label"),
  comment: text("comment"),
  pinnedVersionId: text("pinned_version_id"),
  createdAt: utcMs("created_at").notNull(),
});

export const screenplays = sqliteTable("screenplays", {
  ...projectRecordColumns(),
  currentDraftId: text("current_draft_id"),
  currentRevisionId: text("current_revision_id"),
  approvedRevisionId: text("approved_revision_id"),
  numberingLocked: integer("numbering_locked").notNull(),
  frameRateNumerator: integer("frame_rate_numerator").notNull(),
  frameRateDenominator: integer("frame_rate_denominator").notNull(),
});
export const scriptDrafts = sqliteTable("script_drafts", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  screenplayId: text("screenplay_id")
    .notNull()
    .references(() => screenplays.id, { onDelete: "restrict" }),
  title: text("title").notNull(),
  autosaveState: text("autosave_state").notNull(),
  baseRevisionId: text("base_revision_id"),
  version: integer("version").notNull(),
  createdAt: utcMs("created_at").notNull(),
  updatedAt: utcMs("updated_at").notNull(),
});
export const scriptDraftBlocks = sqliteTable("script_draft_blocks", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  screenplayId: text("screenplay_id").notNull(),
  draftId: text("draft_id")
    .notNull()
    .references(() => scriptDrafts.id, { onDelete: "cascade" }),
  blockType: text("block_type").notNull(),
  textContent: text("text_content").notNull(),
  attributesJson: jsonText("attributes_json").notNull(),
  sortRank: text("sort_rank").notNull(),
  version: integer("version").notNull(),
  archivedAt: utcMs("archived_at"),
  createdAt: utcMs("created_at").notNull(),
  updatedAt: utcMs("updated_at").notNull(),
});
export const scriptRevisions = sqliteTable("script_revisions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  screenplayId: text("screenplay_id")
    .notNull()
    .references(() => screenplays.id, { onDelete: "restrict" }),
  revisionNumber: integer("revision_number").notNull(),
  name: text("name").notNull(),
  revisionColor: text("revision_color"),
  notes: text("notes"),
  contentHash: text("content_hash").notNull(),
  authorUserId: text("author_user_id").notNull(),
  createdAt: utcMs("created_at").notNull(),
});
export const scenes = sqliteTable("scenes", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  screenplayId: text("screenplay_id")
    .notNull()
    .references(() => screenplays.id, { onDelete: "restrict" }),
  displayNumber: text("display_number").notNull(),
  lockedNumberKey: text("locked_number_key"),
  currentSceneRevisionId: text("current_scene_revision_id"),
  slugline: text("slugline").notNull(),
  synopsis: text("synopsis"),
  pageEighths: integer("page_eighths").notNull(),
  sortRank: text("sort_rank").notNull(),
  omitted: integer("omitted").notNull(),
  version: integer("version").notNull(),
  archivedAt: utcMs("archived_at"),
  createdAt: utcMs("created_at").notNull(),
  updatedAt: utcMs("updated_at").notNull(),
});
export const sceneRevisions = sqliteTable("scene_revisions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  sceneId: text("scene_id")
    .notNull()
    .references(() => scenes.id, { onDelete: "restrict" }),
  scriptRevisionId: text("script_revision_id")
    .notNull()
    .references(() => scriptRevisions.id, { onDelete: "restrict" }),
  sourceStartBlockId: text("source_start_block_id").notNull(),
  sourceEndBlockId: text("source_end_block_id").notNull(),
  displayNumber: text("display_number").notNull(),
  slugline: text("slugline").notNull(),
  pageEighths: integer("page_eighths").notNull(),
  sortRank: text("sort_rank").notNull(),
  contentHash: text("content_hash").notNull(),
  createdAt: utcMs("created_at").notNull(),
});
export const scriptSyncs = sqliteTable("script_syncs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  screenplayId: text("screenplay_id").notNull(),
  fromRevisionId: text("from_revision_id"),
  toRevisionId: text("to_revision_id").notNull(),
  status: text("status").notNull(),
  impactSummaryJson: jsonText("impact_summary_json").notNull(),
  mappingHash: text("mapping_hash").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  appliedByUserId: text("applied_by_user_id"),
  appliedAt: utcMs("applied_at"),
  version: integer("version").notNull(),
  createdAt: utcMs("created_at").notNull(),
  updatedAt: utcMs("updated_at").notNull(),
});
export const sceneMappings = sqliteTable("scene_mappings", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  scriptSyncId: text("script_sync_id")
    .notNull()
    .references(() => scriptSyncs.id, { onDelete: "restrict" }),
  priorSceneId: text("prior_scene_id"),
  candidateSceneRevisionId: text("candidate_scene_revision_id"),
  mappingKind: text("mapping_kind").notNull(),
  confidenceBasisJson: jsonText("confidence_basis_json").notNull(),
  resolution: text("resolution"),
  resolvedSceneId: text("resolved_scene_id"),
  resolvedByUserId: text("resolved_by_user_id"),
  resolvedAt: utcMs("resolved_at"),
  version: integer("version").notNull(),
  createdAt: utcMs("created_at").notNull(),
  updatedAt: utcMs("updated_at").notNull(),
});

export const folders = sqliteTable("folders", {
  ...projectRecordColumns(),
  parentFolderId: text("parent_folder_id"),
  logicalCode: text("logical_code"),
});
export const files = sqliteTable("files", {
  ...projectRecordColumns(),
  folderId: text("folder_id").references(() => folders.id, { onDelete: "restrict" }),
  safeDisplayName: text("safe_display_name").notNull(),
  currentVersionId: text("current_version_id"),
  provenance: text("provenance"),
  retentionClass: text("retention_class"),
  retentionReviewAt: utcMs("retention_review_at"),
  isFavorite: integer("is_favorite").notNull(),
});
export const fileVersions = sqliteTable("file_versions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  fileId: text("file_id")
    .notNull()
    .references(() => files.id, { onDelete: "restrict" }),
  versionNumber: integer("version_number").notNull(),
  originalName: text("original_name").notNull(),
  safeDisplayName: text("safe_display_name").notNull(),
  objectKey: text("object_key").notNull().unique(),
  byteSize: integer("byte_size").notNull(),
  mimeType: text("mime_type").notNull(),
  sha256: text("sha256").notNull(),
  uploaderUserId: text("uploader_user_id").notNull(),
  provenance: text("provenance"),
  scanState: text("scan_state").notNull(),
  scanEvidenceJson: jsonText("scan_evidence_json").notNull(),
  retentionClass: text("retention_class"),
  createdAt: utcMs("created_at").notNull(),
});
export const fileLinks = sqliteTable("file_links", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  fileId: text("file_id")
    .notNull()
    .references(() => files.id, { onDelete: "restrict" }),
  objectId: text("object_id")
    .notNull()
    .references(() => objectRegistry.id, { onDelete: "restrict" }),
  purpose: text("purpose").notNull(),
  pinnedFileVersionId: text("pinned_file_version_id"),
  sortRank: text("sort_rank").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  archivedAt: utcMs("archived_at"),
  createdAt: utcMs("created_at").notNull(),
});
export const uploadSessions = sqliteTable("upload_sessions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  fileId: text("file_id"),
  objectKey: text("object_key").notNull().unique(),
  intendedName: text("intended_name").notNull(),
  intendedMimeType: text("intended_mime_type").notNull(),
  intendedByteSize: integer("intended_byte_size").notNull(),
  intendedSha256: text("intended_sha256"),
  allowedTypesJson: jsonText("allowed_types_json").notNull(),
  uploadMode: text("upload_mode").notNull(),
  state: text("state").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  expiresAt: utcMs("expires_at").notNull(),
  completedFileVersionId: text("completed_file_version_id"),
  errorCode: text("error_code"),
  createdAt: utcMs("created_at").notNull(),
  updatedAt: utcMs("updated_at").notNull(),
});

export const scheduleRevisions = sqliteTable("schedule_revisions", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  scheduleId: text("schedule_id")
    .notNull()
    .references(() => schedules.id, { onDelete: "restrict" }),
  revisionNumber: integer("revision_number").notNull(),
  name: text("name").notNull(),
  sourceScriptRevisionId: text("source_script_revision_id"),
  status: text("status").notNull(),
  contentHash: text("content_hash").notNull(),
  totalsJson: jsonText("totals_json").notNull(),
  authorUserId: text("author_user_id").notNull(),
  createdAt: utcMs("created_at").notNull(),
});
export const scheduleItems = sqliteTable("schedule_items", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  scheduleRevisionId: text("schedule_revision_id")
    .notNull()
    .references(() => scheduleRevisions.id, { onDelete: "restrict" }),
  itemType: text("item_type").notNull(),
  sceneId: text("scene_id"),
  sceneSegmentId: text("scene_segment_id"),
  title: text("title"),
  shootDate: text("shoot_date"),
  unit: text("unit"),
  dayCount: integer("day_count"),
  pageEighths: integer("page_eighths").notNull(),
  prepDurationMs: integer("prep_duration_ms").notNull(),
  setupDurationMs: integer("setup_duration_ms").notNull(),
  shootDurationMs: integer("shoot_duration_ms").notNull(),
  moveDurationMs: integer("move_duration_ms").notNull(),
  detailsJson: jsonText("details_json").notNull(),
  sortRank: text("sort_rank").notNull(),
  createdAt: utcMs("created_at").notNull(),
});
export const resourceConflicts = sqliteTable("resource_conflicts", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  scheduleRevisionId: text("schedule_revision_id").notNull(),
  shootDayId: text("shoot_day_id"),
  conflictType: text("conflict_type").notNull(),
  severity: text("severity").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  title: text("title").notNull(),
  evidenceJson: jsonText("evidence_json").notNull(),
  status: text("status").notNull(),
  fingerprint: text("fingerprint").notNull(),
  detectedAt: utcMs("detected_at").notNull(),
  version: integer("version").notNull(),
  updatedAt: utcMs("updated_at").notNull(),
});

export const readinessProfiles = sqliteTable("readiness_profiles", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id"),
  title: text("title").notNull(),
  status: text("status").notNull(),
  summary: text("summary"),
  ownerUserId: text("owner_user_id"),
  sortRank: text("sort_rank").notNull(),
  projectType: text("project_type"),
  currentVersionId: text("current_version_id"),
  detailsJson: jsonText("details_json").notNull(),
  version: integer("version").notNull(),
  archivedAt: utcMs("archived_at"),
  createdAt: utcMs("created_at").notNull(),
  updatedAt: utcMs("updated_at").notNull(),
});
export const readinessRules = sqliteTable("readiness_rules", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id"),
  readinessProfileVersionId: text("readiness_profile_version_id").notNull(),
  code: text("code").notNull(),
  title: text("title").notNull(),
  category: text("category").notNull(),
  scope: text("scope").notNull(),
  evaluationType: text("evaluation_type").notNull(),
  severity: text("severity").notNull(),
  required: integer("required").notNull(),
  ownerOnlyOverride: integer("owner_only_override").notNull(),
  ruleDefinitionJson: jsonText("rule_definition_json").notNull(),
  sortRank: text("sort_rank").notNull(),
  createdAt: utcMs("created_at").notNull(),
});
export const readinessEvaluations = sqliteTable("readiness_evaluations", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  shootDayId: text("shoot_day_id"),
  readinessProfileVersionId: text("readiness_profile_version_id").notNull(),
  state: text("state").notNull(),
  sourceWatermark: integer("source_watermark").notNull(),
  startedByUserId: text("started_by_user_id").notNull(),
  startedAt: utcMs("started_at").notNull(),
  completedAt: utcMs("completed_at"),
  errorCode: text("error_code"),
});
export const readinessResults = sqliteTable("readiness_results", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  readinessEvaluationId: text("readiness_evaluation_id").notNull(),
  readinessRuleId: text("readiness_rule_id").notNull(),
  result: text("result").notNull(),
  ownerUserId: text("owner_user_id"),
  dueAt: utcMs("due_at"),
  explanation: text("explanation").notNull(),
  evidenceJson: jsonText("evidence_json").notNull(),
  resolutionObjectId: text("resolution_object_id"),
  evaluatedAt: utcMs("evaluated_at").notNull(),
});
export const readinessOverrides = sqliteTable("readiness_overrides", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  shootDayId: text("shoot_day_id"),
  readinessRuleId: text("readiness_rule_id").notNull(),
  scope: text("scope").notNull(),
  reason: text("reason").notNull(),
  actorUserId: text("actor_user_id").notNull(),
  expiresAt: utcMs("expires_at"),
  evidenceObjectId: text("evidence_object_id"),
  createdAt: utcMs("created_at").notNull(),
  revokedAt: utcMs("revoked_at"),
  revokedByUserId: text("revoked_by_user_id"),
  revokeReason: text("revoke_reason"),
});
export const readinessIssues = sqliteTable("readiness_issues", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  shootDayId: text("shoot_day_id"),
  readinessEvaluationId: text("readiness_evaluation_id").notNull(),
  issueNumber: integer("issue_number").notNull(),
  title: text("title").notNull(),
  state: text("state").notNull(),
  manifestJson: jsonText("manifest_json").notNull(),
  manifestHash: text("manifest_hash").notNull(),
  issuedByUserId: text("issued_by_user_id").notNull(),
  issuedAt: utcMs("issued_at").notNull(),
  supersedesIssueId: text("supersedes_issue_id"),
});

export const callSheetIssues = sqliteTable("call_sheet_issues", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  callSheetDraftId: text("call_sheet_draft_id").notNull(),
  shootDayId: text("shoot_day_id"),
  sourceScheduleRevisionId: text("source_schedule_revision_id"),
  issueNumber: integer("issue_number").notNull(),
  title: text("title").notNull(),
  confidentialityMarking: text("confidentiality_marking"),
  canonicalSnapshotJson: jsonText("canonical_snapshot_json").notNull(),
  contentHash: text("content_hash").notNull(),
  r2ObjectKey: text("r2_object_key"),
  supersedesIssueId: text("supersedes_issue_id"),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: utcMs("created_at").notNull(),
});
export const productionPackIssues = sqliteTable("production_pack_issues", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  productionPackDraftId: text("production_pack_draft_id").notNull(),
  issueNumber: integer("issue_number").notNull(),
  title: text("title").notNull(),
  manifestJson: jsonText("manifest_json").notNull(),
  manifestHash: text("manifest_hash").notNull(),
  r2ObjectKey: text("r2_object_key"),
  supersedesIssueId: text("supersedes_issue_id"),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: utcMs("created_at").notNull(),
});

export const exportSnapshots = sqliteTable("export_snapshots", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  snapshotType: text("snapshot_type").notNull(),
  schemaVersion: text("schema_version").notNull(),
  state: text("state").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull(),
  summary: text("summary"),
  ownerUserId: text("owner_user_id"),
  sortRank: text("sort_rank").notNull(),
  detailsJson: jsonText("details_json").notNull(),
  manifestObjectKey: text("manifest_object_key"),
  manifestHash: text("manifest_hash"),
  bodyObjectKey: text("body_object_key"),
  contentHash: text("content_hash"),
  requestedByUserId: text("requested_by_user_id"),
  idempotencyKey: text("idempotency_key"),
  createdBy: text("created_by"),
  version: integer("version").notNull(),
  archivedAt: utcMs("archived_at"),
  createdAt: utcMs("created_at").notNull(),
  updatedAt: utcMs("updated_at").notNull(),
  completedAt: utcMs("completed_at"),
});
export const archiveJobs = sqliteTable("archive_jobs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  exportSnapshotId: text("export_snapshot_id")
    .notNull()
    .references(() => exportSnapshots.id, { onDelete: "restrict" }),
  status: text("status").notNull(),
  attemptCount: integer("attempt_count").notNull(),
  lastErrorCode: text("last_error_code"),
  lastErrorMessage: text("last_error_message"),
  lastErrorRetryable: integer("last_error_retryable"),
  requestedByUserId: text("requested_by_user_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  createdAt: utcMs("created_at").notNull(),
  updatedAt: utcMs("updated_at").notNull(),
  verifiedAt: utcMs("verified_at"),
});
export const archiveManifestItems = sqliteTable("archive_manifest_items", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  archiveJobId: text("archive_job_id")
    .notNull()
    .references(() => archiveJobs.id, { onDelete: "restrict" }),
  logicalFileId: text("logical_file_id"),
  fileVersionId: text("file_version_id"),
  sourceRevisionId: text("source_revision_id"),
  relativePath: text("relative_path").notNull(),
  objectKey: text("object_key").notNull(),
  byteSize: integer("byte_size").notNull(),
  mimeType: text("mime_type").notNull(),
  sha256: text("sha256").notNull(),
  sortRank: text("sort_rank").notNull(),
  state: text("state").notNull(),
  createdAt: utcMs("created_at").notNull(),
});
export const archiveAttempts = sqliteTable("archive_attempts", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  archiveJobId: text("archive_job_id")
    .notNull()
    .references(() => archiveJobs.id, { onDelete: "restrict" }),
  attemptNumber: integer("attempt_number").notNull(),
  serviceCredentialId: text("service_credential_id").notNull(),
  agentId: text("agent_id").notNull(),
  state: text("state").notNull(),
  retryable: integer("retryable").notNull(),
  startedAt: utcMs("started_at").notNull(),
  heartbeatAt: utcMs("heartbeat_at").notNull(),
  finishedAt: utcMs("finished_at"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
});
export const archiveLeases = sqliteTable("archive_leases", {
  archiveJobId: text("archive_job_id")
    .primaryKey()
    .references(() => archiveJobs.id, { onDelete: "cascade" }),
  serviceCredentialId: text("service_credential_id").notNull(),
  agentId: text("agent_id").notNull(),
  leaseTokenHash: text("lease_token_hash").notNull().unique(),
  leasedAt: utcMs("leased_at").notNull(),
  heartbeatAt: utcMs("heartbeat_at").notNull(),
  expiresAt: utcMs("expires_at").notNull(),
});
export const archiveAcknowledgements = sqliteTable("archive_acknowledgements", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  projectId: text("project_id").notNull(),
  archiveJobId: text("archive_job_id")
    .notNull()
    .references(() => archiveJobs.id, { onDelete: "restrict" }),
  manifestItemId: text("manifest_item_id"),
  attemptId: text("attempt_id").notNull(),
  ackKind: text("ack_kind").notNull(),
  verifiedByteSize: integer("verified_byte_size"),
  verifiedItemCount: integer("verified_item_count"),
  verifiedSha256: text("verified_sha256"),
  destinationPath: text("destination_path"),
  errorCode: text("error_code"),
  retryable: integer("retryable"),
  serviceCredentialId: text("service_credential_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  payloadHash: text("payload_hash").notNull(),
  createdAt: utcMs("created_at").notNull(),
});

export const recordTableByType = {
  idea: ideas,
  project_brief: projectBriefs,
  development_document: developmentDocuments,
  lookbook: lookbooks,
  av_script: avScripts,
  document: documents,
  scene_breakdown: sceneBreakdowns,
  element: elements,
  report_definition: reportDefinitions,
  board: boards,
  storyboard: storyboards,
  shot_list: shotLists,
  technical_look_plan: technicalLookPlans,
  person: people,
  casting_role: castingRoles,
  location: locations,
  budget: budgets,
  requirement: requirements,
  equipment_item: equipmentItems,
  logistics_plan: logisticsPlans,
  task_card: taskCards,
  calendar_event: calendarEvents,
  schedule: schedules,
  shoot_day: shootDays,
  message: messages,
  file: files,
  call_sheet_draft: callSheetDrafts,
  production_pack_draft: productionPackDrafts,
  export_snapshot: exportSnapshots,
} as const;

export type RecordType = keyof typeof recordTableByType;
