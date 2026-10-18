import { AllProfanity } from "allprofanity";
import { parseDocument } from "htmlparser2";
import serializeHTML from "dom-serializer";
import { normalizeText } from "./text-input";

// AllProfanity's constructor also loads Hindi; explicitly select English to
// avoid censoring ordinary names such as Randi, Lund and Kutta. Never cache
// request text in a shared Worker isolate.
const filter = new AllProfanity({
  silent: true,
  performance: { enableCaching: false },
});
filter.clearList();
filter.loadLanguage("english");
filter.addToWhitelist(["ScunthorpeParking"]);
// Transliteration maps the Greek upsilon in fυck to y. Cover that spelling
// after normalization, as well as the original spelling before normalization.
filter.add("fyck");

// This is a presentation policy, not HTML escaping or an account identifier.
// Keep originals available to editors and moderators; mask existing rows too.
export function censorText(value: string): string {
  const original = value.normalize("NFKC").replace(/[\p{Cf}\p{Cs}]/gu, "");
  return filter.clean(normalizeText(filter.clean(original, "♥")), "♥");
}

export function censorMarkdown(value: string): string {
  // Keep destinations byte-for-byte intact. The Markdown renderer separately
  // filters visible text, including autolinks and decoded HTML entities.
  return value
    .split(/(https?:\/\/[^\s<>"']+)/gi)
    .map((part, index) => (index % 2 ? part : censorText(part)))
    .join("");
}

const blockTags = new Set([
  "p",
  "br",
  "hr",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "h2",
  "h3",
  "h4",
]);

// Call only after HTML sanitization. Parse visible text as a whole so entities
// and inline formatting cannot split a word across separate parser callbacks.
// Only text nodes change; hrefs and all other sanitized attributes stay intact.
export function censorHTML(sanitized: string): string {
  const document = parseDocument(sanitized);
  type Node = (typeof document.children)[number];
  const group: Extract<Node, { type: "text" }>[] = [];
  function flush(): void {
    if (!group.length) return;
    const cleaned = filter.clean(group.map((node) => node.data).join(""), "♥");
    let offset = 0;
    for (const node of group) {
      const end = offset + node.data.length;
      node.data = cleaned.slice(offset, end);
      offset = end;
    }
    group.length = 0;
  }
  function visit(node: Node): void {
    if (node.type === "text") {
      node.data = normalizeText(node.data);
      group.push(node);
    } else if (node.type === "tag") {
      const block = blockTags.has(node.name);
      if (block) flush();
      for (const child of node.children) visit(child);
      if (block) flush();
    }
  }
  for (const node of document.children) visit(node);
  flush();
  return serializeHTML(document, { encodeEntities: "utf8" });
}
