import { createHash } from "node:crypto";

export async function sha256HexFromStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hash = createHash("sha256");
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      hash.update(next.value);
    }
    return hash.digest("hex");
  } finally {
    reader.releaseLock();
  }
}

export async function consumeStreamWithSha256<T>(
  source: ReadableStream<Uint8Array>,
  consume: (stream: ReadableStream<Uint8Array>) => Promise<T>,
): Promise<{ result: T; sha256: string; byteSize: number }> {
  const hash = createHash("sha256");
  let byteSize = 0;
  const stream = source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        hash.update(chunk);
        byteSize += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }),
  );
  const result = await consume(stream);
  return { result, sha256: hash.digest("hex"), byteSize };
}
