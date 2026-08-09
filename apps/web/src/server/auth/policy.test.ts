import { describe, expect, it } from "vitest";

import type { ActorContext } from "../http/types";
import { assertAllowed, assertAppRequestAllowed } from "./policy";

function actor(role: ActorContext["role"]): ActorContext {
  return {
    userId: "test-user",
    workspaceId: "test-workspace",
    sessionId: "test-session",
    username: role === "viewer" ? "TestViewer" : "TestEditor",
    displayName: "Test account",
    role,
    authEpoch: 1,
    csrfHash: "test-csrf-hash",
    lastSeenAt: 0,
  };
}

describe("workspace role policy", () => {
  it("allows viewers to read but denies every application mutation", () => {
    const viewer = actor("viewer");
    expect(() => assertAppRequestAllowed(viewer, "GET")).not.toThrow();
    expect(() => assertAppRequestAllowed(viewer, "HEAD")).not.toThrow();
    expect(() => assertAppRequestAllowed(viewer, "POST")).toThrow(/view-only/u);
    expect(() => assertAppRequestAllowed(viewer, "PATCH")).toThrow(/view-only/u);
    expect(() => assertAppRequestAllowed(viewer, "DELETE")).toThrow(/view-only/u);
  });

  it("denies viewer websocket collaboration and policy actions", () => {
    const viewer = actor("viewer");
    expect(() => assertAppRequestAllowed(viewer, "GET", "websocket")).toThrow(/view-only/u);
    expect(() => assertAllowed(viewer, "project.edit")).toThrow(/view-only/u);
    expect(() => assertAllowed(viewer, "workspace.manage_accounts")).toThrow(/view-only/u);
  });

  it("preserves producer editing and owner-only boundaries", () => {
    const producer = actor("producer");
    expect(() => assertAppRequestAllowed(producer, "POST")).not.toThrow();
    expect(() => assertAllowed(producer, "project.edit")).not.toThrow();
    expect(() => assertAllowed(producer, "workspace.manage_accounts")).toThrow(/does not allow/u);
  });
});
