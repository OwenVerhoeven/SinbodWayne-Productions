export const screenplayBlockTypes = [
  "scene_heading",
  "action",
  "character",
  "parenthetical",
  "dialogue",
  "dual_dialogue",
  "transition",
  "shot",
  "lyrics",
  "page_break",
  "section",
  "synopsis",
  "note",
] as const;

export type ScreenplayBlockType = (typeof screenplayBlockTypes)[number];

export interface ImportedBlock {
  readonly type: ScreenplayBlockType;
  readonly text: string;
}

export interface ScriptImportResult {
  readonly blocks: readonly ImportedBlock[];
  readonly warnings: readonly string[];
  readonly sourceFormat: "fountain" | "fdx" | "txt";
}

const sceneHeading = /^(?:\.)?(?:INT\.?|EXT\.?|INT\.?\/EXT\.?|I\/E\.?|EST\.?)[\s.-]/iu;
const transition = /^(?:FADE (?:IN|OUT)|CUT TO|DISSOLVE TO|SMASH CUT TO|MATCH CUT TO|WIPE TO):?$/iu;
const character = /^[A-Z][A-Z0-9 ._'\-()]{1,48}(?:\^)?$/u;

/** Deterministic, deliberately conservative Fountain parser for supported constructs. */
export function parseFountain(source: string): ScriptImportResult {
  const warnings: string[] = [];
  const blocks: ImportedBlock[] = [];
  const lines = normaliseSource(source).split("\n");
  let prior: ScreenplayBlockType | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      prior = undefined;
      continue;
    }
    if (trimmed === "===") {
      blocks.push({ type: "page_break", text: "" });
      prior = "page_break";
      continue;
    }
    if (trimmed.startsWith("[[") && trimmed.endsWith("]]")) {
      blocks.push({ type: "note", text: trimmed.slice(2, -2).trim() });
      prior = "note";
      continue;
    }
    if (trimmed.startsWith("#")) {
      blocks.push({ type: "section", text: trimmed.replace(/^#+\s*/u, "") });
      prior = "section";
      continue;
    }
    if (trimmed.startsWith("=")) {
      blocks.push({ type: "synopsis", text: trimmed.slice(1).trim() });
      prior = "synopsis";
      continue;
    }
    if (sceneHeading.test(trimmed)) {
      blocks.push({ type: "scene_heading", text: trimmed.replace(/^\./u, "").toUpperCase() });
      prior = "scene_heading";
      continue;
    }
    if (trimmed.startsWith(">") && trimmed.endsWith("<")) {
      blocks.push({ type: "action", text: trimmed.slice(1, -1).trim() });
      prior = "action";
      continue;
    }
    if (transition.test(trimmed) || (trimmed.startsWith(">") && trimmed.endsWith(":"))) {
      blocks.push({ type: "transition", text: trimmed.replace(/^>/u, "") });
      prior = "transition";
      continue;
    }
    if (trimmed.startsWith("@") || character.test(trimmed)) {
      const isCharacter = trimmed.startsWith("@") || looksLikeDialogueCue(lines, index);
      if (isCharacter) {
        blocks.push({
          type: trimmed.endsWith("^") ? "dual_dialogue" : "character",
          text: trimmed.replace(/^@/u, "").replace(/\^$/u, "").trim(),
        });
        prior = "character";
        continue;
      }
    }
    if (trimmed.startsWith("(") && trimmed.endsWith(")") && prior === "character") {
      blocks.push({ type: "parenthetical", text: trimmed });
      prior = "parenthetical";
      continue;
    }
    if (prior === "character" || prior === "parenthetical" || prior === "dialogue") {
      blocks.push({ type: "dialogue", text: trimmed });
      prior = "dialogue";
      continue;
    }
    if (trimmed.startsWith("~")) {
      blocks.push({ type: "lyrics", text: trimmed.slice(1).trimStart() });
      prior = "lyrics";
      continue;
    }
    if (trimmed.startsWith("!!")) {
      warnings.push(`Line ${index + 1}: unsupported Fountain directive was imported as a note.`);
      blocks.push({ type: "note", text: trimmed.slice(2).trim() });
      prior = "note";
      continue;
    }
    blocks.push({ type: "action", text: trimmed });
    prior = "action";
  }

  return { blocks, warnings, sourceFormat: "fountain" };
}

/** Parses the paragraph subset of Final Draft XML without executing or rendering XML. */
export function parseFdx(source: string): ScriptImportResult {
  const input = normaliseSource(source);
  if (!/<FinalDraft\b/iu.test(input)) {
    return {
      blocks: parseFountain(input).blocks,
      warnings: ["The file did not contain a FinalDraft root element; it was read as plain text."],
      sourceFormat: "fdx",
    };
  }

  const warnings: string[] = [];
  const blocks: ImportedBlock[] = [];
  const supported = new Map<string, ScreenplayBlockType>([
    ["Scene Heading", "scene_heading"],
    ["Action", "action"],
    ["Character", "character"],
    ["Parenthetical", "parenthetical"],
    ["Dialogue", "dialogue"],
    ["Transition", "transition"],
    ["Shot", "shot"],
    ["Lyrics", "lyrics"],
    ["General", "note"],
  ]);
  const paragraph = /<Paragraph\b([^>]*)>([\s\S]*?)<\/Paragraph>/giu;
  let match: RegExpExecArray | null;
  while ((match = paragraph.exec(input))) {
    const attributes = match[1] ?? "";
    const body = match[2] ?? "";
    const typeName = decodeEntities(/\bType="([^"]+)"/iu.exec(attributes)?.[1] ?? "General");
    const text = decodeEntities(
      body
        .replace(/<Text\b[^>]*>/giu, "")
        .replace(/<\/Text>/giu, "\n")
        .replace(/<[^>]+>/gu, ""),
    ).trim();
    const type = supported.get(typeName);
    if (!type) {
      warnings.push(`Unsupported FDX paragraph type “${typeName}” was imported as a note.`);
      blocks.push({ type: "note", text });
    } else {
      blocks.push({ type, text });
    }
  }
  const unsupported = new Set<string>();
  for (const found of input.matchAll(/<Paragraph\b[^>]*\bType="([^"]+)"/giu)) {
    const value = decodeEntities(found[1] ?? "");
    if (!supported.has(value)) unsupported.add(value);
  }
  if (/<DualDialogue\b/iu.test(input)) {
    warnings.push("FDX dual-dialogue layout was flattened; dialogue order is preserved.");
  }
  for (const type of unsupported) {
    if (!warnings.some((warning) => warning.includes(`“${type}”`))) {
      warnings.push(`Unsupported FDX paragraph type “${type}” was imported as a note.`);
    }
  }
  if (blocks.length === 0) warnings.push("No supported FDX paragraphs were found.");
  return { blocks, warnings, sourceFormat: "fdx" };
}

export function parseTxt(source: string): ScriptImportResult {
  const parsed = parseFountain(source);
  return {
    blocks: parsed.blocks,
    warnings: [
      "TXT has no reliable structural metadata; review every inferred screenplay element.",
    ],
    sourceFormat: "txt",
  };
}

export function exportFountain(blocks: readonly ImportedBlock[]): string {
  return `${blocks.map(toFountain).join("\n\n").trimEnd()}\n`;
}

export function exportFdx(blocks: readonly ImportedBlock[], title: string): string {
  const paragraphs = blocks
    .filter((block) => block.type !== "page_break")
    .map(
      (block) =>
        `      <Paragraph Type="${escapeXml(fdxType(block.type))}"><Text>${escapeXml(block.text)}</Text></Paragraph>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<FinalDraft DocumentType="Script" Template="No" Version="1">\n  <Content>\n${paragraphs}\n  </Content>\n  <TitlePage><Content><Paragraph Type="Title"><Text>${escapeXml(title)}</Text></Paragraph></Content></TitlePage>\n</FinalDraft>\n`;
}

function looksLikeDialogueCue(lines: readonly string[], index: number): boolean {
  const next = lines[index + 1]?.trim() ?? "";
  return Boolean(next && !sceneHeading.test(next) && !transition.test(next));
}

function toFountain(block: ImportedBlock): string {
  switch (block.type) {
    case "scene_heading":
      return block.text.toUpperCase();
    case "character":
      return block.text.toUpperCase();
    case "dual_dialogue":
      return `${block.text.toUpperCase()} ^`;
    case "transition":
      return block.text.endsWith(":") ? block.text.toUpperCase() : `${block.text.toUpperCase()}:`;
    case "lyrics":
      return `~${block.text}`;
    case "page_break":
      return "===";
    case "section":
      return `# ${block.text}`;
    case "synopsis":
      return `= ${block.text}`;
    case "note":
      return `[[${block.text}]]`;
    default:
      return block.text;
  }
}

function fdxType(type: ScreenplayBlockType): string {
  const names: Record<ScreenplayBlockType, string> = {
    scene_heading: "Scene Heading",
    action: "Action",
    character: "Character",
    parenthetical: "Parenthetical",
    dialogue: "Dialogue",
    dual_dialogue: "Character",
    transition: "Transition",
    shot: "Shot",
    lyrics: "Lyrics",
    page_break: "General",
    section: "General",
    synopsis: "General",
    note: "General",
  };
  return names[type];
}

function normaliseSource(source: string): string {
  return source
    .replace(/^\uFEFF/u, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
}

function decodeEntities(value: string): string {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
