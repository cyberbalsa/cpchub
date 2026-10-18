import { z } from "zod";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import assert from "node:assert/strict";
export interface Schema extends Record<string, unknown> {
  type?: string | string[] | undefined;
  properties?: Record<string, Schema> | undefined;
  required?: string[] | undefined;
  enum?: unknown[] | undefined;
  $ref?: string | undefined;
  allOf?: Schema[] | undefined;
  oneOf?: Schema[] | undefined;
}
const schema: z.ZodType<Schema> = z.lazy(() =>
  z
    .object({
      type: z.union([z.string(), z.array(z.string())]).optional(),
      properties: z.record(z.string(), schema).optional(),
      required: z.array(z.string()).optional(),
      enum: z.array(z.unknown()).optional(),
      $ref: z.string().optional(),
      allOf: z.array(schema).optional(),
      oneOf: z.array(schema).optional(),
    })
    .catchall(z.unknown()),
);
const responseContract = z.object({
  $ref: z.string().optional(),
  content: z.record(z.string(), z.object({ schema })).optional(),
});
const operation = z.object({
  operationId: z.string(),
  parameters: z
    .array(
      z.object({
        name: z.string(),
        in: z.string(),
        required: z.boolean().optional(),
      }),
    )
    .optional(),
  responses: z.record(z.string(), responseContract),
});
export const spec = z
  .object({
    paths: z.record(z.string(), z.record(z.string(), operation)),
    servers: z.array(z.object({ url: z.string() })),
    components: z.object({
      schemas: z.record(z.string(), schema),
      responses: z.record(z.string(), responseContract),
      securitySchemes: z.record(
        z.string(),
        z.object({ name: z.string().optional() }),
      ),
    }),
  })
  .parse(parse(readFileSync("public/openapi.yaml", "utf8")));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addFormat("binary", true);
ajv.addFormat("int64", { type: "number", validate: Number.isSafeInteger });
ajv.addSchema({
  $id: "https://test.local/contract",
  components: spec.components,
});
export function validator(schema: Schema) {
  return ajv.compile({ ...schema, components: spec.components });
}
export function check(name: string, data: unknown) {
  const validate = validator({ $ref: "#/components/schemas/" + name });
  assert(validate(data), name + ": " + JSON.stringify(validate.errors));
}
export const covered = new Set<string>();
export async function checkResponse<T = unknown>(
  path: string,
  method: string,
  response: Response,
): Promise<T | undefined> {
  const op = spec.paths[path]?.[method.toLowerCase()];
  assert(op, `Undocumented operation ${method} ${path}`);
  covered.add(method.toUpperCase() + " " + path);
  const responseSpec = op.responses[String(response.status)];
  assert(
    responseSpec,
    `Undocumented status ${response.status} on ${method} ${path}: ${await response.clone().text()}`,
  );
  const contract = responseSpec.$ref
    ? spec.components.responses[responseSpec.$ref.split("/").at(-1)!]
    : responseSpec;
  assert(contract);
  const contentType = response.headers.get("content-type")?.split(";")[0];
  if (contract.content) {
    assert(contentType);
    const schema = contract.content[contentType]?.schema;
    assert(schema, `Undocumented media type ${contentType}`);
    if (contentType === "application/json") {
      const data: unknown = await response.clone().json();
      const validate = validator(schema);
      assert(
        validate(data),
        `${method} ${path}: ${JSON.stringify(validate.errors)}`,
      );
      return data as T;
    }
  } else assert.equal(await response.clone().text(), "");
  return undefined;
}
