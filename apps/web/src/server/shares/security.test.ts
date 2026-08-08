import { describe, expect, it } from "vitest";

import {
  allowedShareActions,
  assertShareAvailable,
  assertShareObjectPurpose,
  createShareSession,
  extractPublicSections,
  pinnedVersionId,
  verifyShareSession,
  type ShareScope,
} from "./security";

const scope: ShareScope = {
  id: "share-a",
  workspaceId: "workspace-a",
  projectId: "project-a",
  publicLocator: "public-a",
  secretDigest: "YWJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI",
  purpose: "call_sheet_recipient",
  objectType: "call_sheet_recipient_issue",
  objectId: "recipient-issue-a",
  allowedActions: ["view", "confirm", "download"],
  expiresAt: 2_000_000,
  revokedAt: null,
};

describe("public share isolation", () => {
  it("intersects requested permissions with the purpose ceiling", () => {
    expect(allowedShareActions("viewer", ["view", "download", "approve", "confirm"])).toEqual([
      "download",
      "view",
    ]);
    expect(allowedShareActions("call_sheet_recipient", ["confirm", "comment", "view"])).toEqual([
      "confirm",
      "view",
    ]);
  });

  it("rejects cross-purpose objects, revocation, expiry and another project", () => {
    expect(() => assertShareObjectPurpose("call_sheet_recipient_issue", "viewer")).toThrowError(
      /purpose/u,
    );
    expect(() => assertShareAvailable(scope, 1_000_000, "project-a")).not.toThrow();
    expect(() => assertShareAvailable(scope, 1_000_000, "project-b")).toThrowError(/secure link/u);
    expect(() => assertShareAvailable({ ...scope, revokedAt: 999_999 }, 1_000_000)).toThrowError(
      /secure link/u,
    );
    expect(() => assertShareAvailable(scope, 2_000_000)).toThrowError(/secure link/u);
  });

  it("issues a short-lived signed session that fails after revocation checks or tampering", async () => {
    const session = await createShareSession(scope, 1_000_000);
    await expect(verifyShareSession(scope, session.token, 1_000_001)).resolves.toMatchObject({
      csrf: session.csrf,
    });
    await expect(verifyShareSession(scope, `${session.token}x`, 1_000_001)).rejects.toThrowError(
      /secure link/u,
    );
    expect(() => assertShareAvailable({ ...scope, revokedAt: 1_000_002 }, 1_000_003)).toThrowError(
      /secure link/u,
    );
  });

  it("drops private snapshot sections and keeps an issued file version pinned", () => {
    expect(
      extractPublicSections({
        sections: [
          { heading: "Public", body: "General call at 07:00" },
          { heading: "Private rates", body: "Never expose", private: true },
          { heading: "Medical", body: "Never expose", sensitive: true },
        ],
      }),
    ).toEqual([{ heading: "Public", body: "General call at 07:00" }]);
    expect(pinnedVersionId("version-1", { fileId: "file-a", versionId: "version-1" })).toBe(
      "version-1",
    );
    expect(() =>
      pinnedVersionId("version-2", { fileId: "file-a", versionId: "version-1" }),
    ).toThrowError(/secure link/u);
  });
});
