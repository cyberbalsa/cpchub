import { build } from "esbuild";
import { readdir } from "node:fs/promises";

for (const file of await readdir("browser")) {
  if (!file.endsWith(".ts") || file.endsWith(".d.ts")) continue;
  const name = file.slice(0, -3);
  await build({
    stdin: {
      contents: `import { initialize } from './browser/${name}.ts'; initialize(window);`,
      resolveDir: process.cwd(),
      sourcefile: `generated-${name}-entry.ts`,
    },
    outfile: `public/static/js/${name}.js`,
    bundle: true,
    minify: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    legalComments: "none",
  });
}
