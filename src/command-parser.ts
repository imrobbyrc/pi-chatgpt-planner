export interface ParsedAdjustment { id?: string; feedback: string; }

/** Preserve command text; only remove one syntactic outer quote pair. */
export function parseFreeForm(input: string): string {
  const text = input.trim();
  if (text.length < 2 || !['"', "'"].includes(text[0]!)) return text;
  const quote = text[0];
  if (text.at(-1) !== quote) return text;
  let escaped = false;
  for (let i = 1; i < text.length - 1; i++) {
    if (escaped) { escaped = false; continue; }
    if (text[i] === "\\") { escaped = true; continue; }
    if (text[i] === quote) return text;
  }
  return text.slice(1, -1);
}

/** An ID is special only when it is the first unquoted token. */
export function parseAdjustment(input: string): ParsedAdjustment {
  const text = input.trim();
  if (!text || text[0] === '"' || text[0] === "'") return { feedback: parseFreeForm(text) };
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match || !/^[0-9a-f-]{4,36}$/i.test(match[1]!)) return { feedback: parseFreeForm(text) };
  const id = match[1]!;
  const feedback = parseFreeForm(match[2] ?? "");
  return { id, feedback };
}
