import { transliterate } from "transliteration";
import type { Row } from "./env";

// Human-written content shares one normalization policy. HTML encoding is done
// at the output boundary, keeping stored text usable in JSON and Markdown.
export function normalizeText(value: string): string {
  return transliterate(
    value.normalize("NFKC").replace(/[\p{Cf}\p{Cs}]/gu, ""),
    { ignore: ["♥"] },
  ).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

const textFields = new Set([
  "username",
  "name",
  "title",
  "summary",
  "description",
  "tags",
  "caption",
  "version",
  "game_version",
  "changelog",
  "reason",
  "note",
  "q",
  "tag",
]);

export function normalizeTextFields(data: Row): Row {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      textFields.has(key) && typeof value === "string"
        ? normalizeText(value)
        : value,
    ]),
  );
}

export function normalizeSearch(params: URLSearchParams): URLSearchParams {
  const result = new URLSearchParams(params);
  for (const key of ["q", "tag", "username"]) {
    const value = result.get(key);
    if (value !== null) result.set(key, normalizeText(value));
  }
  return result;
}
