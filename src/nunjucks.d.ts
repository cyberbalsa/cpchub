declare module "nunjucks/browser/nunjucks-slim.js" {
  import type { Environment, ILoader, runtime } from "nunjucks";
  const nunjucks: {
    Environment: typeof Environment;
    PrecompiledLoader: new (templates: Record<string, object>) => ILoader;
    runtime: typeof runtime;
  };
  export default nunjucks;
}
