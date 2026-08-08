import { z } from "zod";

import { DomainError } from "./errors";
import { opaqueIdSchema, type OpaqueId } from "./ids";

const labelledCallSchema = z
  .object({
    label: z.string().min(1).max(100),
    time: z.string().regex(/^\d{2}:\d{2}$/),
  })
  .strict();

const recipientAttachmentSchema = z
  .object({
    fileVersionId: opaqueIdSchema,
    displayName: z.string().min(1).max(300),
  })
  .strict();

export const callSheetRecipientSchema = z
  .object({
    recipientId: opaqueIdSchema,
    recipientIssueId: opaqueIdSchema,
    displayName: z.string().min(1).max(300),
    roleLabel: z.string().min(1).max(200),
    email: z.string().email().optional(),
    phone: z.string().max(100).optional(),
    rateMinor: z.number().int().optional(),
    calls: z.array(labelledCallSchema),
    privateNote: z.string().max(10_000),
    attachments: z.array(recipientAttachmentSchema),
  })
  .strict();

export type CallSheetRecipient = z.infer<typeof callSheetRecipientSchema>;

export const issuedCallSheetSchema = z
  .object({
    issueId: opaqueIdSchema,
    issueNumber: z.number().int().positive(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    projectTitle: z.string().min(1).max(300),
    companyName: z.string().min(1).max(300),
    shootDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    confidentiality: z.string().max(500),
    publicSections: z.array(
      z
        .object({
          key: z.string().min(1).max(100),
          title: z.string().min(1).max(200),
          body: z.string().max(50_000),
        })
        .strict(),
    ),
    recipients: z.array(callSheetRecipientSchema),
    producerPrivateNotes: z.string().max(50_000),
    financeSummaryMinor: z.number().int().optional(),
    legalPrivateNotes: z.string().max(50_000),
  })
  .strict();

export type IssuedCallSheet = z.infer<typeof issuedCallSheetSchema>;

export const recipientCallSheetProjectionSchema = z
  .object({
    issueId: opaqueIdSchema,
    recipientIssueId: opaqueIdSchema,
    issueNumber: z.number().int().positive(),
    projectTitle: z.string(),
    companyName: z.string(),
    shootDate: z.string(),
    confidentiality: z.string(),
    sections: z.array(z.object({ key: z.string(), title: z.string(), body: z.string() }).strict()),
    recipient: z
      .object({
        displayName: z.string(),
        roleLabel: z.string(),
        calls: z.array(labelledCallSchema),
        privateNote: z.string(),
        attachments: z.array(recipientAttachmentSchema),
      })
      .strict(),
  })
  .strict();

export type RecipientCallSheetProjection = z.infer<typeof recipientCallSheetProjectionSchema>;

/** An explicit allow-list projection; other recipients and sensitive canonical fields never cross the boundary. */
export function projectCallSheetForRecipient(
  sheetInput: IssuedCallSheet,
  recipientIssueId: OpaqueId,
): RecipientCallSheetProjection {
  const sheet = issuedCallSheetSchema.parse(sheetInput);
  const recipient = sheet.recipients.find(
    (candidate) => candidate.recipientIssueId === recipientIssueId,
  );
  if (recipient === undefined) {
    throw new DomainError("AUTHORIZATION_DENIED", "Recipient view is unavailable.");
  }
  return recipientCallSheetProjectionSchema.parse({
    issueId: sheet.issueId,
    recipientIssueId: recipient.recipientIssueId,
    issueNumber: sheet.issueNumber,
    projectTitle: sheet.projectTitle,
    companyName: sheet.companyName,
    shootDate: sheet.shootDate,
    confidentiality: sheet.confidentiality,
    sections: sheet.publicSections,
    recipient: {
      displayName: recipient.displayName,
      roleLabel: recipient.roleLabel,
      calls: recipient.calls,
      privateNote: recipient.privateNote,
      attachments: recipient.attachments,
    },
  });
}

export function projectAllowlistedFields<
  T extends Readonly<Record<string, unknown>>,
  K extends keyof T,
>(source: T, allowed: readonly K[]): Pick<T, K> {
  return Object.fromEntries(allowed.map((key) => [key, source[key]])) as Pick<T, K>;
}
