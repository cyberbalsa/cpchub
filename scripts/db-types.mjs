import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";

const db = new DatabaseSync(":memory:");
for (const name of readdirSync("migrations")
  .filter((name) => name.endsWith(".sql"))
  .sort()) {
  db.exec(readFileSync("migrations/" + name, "utf8"));
}
const tables = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  )
  .all();
let text =
  "// Generated from migrations by npm run types:db. Do not edit.\nexport interface DatabaseTables {\n";
for (const { name } of tables) {
  text += `  ${name}: {\n`;
  for (const column of db.prepare(`PRAGMA table_info("${name}")`).all()) {
    const type = /int|bool|real|float|decimal/i.test(column.type)
      ? "number"
      : /blob/i.test(column.type)
        ? "ArrayBuffer"
        : "string";
    text += `    ${column.name}: ${type}${column.notnull || column.pk ? "" : " | null"};\n`;
  }
  text += "  };\n";
}
text += "}\n";
db.close();
const destination = "src/database.generated.d.ts";
if (process.argv.includes("--check")) {
  if (readFileSync(destination, "utf8") !== text)
    throw new Error("Database types are stale. Run npm run types:db.");
} else writeFileSync(destination, text);
