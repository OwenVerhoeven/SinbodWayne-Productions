import { createInterface } from "node:readline/promises";

export async function readVisibleLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive terminal input is required.");
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await terminal.question(prompt);
  } finally {
    terminal.close();
  }
}

export async function readHiddenLine(prompt: string): Promise<string> {
  if (
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    typeof process.stdin.setRawMode !== "function"
  ) {
    throw new Error(
      "A TTY with hidden input support is required; password arguments and environment variables are not accepted.",
    );
  }

  process.stdout.write(prompt);
  const characters: string[] = [];
  process.stdin.setEncoding("utf8");
  process.stdin.resume();
  process.stdin.setRawMode(true);

  try {
    return await new Promise<string>((resolveLine, reject) => {
      const onData = (chunk: string): void => {
        for (const character of chunk) {
          if (character === "\u0003") {
            cleanup();
            reject(new Error("Bootstrap cancelled."));
            return;
          }
          if (character === "\r" || character === "\n") {
            cleanup();
            process.stdout.write("\n");
            resolveLine(characters.join(""));
            return;
          }
          if (character === "\u007f" || character === "\b") {
            characters.pop();
            continue;
          }
          if (character >= " ") characters.push(character);
        }
      };
      const cleanup = (): void => {
        process.stdin.off("data", onData);
      };
      process.stdin.on("data", onData);
    });
  } finally {
    characters.fill("");
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}
