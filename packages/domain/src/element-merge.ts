import { z } from "zod";

import { DomainError } from "./errors";
import { opaqueIdSchema, type OpaqueId } from "./ids";

export const elementSchema = z
  .object({
    id: opaqueIdSchema,
    workspaceId: opaqueIdSchema,
    projectId: opaqueIdSchema,
    categoryId: opaqueIdSchema,
    name: z.string().min(1).max(300),
    aliases: z.array(z.string().min(1).max(300)),
    quantity: z.number().int().min(0),
    archived: z.boolean(),
    mergedIntoId: opaqueIdSchema.optional(),
  })
  .strict();

export type ElementRecord = z.infer<typeof elementSchema>;

export const elementReferenceSchema = z
  .object({
    referenceType: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/),
    referenceId: opaqueIdSchema,
    elementId: opaqueIdSchema,
  })
  .strict();

export type ElementReference = z.infer<typeof elementReferenceSchema>;

export interface ElementMergePreview {
  readonly targetId: OpaqueId;
  readonly sourceIds: readonly OpaqueId[];
  readonly resultingAliases: readonly string[];
  readonly resultingQuantity: number;
  readonly redirectedReferences: readonly ElementReference[];
  readonly removedDuplicateReferences: readonly ElementReference[];
  readonly redirects: readonly {
    readonly fromElementId: OpaqueId;
    readonly toElementId: OpaqueId;
  }[];
}

export function previewElementMerge(input: {
  readonly elements: readonly ElementRecord[];
  readonly references: readonly ElementReference[];
  readonly targetId: OpaqueId;
  readonly sourceIds: readonly OpaqueId[];
  readonly quantityStrategy: "keep_target" | "sum";
  readonly allowCrossCategory?: boolean;
}): ElementMergePreview {
  const elements = input.elements.map((element) => elementSchema.parse(element));
  const references = input.references.map((reference) => elementReferenceSchema.parse(reference));
  if (new Set(elements.map((element) => element.id)).size !== elements.length) {
    throw new DomainError("INVALID_INPUT", "Element IDs must be unique.");
  }
  if (input.sourceIds.length === 0 || new Set(input.sourceIds).size !== input.sourceIds.length) {
    throw new DomainError("INVALID_INPUT", "Merge source IDs must be non-empty and unique.");
  }
  if (input.sourceIds.includes(input.targetId)) {
    throw new DomainError("INVALID_INPUT", "Merge target cannot also be a source.");
  }
  const byId = new Map(elements.map((element) => [element.id, element]));
  const target = byId.get(input.targetId);
  const sources = input.sourceIds.map((id) => byId.get(id));
  if (target === undefined || sources.some((source) => source === undefined)) {
    throw new DomainError("INVALID_INPUT", "Merge references an unknown element.");
  }
  const typedSources = sources as ElementRecord[];
  if (
    target.archived ||
    target.mergedIntoId !== undefined ||
    typedSources.some((source) => source.archived)
  ) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "Only active, unmerged elements can participate in a merge.",
    );
  }
  if (
    typedSources.some(
      (source) =>
        source.workspaceId !== target.workspaceId || source.projectId !== target.projectId,
    )
  ) {
    throw new DomainError(
      "AUTHORIZATION_DENIED",
      "Elements from different tenants or projects cannot be merged.",
    );
  }
  if (
    !input.allowCrossCategory &&
    typedSources.some((source) => source.categoryId !== target.categoryId)
  ) {
    throw new DomainError(
      "INVARIANT_VIOLATION",
      "Cross-category merge requires an explicit policy decision.",
    );
  }

  const aliases = [
    target.name,
    ...target.aliases,
    ...typedSources.flatMap((source) => [source.name, ...source.aliases]),
  ];
  const resultingAliases = [
    ...new Map(
      aliases.map((alias) => [alias.trim().toLocaleLowerCase("en-GB"), alias.trim()]),
    ).values(),
  ]
    .filter(
      (alias) => alias.toLocaleLowerCase("en-GB") !== target.name.trim().toLocaleLowerCase("en-GB"),
    )
    .sort((left, right) => left.localeCompare(right, "en-GB"));
  const sourceSet = new Set(input.sourceIds);
  const transformed = references.map((reference) =>
    sourceSet.has(reference.elementId) ? { ...reference, elementId: target.id } : reference,
  );
  const seen = new Set<string>();
  const redirectedReferences: ElementReference[] = [];
  const removedDuplicateReferences: ElementReference[] = [];
  for (const reference of transformed) {
    const key = `${reference.referenceType}:${reference.referenceId}:${reference.elementId}`;
    if (seen.has(key)) removedDuplicateReferences.push(reference);
    else {
      seen.add(key);
      redirectedReferences.push(reference);
    }
  }

  return {
    targetId: target.id,
    sourceIds: input.sourceIds,
    resultingAliases,
    resultingQuantity:
      input.quantityStrategy === "sum"
        ? target.quantity + typedSources.reduce((sum, source) => sum + source.quantity, 0)
        : target.quantity,
    redirectedReferences,
    removedDuplicateReferences,
    redirects: input.sourceIds.map((sourceId) => ({
      fromElementId: sourceId,
      toElementId: target.id,
    })),
  };
}

export function applyElementMerge(input: {
  readonly elements: readonly ElementRecord[];
  readonly preview: ElementMergePreview;
}): {
  readonly elements: readonly ElementRecord[];
  readonly references: readonly ElementReference[];
} {
  const sourceSet = new Set(input.preview.sourceIds);
  const elements = input.elements.map((element) => {
    const validated = elementSchema.parse(element);
    if (validated.id === input.preview.targetId) {
      return {
        ...validated,
        aliases: [...input.preview.resultingAliases],
        quantity: input.preview.resultingQuantity,
      };
    }
    if (sourceSet.has(validated.id)) {
      return { ...validated, archived: true, mergedIntoId: input.preview.targetId };
    }
    return validated;
  });
  return { elements, references: input.preview.redirectedReferences };
}
