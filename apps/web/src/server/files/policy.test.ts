import { describe, expect, it } from "vitest";

import { HttpError } from "../http/errors";
import {
  assertFileSignature,
  assertStoredObject,
  assertUploadIntent,
  contentDisposition,
  safeDisplayName,
} from "./policy";

const validIntent = {
  byteSize: 512,
  mimeType: "application/pdf",
  mode: "single" as const,
  sha256: "a".repeat(64),
};

describe("private file upload policy", () => {
  it("rejects denied MIME types, excessive sizes and malformed checksums", () => {
    expect(() =>
      assertUploadIntent({ ...validIntent, mimeType: "text/html" }, 10_000),
    ).toThrowError(HttpError);
    expect(() => assertUploadIntent({ ...validIntent, byteSize: 10_001 }, 10_000)).toThrowError(
      HttpError,
    );
    expect(() =>
      assertUploadIntent({ ...validIntent, sha256: "not-a-digest" }, 10_000),
    ).toThrowError(HttpError);
  });

  it("rejects stored evidence with a changed checksum or tenant scope", () => {
    const expected = {
      ...validIntent,
      uploadSessionId: "upload-a",
      workspaceId: "workspace-a",
      projectId: "project-a",
    };
    const evidence = {
      byteSize: 512,
      contentType: "application/pdf",
      sha256: validIntent.sha256,
      uploadSessionId: "upload-a",
      workspaceId: "workspace-a",
      projectId: "project-a",
    };
    expect(() => assertStoredObject(evidence, expected)).not.toThrow();
    expect(() =>
      assertStoredObject({ ...evidence, sha256: "b".repeat(64) }, expected),
    ).toThrowError(/checksum/u);
    expect(() =>
      assertStoredObject({ ...evidence, projectId: "project-b" }, expected),
    ).toThrowError(/scope/u);
  });

  it("checks signatures without buffering an entire file", () => {
    expect(() =>
      assertFileSignature("application/pdf", new TextEncoder().encode("%PDF-1.7\n")),
    ).not.toThrow();
    expect(() =>
      assertFileSignature("application/pdf", new TextEncoder().encode("<html>")),
    ).toThrowError(/contents/u);
    expect(() =>
      assertFileSignature(
        "image/png",
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).not.toThrow();
  });

  it("prevents path and response-header injection in display names", () => {
    expect(safeDisplayName("../private\\release\r\n.pdf")).toBe("release.pdf");
    expect(contentDisposition("Süt plan.pdf")).toContain("filename*=UTF-8''S%C3%BCt%20plan.pdf");
    expect(contentDisposition('bad"name.pdf')).not.toContain('filename="bad"name');
  });
});
