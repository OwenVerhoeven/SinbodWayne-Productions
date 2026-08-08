import {
  createUuidV7,
  opaqueIdSchema,
  previewSceneSync,
  rankBetween,
  type CanonicalScene,
  type IncomingScene,
} from "@swp/domain";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { auditStatement } from "../audit";
import { assertProjectAccess } from "../auth/policy";
import { requireActor, requireCsrf } from "../auth/session";
import { ok } from "../http/envelope";
import { HttpError } from "../http/errors";
import { requireJson, requireSameOrigin } from "../http/security";
import type { AppEnv } from "../http/types";
import {
  beginIdempotentOperation,
  completeIdempotentOperation,
  failIdempotentOperation,
  sha256,
} from "../idempotency";
import { parseIfMatch, versionGuard } from "../records/version";
import {
  exportFdx,
  exportFountain,
  parseFdx,
  parseFountain,
  parseTxt,
  screenplayBlockTypes,
  type ImportedBlock,
  type ScreenplayBlockType,
} from "../writing/formats";

const draftBlockSchema = z
  .object({
    id: z.string().min(1).max(64),
    sceneId: z.string().min(1).max(64).nullable(),
    type: z.enum(screenplayBlockTypes),
    text: z.string().max(20_000),
    sortRank: z.string().min(1).max(128),
    version: z.number().int().positive(),
  })
  .strict();
const draftPatchSchema = z.object({ blocks: z.array(draftBlockSchema).min(1).max(2_000) }).strict();
const createBlockSchema = z
  .object({
    sceneId: z.string().min(1).max(64),
    type: z.enum(screenplayBlockTypes).default("action"),
  })
  .strict();
const revisionSchema = z
  .object({
    name: z.string().trim().min(2).max(120),
    notes: z.string().trim().max(2_000).catch(""),
    colour: z
      .enum(["white", "blue", "pink", "yellow", "green", "goldenrod", "buff", "salmon", "cherry"])
      .catch("white"),
  })
  .strict();
const mappingDecisionSchema = z
  .object({
    decision: z.enum(["accept", "remap", "omit", "archive"]),
    targetSceneId: z.string().optional(),
    reason: z.string().trim().min(2).max(1_000),
  })
  .strict();
const applySchema = z
  .object({
    syncId: z.string().min(1),
    decisions: z
      .array(z.object({ itemId: z.string(), decision: z.string().nullable() }).strict())
      .max(1_000)
      .catch([]),
  })
  .strict();

interface ScreenplayRow {
  readonly id: string;
  readonly title: string;
  readonly current_draft_id: string;
  readonly current_revision_id: string | null;
  readonly numbering_locked: number;
  readonly version: number;
}

interface DraftBlockRow {
  readonly id: string;
  readonly block_type: string;
  readonly text_content: string;
  readonly attributes_json: string;
  readonly sort_rank: string;
  readonly version: number;
}

interface SceneDescriptor {
  readonly draftSceneId: string;
  readonly headingBlockId: string;
  readonly canonicalSceneId?: string;
  readonly slugline: string;
  readonly displayNumber: string;
  readonly synopsis: string | null;
  readonly pageEighths: number;
  readonly order: number;
  readonly fingerprint: string;
  readonly sortRank: string;
}

interface SceneRow {
  readonly id: string;
  readonly display_number: string;
  readonly slugline: string;
  readonly synopsis: string | null;
  readonly page_eighths: number;
  readonly sort_rank: string;
  readonly omitted: number;
  readonly archived_at: number | null;
  readonly current_hash: string | null;
}

export const screenplayRoutes = new Hono<AppEnv>();
screenplayRoutes.use("*", requireActor, requireSameOrigin, requireCsrf);

screenplayRoutes.get("/", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredProjectId(context.req.param("projectId"));
  await assertProjectAccess(context.env.DB, actor, projectId);
  const screenplay = await requireScreenplay(context.env.DB, actor.workspaceId, projectId);
  return ok(
    context,
    await screenplayView(context.env.DB, actor.workspaceId, projectId, screenplay),
  );
});

screenplayRoutes.use("/draft", requireJson);
screenplayRoutes.patch("/draft", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredProjectId(context.req.param("projectId"));
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const expected = parseIfMatch(context.req.header("If-Match"));
  const input = draftPatchSchema.parse(await context.req.json());
  const screenplay = await requireScreenplay(context.env.DB, actor.workspaceId, projectId);
  const existing = await context.env.DB.prepare(
    `SELECT id FROM script_draft_blocks WHERE workspace_id = ?1 AND project_id = ?2
        AND screenplay_id = ?3 AND draft_id = ?4 AND archived_at IS NULL`,
  )
    .bind(actor.workspaceId, projectId, screenplay.id, screenplay.current_draft_id)
    .all<{ id: string }>();
  const known = new Set(existing.results.map((row) => row.id));
  if (input.blocks.some((block) => !known.has(block.id))) {
    throw new HttpError(
      422,
      "unknown_script_block",
      "The draft contains a block that is not part of this screenplay.",
    );
  }

  const now = Date.now();
  const guard = versionGuard(
    context.env.DB,
    "screenplays",
    screenplay.id,
    actor.workspaceId,
    projectId,
    expected,
  );
  const statements: D1PreparedStatement[] = [guard.insert];
  for (const block of input.blocks) {
    const attributes = await blockAttributes(
      context.env.DB,
      actor.workspaceId,
      projectId,
      screenplay.current_draft_id,
      block.id,
    );
    statements.push(
      context.env.DB.prepare(
        `UPDATE script_draft_blocks SET block_type = ?1, text_content = ?2, attributes_json = ?3,
             sort_rank = ?4, version = version + 1, updated_at = ?5
           WHERE id = ?6 AND workspace_id = ?7 AND project_id = ?8 AND draft_id = ?9 AND archived_at IS NULL`,
      ).bind(
        dbBlockType(block.type),
        block.text,
        JSON.stringify({ ...attributes, sceneId: block.sceneId }),
        block.sortRank,
        now,
        block.id,
        actor.workspaceId,
        projectId,
        screenplay.current_draft_id,
      ),
    );
  }
  statements.push(
    context.env.DB.prepare(
      "UPDATE script_drafts SET autosave_state = 'saved', version = version + 1, updated_at = ?1 WHERE id = ?2",
    ).bind(now, screenplay.current_draft_id),
    context.env.DB.prepare(
      "UPDATE screenplays SET version = version + 1, updated_at = ?1 WHERE id = ?2",
    ).bind(now, screenplay.id),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "screenplay.draft_saved",
      objectType: "screenplay",
      objectId: screenplay.id,
      requestId: context.get("requestId"),
      occurredAt: now,
      details: { blockCount: input.blocks.length },
    }),
    guard.remove,
  );
  try {
    await context.env.DB.batch(statements);
  } catch (error) {
    if (isConstraintError(error)) {
      const current = await requireScreenplay(context.env.DB, actor.workspaceId, projectId);
      throw new HttpError(
        409,
        "version_conflict",
        "This screenplay was edited in another session.",
        {
          expectedVersion: expected,
          current: await screenplayView(context.env.DB, actor.workspaceId, projectId, current),
          submittedDraft: input,
        },
      );
    }
    throw error;
  }
  return ok(
    context,
    await screenplayView(
      context.env.DB,
      actor.workspaceId,
      projectId,
      await requireScreenplay(context.env.DB, actor.workspaceId, projectId),
    ),
  );
});

screenplayRoutes.post("/scenes", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredProjectId(context.req.param("projectId"));
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const screenplay = await requireScreenplay(context.env.DB, actor.workspaceId, projectId);
  const last = await context.env.DB.prepare(
    "SELECT sort_rank FROM script_draft_blocks WHERE draft_id = ?1 AND archived_at IS NULL ORDER BY sort_rank DESC LIMIT 1",
  )
    .bind(screenplay.current_draft_id)
    .first<{ sort_rank: string }>();
  const sceneId = createUuidV7();
  const headingId = createUuidV7();
  const actionId = createUuidV7();
  const headingRank = rankBetween(last?.sort_rank, undefined);
  const actionRank = rankBetween(headingRank, undefined);
  const now = Date.now();
  await context.env.DB.batch([
    context.env.DB.prepare(
      `INSERT INTO script_draft_blocks
          (id, workspace_id, project_id, screenplay_id, draft_id, block_type, text_content, attributes_json,
           sort_rank, version, archived_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'scene_heading', 'INT. NEW SCENE - DAY', ?6, ?7, 1, NULL, ?8, ?8)`,
    ).bind(
      headingId,
      actor.workspaceId,
      projectId,
      screenplay.id,
      screenplay.current_draft_id,
      JSON.stringify({ sceneId, displayNumber: "New" }),
      headingRank,
      now,
    ),
    context.env.DB.prepare(
      `INSERT INTO script_draft_blocks
          (id, workspace_id, project_id, screenplay_id, draft_id, block_type, text_content, attributes_json,
           sort_rank, version, archived_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'action', '', ?6, ?7, 1, NULL, ?8, ?8)`,
    ).bind(
      actionId,
      actor.workspaceId,
      projectId,
      screenplay.id,
      screenplay.current_draft_id,
      JSON.stringify({ sceneId }),
      actionRank,
      now,
    ),
    context.env.DB.prepare(
      "UPDATE script_drafts SET version = version + 1, updated_at = ?1 WHERE id = ?2",
    ).bind(now, screenplay.current_draft_id),
    context.env.DB.prepare(
      "UPDATE screenplays SET version = version + 1, updated_at = ?1 WHERE id = ?2",
    ).bind(now, screenplay.id),
  ]);
  return ok(context, { created: true as const, sceneId }, 201);
});

screenplayRoutes.use("/blocks", requireJson);
screenplayRoutes.post("/blocks", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredProjectId(context.req.param("projectId"));
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const input = createBlockSchema.parse(await context.req.json());
  const screenplay = await requireScreenplay(context.env.DB, actor.workspaceId, projectId);
  const blocks = await loadDraftBlocks(context.env.DB, screenplay.current_draft_id);
  let lastSceneBlockIndex = -1;
  for (const [index, block] of blocks.entries()) {
    if (parseAttributes(block.attributes_json).sceneId === input.sceneId)
      lastSceneBlockIndex = index;
  }
  if (lastSceneBlockIndex < 0)
    throw new HttpError(404, "scene_not_found", "The selected scene is not in this draft.");

  const previousRank = blocks[lastSceneBlockIndex]?.sort_rank;
  const nextRank = blocks[lastSceneBlockIndex + 1]?.sort_rank;
  const blockId = createUuidV7();
  const now = Date.now();
  await context.env.DB.batch([
    context.env.DB.prepare(
      `INSERT INTO script_draft_blocks
          (id, workspace_id, project_id, screenplay_id, draft_id, block_type, text_content, attributes_json,
           sort_rank, version, archived_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', ?7, ?8, 1, NULL, ?9, ?9)`,
    ).bind(
      blockId,
      actor.workspaceId,
      projectId,
      screenplay.id,
      screenplay.current_draft_id,
      dbBlockType(input.type),
      JSON.stringify({ sceneId: input.sceneId }),
      rankBetween(previousRank, nextRank),
      now,
    ),
    context.env.DB.prepare(
      "UPDATE script_drafts SET version = version + 1, updated_at = ?1 WHERE id = ?2",
    ).bind(now, screenplay.current_draft_id),
    context.env.DB.prepare(
      "UPDATE screenplays SET version = version + 1, updated_at = ?1 WHERE id = ?2",
    ).bind(now, screenplay.id),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "screenplay.block_created",
      objectType: "screenplay",
      objectId: screenplay.id,
      requestId: context.get("requestId"),
      occurredAt: now,
      details: { blockId, sceneId: input.sceneId, type: input.type },
    }),
  ]);
  return ok(context, { created: true as const, blockId }, 201);
});

screenplayRoutes.post("/import", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredProjectId(context.req.param("projectId"));
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const screenplay = await requireScreenplay(context.env.DB, actor.workspaceId, projectId);
  const form = await context.req.formData();
  const file = form.get("file");
  if (!(file instanceof File))
    throw new HttpError(422, "file_required", "Select a script file to import.");
  if (file.size === 0 || file.size > 5 * 1024 * 1024) {
    throw new HttpError(
      413,
      "invalid_file_size",
      "Script imports must be between 1 byte and 5 MiB.",
    );
  }
  const extension = file.name.split(".").at(-1)?.toLocaleLowerCase("en-GB");
  if (!extension || !["fountain", "fdx", "txt"].includes(extension)) {
    throw new HttpError(
      415,
      "unsupported_script_format",
      "Use Fountain, FDX, or TXT for screenplay import.",
    );
  }
  const source = await file.text();
  const parsed =
    extension === "fdx"
      ? parseFdx(source)
      : extension === "txt"
        ? parseTxt(source)
        : parseFountain(source);
  if (parsed.blocks.length === 0)
    throw new HttpError(422, "empty_script", "No supported screenplay blocks were found.");

  const now = Date.now();
  const statements: D1PreparedStatement[] = [
    context.env.DB.prepare(
      "UPDATE script_draft_blocks SET archived_at = ?1, updated_at = ?1 WHERE draft_id = ?2 AND archived_at IS NULL",
    ).bind(now, screenplay.current_draft_id),
  ];
  let rank: string | undefined;
  let sceneId: string | null = null;
  let sceneNumber = 0;
  for (const block of parsed.blocks) {
    rank = rankBetween(rank, undefined);
    if (block.type === "scene_heading") {
      sceneId = createUuidV7();
      sceneNumber += 1;
    }
    const attributes = {
      sceneId,
      ...(block.type === "scene_heading"
        ? { displayNumber: String(sceneNumber), slugline: block.text }
        : {}),
      importSource: parsed.sourceFormat,
    };
    statements.push(
      context.env.DB.prepare(
        `INSERT INTO script_draft_blocks
            (id, workspace_id, project_id, screenplay_id, draft_id, block_type, text_content, attributes_json,
             sort_rank, version, archived_at, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, NULL, ?10, ?10)`,
      ).bind(
        createUuidV7(),
        actor.workspaceId,
        projectId,
        screenplay.id,
        screenplay.current_draft_id,
        dbBlockType(block.type),
        block.text,
        JSON.stringify(attributes),
        rank,
        now,
      ),
    );
  }
  statements.push(
    context.env.DB.prepare(
      "UPDATE script_drafts SET autosave_state = 'saved', version = version + 1, updated_at = ?1 WHERE id = ?2",
    ).bind(now, screenplay.current_draft_id),
    context.env.DB.prepare(
      "UPDATE screenplays SET version = version + 1, updated_at = ?1 WHERE id = ?2",
    ).bind(now, screenplay.id),
    auditStatement(context.env.DB, {
      workspaceId: actor.workspaceId,
      projectId,
      actor,
      action: "screenplay.imported",
      objectType: "screenplay",
      objectId: screenplay.id,
      requestId: context.get("requestId"),
      occurredAt: now,
      details: {
        sourceFormat: parsed.sourceFormat,
        blockCount: parsed.blocks.length,
        warningCount: parsed.warnings.length,
      },
    }),
  );
  await context.env.DB.batch(statements);
  return ok(context, { imported: true as const, warnings: parsed.warnings });
});

screenplayRoutes.use("/revisions", requireJson);
screenplayRoutes.post("/revisions", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredProjectId(context.req.param("projectId"));
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const input = revisionSchema.parse(await context.req.json());
  const screenplay = await requireScreenplay(context.env.DB, actor.workspaceId, projectId);
  const lease = await beginIdempotentOperation({
    db: context.env.DB,
    workspaceId: actor.workspaceId,
    actorFingerprint: actor.userId,
    operation: `screenplay.revision:${screenplay.id}`,
    key: context.req.header("Idempotency-Key"),
    requestBody: input,
  });
  if (lease.replayRef) return ok(context, { revisionId: lease.replayRef });
  try {
    const pending = await context.env.DB.prepare(
      `SELECT id FROM script_syncs WHERE screenplay_id = ?1 AND status IN ('preview', 'needs_resolution', 'ready') LIMIT 1`,
    )
      .bind(screenplay.id)
      .first<{ id: string }>();
    if (pending)
      throw new HttpError(
        409,
        "sync_pending",
        "Resolve or cancel the current production sync first.",
      );
    const blocks = await loadDraftBlocks(context.env.DB, screenplay.current_draft_id);
    if (!blocks.some((block) => uiBlockType(block.block_type) === "scene_heading")) {
      throw new HttpError(
        422,
        "no_scenes",
        "Add at least one scene heading before creating a revision.",
      );
    }
    const descriptors = await describeDraftScenes(blocks);
    const canonicalRows = await loadCanonicalScenes(
      context.env.DB,
      actor.workspaceId,
      projectId,
      screenplay.id,
    );
    const canonical = await canonicalForPreview(context.env.DB, projectId, canonicalRows);
    const incoming: IncomingScene[] = descriptors.map((scene) => ({
      draftSceneId: opaqueIdSchema.parse(scene.draftSceneId),
      proposedSceneId: opaqueIdSchema.parse(scene.draftSceneId),
      order: scene.order,
      slugline: scene.slugline,
      contentFingerprint: scene.fingerprint,
      ...(scene.canonicalSceneId
        ? { priorSceneId: opaqueIdSchema.parse(scene.canonicalSceneId) }
        : {}),
      candidateSceneIds: canonicalRows
        .filter(
          (candidate) =>
            normaliseSlugline(candidate.slugline) === normaliseSlugline(scene.slugline),
        )
        .map((candidate) => opaqueIdSchema.parse(candidate.id)),
    }));
    const preview = previewSceneSync({
      canonicalScenes: canonical,
      incomingScenes: incoming,
      lockedNumbering: Boolean(screenplay.numbering_locked),
    });
    const revisionId = createUuidV7();
    const syncId = createUuidV7();
    const now = Date.now();
    const revisionNumber =
      (
        await context.env.DB.prepare(
          "SELECT COALESCE(MAX(revision_number), 0) + 1 AS value FROM script_revisions WHERE screenplay_id = ?1",
        )
          .bind(screenplay.id)
          .first<{ value: number }>()
      )?.value ?? 1;
    const contentHash = await sha256(
      JSON.stringify(
        blocks.map((block) => [
          block.id,
          block.block_type,
          block.text_content,
          block.attributes_json,
          block.sort_rank,
        ]),
      ),
    );
    const statements: D1PreparedStatement[] = [
      context.env.DB.prepare(
        `INSERT INTO script_revisions
            (id, workspace_id, project_id, screenplay_id, revision_number, name, revision_color, notes,
             content_hash, source_format, import_warnings_json, author_user_id, restored_from_revision_id, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'native', '[]', ?10, NULL, ?11)`,
      ).bind(
        revisionId,
        actor.workspaceId,
        projectId,
        screenplay.id,
        revisionNumber,
        input.name,
        input.colour,
        input.notes || null,
        contentHash,
        actor.userId,
        now,
      ),
    ];
    for (const block of blocks) {
      statements.push(
        context.env.DB.prepare(
          `INSERT INTO script_block_revisions
              (id, workspace_id, project_id, screenplay_id, script_revision_id, stable_block_id,
               block_type, text_content, attributes_json, sort_rank, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
        ).bind(
          createUuidV7(),
          actor.workspaceId,
          projectId,
          screenplay.id,
          revisionId,
          block.id,
          block.block_type,
          block.text_content,
          block.attributes_json,
          block.sort_rank,
          now,
        ),
      );
    }
    const descriptorById = new Map(descriptors.map((scene) => [scene.draftSceneId, scene]));
    const revisionByDraftScene = new Map<string, string>();
    const activeIds = new Set(canonicalRows.map((scene) => scene.id));
    for (const entry of preview.entries) {
      const descriptor = descriptorById.get(entry.draftSceneId);
      if (!descriptor)
        throw new HttpError(500, "sync_invariant", "A revision scene could not be reconstructed.");
      const provisional = entry.status !== "matched";
      const sceneId =
        entry.status === "matched"
          ? entry.canonicalSceneId
          : opaqueIdSchema.parse(descriptor.draftSceneId);
      if (!sceneId)
        throw new HttpError(500, "sync_invariant", "A matched scene has no canonical identity.");
      if (provisional && !activeIds.has(sceneId)) {
        statements.push(
          context.env.DB.prepare(
            `INSERT OR IGNORE INTO scenes
                (id, workspace_id, project_id, screenplay_id, display_number, locked_number_key,
                 current_scene_revision_id, slugline, synopsis, int_ext, time_of_day, story_day, page_eighths,
                 sort_rank, omitted, omission_reason, version, archived_at, created_at, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, ?6, ?7, ?8, ?9, NULL, ?10, ?11, 1,
                       'Awaiting production sync', 1, ?12, ?12, ?12)`,
          ).bind(
            sceneId,
            actor.workspaceId,
            projectId,
            screenplay.id,
            provisionalNumber(descriptor.order, sceneId),
            descriptor.slugline,
            descriptor.synopsis,
            sluglineParts(descriptor.slugline).intExt,
            sluglineParts(descriptor.slugline).timeOfDay,
            descriptor.pageEighths,
            descriptor.sortRank,
            now,
          ),
        );
      }
      const sceneRevisionId = createUuidV7();
      revisionByDraftScene.set(descriptor.draftSceneId, sceneRevisionId);
      statements.push(
        context.env.DB.prepare(
          `INSERT INTO scene_revisions
              (id, workspace_id, project_id, scene_id, script_revision_id, source_start_block_id,
               source_end_block_id, display_number, slugline, synopsis, int_ext, time_of_day,
               page_eighths, sort_rank, content_hash, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
        ).bind(
          sceneRevisionId,
          actor.workspaceId,
          projectId,
          sceneId,
          revisionId,
          descriptor.headingBlockId,
          lastBlockIdForScene(blocks, descriptor.draftSceneId),
          entry.assignedDisplayNumber ?? descriptor.displayNumber,
          descriptor.slugline,
          descriptor.synopsis,
          sluglineParts(descriptor.slugline).intExt,
          sluglineParts(descriptor.slugline).timeOfDay,
          descriptor.pageEighths,
          descriptor.sortRank,
          descriptor.fingerprint,
          now,
        ),
      );
    }
    const previewItems = [
      ...preview.entries.map((entry) => ({ kind: entryKind(entry), entry })),
      ...preview.removed.map((removed) => ({ kind: "removed" as const, removed })),
    ];
    let unresolved = 0;
    statements.push(
      context.env.DB.prepare(
        `INSERT INTO script_syncs
            (id, workspace_id, project_id, screenplay_id, from_revision_id, to_revision_id, status,
             impact_summary_json, mapping_hash, created_by_user_id, applied_by_user_id, applied_at,
             version, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'preview', ?7, ?8, ?9, NULL, NULL, 1, ?10, ?10)`,
      ).bind(
        syncId,
        actor.workspaceId,
        projectId,
        screenplay.id,
        screenplay.current_revision_id,
        revisionId,
        JSON.stringify({
          added: preview.entries.filter((entry) => entry.status === "added").length,
          removed: preview.removed.length,
        }),
        await sha256(JSON.stringify(preview)),
        actor.userId,
        now,
      ),
    );
    for (const item of previewItems) {
      const mappingId = createUuidV7();
      if ("entry" in item) {
        const impact = item.entry.canonicalSceneId
          ? await downstreamImpactSummary(context.env.DB, projectId, item.entry.canonicalSceneId)
          : [];
        const resolution = item.kind === "ambiguous" ? null : "accept";
        if (!resolution) unresolved += 1;
        statements.push(
          context.env.DB.prepare(
            `INSERT INTO scene_mappings
                (id, workspace_id, project_id, script_sync_id, prior_scene_id, candidate_scene_revision_id,
                 mapping_kind, confidence_basis_json, resolution, resolved_scene_id, resolved_by_user_id,
                 resolved_at, version, created_at, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, ?13, ?13)`,
          ).bind(
            mappingId,
            actor.workspaceId,
            projectId,
            syncId,
            item.entry.canonicalSceneId ?? null,
            revisionByDraftScene.get(item.entry.draftSceneId) ?? null,
            item.kind,
            JSON.stringify({
              reason: item.entry.reason,
              assignedDisplayNumber: item.entry.assignedDisplayNumber,
              candidateSceneIds: item.entry.candidateSceneIds,
              downstreamImpact: impact,
            }),
            resolution,
            item.entry.canonicalSceneId ?? null,
            resolution ? actor.userId : null,
            resolution ? now : null,
            now,
          ),
        );
      } else {
        const impact = await downstreamImpactSummary(
          context.env.DB,
          projectId,
          item.removed.canonicalSceneId,
        );
        const resolution = impact.length === 0 ? "archive" : null;
        if (!resolution) unresolved += 1;
        statements.push(
          context.env.DB.prepare(
            `INSERT INTO scene_mappings
                (id, workspace_id, project_id, script_sync_id, prior_scene_id, candidate_scene_revision_id,
                 mapping_kind, confidence_basis_json, resolution, resolved_scene_id, resolved_by_user_id,
                 resolved_at, version, created_at, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, NULL, 'removed', ?6, ?7, NULL, ?8, ?9, 1, ?10, ?10)`,
          ).bind(
            mappingId,
            actor.workspaceId,
            projectId,
            syncId,
            item.removed.canonicalSceneId,
            JSON.stringify({
              assignedDisplayNumber: item.removed.displayNumber,
              downstreamImpact: impact,
            }),
            resolution,
            resolution ? actor.userId : null,
            resolution ? now : null,
            now,
          ),
        );
      }
    }
    statements.push(
      context.env.DB.prepare(
        "UPDATE script_syncs SET status = ?1, version = version + 1, updated_at = ?2 WHERE id = ?3",
      ).bind(unresolved ? "needs_resolution" : "ready", now, syncId),
      context.env.DB.prepare(
        "UPDATE screenplays SET current_revision_id = ?1, version = version + 1, updated_at = ?2 WHERE id = ?3",
      ).bind(revisionId, now, screenplay.id),
      completeIdempotentOperation(context.env.DB, lease.id, revisionId, 201),
      auditStatement(context.env.DB, {
        workspaceId: actor.workspaceId,
        projectId,
        actor,
        action: "screenplay.revision_created",
        objectType: "script_revision",
        objectId: revisionId,
        requestId: context.get("requestId"),
        occurredAt: now,
        details: { revisionNumber, syncId, unresolved },
      }),
    );
    await context.env.DB.batch(statements);
    return ok(context, { revisionId }, 201);
  } catch (error) {
    await failIdempotentOperation(context.env.DB, lease.id);
    throw error;
  }
});

screenplayRoutes.use("/sync/:syncId/mappings/:mappingId", requireJson);
screenplayRoutes.patch("/sync/:syncId/mappings/:mappingId", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredProjectId(context.req.param("projectId"));
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const input = mappingDecisionSchema.parse(await context.req.json());
  const syncId = required(context.req.param("syncId"));
  const mappingId = required(context.req.param("mappingId"));
  const mapping = await context.env.DB.prepare(
    `SELECT sm.id, sm.mapping_kind, sm.prior_scene_id, sm.candidate_scene_revision_id, ss.status
         FROM scene_mappings sm JOIN script_syncs ss ON ss.id = sm.script_sync_id
        WHERE sm.id = ?1 AND sm.script_sync_id = ?2 AND sm.workspace_id = ?3 AND sm.project_id = ?4 LIMIT 1`,
  )
    .bind(mappingId, syncId, actor.workspaceId, projectId)
    .first<{
      id: string;
      mapping_kind: string;
      prior_scene_id: string | null;
      candidate_scene_revision_id: string | null;
      status: string;
    }>();
  if (!mapping) throw new HttpError(404, "not_found", "The scene mapping was not found.");
  if (mapping.status === "applied" || mapping.status === "cancelled") {
    throw new HttpError(
      409,
      "immutable_sync",
      "Applied or cancelled sync records cannot be changed.",
    );
  }
  if (input.decision === "remap" && !input.targetSceneId) {
    throw new HttpError(422, "target_required", "Select the canonical scene for a remap decision.");
  }
  if (input.targetSceneId) {
    const target = await context.env.DB.prepare(
      "SELECT id FROM scenes WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 LIMIT 1",
    )
      .bind(input.targetSceneId, actor.workspaceId, projectId)
      .first<{ id: string }>();
    if (!target)
      throw new HttpError(422, "invalid_target", "The selected canonical scene is unavailable.");
  }
  const now = Date.now();
  const resolvedSceneId = input.decision === "remap" ? input.targetSceneId : mapping.prior_scene_id;
  await context.env.DB.batch([
    context.env.DB.prepare(
      `UPDATE scene_mappings SET resolution = ?1, resolved_scene_id = ?2, resolved_by_user_id = ?3,
           resolved_at = ?4, version = version + 1, updated_at = ?4 WHERE id = ?5`,
    ).bind(input.decision, resolvedSceneId ?? null, actor.userId, now, mappingId),
    context.env.DB.prepare(
      `INSERT INTO scene_mapping_decisions
          (id, workspace_id, project_id, scene_mapping_id, decision, prior_scene_id, resulting_scene_id,
           actor_user_id, reason, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    ).bind(
      createUuidV7(),
      actor.workspaceId,
      projectId,
      mappingId,
      input.decision,
      mapping.prior_scene_id,
      resolvedSceneId ?? null,
      actor.userId,
      input.reason,
      now,
    ),
    context.env.DB.prepare(
      `UPDATE script_syncs SET status = CASE WHEN EXISTS (
           SELECT 1 FROM scene_mappings WHERE script_sync_id = ?1 AND resolution IS NULL
         ) THEN 'needs_resolution' ELSE 'ready' END, version = version + 1, updated_at = ?2 WHERE id = ?1`,
    ).bind(syncId, now),
  ]);
  return ok(context, { resolved: true as const });
});

screenplayRoutes.use("/sync/apply", requireJson);
screenplayRoutes.post("/sync/apply", async (context) => {
  const actor = context.get("actor");
  const projectId = requiredProjectId(context.req.param("projectId"));
  await assertProjectAccess(context.env.DB, actor, projectId, "edit");
  const input = applySchema.parse(await context.req.json());
  const lease = await beginIdempotentOperation({
    db: context.env.DB,
    workspaceId: actor.workspaceId,
    actorFingerprint: actor.userId,
    operation: `screenplay.sync.apply:${input.syncId}`,
    key: context.req.header("Idempotency-Key"),
    requestBody: input,
  });
  if (lease.replayRef) return ok(context, { applied: true as const, syncId: lease.replayRef });
  try {
    const sync = await context.env.DB.prepare(
      `SELECT id, screenplay_id, to_revision_id, status FROM script_syncs
          WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 LIMIT 1`,
    )
      .bind(input.syncId, actor.workspaceId, projectId)
      .first<{ id: string; screenplay_id: string; to_revision_id: string; status: string }>();
    if (!sync) throw new HttpError(404, "not_found", "The script sync was not found.");
    if (sync.status === "applied") {
      await context.env.DB.batch([completeIdempotentOperation(context.env.DB, lease.id, sync.id)]);
      return ok(context, { applied: true as const, syncId: sync.id });
    }
    const mappings = await context.env.DB.prepare(
      `SELECT sm.id, sm.mapping_kind, sm.prior_scene_id, sm.candidate_scene_revision_id,
                sm.resolution, sm.resolved_scene_id, sm.confidence_basis_json,
                sr.scene_id AS candidate_scene_id, sr.display_number, sr.slugline, sr.synopsis,
                sr.int_ext, sr.time_of_day, sr.page_eighths, sr.sort_rank, sr.id AS scene_revision_id,
                sr.source_start_block_id, sr.source_end_block_id, sr.content_hash
           FROM scene_mappings sm
           LEFT JOIN scene_revisions sr ON sr.id = sm.candidate_scene_revision_id
          WHERE sm.script_sync_id = ?1 ORDER BY sm.created_at, sm.id`,
    )
      .bind(sync.id)
      .all<ApplyMappingRow>();
    if (mappings.results.some((mapping) => !mapping.resolution)) {
      throw new HttpError(
        409,
        "sync_requires_review",
        "Resolve every ambiguous or impacted removed scene before apply.",
      );
    }
    const now = Date.now();
    const statements: D1PreparedStatement[] = [];
    const draftSceneToCanonical = new Map<string, string>();
    for (const mapping of mappings.results) {
      if (mapping.mapping_kind === "removed") {
        if (!mapping.prior_scene_id)
          throw new HttpError(500, "sync_invariant", "Removed mapping has no canonical scene.");
        if (mapping.resolution === "omit") {
          statements.push(
            context.env.DB.prepare(
              "UPDATE scenes SET omitted = 1, omission_reason = 'Removed by script sync', version = version + 1, updated_at = ?1 WHERE id = ?2",
            ).bind(now, mapping.prior_scene_id),
          );
        } else if (mapping.resolution === "archive") {
          statements.push(
            context.env.DB.prepare(
              "UPDATE scenes SET omitted = 1, archived_at = ?1, omission_reason = 'Archived by script sync', version = version + 1, updated_at = ?1 WHERE id = ?2",
            ).bind(now, mapping.prior_scene_id),
          );
        } else if (mapping.resolution === "remap" && mapping.resolved_scene_id) {
          await remapSceneLinks(
            context.env.DB,
            projectId,
            mapping.prior_scene_id,
            mapping.resolved_scene_id,
            statements,
          );
          statements.push(
            context.env.DB.prepare(
              "UPDATE scenes SET omitted = 1, archived_at = ?1, omission_reason = 'Remapped by script sync', version = version + 1, updated_at = ?1 WHERE id = ?2",
            ).bind(now, mapping.prior_scene_id),
          );
        }
        continue;
      }
      if (
        !mapping.scene_revision_id ||
        !mapping.candidate_scene_id ||
        !mapping.source_start_block_id
      ) {
        throw new HttpError(
          500,
          "sync_invariant",
          "A mapped incoming scene has no immutable scene revision.",
        );
      }
      const targetSceneId =
        mapping.resolution === "remap" && mapping.resolved_scene_id
          ? mapping.resolved_scene_id
          : mapping.mapping_kind === "added" || mapping.mapping_kind === "ambiguous"
            ? mapping.candidate_scene_id
            : (mapping.prior_scene_id ?? mapping.candidate_scene_id);
      draftSceneToCanonical.set(mapping.candidate_scene_id, targetSceneId);
      let effectiveSceneRevisionId = mapping.scene_revision_id;
      if (targetSceneId !== mapping.candidate_scene_id) {
        effectiveSceneRevisionId = createUuidV7();
        statements.push(
          context.env.DB.prepare(
            `INSERT INTO scene_revisions
                (id, workspace_id, project_id, scene_id, script_revision_id, source_start_block_id,
                 source_end_block_id, display_number, slugline, synopsis, int_ext, time_of_day,
                 page_eighths, sort_rank, content_hash, created_at)
               SELECT ?1, workspace_id, project_id, ?2, script_revision_id, source_start_block_id,
                      source_end_block_id, display_number, slugline, synopsis, int_ext, time_of_day,
                      page_eighths, sort_rank, content_hash, ?3
                 FROM scene_revisions WHERE id = ?4`,
          ).bind(effectiveSceneRevisionId, targetSceneId, now, mapping.scene_revision_id),
        );
      }
      statements.push(
        context.env.DB.prepare(
          `UPDATE scenes SET display_number = ?1, current_scene_revision_id = ?2, slugline = ?3,
               synopsis = ?4, int_ext = ?5, time_of_day = ?6, page_eighths = ?7, sort_rank = ?8,
               omitted = 0, omission_reason = NULL, archived_at = NULL, version = version + 1, updated_at = ?9
             WHERE id = ?10 AND workspace_id = ?11 AND project_id = ?12`,
        ).bind(
          mapping.display_number,
          effectiveSceneRevisionId,
          mapping.slugline,
          mapping.synopsis,
          mapping.int_ext,
          mapping.time_of_day,
          mapping.page_eighths,
          mapping.sort_rank,
          now,
          targetSceneId,
          actor.workspaceId,
          projectId,
        ),
      );
      if (targetSceneId !== mapping.candidate_scene_id) {
        statements.push(
          context.env.DB.prepare(
            "UPDATE scenes SET omitted = 1, archived_at = ?1, omission_reason = 'Revision source remapped', version = version + 1, updated_at = ?1 WHERE id = ?2 AND archived_at IS NOT NULL",
          ).bind(now, mapping.candidate_scene_id),
        );
      }
      const object = await context.env.DB.prepare(
        "SELECT id FROM object_registry WHERE domain_table = 'scenes' AND domain_id = ?1 LIMIT 1",
      )
        .bind(targetSceneId)
        .first<{ id: string }>();
      if (!object) {
        statements.push(
          context.env.DB.prepare(
            `INSERT INTO object_registry
                (id, workspace_id, project_id, object_type, domain_table, domain_id, title, version,
                 archived_at, created_at, updated_at)
               VALUES (?1, ?2, ?3, 'scene', 'scenes', ?4, ?5, 1, NULL, ?6, ?6)`,
          ).bind(
            createUuidV7(),
            actor.workspaceId,
            projectId,
            targetSceneId,
            mapping.slugline,
            now,
          ),
        );
      } else {
        statements.push(
          context.env.DB.prepare(
            "UPDATE object_registry SET title = ?1, version = version + 1, archived_at = NULL, updated_at = ?2 WHERE id = ?3",
          ).bind(mapping.slugline, now, object.id),
        );
      }
    }
    const screenplay = await requireScreenplay(context.env.DB, actor.workspaceId, projectId);
    const draftBlocks = await loadDraftBlocks(context.env.DB, screenplay.current_draft_id);
    for (const block of draftBlocks) {
      const attributes = parseAttributes(block.attributes_json);
      const draftSceneId = typeof attributes.sceneId === "string" ? attributes.sceneId : undefined;
      const canonicalSceneId = draftSceneId ? draftSceneToCanonical.get(draftSceneId) : undefined;
      if (!canonicalSceneId) continue;
      statements.push(
        context.env.DB.prepare(
          "UPDATE script_draft_blocks SET attributes_json = ?1, updated_at = ?2 WHERE id = ?3",
        ).bind(
          JSON.stringify({ ...attributes, sceneId: draftSceneId, canonicalSceneId }),
          now,
          block.id,
        ),
      );
    }
    statements.push(
      context.env.DB.prepare(
        "UPDATE script_syncs SET status = 'applied', applied_by_user_id = ?1, applied_at = ?2, version = version + 1, updated_at = ?2 WHERE id = ?3",
      ).bind(actor.userId, now, sync.id),
      context.env.DB.prepare(
        "UPDATE screenplays SET current_revision_id = ?1, version = version + 1, updated_at = ?2 WHERE id = ?3",
      ).bind(sync.to_revision_id, now, sync.screenplay_id),
      context.env.DB.prepare(
        "UPDATE readiness_issues SET state = 'stale' WHERE project_id = ?1 AND state = 'ready'",
      ).bind(projectId),
      context.env.DB.prepare(
        "UPDATE projects SET readiness_state = 'stale', updated_at = ?1, version = version + 1 WHERE id = ?2",
      ).bind(now, projectId),
      completeIdempotentOperation(context.env.DB, lease.id, sync.id),
      auditStatement(context.env.DB, {
        workspaceId: actor.workspaceId,
        projectId,
        actor,
        action: "screenplay.sync_applied",
        objectType: "script_sync",
        objectId: sync.id,
        requestId: context.get("requestId"),
        occurredAt: now,
        details: { revisionId: sync.to_revision_id },
      }),
    );
    await context.env.DB.batch(statements);
    return ok(context, { applied: true as const, syncId: sync.id });
  } catch (error) {
    await failIdempotentOperation(context.env.DB, lease.id);
    throw error;
  }
});

screenplayRoutes.get("/export.fountain", async (context) => {
  return screenplayExport(context, "fountain");
});

screenplayRoutes.get("/export.fdx", async (context) => {
  return screenplayExport(context, "fdx");
});

async function screenplayExport(context: Context<AppEnv>, format: "fountain" | "fdx") {
  const actor = context.get("actor");
  const projectId = requiredProjectId(context.req.param("projectId"));
  await assertProjectAccess(context.env.DB, actor, projectId);
  const screenplay = await requireScreenplay(context.env.DB, actor.workspaceId, projectId);
  const blocks = (await loadDraftBlocks(context.env.DB, screenplay.current_draft_id)).map(
    (row) => ({
      type: uiBlockType(row.block_type),
      text: row.text_content,
    }),
  );
  const body = format === "fdx" ? exportFdx(blocks, screenplay.title) : exportFountain(blocks);
  const safeName =
    screenplay.title.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "screenplay";
  return new Response(body, {
    headers: {
      "Content-Type":
        format === "fdx" ? "application/xml; charset=utf-8" : "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${safeName}.${format}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function screenplayView(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  screenplay: ScreenplayRow,
) {
  const [blocks, revisions, canonicalScenes, sync] = await Promise.all([
    loadDraftBlocks(db, screenplay.current_draft_id),
    db
      .prepare(
        `SELECT id, name, COALESCE(revision_color, 'white') AS colour, notes, created_at
           FROM script_revisions WHERE screenplay_id = ?1 ORDER BY revision_number DESC`,
      )
      .bind(screenplay.id)
      .all<{
        id: string;
        name: string;
        colour: string;
        notes: string | null;
        created_at: number;
      }>(),
    loadCanonicalScenes(db, workspaceId, projectId, screenplay.id),
    db
      .prepare(
        `SELECT id, to_revision_id, status FROM script_syncs WHERE screenplay_id = ?1
          AND status IN ('preview', 'needs_resolution', 'ready') ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(screenplay.id)
      .first<{ id: string; to_revision_id: string; status: string }>(),
  ]);
  const descriptors = await describeDraftScenes(blocks);
  const syncMappings = sync
    ? await db
        .prepare(
          `SELECT sm.id, sm.prior_scene_id, sm.mapping_kind, sm.resolution, sm.confidence_basis_json,
                  sr.scene_id AS incoming_scene_id, sr.display_number, sr.slugline
             FROM scene_mappings sm LEFT JOIN scene_revisions sr ON sr.id = sm.candidate_scene_revision_id
            WHERE sm.script_sync_id = ?1 ORDER BY sm.created_at, sm.id`,
        )
        .bind(sync.id)
        .all<{
          id: string;
          prior_scene_id: string | null;
          mapping_kind: "added" | "matched" | "revised" | "moved" | "ambiguous" | "removed";
          resolution: string | null;
          confidence_basis_json: string;
          incoming_scene_id: string | null;
          display_number: string | null;
          slugline: string | null;
        }>()
    : { results: [] };
  const stateByIncoming = new Map(
    syncMappings.results
      .filter((mapping) => mapping.incoming_scene_id)
      .map((mapping) => [mapping.incoming_scene_id!, mapping.mapping_kind]),
  );
  const canonicalById = new Map(canonicalScenes.map((scene) => [scene.id, scene]));
  const sceneItems = descriptors.length
    ? descriptors.map((scene) => {
        const canonical = scene.canonicalSceneId
          ? canonicalById.get(scene.canonicalSceneId)
          : undefined;
        return {
          id: scene.draftSceneId,
          displayNumber: scene.displayNumber,
          slugline: scene.slugline,
          synopsis: scene.synopsis,
          pageEighths: scene.pageEighths,
          omitted: canonical ? Boolean(canonical.omitted) : false,
          syncState:
            stateByIncoming.get(scene.draftSceneId) ??
            (scene.canonicalSceneId ? "synced" : "added"),
        };
      })
    : canonicalScenes.map((scene) => ({
        id: scene.id,
        displayNumber: scene.display_number,
        slugline: scene.slugline,
        synopsis: scene.synopsis,
        pageEighths: scene.page_eighths,
        omitted: Boolean(scene.omitted),
        syncState: "synced" as const,
      }));
  const current =
    revisions.results.find((revision) => revision.id === screenplay.current_revision_id) ?? null;
  const revisionName =
    revisions.results.find((revision) => revision.id === sync?.to_revision_id)?.name ?? "Revision";
  return {
    id: screenplay.id,
    title: screenplay.title,
    version: screenplay.version,
    saveState: "saved",
    sceneNumbersLocked: Boolean(screenplay.numbering_locked),
    currentRevision: current
      ? { id: current.id, name: current.name, colour: current.colour, issuedAt: current.created_at }
      : null,
    revisions: revisions.results.map((revision) => ({
      id: revision.id,
      name: revision.name,
      colour: revision.colour,
      notes: revision.notes,
      issuedAt: revision.created_at,
    })),
    scenes: sceneItems,
    blocks: blocks.map((block) => {
      const attributes = parseAttributes(block.attributes_json);
      return {
        id: block.id,
        sceneId: typeof attributes.sceneId === "string" ? attributes.sceneId : null,
        type: uiBlockType(block.block_type),
        text: block.text_content,
        sortRank: block.sort_rank,
        version: block.version,
      };
    }),
    syncPreview: sync
      ? {
          id: sync.id,
          sourceRevisionName: revisionName,
          unresolved: syncMappings.results.filter((mapping) => !mapping.resolution).length,
          items: syncMappings.results.map((mapping) => {
            const basis = parseAttributes(mapping.confidence_basis_json);
            return {
              id: mapping.id,
              incomingSceneId: mapping.incoming_scene_id,
              canonicalSceneId: mapping.prior_scene_id,
              displayNumber:
                mapping.display_number ??
                (typeof basis.assignedDisplayNumber === "string"
                  ? basis.assignedDisplayNumber
                  : null),
              classification: mapping.mapping_kind,
              summary:
                mapping.slugline ??
                canonicalById.get(mapping.prior_scene_id ?? "")?.slugline ??
                "Scene removed from incoming revision",
              downstreamImpact: Array.isArray(basis.downstreamImpact)
                ? basis.downstreamImpact.filter(
                    (value): value is string => typeof value === "string",
                  )
                : [],
              candidateSceneIds: Array.isArray(basis.candidateSceneIds)
                ? basis.candidateSceneIds.filter(
                    (value): value is string => typeof value === "string",
                  )
                : [],
              decision: mapping.resolution,
            };
          }),
        }
      : null,
  };
}

async function requireScreenplay(
  db: D1Database,
  workspaceId: string,
  projectId: string,
): Promise<ScreenplayRow> {
  const row = await db
    .prepare(
      `SELECT id, title, current_draft_id, current_revision_id, numbering_locked, version
         FROM screenplays WHERE workspace_id = ?1 AND project_id = ?2 AND archived_at IS NULL
         ORDER BY updated_at DESC LIMIT 1`,
    )
    .bind(workspaceId, projectId)
    .first<ScreenplayRow>();
  if (!row?.current_draft_id)
    throw new HttpError(404, "screenplay_not_found", "This project has no active screenplay.");
  return row;
}

async function loadDraftBlocks(db: D1Database, draftId: string): Promise<DraftBlockRow[]> {
  const result = await db
    .prepare(
      `SELECT id, block_type, text_content, attributes_json, sort_rank, version
         FROM script_draft_blocks WHERE draft_id = ?1 AND archived_at IS NULL ORDER BY sort_rank, id`,
    )
    .bind(draftId)
    .all<DraftBlockRow>();
  return result.results;
}

async function loadCanonicalScenes(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  screenplayId: string,
): Promise<SceneRow[]> {
  const result = await db
    .prepare(
      `SELECT s.id, s.display_number, s.slugline, s.synopsis, s.page_eighths, s.sort_rank,
              s.omitted, s.archived_at, sr.content_hash AS current_hash
         FROM scenes s LEFT JOIN scene_revisions sr ON sr.id = s.current_scene_revision_id
        WHERE s.workspace_id = ?1 AND s.project_id = ?2 AND s.screenplay_id = ?3 AND s.archived_at IS NULL
        ORDER BY s.sort_rank, s.id`,
    )
    .bind(workspaceId, projectId, screenplayId)
    .all<SceneRow>();
  return result.results;
}

async function describeDraftScenes(blocks: readonly DraftBlockRow[]): Promise<SceneDescriptor[]> {
  const result: SceneDescriptor[] = [];
  let current:
    | {
        id: string;
        heading: DraftBlockRow;
        attrs: Record<string, unknown>;
        content: ImportedBlock[];
      }
    | undefined;
  for (const block of blocks) {
    const type = uiBlockType(block.block_type);
    const attrs = parseAttributes(block.attributes_json);
    if (type === "scene_heading") {
      if (current) result.push(await finishDescriptor(current, result.length));
      const id = typeof attrs.sceneId === "string" ? attrs.sceneId : block.id;
      current = { id, heading: block, attrs, content: [{ type, text: block.text_content }] };
    } else if (current) {
      current.content.push({ type, text: block.text_content });
    }
  }
  if (current) result.push(await finishDescriptor(current, result.length));
  return result;
}

async function finishDescriptor(
  current: {
    id: string;
    heading: DraftBlockRow;
    attrs: Record<string, unknown>;
    content: ImportedBlock[];
  },
  order: number,
): Promise<SceneDescriptor> {
  return {
    draftSceneId: current.id,
    headingBlockId: current.heading.id,
    ...(typeof current.attrs.canonicalSceneId === "string"
      ? { canonicalSceneId: current.attrs.canonicalSceneId }
      : {}),
    slugline: current.heading.text_content.trim() || "UNTITLED SCENE",
    displayNumber:
      typeof current.attrs.displayNumber === "string"
        ? current.attrs.displayNumber
        : String(order + 1),
    synopsis: typeof current.attrs.synopsis === "string" ? current.attrs.synopsis : null,
    pageEighths:
      typeof current.attrs.pageEighths === "number" && Number.isInteger(current.attrs.pageEighths)
        ? Math.max(0, current.attrs.pageEighths)
        : estimatePageEighths(current.content),
    order,
    fingerprint: await sha256(JSON.stringify(current.content)),
    sortRank: current.heading.sort_rank,
  };
}

async function canonicalForPreview(
  db: D1Database,
  projectId: string,
  rows: readonly SceneRow[],
): Promise<CanonicalScene[]> {
  return Promise.all(
    rows.map(async (row, order) => ({
      id: opaqueIdSchema.parse(row.id),
      displayNumber: row.display_number,
      order,
      slugline: row.slugline,
      contentFingerprint: row.current_hash ?? (await sha256(row.slugline)),
      omitted: Boolean(row.omitted),
      archived: Boolean(row.archived_at),
      downstreamLinks: await downstreamObjectLinks(db, projectId, row.id),
    })),
  );
}

async function downstreamObjectLinks(db: D1Database, projectId: string, sceneId: string) {
  const sceneObject = await db
    .prepare(
      "SELECT id FROM object_registry WHERE project_id = ?1 AND domain_table = 'scenes' AND domain_id = ?2 LIMIT 1",
    )
    .bind(projectId, sceneId)
    .first<{ id: string }>();
  if (!sceneObject) return [];
  const rows = await db
    .prepare(
      `SELECT o.object_type, o.domain_id FROM object_links l JOIN object_registry o
         ON o.id = CASE WHEN l.source_object_id = ?1 THEN l.target_object_id ELSE l.source_object_id END
        WHERE l.project_id = ?2 AND l.archived_at IS NULL
          AND (l.source_object_id = ?1 OR l.target_object_id = ?1) LIMIT 100`,
    )
    .bind(sceneObject.id, projectId)
    .all<{ object_type: string; domain_id: string }>();
  return rows.results.map((row) => ({
    kind: row.object_type,
    objectId: opaqueIdSchema.parse(row.domain_id),
  }));
}

async function downstreamImpactSummary(
  db: D1Database,
  projectId: string,
  sceneId: string,
): Promise<string[]> {
  const queries = [
    [
      "breakdown tags",
      "SELECT COUNT(*) AS count FROM scene_element_tags WHERE project_id = ?1 AND scene_id = ?2 AND archived_at IS NULL",
    ],
    [
      "shots",
      "SELECT COUNT(*) AS count FROM shots WHERE project_id = ?1 AND scene_id = ?2 AND archived_at IS NULL",
    ],
    [
      "storyboard frames",
      "SELECT COUNT(*) AS count FROM storyboard_frames WHERE project_id = ?1 AND scene_id = ?2 AND archived_at IS NULL",
    ],
    [
      "schedule strips",
      "SELECT COUNT(*) AS count FROM schedule_items WHERE project_id = ?1 AND scene_id = ?2",
    ],
    ["sides issues", "SELECT COUNT(*) AS count FROM sides_issue_scenes WHERE scene_id = ?2"],
    [
      "location links",
      "SELECT COUNT(*) AS count FROM location_scene_links WHERE project_id = ?1 AND scene_id = ?2",
    ],
  ] as const;
  const values = await Promise.all(
    queries.map(async ([label, sql]) => {
      const row = await db.prepare(sql).bind(projectId, sceneId).first<{ count: number }>();
      return { label, count: row?.count ?? 0 };
    }),
  );
  return values.filter((item) => item.count > 0).map((item) => `${item.count} ${item.label}`);
}

async function remapSceneLinks(
  db: D1Database,
  projectId: string,
  fromSceneId: string,
  toSceneId: string,
  statements: D1PreparedStatement[],
) {
  const relations = [
    ["scene_element_tags", "scene_id"],
    ["shots", "scene_id"],
    ["storyboard_frames", "scene_id"],
    ["schedule_items", "scene_id"],
    ["location_scene_links", "scene_id"],
  ] as const;
  for (const [table, column] of relations) {
    statements.push(
      db
        .prepare(
          `UPDATE OR IGNORE ${table} SET ${column} = ?1 WHERE project_id = ?2 AND ${column} = ?3`,
        )
        .bind(toSceneId, projectId, fromSceneId),
    );
  }
}

async function blockAttributes(
  db: D1Database,
  workspaceId: string,
  projectId: string,
  draftId: string,
  blockId: string,
): Promise<Record<string, unknown>> {
  const row = await db
    .prepare(
      "SELECT attributes_json FROM script_draft_blocks WHERE id = ?1 AND workspace_id = ?2 AND project_id = ?3 AND draft_id = ?4 LIMIT 1",
    )
    .bind(blockId, workspaceId, projectId, draftId)
    .first<{ attributes_json: string }>();
  return parseAttributes(row?.attributes_json ?? "{}");
}

function lastBlockIdForScene(blocks: readonly DraftBlockRow[], sceneId: string): string {
  let last = blocks.find((block) => parseAttributes(block.attributes_json).sceneId === sceneId)?.id;
  for (const block of blocks) {
    if (parseAttributes(block.attributes_json).sceneId === sceneId) last = block.id;
  }
  if (!last) throw new HttpError(500, "sync_invariant", "A draft scene has no source block range.");
  return last;
}

function parseAttributes(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function dbBlockType(value: ScreenplayBlockType): string {
  return value === "lyrics" ? "lyrics" : value;
}

function uiBlockType(value: string): ScreenplayBlockType {
  if (value === "lyrics_text") return "lyrics";
  const parsed = z.enum(screenplayBlockTypes).safeParse(value);
  return parsed.success ? parsed.data : "note";
}

function estimatePageEighths(blocks: readonly ImportedBlock[]): number {
  const characters = blocks.reduce((total, block) => total + block.text.length, 0);
  return Math.max(1, Math.round((characters / 1_800) * 8));
}

function normaliseSlugline(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleUpperCase("en-GB");
}

function sluglineParts(value: string): { intExt: string; timeOfDay: string | null } {
  const normalized = normaliseSlugline(value);
  const intExt =
    normalized.startsWith("INT./EXT.") || normalized.startsWith("INT/EXT")
      ? "INT_EXT"
      : normalized.startsWith("INT.")
        ? "INT"
        : normalized.startsWith("EXT.")
          ? "EXT"
          : "OTHER";
  const pieces = normalized.split(" - ");
  return { intExt, timeOfDay: pieces.length > 1 ? (pieces.at(-1) ?? null) : null };
}

function provisionalNumber(order: number, id: string): string {
  return `P${order + 1}-${id.slice(-6).toUpperCase()}`;
}

function entryKind(
  entry: ReturnType<typeof previewSceneSync>["entries"][number],
): "added" | "matched" | "revised" | "moved" | "ambiguous" {
  if (entry.status === "ambiguous") return "ambiguous";
  if (entry.status === "added") return "added";
  if (entry.revised) return "revised";
  if (entry.moved) return "moved";
  return "matched";
}

function requiredProjectId(value: string | undefined): string {
  return required(value);
}

function required(value: string | undefined): string {
  if (!value) throw new HttpError(404, "route_not_found", "The requested route was not found.");
  return value;
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|CHECK|NOT NULL/iu.test(error.message);
}

interface ApplyMappingRow {
  readonly id: string;
  readonly mapping_kind: string;
  readonly prior_scene_id: string | null;
  readonly candidate_scene_revision_id: string | null;
  readonly resolution: string | null;
  readonly resolved_scene_id: string | null;
  readonly confidence_basis_json: string;
  readonly candidate_scene_id: string | null;
  readonly display_number: string | null;
  readonly slugline: string | null;
  readonly synopsis: string | null;
  readonly int_ext: string | null;
  readonly time_of_day: string | null;
  readonly page_eighths: number | null;
  readonly sort_rank: string | null;
  readonly scene_revision_id: string | null;
  readonly source_start_block_id: string | null;
  readonly source_end_block_id: string | null;
  readonly content_hash: string | null;
}
