import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { uuidV7From } from "@swp/domain";

import { encodePassword } from "../../src/server/auth/crypto";
import { insertOrIgnore, sqlInteger, sqlJson, sqlNullableText, sqlText } from "./sql";

const FIXTURE_TIME = Date.UTC(2026, 5, 15, 8, 0, 0);
const DAY = 86_400_000;
const encoder = new TextEncoder();

export const testSeedPersistencePath = resolve(process.cwd(), ".wrangler", "test-state-v3");
export const localSeedPersistencePath = resolve(process.cwd(), ".wrangler", "state");

export function fixtureId(label: string): string {
  const random = createHash("sha256")
    .update(`sinbod-wayne-test-fixture:${label}`)
    .digest()
    .subarray(0, 10);
  return uuidV7From(FIXTURE_TIME, random);
}

export function fixtureHash(label: string): string {
  return createHash("sha256").update(`sinbod-wayne-test-fixture:${label}`).digest("hex");
}

export interface TestSeedObject {
  label: "release-v1" | "release-v2" | "project-export" | "archive-manifest";
  objectKey: string;
  contentType: string;
  bytes: Uint8Array;
  sha256: string;
}

function objectRecord(
  label: TestSeedObject["label"],
  objectKey: string,
  contentType: string,
  content: string,
): TestSeedObject {
  const bytes = encoder.encode(content);
  return {
    label,
    objectKey,
    contentType,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

export function createTestSeedObjects(): readonly TestSeedObject[] {
  const releaseV1 = objectRecord(
    "release-v1",
    `test/${id("project")}/legal/location-release-v1.pdf`,
    "application/pdf",
    "%PDF-1.4\n% Synthetic unsigned location release fixture.\n%%EOF\n",
  );
  const releaseV2 = objectRecord(
    "release-v2",
    `test/${id("project")}/legal/location-release-v2.pdf`,
    "application/pdf",
    "%PDF-1.4\n% Synthetic signed location release fixture; no legal effect.\n%%EOF\n",
  );
  const projectExport = objectRecord(
    "project-export",
    `test/${id("project")}/archive/project.json`,
    "application/json",
    `${JSON.stringify({ schemaVersion: "1", projectId: id("project"), title: "Night Bus to Noord", fictional: true })}\n`,
  );
  const archiveManifest = objectRecord(
    "archive-manifest",
    `test/${id("project")}/archive/project-manifest.json`,
    "application/json",
    `${JSON.stringify({ schemaVersion: "1", projectId: id("project"), items: [{ relativePath: "07-legal-safety/location-release-signed.pdf", objectKey: releaseV2.objectKey, byteSize: releaseV2.bytes.byteLength, sha256: releaseV2.sha256 }] })}\n`,
  );
  return [releaseV1, releaseV2, projectExport, archiveManifest];
}

function seedObject(
  objects: readonly TestSeedObject[],
  label: TestSeedObject["label"],
): TestSeedObject {
  const object = objects.find((candidate) => candidate.label === label);
  if (object === undefined) throw new Error(`Missing test seed object ${label}.`);
  return object;
}

const id = fixtureId;
const hash = fixtureHash;
const rank = (index: number): string => `a${index.toString().padStart(4, "0")}`;
const now = FIXTURE_TIME;

function commonProjectRecord(title: string, status = "active", index = 0): Record<string, string> {
  return {
    workspace_id: sqlText(id("workspace")),
    project_id: sqlText(id("project")),
    title: sqlText(title),
    status: sqlText(status),
    owner_user_id: sqlText(id("owner")),
    sort_rank: sqlText(rank(index)),
    created_at: sqlInteger(now),
    updated_at: sqlInteger(now),
  };
}

function registry(table: string, domainLabel: string, objectType: string, title: string): string {
  return insertOrIgnore("object_registry", {
    id: sqlText(id(`registry:${domainLabel}`)),
    workspace_id: sqlText(id("workspace")),
    project_id: sqlText(id("project")),
    object_type: sqlText(objectType),
    domain_table: sqlText(table),
    domain_id: sqlText(id(domainLabel)),
    title: sqlText(title),
    created_at: sqlInteger(now),
    updated_at: sqlInteger(now),
  });
}

export interface TestSeedCredentials {
  owner: Awaited<ReturnType<typeof encodePassword>>;
  producer: Awaited<ReturnType<typeof encodePassword>>;
}

export async function createTestSeedCredentials(): Promise<TestSeedCredentials> {
  return {
    owner: await encodePassword("test-only-owner-passphrase"),
    producer: await encodePassword("test-only-producer-passphrase"),
  };
}

export function buildTestSeedSql(credentials: TestSeedCredentials): string {
  const objects = createTestSeedObjects();
  const releaseV1 = seedObject(objects, "release-v1");
  const releaseV2 = seedObject(objects, "release-v2");
  const projectExport = seedObject(objects, "project-export");
  const archiveManifest = seedObject(objects, "archive-manifest");
  const statements: string[] = ["PRAGMA foreign_keys = ON;"];
  statements.push(
    insertOrIgnore("workspaces", {
      id: sqlText(id("workspace")),
      name: sqlText("Sinbod Wayne Test Workspace"),
      company_name: sqlText("Sinbod Wayne"),
      timezone: sqlText("Europe/Amsterdam"),
      locale: sqlText("en-GB"),
      currency: sqlText("EUR"),
      unit_system: sqlText("metric"),
      temperature_unit: sqlText("celsius"),
      paper_size: sqlText("A4"),
      created_at: sqlInteger(now),
      updated_at: sqlInteger(now),
    }),
  );

  const testUsers = [
    {
      label: "owner",
      username: "TestOwner",
      displayName: "Alex Example",
      role: "workspace_owner",
      credential: credentials.owner,
    },
    {
      label: "producer",
      username: "TestProducer",
      displayName: "Robin Example",
      role: "producer",
      credential: credentials.producer,
    },
  ] as const;
  for (const user of testUsers) {
    statements.push(
      insertOrIgnore("user_identities", {
        id: sqlText(id(user.label)),
        workspace_id: sqlText(id("workspace")),
        username: sqlText(user.username),
        display_name: sqlText(user.displayName),
        role: sqlText(user.role),
        status: sqlText("active"),
        current_password_credential_id: sqlText(id(`${user.label}:credential`)),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now),
      }),
      insertOrIgnore("password_credentials", {
        id: sqlText(id(`${user.label}:credential`)),
        workspace_id: sqlText(id("workspace")),
        user_id: sqlText(id(user.label)),
        kdf: sqlText(user.credential.kdf),
        parameters_json: sqlText(user.credential.parameters),
        encoded_hash: sqlText(user.credential.encodedHash),
        created_at: sqlInteger(now),
      }),
      insertOrIgnore("workspace_memberships", {
        id: sqlText(id(`${user.label}:membership`)),
        workspace_id: sqlText(id("workspace")),
        user_id: sqlText(id(user.label)),
        role: sqlText(user.role),
        status: sqlText("active"),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now),
      }),
    );
  }

  statements.push(
    insertOrIgnore("projects", {
      id: sqlText(id("project")),
      workspace_id: sqlText(id("workspace")),
      title: sqlText("Night Bus to Noord"),
      working_title: sqlText("Night Bus"),
      code: sqlText("NBT-001"),
      type: sqlText("short_film"),
      phase: sqlText("ready_to_shoot"),
      status: sqlText("active"),
      company: sqlText("Sinbod Wayne"),
      owner_user_id: sqlText(id("owner")),
      logline: sqlText(
        "On her final route before dawn, a bus driver must return a passenger's lost memory before the city wakes.",
      ),
      format: sqlText("Narrative short"),
      target_runtime_ms: sqlInteger(480_000),
      aspect_ratio: sqlText("2.00:1"),
      resolution: sqlText("4K UHD"),
      frame_rate_numerator: sqlInteger(24),
      frame_rate_denominator: sqlInteger(1),
      drop_frame: sqlInteger(0),
      starts_on: sqlText("2026-06-15"),
      ends_on: sqlText("2026-08-15"),
      timezone: sqlText("Europe/Amsterdam"),
      locale: sqlText("en-GB"),
      currency: sqlText("EUR"),
      unit_system: sqlText("metric"),
      paper_size: sqlText("A4"),
      confidentiality: sqlText("Internal test fixture — fictional"),
      enabled_modules_json: sqlJson([
        "development",
        "writing",
        "breakdown",
        "visual",
        "planning",
        "readiness",
      ]),
      readiness_state: sqlText("ready"),
      readiness_score: sqlInteger(100),
      created_at: sqlInteger(now),
      updated_at: sqlInteger(now + DAY),
    }),
    insertOrIgnore("ideas", {
      id: sqlText(id("idea")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      title: sqlText("The last night bus remembers its passengers"),
      type: sqlText("short_film"),
      source: sqlText("Original fictional test fixture"),
      status: sqlText("promoted"),
      summary: sqlText("A driver discovers that an empty bus is carrying memories toward dawn."),
      owner_user_id: sqlText(id("owner")),
      sort_rank: sqlText(rank(1)),
      details_json: sqlJson({ tags: ["night", "memory", "Amsterdam"], fictional: true }),
      promoted_at: sqlInteger(now + 1_000),
      created_at: sqlInteger(now),
      updated_at: sqlInteger(now + 1_000),
    }),
  );
  statements.push(registry("projects", "project", "project", "Night Bus to Noord"));
  for (const [index, user] of testUsers.entries()) {
    statements.push(
      insertOrIgnore("project_memberships", {
        id: sqlText(id(`${user.label}:project-membership`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        user_id: sqlText(id(user.label)),
        role: sqlText(index === 0 ? "owner" : "producer"),
        status: sqlText("active"),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now),
      }),
    );
  }
  const folderTitles = [
    "00 Project & Development",
    "01 Story & Writing",
    "02 Breakdown",
    "03 Visual Planning",
    "04 Cast & Crew",
    "05 Locations",
    "06 Budget",
    "07 Legal & Safety",
    "08 Equipment & Logistics",
    "09 Schedule",
    "10 Call Sheets & Production Packs",
    "11 Exports & Archive",
  ];
  folderTitles.forEach((title, index) =>
    statements.push(
      insertOrIgnore("folders", {
        id: sqlText(id(`folder:${index}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        title: sqlText(title),
        logical_code: sqlText(title.slice(0, 2)),
        sort_rank: sqlText(rank(index)),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now),
      }),
    ),
  );

  statements.push(
    insertOrIgnore("project_briefs", {
      id: sqlText(id("brief")),
      ...commonProjectRecord("Night Bus project brief", "approved", 1),
      summary: sqlText(
        "A compact, human-scale story designed for an eight-minute online premiere.",
      ),
      purpose: sqlText("Explore how routine places can hold emotional memory."),
      creative_intent: sqlText("Quiet suspense resolving into warmth at first light."),
      target_audience: sqlText("European short-film and narrative-video audiences aged 16+."),
      intended_effect: sqlText("Leave viewers noticing ordinary late-night spaces differently."),
      format_platform: sqlText("Festival and online narrative short"),
      target_duration_ms: sqlInteger(480_000),
      budget_min_minor: sqlInteger(800_000),
      budget_max_minor: sqlInteger(1_200_000),
      currency: sqlText("EUR"),
      current_revision_id: sqlText(id("brief:revision")),
      details_json: sqlJson({
        constraints: ["one shoot day", "contained bus interior"],
        successCriteria: ["approved six-scene cut"],
      }),
    }),
    insertOrIgnore("development_revisions", {
      id: sqlText(id("brief:revision")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      project_brief_id: sqlText(id("brief")),
      revision_number: sqlInteger(1),
      title: sqlText("Approved brief"),
      body_json: sqlJson({ purpose: "Explore memory in routine places", approved: true }),
      content_hash: sqlText(hash("brief:revision")),
      author_user_id: sqlText(id("owner")),
      notes: sqlText("Approved for test fixture"),
      created_at: sqlInteger(now + 2_000),
    }),
    insertOrIgnore("development_documents", {
      id: sqlText(id("treatment")),
      ...commonProjectRecord("Night Bus treatment", "approved", 2),
      document_type: sqlText("treatment"),
      summary: sqlText(
        "Mara drives the final route and helps Ivo recover a memory left aboard years earlier.",
      ),
      current_revision_id: sqlText(id("treatment:revision")),
      details_json: sqlJson({ tone: "restrained magical realism", versioned: true }),
    }),
    insertOrIgnore("development_revisions", {
      id: sqlText(id("treatment:revision")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      development_document_id: sqlText(id("treatment")),
      revision_number: sqlInteger(1),
      title: sqlText("Approved treatment"),
      body_json: sqlJson({ sections: ["Last route", "The lost ticket", "Dawn crossing"] }),
      content_hash: sqlText(hash("treatment:revision")),
      author_user_id: sqlText(id("producer")),
      created_at: sqlInteger(now + 3_000),
    }),
    insertOrIgnore("outlines", {
      id: sqlText(id("outline")),
      ...commonProjectRecord("Six-scene outline", "approved", 3),
      summary: sqlText("Three sequences across one continuous night route."),
      details_json: sqlJson({ totalPageEstimateEighths: 48 }),
    }),
  );
  [
    ["act", "Departure", "The last route begins."],
    ["sequence", "Discovery", "A forgotten ticket glows."],
    ["beat", "Passenger appears", "Ivo boards without a reflection."],
    ["beat", "Memory returned", "The river crossing unlocks the memory."],
    ["card", "Arrival", "Mara reaches Noord at dawn."],
  ].forEach(([type, title, summary], index) =>
    statements.push(
      insertOrIgnore("beats", {
        id: sqlText(id(`beat:${index}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        outline_id: sqlText(id("outline")),
        beat_type: sqlText(type!),
        title: sqlText(title!),
        summary: sqlText(summary!),
        status: sqlText("approved"),
        duration_estimate_ms: sqlInteger(90_000),
        page_estimate_eighths: sqlInteger(index === 4 ? 8 : 10),
        sort_rank: sqlText(rank(index)),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now),
      }),
    ),
  );
  [
    ["Mara Vos", "A disciplined night-bus driver who avoids unfinished goodbyes."],
    ["Ivo", "A gentle passenger searching for the memory attached to an old ticket."],
    ["Nina", "A depot controller whose practical voice keeps Mara grounded."],
  ].forEach(([title, summary], index) =>
    statements.push(
      insertOrIgnore("character_profiles", {
        id: sqlText(id(`character-profile:${index}`)),
        ...commonProjectRecord(title!, "approved", index),
        summary: sqlText(summary!),
        wants: sqlText(
          index === 0 ? "Finish the route without disruption" : "Recover what was forgotten",
        ),
        needs: sqlText("Accept that memory changes when shared"),
        conflict: sqlText("The route and the memory are both running out of time"),
        arc: sqlText("From guarded routine to deliberate connection"),
        details_json: sqlJson({ fictional: true }),
      }),
    ),
  );
  statements.push(
    insertOrIgnore("research_items", {
      id: sqlText(id("research")),
      ...commonProjectRecord("Night-bus accessibility and depot research", "approved", 1),
      summary: sqlText("Original notes on safe late-night transit staging."),
      source_url: sqlText("https://example.invalid/fictional-transit-reference"),
      citation: sqlText("Fictional fixture source; not for publication."),
      provenance: sqlText("Created for automated testing"),
      copyright_clearance_status: sqlText("cleared_original"),
      captured_notes: sqlText(
        "Keep all boarding action step-free and preserve an emergency aisle.",
      ),
      details_json: sqlJson({ fictional: true }),
    }),
  );

  statements.push(
    insertOrIgnore("screenplays", {
      id: sqlText(id("screenplay")),
      ...commonProjectRecord("Night Bus to Noord", "approved", 1),
      current_revision_id: sqlText(id("script:revision:2")),
      approved_revision_id: sqlText(id("script:revision:2")),
      numbering_locked: sqlInteger(1),
      frame_rate_numerator: sqlInteger(24),
      frame_rate_denominator: sqlInteger(1),
      paper_size: sqlText("A4"),
      details_json: sqlJson({ source: "native", fictional: true }),
    }),
  );
  for (const revisionNumber of [1, 2]) {
    statements.push(
      insertOrIgnore("script_revisions", {
        id: sqlText(id(`script:revision:${revisionNumber}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        screenplay_id: sqlText(id("screenplay")),
        revision_number: sqlInteger(revisionNumber),
        name: sqlText(revisionNumber === 1 ? "White draft" : "Blue revision"),
        revision_color: sqlText(revisionNumber === 1 ? "white" : "blue"),
        notes: sqlText(
          revisionNumber === 1 ? "Initial six-scene draft" : "Approved timing and slugline polish",
        ),
        content_hash: sqlText(hash(`script:revision:${revisionNumber}`)),
        source_format: sqlText("native"),
        import_warnings_json: sqlText("[]"),
        author_user_id: sqlText(revisionNumber === 1 ? id("owner") : id("producer")),
        created_at: sqlInteger(now + revisionNumber * DAY),
      }),
    );
  }
  const scenes = [
    ["1", "EXT. CENTRAL STATION BUS BAY - NIGHT", "Mara begins the final route."],
    ["2", "INT. NIGHT BUS - MOVING - NIGHT", "A forgotten paper ticket begins to glow."],
    ["3", "INT. NIGHT BUS - REAR SEATS - NIGHT", "Ivo appears and asks for the final stop."],
    ["4", "EXT. IJ RIVER CROSSING - PRE-DAWN", "The city lights trigger Ivo's missing memory."],
    ["5", "INT. NIGHT BUS - NOORD APPROACH - DAWN", "Mara chooses to hear the whole story."],
    ["6", "EXT. NOORD TERMINUS - DAWN", "The doors open on an empty but changed bus."],
  ] as const;
  for (const [index, scene] of scenes.entries()) {
    const [displayNumber, slugline, synopsis] = scene;
    const sceneId = id(`scene:${index + 1}`);
    const blockIds = ["heading", "action", "character", "dialogue"].map((kind) =>
      id(`block:${index + 1}:${kind}`),
    );
    statements.push(
      insertOrIgnore("scenes", {
        id: sqlText(sceneId),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        screenplay_id: sqlText(id("screenplay")),
        display_number: sqlText(displayNumber),
        locked_number_key: sqlText(displayNumber),
        current_scene_revision_id: sqlText(id(`scene-revision:2:${index + 1}`)),
        slugline: sqlText(slugline),
        synopsis: sqlText(synopsis),
        int_ext: sqlText(slugline.startsWith("INT") ? "INT" : "EXT"),
        time_of_day: sqlText(slugline.includes("DAWN") ? "DAWN" : "NIGHT"),
        story_day: sqlText("1"),
        page_eighths: sqlInteger(8),
        sort_rank: sqlText(rank(index)),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now + 2 * DAY),
      }),
    );
    for (const revisionNumber of [1, 2]) {
      const revisionId = id(`script:revision:${revisionNumber}`);
      const revisionSlugline =
        revisionNumber === 2 && index === 2 ? "INT. NIGHT BUS - BACK ROW - NIGHT" : slugline;
      const contents = [
        revisionSlugline,
        synopsis,
        index === 0 ? "MARA" : "IVO",
        "We only carry what we are ready to remember.",
      ];
      ["scene_heading", "action", "character", "dialogue"].forEach((blockType, blockIndex) =>
        statements.push(
          insertOrIgnore("script_block_revisions", {
            id: sqlText(id(`block-revision:${revisionNumber}:${index + 1}:${blockIndex}`)),
            workspace_id: sqlText(id("workspace")),
            project_id: sqlText(id("project")),
            screenplay_id: sqlText(id("screenplay")),
            script_revision_id: sqlText(revisionId),
            stable_block_id: sqlText(blockIds[blockIndex]!),
            block_type: sqlText(blockType),
            text_content: sqlText(contents[blockIndex]!),
            attributes_json: sqlText("{}"),
            sort_rank: sqlText(rank(index * 10 + blockIndex)),
            created_at: sqlInteger(now + revisionNumber * DAY),
          }),
        ),
      );
      statements.push(
        insertOrIgnore("scene_revisions", {
          id: sqlText(id(`scene-revision:${revisionNumber}:${index + 1}`)),
          workspace_id: sqlText(id("workspace")),
          project_id: sqlText(id("project")),
          scene_id: sqlText(sceneId),
          script_revision_id: sqlText(revisionId),
          source_start_block_id: sqlText(blockIds[0]!),
          source_end_block_id: sqlText(blockIds[3]!),
          display_number: sqlText(displayNumber),
          slugline: sqlText(revisionSlugline),
          synopsis: sqlText(synopsis),
          int_ext: sqlText(slugline.startsWith("INT") ? "INT" : "EXT"),
          time_of_day: sqlText(slugline.includes("DAWN") ? "DAWN" : "NIGHT"),
          page_eighths: sqlInteger(8),
          sort_rank: sqlText(rank(index)),
          content_hash: sqlText(hash(`scene-revision:${revisionNumber}:${index + 1}`)),
          created_at: sqlInteger(now + revisionNumber * DAY),
        }),
      );
    }
  }
  statements.push(
    insertOrIgnore("script_syncs", {
      id: sqlText(id("script-sync")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      screenplay_id: sqlText(id("screenplay")),
      from_revision_id: sqlText(id("script:revision:1")),
      to_revision_id: sqlText(id("script:revision:2")),
      status: sqlText("applied"),
      impact_summary_json: sqlJson({ matched: 5, revised: 1, ambiguous: 0, removed: 0 }),
      mapping_hash: sqlText(hash("script-sync:mapping")),
      created_by_user_id: sqlText(id("producer")),
      applied_by_user_id: sqlText(id("owner")),
      applied_at: sqlInteger(now + 2 * DAY),
      created_at: sqlInteger(now + 2 * DAY),
      updated_at: sqlInteger(now + 2 * DAY),
    }),
  );
  scenes.forEach((_, index) =>
    statements.push(
      insertOrIgnore("scene_mappings", {
        id: sqlText(id(`scene-mapping:${index + 1}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        script_sync_id: sqlText(id("script-sync")),
        prior_scene_id: sqlText(id(`scene:${index + 1}`)),
        candidate_scene_revision_id: sqlText(id(`scene-revision:2:${index + 1}`)),
        mapping_kind: sqlText(index === 2 ? "revised" : "matched"),
        confidence_basis_json: sqlJson({ stableBlocks: true, score: index === 2 ? 0.82 : 1 }),
        resolution: sqlText("accept"),
        resolved_scene_id: sqlText(id(`scene:${index + 1}`)),
        resolved_by_user_id: sqlText(id("owner")),
        resolved_at: sqlInteger(now + 2 * DAY),
        created_at: sqlInteger(now + 2 * DAY),
        updated_at: sqlInteger(now + 2 * DAY),
      }),
    ),
  );

  statements.push(
    insertOrIgnore("av_scripts", {
      id: sqlText(id("av-script")),
      ...commonProjectRecord("Thirty-second night bus teaser", "approved", 1),
      template_kind: sqlText("commercial"),
      frame_rate_numerator: sqlInteger(24),
      frame_rate_denominator: sqlInteger(1),
      current_revision_id: sqlText(id("av-revision")),
      details_json: sqlJson({ columns: ["visual", "audio"] }),
    }),
    insertOrIgnore("av_revisions", {
      id: sqlText(id("av-revision")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      av_script_id: sqlText(id("av-script")),
      revision_number: sqlInteger(1),
      name: sqlText("Approved teaser"),
      snapshot_json: sqlJson({ segments: 1, rows: 2 }),
      content_hash: sqlText(hash("av-revision")),
      total_frames: sqlInteger(720),
      word_count: sqlInteger(18),
      author_user_id: sqlText(id("producer")),
      created_at: sqlInteger(now + 3 * DAY),
    }),
    insertOrIgnore("av_segments", {
      id: sqlText(id("av-segment")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      av_script_id: sqlText(id("av-script")),
      title: sqlText("Teaser"),
      status: sqlText("approved"),
      sort_rank: sqlText(rank(1)),
      created_at: sqlInteger(now),
      updated_at: sqlInteger(now),
    }),
  );
  [
    ["Bus lights wake one by one.", "A low electrical hum.", 360],
    ["The empty rear seat catches sunrise.", "VO: Some routes remember us.", 360],
  ].forEach(([visual, audio, frames], index) =>
    statements.push(
      insertOrIgnore("av_rows", {
        id: sqlText(id(`av-row:${index}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        av_script_id: sqlText(id("av-script")),
        av_segment_id: sqlText(id("av-segment")),
        row_type: sqlText("content"),
        visual: sqlText(String(visual)),
        audio: sqlText(String(audio)),
        status: sqlText("approved"),
        duration_frames: sqlInteger(Number(frames)),
        sort_rank: sqlText(rank(index)),
        details_json: sqlText("{}"),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now),
      }),
    ),
  );

  scenes.forEach((scene, index) =>
    statements.push(
      insertOrIgnore("scene_breakdowns", {
        id: sqlText(id(`breakdown:${index + 1}`)),
        ...commonProjectRecord(`Scene ${scene[0]} breakdown`, "complete", index),
        scene_id: sqlText(id(`scene:${index + 1}`)),
        source_scene_revision_id: sqlText(id(`scene-revision:2:${index + 1}`)),
        page_eighths: sqlInteger(8),
        chronology_rank: sqlText(rank(index)),
        prep_estimate_ms: sqlInteger(20 * 60_000),
        shoot_estimate_ms: sqlInteger(45 * 60_000),
        readiness_state: sqlText("ready"),
        details_json: sqlJson({ source: "script", override: false }),
      }),
    ),
  );
  const categories = [
    ["cast", "Cast / Characters"],
    ["props", "Props"],
    ["wardrobe", "Wardrobe"],
    ["sound", "Sound"],
    ["safety", "Safety / Hazards"],
  ] as const;
  categories.forEach(([code, title], index) =>
    statements.push(
      insertOrIgnore("element_categories", {
        id: sqlText(id(`category:${code}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        code: sqlText(code),
        title: sqlText(title),
        is_seeded: sqlInteger(1),
        sort_rank: sqlText(rank(index)),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now),
      }),
    ),
  );
  const elements = [
    ["paper-ticket", "Paper ticket", "props", "ready", 2],
    ["driver-coat", "Mara's navy driver coat", "wardrobe", "ready", 1],
    ["bus-hum", "Practical bus electrical hum", "sound", "ready", 1],
    ["road-control", "Night road traffic control", "safety", "ready", 1],
  ] as const;
  elements.forEach(([label, title, category, status, quantity], index) => {
    statements.push(
      insertOrIgnore("elements", {
        id: sqlText(id(`element:${label}`)),
        ...commonProjectRecord(title, status, index),
        category_id: sqlText(id(`category:${category}`)),
        quantity: sqlInteger(quantity),
        procurement_status: sqlText("ready"),
        cost_minor: sqlInteger(index * 2_500),
        currency: sqlText("EUR"),
        continuity_notes: sqlText("Track by scene and story day."),
        details_json: sqlJson({ fictional: true }),
      }),
      insertOrIgnore("scene_element_tags", {
        id: sqlText(id(`tag:${label}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        scene_id: sqlText(id(`scene:${(index % 6) + 1}`)),
        element_id: sqlText(id(`element:${label}`)),
        source_kind: sqlText(index < 2 ? "script_range" : "manual"),
        source_revision_id: sqlText(id("script:revision:2")),
        source_start_block_id: sqlNullableText(
          index < 2 ? id(`block:${(index % 6) + 1}:action`) : null,
        ),
        source_end_block_id: sqlNullableText(
          index < 2 ? id(`block:${(index % 6) + 1}:action`) : null,
        ),
        created_by_user_id: sqlText(id("producer")),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now),
      }),
    );
  });

  const departments = [
    ["production", "Production"],
    ["directing", "Directing"],
    ["camera", "Camera"],
    ["sound", "Sound"],
    ["art", "Art"],
    ["safety", "Safety"],
  ] as const;
  departments.forEach(([code, title], index) =>
    statements.push(
      insertOrIgnore("departments", {
        id: sqlText(id(`department:${code}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        code: sqlText(code),
        title: sqlText(title),
        color: sqlText(["#e5ad42", "#51c4c7", "#83c968", "#b47bd5", "#e0665d", "#edf1ef"][index]!),
        sort_rank: sqlText(rank(index)),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now),
      }),
      insertOrIgnore("role_definitions", {
        id: sqlText(id(`role:${code}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        department_id: sqlText(id(`department:${code}`)),
        code: sqlText(code === "directing" ? "director" : `${code}_lead`),
        title: sqlText(code === "directing" ? "Director" : `${title} Lead`),
        sort_rank: sqlText(rank(index)),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now),
      }),
    ),
  );
  const people = [
    ["mara-actor", "Samira", "de Wit", "cast", "Mara Vos", "booked"],
    ["ivo-actor", "Tomas", "van Leeuwen", "cast", "Ivo", "booked"],
    ["nina-actor", "Elin", "Smit", "cast", "Nina", "booked"],
    ["line-producer", "Jules", "Example", "production", "Line Producer", "confirmed"],
    ["director", "Noor", "Example", "directing", "Director", "confirmed"],
    ["dop", "Pim", "Example", "camera", "Director of Photography", "confirmed"],
    ["sound-mixer", "Aya", "Example", "sound", "Sound Mixer", "confirmed"],
    ["art-lead", "Mika", "Example", "art", "Art Lead", "confirmed"],
    ["safety-lead", "Roos", "Example", "safety", "Safety Lead", "confirmed"],
  ] as const;
  people.forEach(([label, givenName, familyName, department, jobTitle, booking], index) => {
    statements.push(
      insertOrIgnore("people", {
        id: sqlText(id(`person:${label}`)),
        ...commonProjectRecord(`${givenName} ${familyName}`, "active", index),
        summary: sqlText(`Fictional ${jobTitle.toLowerCase()} record for automated testing.`),
        given_name: sqlText(givenName),
        family_name: sqlText(familyName),
        provenance: sqlText("Synthetic test fixture"),
        consent_status: sqlText("documented_test_fixture"),
        details_json: sqlJson({ fictional: true }),
      }),
      insertOrIgnore("contact_points", {
        id: sqlText(id(`contact:${label}`)),
        workspace_id: sqlText(id("workspace")),
        person_id: sqlText(id(`person:${label}`)),
        type: sqlText("email"),
        label: sqlText("Test"),
        value: sqlText(`${label}@example.invalid`),
        is_primary: sqlInteger(1),
        consent_status: sqlText("test_fixture"),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now),
      }),
    );
    if (department !== "cast") {
      statements.push(
        insertOrIgnore("person_project_roles", {
          id: sqlText(id(`person-role:${label}`)),
          workspace_id: sqlText(id("workspace")),
          project_id: sqlText(id("project")),
          person_id: sqlText(id(`person:${label}`)),
          department_id: sqlText(id(`department:${department}`)),
          role_definition_id: sqlText(id(`role:${department}`)),
          job_title: sqlText(jobTitle),
          booking_status: sqlText(booking),
          availability_status: sqlText("available"),
          currency: sqlText("EUR"),
          rate_unit: sqlText("day"),
          deal_memo_status: sqlText("complete"),
          confirmation_status: sqlText("confirmed"),
          created_at: sqlInteger(now),
          updated_at: sqlInteger(now),
        }),
      );
    }
  });
  ["MARA VOS", "IVO", "NINA"].forEach((name, index) => {
    statements.push(
      insertOrIgnore("characters", {
        id: sqlText(id(`character:${index}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        character_profile_id: sqlText(id(`character-profile:${index}`)),
        screenplay_id: sqlText(id("screenplay")),
        name: sqlText(name),
        normalized_name: sqlText(name),
        speaking: sqlInteger(1),
        status: sqlText("booked"),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now),
      }),
      insertOrIgnore("casting_roles", {
        id: sqlText(id(`casting-role:${index}`)),
        ...commonProjectRecord(name, "booked", index),
        character_id: sqlText(id(`character:${index}`)),
        playing_age: sqlText(index === 1 ? "25–40" : "30–50"),
        required_skills: sqlText(
          index === 0 ? "Confident driving performance" : "Naturalistic dialogue",
        ),
        details_json: sqlJson({ scenes: index === 2 ? [1, 6] : [1, 2, 3, 4, 5, 6] }),
      }),
      insertOrIgnore("candidates", {
        id: sqlText(id(`candidate:${index}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        casting_role_id: sqlText(id(`casting-role:${index}`)),
        person_id: sqlText(id(`person:${["mara-actor", "ivo-actor", "nina-actor"][index]}`)),
        status: sqlText("booked"),
        source: sqlText("Fictional direct submission"),
        reel_links_json: sqlJson(["https://example.invalid/fictional-reel"]),
        consent_status: sqlText("documented_test_fixture"),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now),
      }),
      insertOrIgnore("cast_assignments", {
        id: sqlText(id(`cast-assignment:${index}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        character_id: sqlText(id(`character:${index}`)),
        person_id: sqlText(id(`person:${["mara-actor", "ivo-actor", "nina-actor"][index]}`)),
        casting_role_id: sqlText(id(`casting-role:${index}`)),
        status: sqlText("confirmed"),
        confirmed_at: sqlInteger(now + 4 * DAY),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now + 4 * DAY),
      }),
    );
  });
  statements.push(
    insertOrIgnore("auditions", {
      id: sqlText(id("audition")),
      ...commonProjectRecord("Mara chemistry read", "complete", 1),
      casting_role_id: sqlText(id("casting-role:0")),
      starts_at: sqlInteger(now + 5 * DAY),
      ends_at: sqlInteger(now + 5 * DAY + 60 * 60_000),
      timezone: sqlText("Europe/Amsterdam"),
      location_or_link: sqlText("Fictional rehearsal room"),
      instructions: sqlText("Use the synthetic sides package."),
      details_json: sqlJson({ manualReminderLogged: true }),
    }),
    insertOrIgnore("audition_slots", {
      id: sqlText(id("audition-slot")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      audition_id: sqlText(id("audition")),
      candidate_id: sqlText(id("candidate:0")),
      starts_at: sqlInteger(now + 5 * DAY),
      ends_at: sqlInteger(now + 5 * DAY + 30 * 60_000),
      attendance_state: sqlText("attended"),
      created_at: sqlInteger(now),
      updated_at: sqlInteger(now + 5 * DAY),
    }),
  );

  const locations = [
    ["station", "Fictional Central Bus Bay", "confirmed", "approved", "ready", "ready"],
    ["depot", "Fictional Noord Depot", "candidate", "changes_requested", "pending", "blocked"],
  ] as const;
  locations.forEach(([label, title, status, approval, legal, safety], index) =>
    statements.push(
      insertOrIgnore("locations", {
        id: sqlText(id(`location:${label}`)),
        ...commonProjectRecord(title, status, index),
        summary: sqlText(
          index === 0
            ? "Primary bus bay and controlled road exterior."
            : "Backup depot initially blocked by access review.",
        ),
        address_json: sqlJson({ city: "Amsterdam", country: "NL", fictional: true }),
        latitude: "52.377956",
        longitude: "4.897070",
        map_url: sqlText("https://www.openstreetmap.org/"),
        timezone: sqlText("Europe/Amsterdam"),
        fee_minor: sqlInteger(index === 0 ? 75_000 : 30_000),
        currency: sqlText("EUR"),
        availability_state: sqlText(index === 0 ? "confirmed" : "hold"),
        legal_state: sqlText(legal),
        safety_state: sqlText(safety),
        approval_state: sqlText(approval),
        details_json: sqlJson({
          access: "step-free",
          parking: "unit van bay",
          hospital: "Fictional City Hospital",
          fictional: true,
        }),
      }),
      insertOrIgnore("scout_visits", {
        id: sqlText(id(`scout:${label}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        location_id: sqlText(id(`location:${label}`)),
        title: sqlText(`${title} scout`),
        status: sqlText("complete"),
        visited_at: sqlInteger(now + 6 * DAY + index * 60_000),
        timezone: sqlText("Europe/Amsterdam"),
        notes: sqlText(
          index === 0
            ? "Approved with controlled loading access."
            : "Access gate requires revised permit.",
        ),
        decision: sqlText(index === 0 ? "approved" : "blocked"),
        details_json: sqlJson({ attendees: ["Director", "Safety Lead"], fictional: true }),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now + 6 * DAY),
      }),
    ),
  );

  statements.push(
    insertOrIgnore("boards", {
      id: sqlText(id("board")),
      ...commonProjectRecord("Night transit mood board", "approved", 1),
      summary: sqlText("Cool practical light giving way to restrained amber dawn."),
      board_type: sqlText("mood_board"),
      layout: sqlText("masonry"),
      background: sqlText("#080d10"),
      details_json: sqlJson({ presentationReady: true }),
    }),
    insertOrIgnore("board_groups", {
      id: sqlText(id("board-group")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      board_id: sqlText(id("board")),
      title: sqlText("Night to dawn palette"),
      layout: sqlText("grid"),
      sort_rank: sqlText(rank(1)),
      created_at: sqlInteger(now),
      updated_at: sqlInteger(now),
    }),
  );
  [
    ["Cyan practicals", "Cool fluorescent pools inside the bus."],
    ["Amber horizon", "A narrow warm edge at the terminus."],
    ["Wet glass", "Reflections remain crisp and controlled."],
  ].forEach(([title, caption], index) =>
    statements.push(
      insertOrIgnore("board_items", {
        id: sqlText(id(`board-item:${index}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        board_id: sqlText(id("board")),
        board_group_id: sqlText(id("board-group")),
        item_type: sqlText("link"),
        title: sqlText(title!),
        caption: sqlText(caption!),
        external_url: sqlText(`https://example.invalid/fictional-reference-${index + 1}`),
        is_favorite: sqlInteger(index === 0 ? 1 : 0),
        sort_rank: sqlText(rank(index)),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now),
      }),
    ),
  );
  statements.push(
    insertOrIgnore("storyboards", {
      id: sqlText(id("storyboard")),
      ...commonProjectRecord("Main sequence storyboard", "approved", 1),
      summary: sqlText("Six fictional text-only frames for the primary sequence."),
      grouping_mode: sqlText("scene"),
      details_json: sqlJson({ textOnlyFixture: true }),
    }),
    insertOrIgnore("shot_lists", {
      id: sqlText(id("shot-list")),
      ...commonProjectRecord("Approved master shot list", "approved", 1),
      summary: sqlText("Eight shots across two setups."),
      grouping_mode: sqlText("setup"),
      details_json: sqlJson({ mustHaveCount: 6, niceToHaveCount: 2 }),
    }),
  );
  [
    ["setup-a", "Bus interior moving master", "Cinema camera A", "24mm and 35mm", 1_800_000],
    ["setup-b", "Terminus dawn coverage", "Cinema camera A", "50mm and 85mm", 1_200_000],
  ].forEach(([label, title, camera, lenses, duration], index) =>
    statements.push(
      insertOrIgnore("camera_setups", {
        id: sqlText(id(String(label))),
        ...commonProjectRecord(String(title), "approved", index),
        camera_body: sqlText(String(camera)),
        lens_plan: sqlText(String(lenses)),
        support: sqlText(index === 0 ? "Low-profile dolly" : "Tripod"),
        lighting_plan: sqlText(
          index === 0
            ? "Practical fluorescents with soft negative fill"
            : "Natural dawn with small bounce",
        ),
        grip_power: sqlText("Battery-first; isolated practical circuit"),
        sound_playback: sqlText("Wild bus tone and concealed lavs"),
        setup_duration_ms: sqlInteger(Number(duration)),
        move_duration_ms: sqlInteger(600_000),
        details_json: sqlJson({ approved: true }),
      }),
    ),
  );
  scenes.forEach((scene, index) =>
    statements.push(
      insertOrIgnore("storyboard_frames", {
        id: sqlText(id(`storyboard-frame:${index}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        storyboard_id: sqlText(id("storyboard")),
        scene_id: sqlText(id(`scene:${index + 1}`)),
        display_number: sqlText(String(index + 1)),
        shot_number: sqlText(`${index + 1}A`),
        aspect_ratio: sqlText("2.00:1"),
        framing: sqlText(index % 2 === 0 ? "Wide" : "Medium"),
        lens: sqlText(index % 2 === 0 ? "24mm" : "50mm"),
        movement: sqlText(index === 3 ? "Slow push" : "Static"),
        camera: sqlText("A"),
        frame_rate_numerator: sqlInteger(24),
        frame_rate_denominator: sqlInteger(1),
        duration_frames: sqlInteger(120),
        location_id: sqlText(id("location:station")),
        time_of_day: sqlText(scene[1].includes("DAWN") ? "DAWN" : "NIGHT"),
        visual_description: sqlText(scene[2]),
        audio_dialogue: sqlText("Fictional production audio note."),
        status: sqlText("approved"),
        owner_user_id: sqlText(id("producer")),
        sort_rank: sqlText(rank(index)),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now),
      }),
    ),
  );
  for (let index = 0; index < 8; index += 1) {
    const sceneNumber = (index % 6) + 1;
    statements.push(
      insertOrIgnore("shots", {
        id: sqlText(id(`shot:${index + 1}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        shot_list_id: sqlText(id("shot-list")),
        scene_id: sqlText(id(`scene:${sceneNumber}`)),
        camera_setup_id: sqlText(id(index < 5 ? "setup-a" : "setup-b")),
        location_id: sqlText(id("location:station")),
        display_number: sqlText(`${sceneNumber}${String.fromCharCode(65 + Math.floor(index / 6))}`),
        title: sqlText(index === 0 ? "Empty bus bay master" : `Coverage shot ${index + 1}`),
        description: sqlText("Original fictional shot description."),
        shot_size: sqlText(index % 2 === 0 ? "WS" : "MCU"),
        angle_type: sqlText("eye_level"),
        subject: sqlText(index < 4 ? "Mara" : "Ivo"),
        movement: sqlText(index === 3 ? "push_in" : "static"),
        lens_focal_length: sqlText(index % 2 === 0 ? "24mm" : "50mm"),
        frame_rate_numerator: sqlInteger(24),
        frame_rate_denominator: sqlInteger(1),
        camera: sqlText("A"),
        aspect_ratio: sqlText("2.00:1"),
        prep_estimate_ms: sqlInteger(600_000),
        shoot_estimate_ms: sqlInteger(900_000),
        priority: sqlText(index < 6 ? "must_have" : "nice_to_have"),
        coverage_purpose: sqlText("Narrative coverage"),
        status: sqlText("approved"),
        sort_rank: sqlText(rank(index)),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now),
      }),
    );
  }
  statements.push(
    insertOrIgnore("technical_look_plans", {
      id: sqlText(id("technical-look")),
      ...commonProjectRecord("Night Bus technical look", "approved", 1),
      summary: sqlText("Cool practical night interiors transition to a restrained natural dawn."),
      camera_format: sqlText("Super 35"),
      resolution: sqlText("4K UHD"),
      codec_notes: sqlText("10-bit 4:2:2 intraframe acquisition"),
      frame_rate_numerator: sqlInteger(24),
      frame_rate_denominator: sqlInteger(1),
      shutter_convention: sqlText("180-degree equivalent"),
      aspect_ratio: sqlText("2.00:1"),
      lens_strategy: sqlText("Spherical primes; restrained close focus"),
      movement_language: sqlText("Static routine interrupted by one deliberate push"),
      color_pipeline: sqlText("Log acquisition with approved viewing LUT reference"),
      lighting_philosophy: sqlText("Motivated practicals and controlled dawn"),
      sound_approach: sqlText("Prioritise low mechanical texture and intimate dialogue"),
      vfx_methodology: sqlText("In-camera reflections; minimal cleanup only"),
      delivery_framing_notes: sqlText("Protect 16:9 centre crop"),
      details_json: sqlJson({ approved: true, fictional: true }),
    }),
  );

  statements.push(
    insertOrIgnore("vendors", {
      id: sqlText(id("vendor")),
      ...commonProjectRecord("Fictional Transit Rentals", "active", 1),
      summary: sqlText("Synthetic equipment and bus supplier."),
      address_json: sqlJson({ city: "Amsterdam", country: "NL", fictional: true }),
      payment_terms: sqlText("30 days"),
      details_json: sqlJson({ fictional: true }),
    }),
    insertOrIgnore("budgets", {
      id: sqlText(id("budget")),
      ...commonProjectRecord("Night Bus approved budget", "approved", 1),
      summary: sqlText("Approved fictional EUR budget."),
      currency: sqlText("EUR"),
      working_version_id: sqlText(id("budget-version")),
      approved_version_id: sqlText(id("budget-version")),
      details_json: sqlJson({ approvalThresholdMinor: 100_000 }),
    }),
    insertOrIgnore("budget_versions", {
      id: sqlText(id("budget-version")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      budget_id: sqlText(id("budget")),
      version_number: sqlInteger(1),
      name: sqlText("Approved budget v1"),
      status: sqlText("approved"),
      currency: sqlText("EUR"),
      exchange_rate_note: sqlText("Single-currency fixture"),
      contingency_basis_points: sqlInteger(500),
      total_estimate_minor: sqlInteger(1_000_000),
      total_approved_minor: sqlInteger(1_000_000),
      total_committed_minor: sqlInteger(825_000),
      content_hash: sqlText(hash("budget-version")),
      author_user_id: sqlText(id("owner")),
      created_at: sqlInteger(now + 7 * DAY),
    }),
  );
  const accounts = [
    ["1000", "Cast & Crew"],
    ["2000", "Locations & Transport"],
    ["3000", "Camera & Sound"],
  ] as const;
  accounts.forEach(([code, title], index) => {
    statements.push(
      insertOrIgnore("budget_accounts", {
        id: sqlText(id(`budget-account:${code}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        budget_version_id: sqlText(id("budget-version")),
        code: sqlText(code),
        title: sqlText(title),
        sort_rank: sqlText(rank(index)),
        created_at: sqlInteger(now),
      }),
      insertOrIgnore("budget_lines", {
        id: sqlText(id(`budget-line:${code}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        budget_version_id: sqlText(id("budget-version")),
        budget_account_id: sqlText(id(`budget-account:${code}`)),
        title: sqlText(title),
        notes: sqlText("Synthetic approved planning cost."),
        owner_user_id: sqlText(id("producer")),
        quantity_micros: sqlInteger(1_000_000),
        unit: sqlText("package"),
        rate_minor: sqlInteger([400_000, 250_000, 350_000][index]!),
        duration_micros: sqlInteger(1_000_000),
        subtotal_minor: sqlInteger([400_000, 250_000, 350_000][index]!),
        estimate_minor: sqlInteger([400_000, 250_000, 350_000][index]!),
        approved_minor: sqlInteger([400_000, 250_000, 350_000][index]!),
        committed_minor: sqlInteger([350_000, 200_000, 275_000][index]!),
        currency: sqlText("EUR"),
        sort_rank: sqlText(rank(index)),
        created_at: sqlInteger(now),
      }),
    );
  });
  statements.push(
    insertOrIgnore("quotes", {
      id: sqlText(id("quote")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      vendor_id: sqlText(id("vendor")),
      title: sqlText("Bus and camera support quote"),
      status: sqlText("accepted"),
      quote_number: sqlText("TEST-Q-001"),
      currency: sqlText("EUR"),
      total_minor: sqlInteger(275_000),
      valid_until: sqlText("2026-12-31"),
      created_at: sqlInteger(now),
      updated_at: sqlInteger(now),
    }),
  );

  const requirements = [
    ["location-release", "Location release", "location_release", "complete", 1],
    ["filming-permit", "Public-space filming permit", "permit", "complete", 1],
    ["insurance", "Production insurance", "insurance_certificate", "complete", 1],
    ["cast-agreement", "Cast agreements", "cast_agreement", "complete", 1],
  ] as const;
  requirements.forEach(([label, title, type, status, blocking], index) =>
    statements.push(
      insertOrIgnore("requirements", {
        id: sqlText(id(`requirement:${label}`)),
        ...commonProjectRecord(title, status, index),
        summary: sqlText("Synthetic executed requirement for readiness testing."),
        requirement_type: sqlText(type),
        jurisdiction: sqlText("NL"),
        due_at: sqlInteger(now + 14 * DAY),
        expires_at: sqlInteger(now + 180 * DAY),
        priority: sqlText("high"),
        is_blocking: sqlInteger(blocking),
        current_file_version_id:
          label === "location-release" ? sqlText(id("release-file:v2")) : "NULL",
        signed_executed_state: sqlText("executed"),
        restricted: sqlInteger(1),
        details_json: sqlJson({ fictional: true, reviewed: true }),
      }),
    ),
  );
  statements.push(
    insertOrIgnore("insurance_records", {
      id: sqlText(id("insurance-record")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      requirement_id: sqlText(id("requirement:insurance")),
      provider: sqlText("Fictional Mutual"),
      policy_number: sqlText("TEST-POLICY-001"),
      coverage_minor: sqlInteger(5_000_000),
      currency: sqlText("EUR"),
      valid_from: sqlText("2026-01-01"),
      valid_until: sqlText("2026-12-31"),
      version: sqlInteger(1),
      updated_at: sqlInteger(now),
    }),
    insertOrIgnore("risk_assessments", {
      id: sqlText(id("risk-assessment")),
      ...commonProjectRecord("Night road and vehicle risk assessment", "approved", 1),
      summary: sqlText("Controls traffic interfaces, low light, vehicle access, and fatigue."),
      review_at: sqlInteger(now + 20 * DAY),
      details_json: sqlJson({ residualRiskAccepted: true, fictional: true }),
    }),
    insertOrIgnore("hazards", {
      id: sqlText(id("hazard")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      risk_assessment_id: sqlText(id("risk-assessment")),
      title: sqlText("Vehicle movement in low light"),
      description: sqlText("Cast and crew working near a stationary picture bus at night."),
      affected_people: sqlText("All unit personnel"),
      likelihood: sqlInteger(3),
      impact: sqlInteger(4),
      initial_score: sqlInteger(12),
      residual_likelihood: sqlInteger(1),
      residual_impact: sqlInteger(4),
      residual_score: sqlInteger(4),
      owner_user_id: sqlText(id("owner")),
      status: sqlText("controlled"),
      sort_rank: sqlText(rank(1)),
      created_at: sqlInteger(now),
      updated_at: sqlInteger(now),
    }),
    insertOrIgnore("control_measures", {
      id: sqlText(id("control-measure")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      hazard_id: sqlText(id("hazard")),
      title: sqlText("Lock picture bus and appoint traffic marshal"),
      description: sqlText("No vehicle movement while unit personnel occupy the controlled zone."),
      owner_user_id: sqlText(id("owner")),
      status: sqlText("complete"),
      sort_rank: sqlText(rank(1)),
      created_at: sqlInteger(now),
      updated_at: sqlInteger(now),
    }),
    insertOrIgnore("safety_plans", {
      id: sqlText(id("safety-plan")),
      ...commonProjectRecord("Approved safety and emergency plan", "approved", 1),
      summary: sqlText("One-day fictional shoot safety plan."),
      plan_type: sqlText("safety_plan"),
      emergency_plan: sqlText("Stop work, contact emergency services, then notify the producer."),
      medical_hospital: sqlText("Fictional City Hospital — verify before live use."),
      evacuation: sqlText("Assemble at the signed depot gate."),
      weather_contingencies: sqlText("Move exterior coverage under the terminal canopy."),
      safeguarding_intimacy: sqlText(
        "Closed-set policy not required for scripted material; normal safeguarding applies.",
      ),
      details_json: sqlJson({ approved: true, fictional: true }),
    }),
  );

  const equipment = [
    ["camera", "Cinema camera body", "camera", "SWP-TEST-CAM-01"],
    ["lens", "Prime lens set", "lens", "SWP-TEST-LENS-01"],
    ["sound", "Location sound kit", "sound", "SWP-TEST-SND-01"],
  ] as const;
  equipment.forEach(([label, title, category, serial], index) =>
    statements.push(
      insertOrIgnore("equipment_items", {
        id: sqlText(id(`equipment:${label}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        title: sqlText(title),
        status: sqlText("ready"),
        summary: sqlText("Synthetic pre-shoot equipment record."),
        owner_user_id: sqlText(id("producer")),
        sort_rank: sqlText(rank(index)),
        ownership_type: sqlText(index === 2 ? "owned" : "rented"),
        category: sqlText(category),
        manufacturer: sqlText("Fictional Imaging"),
        model: sqlText(`Test ${index + 1}`),
        serial_asset_id: sqlText(serial),
        condition: sqlText("checked_ready"),
        value_minor: sqlInteger(200_000 + index * 50_000),
        currency: sqlText("EUR"),
        storage_location: sqlText("Test equipment cage"),
        vendor_id: sqlText(id("vendor")),
        details_json: sqlJson({ fictional: true }),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now),
      }),
    ),
  );
  statements.push(
    insertOrIgnore("equipment_kits", {
      id: sqlText(id("equipment-kit")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      title: sqlText("Night Bus camera and sound kit"),
      status: sqlText("ready"),
      summary: sqlText("Synthetic package; child assets remain distinct."),
      owner_user_id: sqlText(id("producer")),
      sort_rank: sqlText(rank(1)),
      details_json: sqlJson({ packingListReady: true }),
      created_at: sqlInteger(now),
      updated_at: sqlInteger(now),
    }),
  );
  equipment.forEach(([label], index) =>
    statements.push(
      insertOrIgnore("kit_members", {
        equipment_kit_id: sqlText(id("equipment-kit")),
        equipment_item_id: sqlText(id(`equipment:${label}`)),
        quantity: sqlInteger(1),
        sort_rank: sqlText(rank(index)),
      }),
    ),
  );
  statements.push(
    insertOrIgnore("rentals", {
      id: sqlText(id("rental")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      vendor_id: sqlText(id("vendor")),
      title: sqlText("Camera package rental"),
      status: sqlText("confirmed"),
      pickup_at: sqlInteger(now + 24 * DAY),
      return_at: sqlInteger(now + 26 * DAY),
      deposit_minor: sqlInteger(50_000),
      cost_minor: sqlInteger(275_000),
      currency: sqlText("EUR"),
      terms: sqlText("Synthetic fixture terms"),
      created_at: sqlInteger(now),
      updated_at: sqlInteger(now),
    }),
    insertOrIgnore("reservations", {
      id: sqlText(id("reservation")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      equipment_kit_id: sqlText(id("equipment-kit")),
      starts_at: sqlInteger(now + 24 * DAY),
      ends_at: sqlInteger(now + 26 * DAY),
      timezone: sqlText("Europe/Amsterdam"),
      status: sqlText("ready"),
      planned_custodian_person_id: sqlText(id("person:dop")),
      collection_checklist_json: sqlJson([{ title: "Serials checked", complete: true }]),
      return_checklist_json: sqlJson([{ title: "Return slots confirmed", complete: true }]),
      created_at: sqlInteger(now),
      updated_at: sqlInteger(now),
    }),
  );
  [
    ["paper-ticket", "made", "complete", 2],
    ["driver-coat", "rented", "complete", 1],
  ].forEach(([label, sourceType, status, quantity], index) =>
    statements.push(
      insertOrIgnore("procurement_records", {
        id: sqlText(id(`procurement:${label}`)),
        ...commonProjectRecord(`${label} sourcing`, String(status), index),
        element_id: sqlText(id(`element:${label}`)),
        source_type: sqlText(String(sourceType)),
        vendor_id: sqlText(id("vendor")),
        quantity: sqlInteger(Number(quantity)),
        size_measurements_json: sqlJson(label === "driver-coat" ? { fitting: "completed" } : {}),
        fitting_test_at: sqlInteger(now + 18 * DAY),
        cost_minor: sqlInteger(index === 0 ? 5_000 : 15_000),
        currency: sqlText("EUR"),
        details_json: sqlJson({ continuityPhotosPlanned: true }),
      }),
    ),
  );
  statements.push(
    insertOrIgnore("transport_plans", {
      id: sqlText(id("transport-plan")),
      ...commonProjectRecord("Unit transport plan", "approved", 1),
      summary: sqlText("One passenger van and one picture-bus movement."),
      route_map_url: sqlText("https://www.openstreetmap.org/"),
      details_json: sqlJson({ driversConfirmed: true, passengers: 9, fictional: true }),
    }),
    insertOrIgnore("travel_records", {
      id: sqlText(id("travel-record")),
      ...commonProjectRecord("Lead cast local transfer", "confirmed", 1),
      person_id: sqlText(id("person:mara-actor")),
      departs_at: sqlInteger(now + 25 * DAY),
      arrives_at: sqlInteger(now + 25 * DAY + 45 * 60_000),
      origin: sqlText("Fictional hotel"),
      destination: sqlText("Fictional Central Bus Bay"),
      booking_reference: sqlText("TEST-TRAVEL-001"),
      cost_minor: sqlInteger(4_500),
      currency: sqlText("EUR"),
      details_json: sqlJson({ fictional: true }),
    }),
    insertOrIgnore("accommodation_records", {
      id: sqlText(id("accommodation")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      person_id: sqlText(id("person:mara-actor")),
      vendor_id: sqlText(id("vendor")),
      title: sqlText("Lead cast accommodation"),
      status: sqlText("confirmed"),
      check_in_on: sqlText("2026-07-09"),
      check_out_on: sqlText("2026-07-11"),
      booking_reference: sqlText("TEST-STAY-001"),
      responsible_person_id: sqlText(id("person:line-producer")),
      cost_minor: sqlInteger(28_000),
      currency: sqlText("EUR"),
      created_at: sqlInteger(now),
      updated_at: sqlInteger(now),
    }),
    insertOrIgnore("catering_plans", {
      id: sqlText(id("catering")),
      ...commonProjectRecord("Shoot-day meals and water", "approved", 1),
      vendor_id: sqlText(id("vendor")),
      head_count: sqlInteger(12),
      meal_times_json: sqlJson([
        { label: "Breakfast", time: "05:30" },
        { label: "Lunch", time: "12:30" },
      ]),
      cost_minor: sqlInteger(36_000),
      currency: sqlText("EUR"),
      details_json: sqlJson({ restrictionsReviewedPrivately: true, waterStations: 2 }),
    }),
    insertOrIgnore("logistics_plans", {
      id: sqlText(id("logistics")),
      ...commonProjectRecord("Shoot-day logistics", "approved", 1),
      summary: sqlText("Base, holding, parking, power, security, and emergency routing."),
      base_camp: sqlText("Signed unit van bay"),
      holding: sqlText("Heated terminal room"),
      green_room: sqlText("Shared cast room"),
      toilets: sqlText("Accessible terminal toilets"),
      power_charging: sqlText("Isolated 16A circuit plus charged batteries"),
      waste: sqlText("Separated waste station"),
      security: sqlText("One access marshal"),
      access_notes: sqlText("Keep public path open at all times"),
      emergency_notes: sqlText("Emergency vehicle route remains unobstructed"),
      details_json: sqlJson({ approved: true, fictional: true }),
    }),
  );

  const registries = [
    ["ideas", "idea", "idea", "The last night bus remembers its passengers"],
    ["project_briefs", "brief", "project_brief", "Night Bus project brief"],
    ["development_documents", "treatment", "development_document", "Night Bus treatment"],
    ["outlines", "outline", "outline", "Six-scene outline"],
    ["research_items", "research", "research_item", "Night-bus research"],
    ["screenplays", "screenplay", "screenplay", "Night Bus to Noord"],
    ["av_scripts", "av-script", "av_script", "Thirty-second night bus teaser"],
    ["scene_breakdowns", "breakdown:1", "scene_breakdown", "Scene 1 breakdown"],
    ["elements", "element:paper-ticket", "element", "Paper ticket"],
    ["people", "person:mara-actor", "person", "Samira de Wit"],
    ["locations", "location:station", "location", "Fictional Central Bus Bay"],
    ["boards", "board", "board", "Night transit mood board"],
    ["storyboards", "storyboard", "storyboard", "Main sequence storyboard"],
    ["shot_lists", "shot-list", "shot_list", "Approved master shot list"],
    ["technical_look_plans", "technical-look", "technical_look_plan", "Night Bus technical look"],
    ["budgets", "budget", "budget", "Night Bus approved budget"],
    ["requirements", "requirement:location-release", "requirement", "Location release"],
    ["risk_assessments", "risk-assessment", "risk_assessment", "Night road risk assessment"],
    ["equipment_kits", "equipment-kit", "equipment_kit", "Night Bus camera and sound kit"],
    ["transport_plans", "transport-plan", "transport_plan", "Unit transport plan"],
    ["logistics_plans", "logistics", "logistics_plan", "Shoot-day logistics"],
    ["task_boards", "task-board", "task_board", "Pre-production board"],
    ["calendars", "calendar", "calendar", "Production calendar"],
    ["schedules", "schedule:primary", "schedule", "Primary schedule"],
    ["shoot_days", "shoot-day", "shoot_day", "Shoot Day 1"],
    ["call_sheet_drafts", "call-draft", "call_sheet_draft", "Shoot Day 1 call sheet"],
    [
      "production_pack_drafts",
      "pack-draft",
      "production_pack_draft",
      "Shoot Day 1 production pack",
    ],
    ["readiness_profiles", "readiness-profile", "readiness_profile", "Short film readiness"],
    ["files", "release-file", "file", "Location release"],
  ] as const;
  registries.forEach(([table, label, objectType, title]) =>
    statements.push(registry(table, label, objectType, title)),
  );

  const approvals = [
    ["brief", "Brief approval", "brief", "brief:revision"],
    ["script", "Script approval", "screenplay", "script:revision:2"],
    ["visual", "Visual plan approval", "shot-list", "shot-list"],
  ] as const;
  approvals.forEach(([label, title, registryLabel, pinned], index) =>
    statements.push(
      insertOrIgnore("approvals", {
        id: sqlText(id(`approval:${label}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        object_id: sqlText(id(`registry:${registryLabel}`)),
        title: sqlText(title),
        status: sqlText("approved"),
        summary: sqlText("Approved in the fictional test fixture."),
        owner_user_id: sqlText(id("owner")),
        approver_user_id: sqlText(id(index === 0 ? "producer" : "owner")),
        pinned_version_id: sqlText(id(pinned)),
        requested_at: sqlInteger(now + 8 * DAY),
        self_approval_allowed: sqlInteger(0),
        details_json: sqlJson({ fictional: true }),
        created_at: sqlInteger(now + 8 * DAY),
        updated_at: sqlInteger(now + 8 * DAY),
      }),
      insertOrIgnore("approval_decisions", {
        id: sqlText(id(`approval-decision:${label}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        approval_id: sqlText(id(`approval:${label}`)),
        decision: sqlText("approved"),
        actor_user_id: sqlText(id(index === 0 ? "producer" : "owner")),
        comment: sqlText("Approved for the fictional readiness fixture."),
        pinned_version_id: sqlText(id(pinned)),
        created_at: sqlInteger(now + 8 * DAY),
      }),
    ),
  );

  statements.push(
    insertOrIgnore("task_boards", {
      id: sqlText(id("task-board")),
      ...commonProjectRecord("Pre-production board", "active", 1),
      summary: sqlText("Cross-department preparation tasks."),
      details_json: sqlJson({ template: "short-film" }),
    }),
  );
  [
    ["todo", "To do"],
    ["doing", "In progress"],
    ["done", "Done"],
  ].forEach(([key, title], index) =>
    statements.push(
      insertOrIgnore("task_columns", {
        id: sqlText(id(`task-column:${key}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        task_board_id: sqlText(id("task-board")),
        title: sqlText(title!),
        status_key: sqlText(key!),
        sort_rank: sqlText(rank(index)),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now),
      }),
    ),
  );
  const tasks = [
    ["permit", "Confirm permit reference", "done", "high", "requirement:location-release"],
    ["fitting", "Complete Mara wardrobe fitting", "done", "normal", "element:paper-ticket"],
    ["pack", "Review production pack manifest", "done", "high", "logistics"],
  ] as const;
  tasks.forEach(([label, title, state, priority, linked], index) =>
    statements.push(
      insertOrIgnore("task_cards", {
        id: sqlText(id(`task:${label}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        task_board_id: sqlText(id("task-board")),
        task_column_id: sqlText(id(`task-column:${state === "done" ? "done" : "todo"}`)),
        linked_object_id: sqlText(id(`registry:${linked}`)),
        title: sqlText(title),
        status: sqlText(state),
        summary: sqlText("Completed fictional pre-production task."),
        owner_user_id: sqlText(id(index % 2 === 0 ? "owner" : "producer")),
        sort_rank: sqlText(rank(index)),
        description: sqlText("Fixture task with real dependency and checklist paths."),
        priority: sqlText(priority),
        starts_at: sqlInteger(now + 9 * DAY),
        due_at: sqlInteger(now + 12 * DAY),
        timezone: sqlText("Europe/Amsterdam"),
        estimate_ms: sqlInteger(3_600_000),
        is_blocking: sqlInteger(label === "permit" ? 1 : 0),
        details_json: sqlJson({ fixture: true }),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now + 12 * DAY),
      }),
      insertOrIgnore("task_assignees", {
        task_card_id: sqlText(id(`task:${label}`)),
        user_id: sqlText(id(index % 2 === 0 ? "owner" : "producer")),
        person_id: "NULL",
        assigned_at: sqlInteger(now),
      }),
      insertOrIgnore("checklists", {
        id: sqlText(id(`checklist:${label}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        task_card_id: sqlText(id(`task:${label}`)),
        title: sqlText("Completion checks"),
        sort_rank: sqlText(rank(1)),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now),
      }),
      insertOrIgnore("checklist_items", {
        id: sqlText(id(`checklist-item:${label}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        checklist_id: sqlText(id(`checklist:${label}`)),
        title: sqlText("Evidence linked"),
        completed: sqlInteger(1),
        completed_at: sqlInteger(now + 12 * DAY),
        completed_by_user_id: sqlText(id("producer")),
        sort_rank: sqlText(rank(1)),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now + 12 * DAY),
      }),
    ),
  );
  statements.push(
    insertOrIgnore("task_dependencies", {
      id: sqlText(id("task-dependency")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      predecessor_task_id: sqlText(id("task:permit")),
      successor_task_id: sqlText(id("task:pack")),
      dependency_type: sqlText("finish_to_start"),
      lag_ms: sqlInteger(0),
      created_at: sqlInteger(now),
    }),
    insertOrIgnore("calendars", {
      id: sqlText(id("calendar")),
      ...commonProjectRecord("Production calendar", "approved", 1),
      timezone: sqlText("Europe/Amsterdam"),
      current_revision_id: sqlText(id("calendar-revision")),
      details_json: sqlJson({ workingDays: [1, 2, 3, 4, 5] }),
    }),
    insertOrIgnore("calendar_revisions", {
      id: sqlText(id("calendar-revision")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      calendar_id: sqlText(id("calendar")),
      revision_number: sqlInteger(1),
      name: sqlText("Approved production calendar"),
      snapshot_hash: sqlText(hash("calendar-revision")),
      author_user_id: sqlText(id("producer")),
      created_at: sqlInteger(now + 10 * DAY),
    }),
    insertOrIgnore("calendar_rows", {
      id: sqlText(id("calendar-row")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      calendar_id: sqlText(id("calendar")),
      title: sqlText("Main unit"),
      color: sqlText("#e5ad42"),
      sort_rank: sqlText(rank(1)),
      created_at: sqlInteger(now),
      updated_at: sqlInteger(now),
    }),
  );
  [
    ["scout-event", "Approved location scout", "scout", 6],
    ["fitting-event", "Mara wardrobe fitting", "fitting", 18],
    ["shoot-event", "Principal photography", "shoot_day", 25],
  ].forEach(([label, title, type, dayOffset], index) =>
    statements.push(
      insertOrIgnore("calendar_events", {
        id: sqlText(id(String(label))),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        calendar_id: sqlText(id("calendar")),
        calendar_row_id: sqlText(id("calendar-row")),
        title: sqlText(String(title)),
        status: sqlText("confirmed"),
        summary: sqlText("Fictional calendar fixture event."),
        owner_user_id: sqlText(id("producer")),
        sort_rank: sqlText(rank(index)),
        event_type: sqlText(String(type)),
        starts_at: sqlInteger(now + Number(dayOffset) * DAY),
        ends_at: sqlInteger(now + Number(dayOffset) * DAY + 3_600_000),
        timezone: sqlText("Europe/Amsterdam"),
        all_day: sqlInteger(0),
        color: sqlText("#e5ad42"),
        ics_uid: sqlText(`${label}@sinbod-wayne-test.invalid`),
        ics_sequence: sqlInteger(0),
        details_json: sqlJson({ fixture: true }),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now),
      }),
    ),
  );
  statements.push(
    insertOrIgnore("event_dependencies", {
      id: sqlText(id("event-dependency")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      predecessor_event_id: sqlText(id("fitting-event")),
      successor_event_id: sqlText(id("shoot-event")),
      dependency_type: sqlText("finish_to_start"),
      lag_ms: sqlInteger(0),
      created_at: sqlInteger(now),
    }),
  );

  const schedules = [
    ["primary", "Primary schedule", 1],
    ["weather", "Weather-cover schedule", 0],
  ] as const;
  schedules.forEach(([label, title, isDefault], index) =>
    statements.push(
      insertOrIgnore("schedules", {
        id: sqlText(id(`schedule:${label}`)),
        ...commonProjectRecord(title, label === "primary" ? "approved" : "working", index),
        is_default: sqlInteger(isDefault),
        current_revision_id: sqlText(id(`schedule-revision:${label}`)),
        approved_revision_id:
          label === "primary" ? sqlText(id(`schedule-revision:${label}`)) : "NULL",
        details_json: sqlJson({ variant: label }),
      }),
      insertOrIgnore("schedule_revisions", {
        id: sqlText(id(`schedule-revision:${label}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        schedule_id: sqlText(id(`schedule:${label}`)),
        revision_number: sqlInteger(1),
        name: sqlText(`${title} revision 1`),
        source_script_revision_id: sqlText(id("script:revision:2")),
        status: sqlText(label === "primary" ? "approved" : "draft"),
        content_hash: sqlText(hash(`schedule-revision:${label}`)),
        totals_json: sqlJson({
          pageEighths: 48,
          prepMs: 7_200_000,
          shootMs: 21_600_000,
          moveMs: 1_800_000,
        }),
        author_user_id: sqlText(id("producer")),
        created_at: sqlInteger(now + 15 * DAY),
      }),
    ),
  );
  const scheduleItems = [
    ["day-break", "day_break", null, "Shoot Day 1", 0, 0, 0, 0],
    ...scenes.map((scene, index) => [
      `scene-${index + 1}`,
      "scene",
      `scene:${index + 1}`,
      scene[1],
      8,
      600_000,
      900_000,
      2_700_000,
    ]),
    ["meal", "meal", null, "Lunch", 0, 0, 0, 2_700_000],
    ["company-move", "company_move", null, "Company move to terminus", 0, 0, 0, 0],
  ] as const;
  scheduleItems.forEach(
    ([label, itemType, sceneLabel, title, eighths, prep, setup, shoot], index) =>
      statements.push(
        insertOrIgnore("schedule_items", {
          id: sqlText(id(`schedule-item:${label}`)),
          workspace_id: sqlText(id("workspace")),
          project_id: sqlText(id("project")),
          schedule_revision_id: sqlText(id("schedule-revision:primary")),
          item_type: sqlText(String(itemType)),
          scene_id: sceneLabel === null ? "NULL" : sqlText(id(String(sceneLabel))),
          title: sqlText(String(title)),
          shoot_date: sqlText("2026-07-10"),
          unit: sqlText("Main"),
          day_count: sqlInteger(1),
          general_call_local: sqlText("05:30"),
          estimated_start_local: sqlText("06:30"),
          estimated_wrap_local: sqlText("18:30"),
          timezone: sqlText("Europe/Amsterdam"),
          location_id: sqlText(id("location:station")),
          page_eighths: sqlInteger(Number(eighths)),
          prep_duration_ms: sqlInteger(Number(prep)),
          setup_duration_ms: sqlInteger(Number(setup)),
          shoot_duration_ms: sqlInteger(Number(shoot)),
          move_duration_ms: sqlInteger(label === "company-move" ? 1_800_000 : 0),
          hard_constraints_json: sqlText("[]"),
          details_json: sqlJson({ fixture: true }),
          sort_rank: sqlText(rank(index)),
          created_at: sqlInteger(now + 15 * DAY),
        }),
      ),
  );
  statements.push(
    insertOrIgnore("shoot_days", {
      id: sqlText(id("shoot-day")),
      ...commonProjectRecord("Shoot Day 1", "approved", 1),
      schedule_revision_id: sqlText(id("schedule-revision:primary")),
      summary: sqlText("Six scenes across the bus bay, moving interior, and terminus."),
      shoot_date: sqlText("2026-07-10"),
      unit: sqlText("Main"),
      day_count: sqlInteger(1),
      timezone: sqlText("Europe/Amsterdam"),
      general_call_at: sqlInteger(now + 25 * DAY - 2 * 60 * 60_000),
      estimated_start_at: sqlInteger(now + 25 * DAY - 60 * 60_000),
      estimated_wrap_at: sqlInteger(now + 25 * DAY + 11 * 60 * 60_000),
      base_location_id: sqlText(id("location:station")),
      primary_location_id: sqlText(id("location:station")),
      hard_constraints_json: sqlJson(["public path remains open"]),
      readiness_state: sqlText("ready"),
      details_json: sqlJson({ meal: "12:30", companyMove: "15:00" }),
    }),
    insertOrIgnore("resource_conflicts", {
      id: sqlText(id("resource-conflict:cast")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      schedule_revision_id: sqlText(id("schedule-revision:primary")),
      shoot_day_id: sqlText(id("shoot-day")),
      conflict_type: sqlText("cast"),
      severity: sqlText("blocker"),
      resource_type: sqlText("person"),
      resource_id: sqlText(id("person:ivo-actor")),
      title: sqlText("Original availability overlap"),
      evidence_json: sqlJson({ resolvedBy: "updated availability" }),
      status: sqlText("resolved"),
      fingerprint: sqlText(hash("resource-conflict:cast")),
      detected_at: sqlInteger(now + 15 * DAY),
      updated_at: sqlInteger(now + 16 * DAY),
    }),
    insertOrIgnore("resource_conflicts", {
      id: sqlText(id("resource-conflict:equipment")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      schedule_revision_id: sqlText(id("schedule-revision:primary")),
      shoot_day_id: sqlText(id("shoot-day")),
      conflict_type: sqlText("equipment"),
      severity: sqlText("warning"),
      resource_type: sqlText("equipment_kit"),
      resource_id: sqlText(id("equipment-kit")),
      title: sqlText("Short pickup turnaround"),
      evidence_json: sqlJson({ overrideReason: "Vendor opened early collection slot" }),
      status: sqlText("overridden"),
      fingerprint: sqlText(hash("resource-conflict:equipment")),
      detected_at: sqlInteger(now + 15 * DAY),
      updated_at: sqlInteger(now + 16 * DAY),
    }),
  );

  statements.push(
    insertOrIgnore("files", {
      id: sqlText(id("release-file")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      folder_id: sqlText(id("folder:7")),
      title: sqlText("Location release"),
      status: sqlText("active"),
      summary: sqlText("Synthetic unsigned and signed immutable file versions."),
      owner_user_id: sqlText(id("owner")),
      sort_rank: sqlText(rank(1)),
      safe_display_name: sqlText("location-release.pdf"),
      current_version_id: sqlText(id("release-file:v2")),
      provenance: sqlText("Synthetic test fixture"),
      retention_class: sqlText("legal"),
      is_favorite: sqlInteger(1),
      details_json: sqlJson({ fictional: true }),
      created_at: sqlInteger(now + 10 * DAY),
      updated_at: sqlInteger(now + 12 * DAY),
    }),
    insertOrIgnore("file_versions", {
      id: sqlText(id("release-file:v1")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      file_id: sqlText(id("release-file")),
      version_number: sqlInteger(1),
      original_name: sqlText("location-release-unsigned.pdf"),
      safe_display_name: sqlText("location-release-unsigned.pdf"),
      object_key: sqlText(releaseV1.objectKey),
      byte_size: sqlInteger(releaseV1.bytes.byteLength),
      mime_type: sqlText(releaseV1.contentType),
      sha256: sqlText(releaseV1.sha256),
      uploader_user_id: sqlText(id("producer")),
      provenance: sqlText("Synthetic test fixture; checksum-verified local R2 object"),
      scan_state: sqlText("not_configured"),
      scan_evidence_json: sqlText("{}"),
      retention_class: sqlText("legal"),
      created_at: sqlInteger(now + 10 * DAY),
    }),
    insertOrIgnore("file_versions", {
      id: sqlText(id("release-file:v2")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      file_id: sqlText(id("release-file")),
      version_number: sqlInteger(2),
      original_name: sqlText("location-release-signed.pdf"),
      safe_display_name: sqlText("location-release-signed.pdf"),
      object_key: sqlText(releaseV2.objectKey),
      byte_size: sqlInteger(releaseV2.bytes.byteLength),
      mime_type: sqlText(releaseV2.contentType),
      sha256: sqlText(releaseV2.sha256),
      uploader_user_id: sqlText(id("owner")),
      provenance: sqlText("Synthetic signed-file fixture; checksum-verified local R2 object"),
      scan_state: sqlText("not_configured"),
      scan_evidence_json: sqlText("{}"),
      retention_class: sqlText("legal"),
      created_at: sqlInteger(now + 12 * DAY),
    }),
    insertOrIgnore("report_definitions", {
      id: sqlText(id("report-definition")),
      ...commonProjectRecord("Department and DOOD reports", "active", 1),
      report_type: sqlText("dood"),
      configuration_json: sqlJson({ categories: ["cast", "props", "wardrobe"], legend: "W/H/SW" }),
      details_json: sqlJson({ paperSize: "A4" }),
    }),
    insertOrIgnore("report_snapshots", {
      id: sqlText(id("report-snapshot")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      report_definition_id: sqlText(id("report-definition")),
      report_type: sqlText("dood"),
      issue_number: sqlInteger(1),
      title: sqlText("DOOD issue 1"),
      snapshot_json: sqlJson({ scenes: 6, cast: 3, immutable: true }),
      content_hash: sqlText(hash("report-snapshot")),
      created_by_user_id: sqlText(id("producer")),
      created_at: sqlInteger(now + 17 * DAY),
    }),
    insertOrIgnore("sides_issues", {
      id: sqlText(id("sides-issue")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      screenplay_id: sqlText(id("screenplay")),
      script_revision_id: sqlText(id("script:revision:2")),
      issue_number: sqlInteger(1),
      title: sqlText("Shoot Day 1 sides"),
      selection_json: sqlJson({
        sceneIds: scenes.map((_, index) => id(`scene:${index + 1}`)),
        characterIds: [id("character:0"), id("character:1")],
      }),
      presentation_json: sqlJson({
        watermark: "FICTIONAL TEST",
        revisionMarks: true,
        paperSize: "A4",
      }),
      content_hash: sqlText(hash("sides-issue")),
      created_by_user_id: sqlText(id("producer")),
      created_at: sqlInteger(now + 18 * DAY),
    }),
  );

  statements.push(
    insertOrIgnore("call_sheet_drafts", {
      id: sqlText(id("call-draft")),
      ...commonProjectRecord("Shoot Day 1 call sheet", "issued", 1),
      shoot_day_id: sqlText(id("shoot-day")),
      source_schedule_revision_id: sqlText(id("schedule-revision:primary")),
      summary: sqlText("Main-unit fictional call sheet with manual weather."),
      call_sheet_type: sqlText("shoot_day"),
      issue_number_next: sqlInteger(2),
      timezone: sqlText("Europe/Amsterdam"),
      paper_size: sqlText("A4"),
      layout: sqlText("standard"),
      manual_weather_json: sqlJson({
        source: "manual",
        summary: "Dry, 14–19 °C",
        frozenAt: now + 18 * DAY,
      }),
      details_json: sqlJson({ generalCall: "05:30", hospitalVerifiedManually: true }),
    }),
  );
  [
    ["overview", "Day overview", { scenes: 6, generalCall: "05:30" }],
    ["safety", "Safety bulletin", { notes: ["Controlled vehicle zone", "Public path stays open"] }],
    ["logistics", "Transport and meals", { meal: "12:30", companyMove: "15:00" }],
  ].forEach(([type, title, body], index) =>
    statements.push(
      insertOrIgnore("call_sheet_sections", {
        id: sqlText(id(`call-section:${type}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        call_sheet_draft_id: sqlText(id("call-draft")),
        section_type: sqlText(String(type)),
        title: sqlText(String(title)),
        visible: sqlInteger(1),
        columns_json: sqlText("[]"),
        body_json: sqlJson(body),
        sort_rank: sqlText(rank(index)),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now),
      }),
    ),
  );
  const recipients = ["mara-actor", "ivo-actor", "dop"] as const;
  recipients.forEach((personLabel, index) => {
    statements.push(
      insertOrIgnore("call_sheet_recipients", {
        id: sqlText(id(`call-recipient:${index}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        call_sheet_draft_id: sqlText(id("call-draft")),
        person_id: sqlText(id(`person:${personLabel}`)),
        label: sqlText(index < 2 ? "Cast" : "Camera"),
        private_note: sqlText(
          index === 0 ? "Pickup at fictional hotel at 04:50." : "No private note.",
        ),
        required_confirmation: sqlInteger(1),
        recipient_projection_json: sqlJson({
          includePrivateNote: true,
          includeRates: false,
          recipientIndex: index,
        }),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now),
      }),
      insertOrIgnore("share_links", {
        id: sqlText(id(`call-share:${index}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        public_locator: sqlText(`fixture-call-${index + 1}`),
        secret_digest: sqlText(hash(`call-share-secret:${index}`)),
        purpose: sqlText("call_sheet_recipient"),
        object_type: sqlText("call_sheet_recipient_issue"),
        object_id: sqlText(id(`call-recipient-issue:${index}`)),
        allowed_actions_json: sqlJson(["view", "confirm"]),
        field_projection_json: sqlJson({
          recipientIndex: index,
          finance: false,
          legalPrivate: false,
        }),
        created_by_user_id: sqlText(id("producer")),
        expires_at: sqlInteger(now + 40 * DAY),
        created_at: sqlInteger(now + 19 * DAY),
      }),
    );
  });
  statements.push(
    insertOrIgnore("call_sheet_issues", {
      id: sqlText(id("call-issue")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      call_sheet_draft_id: sqlText(id("call-draft")),
      shoot_day_id: sqlText(id("shoot-day")),
      source_schedule_revision_id: sqlText(id("schedule-revision:primary")),
      issue_number: sqlInteger(1),
      title: sqlText("Shoot Day 1 call sheet — issue 1"),
      confidentiality_marking: sqlText("FICTIONAL TEST — CONFIDENTIAL"),
      canonical_snapshot_json: sqlJson({
        scheduleRevisionId: id("schedule-revision:primary"),
        recipientCount: 3,
        manualWeather: true,
      }),
      content_hash: sqlText(hash("call-issue")),
      created_by_user_id: sqlText(id("producer")),
      created_at: sqlInteger(now + 19 * DAY),
    }),
  );
  recipients.forEach((_, index) =>
    statements.push(
      insertOrIgnore("call_sheet_recipient_issues", {
        id: sqlText(id(`call-recipient-issue:${index}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        call_sheet_issue_id: sqlText(id("call-issue")),
        call_sheet_recipient_id: sqlText(id(`call-recipient:${index}`)),
        share_link_id: sqlText(id(`call-share:${index}`)),
        variant_snapshot_json: sqlJson({
          recipientIndex: index,
          privateNoteOwner: index,
          otherRecipients: false,
          finance: false,
        }),
        content_hash: sqlText(hash(`call-recipient-issue:${index}`)),
        created_at: sqlInteger(now + 19 * DAY),
      }),
      insertOrIgnore("delivery_events", {
        id: sqlText(id(`delivery-event:${index}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        call_sheet_recipient_issue_id: sqlText(id(`call-recipient-issue:${index}`)),
        event_type: sqlText(index === 0 ? "viewed" : "link_copied"),
        evidence_json: sqlJson({ fixture: true, provider: "manual" }),
        idempotency_key: sqlText(`fixture-delivery-${index}`),
        occurred_at: sqlInteger(now + 19 * DAY + index * 1_000),
        created_at: sqlInteger(now + 19 * DAY + index * 1_000),
      }),
    ),
  );
  statements.push(
    insertOrIgnore("confirmations", {
      id: sqlText(id("confirmation")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      call_sheet_recipient_issue_id: sqlText(id("call-recipient-issue:0")),
      confirmed_by_type: sqlText("recipient"),
      share_link_id: sqlText(id("call-share:0")),
      note: sqlText("Confirmed — fictional fixture."),
      idempotency_key: sqlText("fixture-confirmation-1"),
      confirmed_at: sqlInteger(now + 19 * DAY + 10_000),
      created_at: sqlInteger(now + 19 * DAY + 10_000),
    }),
    insertOrIgnore("production_pack_drafts", {
      id: sqlText(id("pack-draft")),
      ...commonProjectRecord("Shoot Day 1 production pack", "issued", 1),
      shoot_day_id: sqlText(id("shoot-day")),
      summary: sqlText("Approved script, sides, schedule, calls, visuals, logistics, and safety."),
      paper_size: sqlText("A4"),
      confidentiality_marking: sqlText("FICTIONAL TEST — INTERNAL"),
      details_json: sqlJson({ sections: 8 }),
    }),
  );
  [
    ["script", "Approved screenplay", "screenplay", "script:revision:2", null],
    ["sides", "Daily sides", null, "sides-issue", null],
    ["call_sheet", "Call sheet", "call-draft", "call-issue", null],
    ["schedule", "One-liner", "schedule:primary", "schedule-revision:primary", null],
    [
      "legal",
      "Location release (unsigned pinned fixture)",
      "release-file",
      null,
      "release-file:v1",
    ],
  ].forEach(([section, title, registryLabel, revision, fileVersion], index) =>
    statements.push(
      insertOrIgnore("production_pack_items", {
        id: sqlText(id(`pack-item:${index}`)),
        workspace_id: sqlText(id("workspace")),
        project_id: sqlText(id("project")),
        production_pack_draft_id: sqlText(id("pack-draft")),
        object_id: registryLabel === null ? "NULL" : sqlText(id(`registry:${registryLabel}`)),
        file_version_id: fileVersion === null ? "NULL" : sqlText(id(fileVersion!)),
        revision_or_issue_id: revision === null ? "NULL" : sqlText(id(revision!)),
        section_type: sqlText(section!),
        title: sqlText(title!),
        include_file: sqlInteger(1),
        permission_scope: sqlText(section === "legal" ? "legal" : "project"),
        sort_rank: sqlText(rank(index)),
        created_at: sqlInteger(now),
        updated_at: sqlInteger(now),
      }),
    ),
  );
  statements.push(
    insertOrIgnore("production_pack_issues", {
      id: sqlText(id("pack-issue")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      production_pack_draft_id: sqlText(id("pack-draft")),
      issue_number: sqlInteger(1),
      title: sqlText("Shoot Day 1 production pack — issue 1"),
      manifest_json: sqlJson({
        items: 5,
        scriptRevisionId: id("script:revision:2"),
        callSheetIssueId: id("call-issue"),
      }),
      manifest_hash: sqlText(hash("pack-issue")),
      created_by_user_id: sqlText(id("owner")),
      created_at: sqlInteger(now + 20 * DAY),
    }),
  );

  statements.push(
    insertOrIgnore("comments", {
      id: sqlText(id("comment")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      object_id: sqlText(id("registry:shot-list")),
      author_user_id: sqlText(id("producer")),
      body: sqlText("@TestOwner The terminus coverage is approved after the safety note update."),
      created_at: sqlInteger(now + 18 * DAY),
      updated_at: sqlInteger(now + 18 * DAY),
    }),
    insertOrIgnore("mentions", {
      id: sqlText(id("mention")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      comment_id: sqlText(id("comment")),
      mentioned_user_id: sqlText(id("owner")),
      created_at: sqlInteger(now + 18 * DAY),
    }),
    insertOrIgnore("activities", {
      id: sqlText(id("activity")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      actor_user_id: sqlText(id("producer")),
      actor_type: sqlText("user"),
      verb: sqlText("approved"),
      object_id: sqlText(id("registry:shot-list")),
      summary: sqlText("Approved the master shot list."),
      metadata_json: sqlJson({ fixture: true }),
      created_at: sqlInteger(now + 18 * DAY),
    }),
    insertOrIgnore("notifications", {
      id: sqlText(id("notification")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      recipient_user_id: sqlText(id("owner")),
      type: sqlText("mention"),
      title: sqlText("You were mentioned on Approved master shot list"),
      body: sqlText("Review the approved terminus coverage note."),
      object_type: sqlText("shot_list"),
      object_id: sqlText(id("shot-list")),
      created_at: sqlInteger(now + 18 * DAY),
    }),
    insertOrIgnore("announcements", {
      id: sqlText(id("announcement")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      title: sqlText("Ready-to-shoot review at 16:00"),
      body: sqlText("Please review the fictional readiness evidence before issue."),
      status: sqlText("published"),
      author_user_id: sqlText(id("owner")),
      created_at: sqlInteger(now + 19 * DAY),
      updated_at: sqlInteger(now + 19 * DAY),
    }),
    insertOrIgnore("messages", {
      id: sqlText(id("message")),
      ...commonProjectRecord("Readiness review", "sent", 1),
      message_type: sqlText("direct"),
      sender_user_id: sqlText(id("producer")),
      body: sqlText("The production pack manifest is ready for your final review."),
      details_json: sqlJson({ internalOnly: true }),
    }),
    insertOrIgnore("message_participants", {
      message_id: sqlText(id("message")),
      user_id: sqlText(id("owner")),
      person_id: "NULL",
      participant_role: sqlText("to"),
    }),
  );

  // Readiness evidence is materialised after every related fixture record exists so the
  // production source loaders, rule engine and immutable issue path use real graph data.

  statements.push(
    insertOrIgnore("export_snapshots", {
      id: sqlText(id("export-snapshot")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      snapshot_type: sqlText("nas_archive"),
      schema_version: sqlText("1"),
      state: sqlText("complete"),
      title: sqlText("Night Bus archive snapshot"),
      summary: sqlText("Synthetic complete export for archive protocol tests."),
      manifest_object_key: sqlText(archiveManifest.objectKey),
      manifest_hash: sqlText(archiveManifest.sha256),
      body_object_key: sqlText(projectExport.objectKey),
      content_hash: sqlText(projectExport.sha256),
      requested_by_user_id: sqlText(id("owner")),
      idempotency_key: sqlText("fixture-export-1"),
      created_at: sqlInteger(now + 21 * DAY),
      completed_at: sqlInteger(now + 21 * DAY + 5_000),
    }),
    insertOrIgnore("service_credentials", {
      id: sqlText(id("service-credential")),
      workspace_id: sqlText(id("workspace")),
      name: sqlText("Synthetic NAS agent credential record"),
      secret_digest: sqlText(hash("synthetic-service-credential-digest")),
      scopes_json: sqlJson(["archive:lease", "archive:read", "archive:ack"]),
      expires_at: sqlInteger(now + 365 * DAY),
      created_by_user_id: sqlText(id("owner")),
      created_at: sqlInteger(now),
    }),
    insertOrIgnore("archive_jobs", {
      id: sqlText(id("archive-job")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      export_snapshot_id: sqlText(id("export-snapshot")),
      status: sqlText("verified"),
      attempt_count: sqlInteger(2),
      requested_by_user_id: sqlText(id("owner")),
      idempotency_key: sqlText("fixture-archive-1"),
      created_at: sqlInteger(now + 21 * DAY),
      updated_at: sqlInteger(now + 21 * DAY + 20_000),
      verified_at: sqlInteger(now + 21 * DAY + 20_000),
    }),
    insertOrIgnore("archive_attempts", {
      id: sqlText(id("archive-attempt-interrupted")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      archive_job_id: sqlText(id("archive-job")),
      attempt_number: sqlInteger(1),
      service_credential_id: sqlText(id("service-credential")),
      agent_id: sqlText("synthetic-test-agent"),
      state: sqlText("failed"),
      retryable: sqlInteger(1),
      started_at: sqlInteger(now + 21 * DAY + 1_000),
      heartbeat_at: sqlInteger(now + 21 * DAY + 5_000),
      finished_at: sqlInteger(now + 21 * DAY + 6_000),
      error_code: sqlText("synthetic_interruption"),
      error_message: sqlText("Synthetic retryable interruption fixture."),
    }),
    insertOrIgnore("archive_attempts", {
      id: sqlText(id("archive-attempt")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      archive_job_id: sqlText(id("archive-job")),
      attempt_number: sqlInteger(2),
      service_credential_id: sqlText(id("service-credential")),
      agent_id: sqlText("synthetic-test-agent"),
      state: sqlText("verified"),
      retryable: sqlInteger(0),
      started_at: sqlInteger(now + 21 * DAY + 10_000),
      heartbeat_at: sqlInteger(now + 21 * DAY + 19_000),
      finished_at: sqlInteger(now + 21 * DAY + 20_000),
    }),
    insertOrIgnore("archive_manifest_items", {
      id: sqlText(id("archive-item")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      archive_job_id: sqlText(id("archive-job")),
      logical_file_id: sqlText(id("release-file")),
      file_version_id: sqlText(id("release-file:v2")),
      source_revision_id: sqlText(id("script:revision:2")),
      relative_path: sqlText("07-legal-safety/location-release-signed.pdf"),
      object_key: sqlText(releaseV2.objectKey),
      byte_size: sqlInteger(releaseV2.bytes.byteLength),
      mime_type: sqlText(releaseV2.contentType),
      sha256: sqlText(releaseV2.sha256),
      sort_rank: sqlText(rank(1)),
      state: sqlText("verified"),
      created_at: sqlInteger(now + 21 * DAY),
    }),
    insertOrIgnore("archive_acknowledgements", {
      id: sqlText(id("archive-ack")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      archive_job_id: sqlText(id("archive-job")),
      manifest_item_id: sqlText(id("archive-item")),
      attempt_id: sqlText(id("archive-attempt")),
      ack_kind: sqlText("item"),
      verified_byte_size: sqlInteger(releaseV2.bytes.byteLength),
      verified_sha256: sqlText(releaseV2.sha256),
      destination_path: sqlText("07-legal-safety/location-release-signed.pdf"),
      retryable: sqlInteger(0),
      service_credential_id: sqlText(id("service-credential")),
      idempotency_key: sqlText("fixture-archive-item-ack-1"),
      payload_hash: sqlText(hash("archive-ack-payload")),
      created_at: sqlInteger(now + 21 * DAY + 20_000),
    }),
    insertOrIgnore("audit_events", {
      id: sqlText(id("seed-audit")),
      workspace_id: sqlText(id("workspace")),
      project_id: sqlText(id("project")),
      actor_type: sqlText("system"),
      action: sqlText("test.fixture_seeded"),
      object_type: sqlText("project"),
      object_id: sqlText(id("project")),
      metadata_json: sqlJson({ fictional: true, sixScenes: true, productionEligible: false }),
      created_at: sqlInteger(now),
    }),
  );

  return `${statements.join("\n")}\n`;
}
