/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { createUuidV7 } from "@swp/domain";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";

import { sha256 } from "../auth/crypto";
import { errorEnvelope } from "../http/envelope";
import { HttpError } from "../http/errors";
import { requestContext } from "../http/security";
import type { AppEnv } from "../http/types";
import { operationsPrintRoutes, operationsRoutes } from "../routes/operations";

const testEnv = env as typeof env & { TEST_MIGRATIONS: D1Migration[] };
const app = new Hono<AppEnv>();
app.use("*", requestContext);
app.route("/api/v1/app/print", operationsPrintRoutes);
app.route("/api/v1/app/projects/:projectId/operations", operationsRoutes);
app.onError((error, context) => {
  if (error instanceof HttpError)
    return errorEnvelope(
      context,
      { code: error.code, message: error.message, details: error.details },
      error.status,
    );
  throw error;
});

interface Fixture {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly personId: string;
  readonly session: { readonly token: string; readonly csrf: string };
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

describe("scheduling and issued-document Worker routes", () => {
  it("persists immutable revisions, recipient variants, confirmations, pack pins, and print views", async () => {
    const fixture = await seedFixture();
    const base = `/api/v1/app/projects/${fixture.projectId}/operations`;
    const scheduleResponse = await request(fixture.session, `${base}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Primary schedule",
        name: "Primary schedule revision 1",
        isDefault: true,
        items: [
          {
            itemType: "day_break",
            title: "Shoot Day 1",
            shootDate: "2030-05-14",
            unit: "Main",
            dayCount: 1,
            generalCallLocal: "07:00",
            timezone: "Europe/Amsterdam",
            pageEighths: 0,
            prepDurationMs: 0,
            setupDurationMs: 0,
            shootDurationMs: 0,
            moveDurationMs: 0,
            mealDurationMs: 0,
            hardConstraints: [],
            details: {},
            assignments: [],
          },
          {
            itemType: "meal",
            title: "Lunch",
            shootDate: "2030-05-14",
            unit: "Main",
            dayCount: 1,
            timezone: "Europe/Amsterdam",
            pageEighths: 0,
            prepDurationMs: 0,
            setupDurationMs: 0,
            shootDurationMs: 0,
            moveDurationMs: 0,
            mealDurationMs: 1_800_000,
            hardConstraints: [],
            details: {},
            assignments: [],
          },
        ],
        availability: [],
        travelDurations: [],
      }),
    });
    expect(scheduleResponse.status).toBe(201);
    const schedule = await data<{
      id: string;
      currentRevisionId: string;
      revision: { dayBreakItemId: string; totals: { mealMs: number } };
    }>(scheduleResponse);
    expect(schedule.revision.totals.mealMs).toBe(1_800_000);
    const immutable = await testEnv.DB.prepare(
      "UPDATE schedule_revisions SET name = 'mutated' WHERE id = ?1",
    )
      .bind(schedule.currentRevisionId)
      .run()
      .then(
        () => false,
        () => true,
      );
    expect(immutable).toBe(true);

    const approve = await request(fixture.session, `${base}/schedules/${schedule.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(approve.status).toBe(201);
    const approved = await data<{ id: string; status: string }>(approve);
    expect(approved.status).toBe("approved");

    const dayResponse = await request(fixture.session, `${base}/shoot-days`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scheduleRevisionId: approved.id,
        dayBreakItemId: await firstDayBreak(approved.id),
        generalCallAt: Date.UTC(2030, 4, 14, 5, 0),
      }),
    });
    expect(dayResponse.status).toBe(201);
    const day = await data<{ id: string; scheduleRevisionId: string; estimatedWrapAt: number }>(
      dayResponse,
    );
    expect(day.scheduleRevisionId).toBe(approved.id);
    expect(day.estimatedWrapAt).toBe(Date.UTC(2030, 4, 14, 5, 30));

    const draftResponse = await request(fixture.session, `${base}/call-sheets`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shootDayId: day.id,
        callSheetType: "shoot_day",
        title: "Shoot Day 1 call sheet",
        paperSize: "A4",
        layout: "standard",
        manualWeather: { source: "manual", summary: "Dry" },
        sections: [],
        recipients: [
          {
            personId: fixture.personId,
            label: "Camera",
            privateNote: "Use the south entrance",
            requiredConfirmation: true,
            calls: [
              {
                label: "General",
                callAt: Date.UTC(2030, 4, 14, 5, 0),
                timezone: "Europe/Amsterdam",
              },
            ],
          },
        ],
      }),
    });
    expect(draftResponse.status).toBe(201);
    const draft = await data<{ id: string; version: number }>(draftResponse);
    const issueResponse = await request(fixture.session, `${base}/call-sheets/${draft.id}/issue`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "If-Match": `"${draft.version}"`,
        "Idempotency-Key": "operations-call-issue-0001",
      },
      body: JSON.stringify({ confidentiality: "Fixture confidential" }),
    });
    expect(issueResponse.status, await issueResponse.clone().text()).toBe(201);
    const callIssue = await data<{
      id: string;
      contentHash: string;
      recipientLinks: { recipientIssueId: string; url: string }[];
    }>(issueResponse);
    expect(callIssue.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(callIssue.recipientLinks).toHaveLength(1);
    expect(callIssue.recipientLinks[0]?.url).toContain("/s/");
    const variant = await testEnv.DB.prepare(
      "SELECT variant_snapshot_json FROM call_sheet_recipient_issues WHERE id = ?1",
    )
      .bind(callIssue.recipientLinks[0]?.recipientIssueId)
      .first<string>("variant_snapshot_json");
    expect(variant).toContain("Use the south entrance");
    expect(variant).not.toContain("producerPrivateNotes");

    const confirmation = await request(
      fixture.session,
      `${base}/call-sheet-recipient-issues/${callIssue.recipientLinks[0]?.recipientIssueId}/confirm-manual`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "operations-confirm-0001",
        },
        body: JSON.stringify({ note: "Confirmed by phone" }),
      },
    );
    expect(confirmation.status).toBe(200);
    expect((await data<{ deliveryState: string }>(confirmation)).deliveryState).toBe("confirmed");

    const registry = await testEnv.DB.prepare(
      "SELECT id FROM object_registry WHERE domain_table = 'call_sheet_issues' AND domain_id = ?1",
    )
      .bind(callIssue.id)
      .first<{ id: string }>();
    expect(registry).toBeTruthy();
    const packDraftResponse = await request(fixture.session, `${base}/production-packs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        shootDayId: day.id,
        title: "Shoot Day 1 production pack",
        summary: "Pinned call sheet",
        paperSize: "A4",
        confidentiality: "Fixture internal",
        items: [
          {
            objectId: registry?.id,
            revisionOrIssueId: callIssue.id,
            sectionType: "call-sheets",
            title: "Issued call sheet",
            includeFile: true,
            permissionScope: "project",
          },
        ],
      }),
    });
    expect(packDraftResponse.status).toBe(201);
    const packDraft = await data<{ id: string; version: number }>(packDraftResponse);
    const packIssueResponse = await request(
      fixture.session,
      `${base}/production-packs/${packDraft.id}/issue`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "If-Match": `"${packDraft.version}"`,
          "Idempotency-Key": "operations-pack-issue-0001",
        },
        body: "{}",
      },
    );
    expect(packIssueResponse.status).toBe(201);
    const packIssue = await data<{ id: string; manifestHash: string; zipState: string }>(
      packIssueResponse,
    );
    expect(packIssue.manifestHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(packIssue.zipState).toBe("not_configured");

    const callPrint = await request(
      fixture.session,
      `/api/v1/app/print/call_sheet_issue/${callIssue.id}`,
      { method: "GET" },
    );
    expect(callPrint.status).toBe(200);
    expect((await data<{ sections: unknown[] }>(callPrint)).sections.length).toBeGreaterThan(0);
    const packPrint = await request(
      fixture.session,
      `/api/v1/app/print/production_pack_issue/${packIssue.id}`,
      { method: "GET" },
    );
    expect(packPrint.status).toBe(200);
  });
});

async function seedFixture(): Promise<Fixture> {
  const workspaceId = createUuidV7();
  const ownerId = createUuidV7();
  const projectId = createUuidV7();
  const personId = createUuidV7();
  const session = {
    token: `operations-token-${createUuidV7()}`,
    csrf: `operations-csrf-${createUuidV7()}`,
  };
  const now = Date.now();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      "INSERT INTO workspaces (id, name, company_name, created_at, updated_at) VALUES (?1, 'Operations fixture', 'Sinbod Wayne', ?2, ?2)",
    ).bind(workspaceId, now),
    testEnv.DB.prepare(
      "INSERT INTO user_identities (id, workspace_id, username, display_name, role, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'Fixture Owner', 'workspace_owner', 'active', ?4, ?4)",
    ).bind(ownerId, workspaceId, `OpsOwner${ownerId.slice(-6)}`, now),
    testEnv.DB.prepare(
      "INSERT INTO workspace_memberships (id, workspace_id, user_id, role, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'workspace_owner', 'active', ?4, ?4)",
    ).bind(createUuidV7(), workspaceId, ownerId, now),
    testEnv.DB.prepare(
      "INSERT INTO projects (id, workspace_id, title, code, type, owner_user_id, timezone, paper_size, created_at, updated_at) VALUES (?1, ?2, 'Operations fixture', ?3, 'short_film', ?4, 'Europe/Amsterdam', 'A4', ?5, ?5)",
    ).bind(projectId, workspaceId, `OPS-${projectId.slice(-6)}`, ownerId, now),
    testEnv.DB.prepare(
      "INSERT INTO project_memberships (id, workspace_id, project_id, user_id, role, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'owner', 'active', ?5, ?5)",
    ).bind(createUuidV7(), workspaceId, projectId, ownerId, now),
    testEnv.DB.prepare(
      "INSERT INTO people (id, workspace_id, project_id, title, status, owner_user_id, created_at, updated_at) VALUES (?1, ?2, ?3, 'Casey Camera', 'confirmed', ?4, ?5, ?5)",
    ).bind(personId, workspaceId, projectId, ownerId, now),
    testEnv.DB.prepare(
      "INSERT INTO contact_points (id, workspace_id, person_id, type, value, is_primary, created_at, updated_at) VALUES (?1, ?2, ?3, 'email', 'fixture@example.invalid', 1, ?4, ?4)",
    ).bind(createUuidV7(), workspaceId, personId, now),
    await sessionStatement(workspaceId, ownerId, session, now),
  ]);
  return { workspaceId, projectId, personId, session };
}

async function sessionStatement(
  workspaceId: string,
  userId: string,
  session: Fixture["session"],
  now: number,
): Promise<D1PreparedStatement> {
  return testEnv.DB.prepare(
    "INSERT INTO sessions (id, workspace_id, user_id, token_hash, csrf_hash, auth_epoch, created_at, last_seen_at, idle_expires_at, absolute_expires_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?6, ?7, ?8)",
  ).bind(
    createUuidV7(),
    workspaceId,
    userId,
    await sha256(session.token),
    await sha256(session.csrf),
    now,
    now + 3_600_000,
    now + 86_400_000,
  );
}

async function request(
  session: Fixture["session"],
  path: string,
  init: RequestInit,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cookie", `__Host-swp_session=${session.token}`);
  headers.set("Origin", "https://productions.sinbodwayne.nl");
  headers.set("Sec-Fetch-Site", "same-origin");
  headers.set("X-CSRF-Token", session.csrf);
  return app.request(`https://productions.sinbodwayne.nl${path}`, { ...init, headers }, testEnv);
}

async function data<T>(response: Response): Promise<T> {
  return ((await response.json()) as { data: T }).data;
}
async function firstDayBreak(revisionId: string): Promise<string> {
  const row = await testEnv.DB.prepare(
    "SELECT id FROM schedule_items WHERE schedule_revision_id = ?1 AND item_type = 'day_break' ORDER BY sort_rank LIMIT 1",
  )
    .bind(revisionId)
    .first<{ id: string }>();
  if (!row) throw new Error("Approved day break was not copied.");
  return row.id;
}
