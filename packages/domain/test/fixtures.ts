import { opaqueIdSchema, type OpaqueId } from "../src";

export function id(sequence: number): OpaqueId {
  return opaqueIdSchema.parse(`018f0000-0000-7000-8000-${sequence.toString(16).padStart(12, "0")}`);
}

export function fingerprint(character: string): string {
  return character.repeat(64).slice(0, 64);
}
