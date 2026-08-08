import { z } from "zod";

import { DomainError } from "./errors";

export const frameRateSchema = z
  .object({
    numerator: z.number().int().positive().max(240_000),
    denominator: z.number().int().positive().max(10_000),
    dropFrame: z.boolean().default(false),
  })
  .strict()
  .superRefine((rate, context) => {
    if (rate.dropFrame) {
      const supported =
        (rate.numerator === 30_000 && rate.denominator === 1_001) ||
        (rate.numerator === 60_000 && rate.denominator === 1_001);
      if (!supported) {
        context.addIssue({
          code: "custom",
          message: "Drop-frame timecode is supported only for 30000/1001 and 60000/1001.",
        });
      }
    }
  });

export type FrameRate = z.infer<typeof frameRateSchema>;
export type IntegerRounding = "floor" | "ceil" | "nearest";

export const DEFAULT_FRAME_RATE: FrameRate = Object.freeze({
  numerator: 24,
  denominator: 1,
  dropFrame: false,
});

function checkedNonNegativeInteger(value: number, label: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError("INVALID_INPUT", `${label} must be a non-negative safe integer.`);
  }
  return BigInt(value);
}

function divide(numerator: bigint, denominator: bigint, rounding: IntegerRounding): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n || rounding === "floor") return quotient;
  if (rounding === "ceil") return quotient + 1n;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

function safeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DomainError("INVALID_INPUT", `${label} exceeds JavaScript's safe integer range.`);
  }
  return Number(value);
}

export function framesFromMilliseconds(
  milliseconds: number,
  frameRate: FrameRate,
  rounding: IntegerRounding = "nearest",
): number {
  const rate = frameRateSchema.parse(frameRate);
  const result = divide(
    checkedNonNegativeInteger(milliseconds, "Milliseconds") * BigInt(rate.numerator),
    1_000n * BigInt(rate.denominator),
    rounding,
  );
  return safeNumber(result, "Frame count");
}

export function millisecondsFromFrames(
  frames: number,
  frameRate: FrameRate,
  rounding: IntegerRounding = "nearest",
): number {
  const rate = frameRateSchema.parse(frameRate);
  const result = divide(
    checkedNonNegativeInteger(frames, "Frames") * 1_000n * BigInt(rate.denominator),
    BigInt(rate.numerator),
    rounding,
  );
  return safeNumber(result, "Duration");
}

function nominalFramesPerSecond(frameRate: FrameRate): number {
  return Math.round(frameRate.numerator / frameRate.denominator);
}

function dropFramesPerMinute(frameRate: FrameRate): number {
  return nominalFramesPerSecond(frameRate) === 60 ? 4 : 2;
}

export function formatTimecode(frames: number, frameRate: FrameRate): string {
  const rate = frameRateSchema.parse(frameRate);
  const original = Number(checkedNonNegativeInteger(frames, "Frames"));
  const nominal = nominalFramesPerSecond(rate);
  let labelFrames = original;

  if (rate.dropFrame) {
    const dropped = dropFramesPerMinute(rate);
    const framesPer10Minutes = nominal * 60 * 10 - dropped * 9;
    const framesPerMinute = nominal * 60 - dropped;
    const framesPer24Hours = (nominal * 60 * 60 - dropped * 54) * 24;
    const wrapped = labelFrames % framesPer24Hours;
    const tenMinuteBlocks = Math.floor(wrapped / framesPer10Minutes);
    const remainder = wrapped % framesPer10Minutes;
    labelFrames =
      wrapped +
      dropped * 9 * tenMinuteBlocks +
      (remainder >= dropped ? dropped * Math.floor((remainder - dropped) / framesPerMinute) : 0);
  }

  const framesField = labelFrames % nominal;
  const totalSeconds = Math.floor(labelFrames / nominal);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60) % 24;
  const separator = rate.dropFrame ? ";" : ":";
  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":")
    .concat(separator, String(framesField).padStart(2, "0"));
}

export function parseTimecode(value: string, frameRate: FrameRate): number {
  const rate = frameRateSchema.parse(frameRate);
  const match = /^(\d{2}):(\d{2}):(\d{2})([:;])(\d{2,3})$/.exec(value);
  if (!match)
    throw new DomainError("INVALID_INPUT", "Timecode must use HH:MM:SS:FF or HH:MM:SS;FF.");
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const separator = match[4];
  const frameField = Number(match[5]);
  const nominal = nominalFramesPerSecond(rate);
  if (hours > 23 || minutes > 59 || seconds > 59 || frameField >= nominal) {
    throw new DomainError("INVALID_INPUT", "Timecode field is outside its valid range.");
  }
  if ((separator === ";") !== rate.dropFrame) {
    throw new DomainError(
      "INVALID_INPUT",
      "Timecode separator does not match the frame-rate mode.",
    );
  }

  const totalMinutes = hours * 60 + minutes;
  let frameNumber = (hours * 60 * 60 + minutes * 60 + seconds) * nominal + frameField;
  if (rate.dropFrame) {
    const dropped = dropFramesPerMinute(rate);
    if (minutes % 10 !== 0 && seconds === 0 && frameField < dropped) {
      throw new DomainError(
        "INVALID_INPUT",
        "Timecode names a frame omitted by drop-frame counting.",
      );
    }
    frameNumber -= dropped * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return frameNumber;
}

export function sumFrameDurations(frames: readonly number[]): number {
  return safeNumber(
    frames.reduce((sum, value) => sum + checkedNonNegativeInteger(value, "Frames"), 0n),
    "Frame total",
  );
}

export function estimatedSpeechFrames(
  wordCount: number,
  wordsPerMinute: number,
  frameRate: FrameRate,
): number {
  if (
    !Number.isSafeInteger(wordCount) ||
    wordCount < 0 ||
    !Number.isFinite(wordsPerMinute) ||
    wordsPerMinute <= 0
  ) {
    throw new DomainError(
      "INVALID_INPUT",
      "Word count and speaking rate must be positive valid values.",
    );
  }
  const durationMs = Math.round((wordCount * 60_000) / wordsPerMinute);
  return framesFromMilliseconds(durationMs, frameRate, "nearest");
}
