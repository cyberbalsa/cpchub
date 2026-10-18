import { normalizeText } from "./text-input";

// NFKC folds decorative alphabets; the library supplies language mappings.
// Strip invisible formatting before transliteration so it cannot split a name.
export function socialUsername(name: string, provider: "steam" | "discord") {
  const result = normalizeText(name)
    .replace(/[^A-Za-z0-9_ .-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140)
    .trim();
  return /[A-Za-z0-9]/.test(result) ? result : provider;
}
