import { statfs } from "node:fs/promises";

import type { SpaceProbe } from "./types.ts";

export class HostSpaceProbe implements SpaceProbe {
  async availableBytes(destinationRoot: string): Promise<bigint | null> {
    try {
      const stats = await statfs(destinationRoot, { bigint: true });
      return stats.bavail * stats.bsize;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        ["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EINVAL"].includes(String(error.code))
      ) {
        return null;
      }
      throw error;
    }
  }
}
