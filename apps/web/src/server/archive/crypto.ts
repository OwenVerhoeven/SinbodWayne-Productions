const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function fromHexOrZeros(value: string): { readonly bytes: Uint8Array; readonly valid: boolean } {
  const valid = /^[a-f0-9]{64}$/.test(value);
  const bytes = new Uint8Array(32);
  if (valid) {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    }
  }
  return { bytes, valid };
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const source = typeof input === "string" ? encoder.encode(input) : input;
  const copied = new Uint8Array(source.byteLength);
  copied.set(source);
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", copied.buffer)));
}

export function timingSafeHexEqual(left: string, right: string): boolean {
  const leftValue = fromHexOrZeros(left);
  const rightValue = fromHexOrZeros(right);
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (leftBytes: ArrayBufferView, rightBytes: ArrayBufferView) => boolean;
  };
  const equal =
    typeof subtle.timingSafeEqual === "function"
      ? subtle.timingSafeEqual(leftValue.bytes, rightValue.bytes)
      : leftValue.bytes.reduce(
          (difference, byte, index) => difference | (byte ^ (rightValue.bytes[index] ?? 0)),
          0,
        ) === 0;
  return equal && leftValue.valid && rightValue.valid;
}

export function randomSecret(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
