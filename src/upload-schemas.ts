import { z } from "zod";
export const uploadMetadata = z.object({
  type: z.enum(["blueprints", "scenarios"]),
  version: z.string().default(""),
  game_version: z.string().default(""),
  changelog: z.string().default(""),
  caption: z.string().default(""),
});
const count = z.number().int().min(0).max(163_880_482);
const dimension = z.number().int().min(1).max(2048);
export const fileStatistics = z.strictObject({
  schema_version: z.literal(1),
  kind: z.enum(["blueprint", "scenario"]),
  width: dimension,
  height: dimension,
  depth: dimension,
  format_version: count.nullable().optional(),
  footprint_tiles: count.nullable().optional(),
  maps: count.nullable().optional(),
  entities: count.nullable().optional(),
  objects: count.nullable().optional(),
  object_types: count.nullable().optional(),
  parking_spaces: count.nullable().optional(),
  golf_cart_spaces: count.nullable().optional(),
  entrances: count.nullable().optional(),
  exits: count.nullable().optional(),
});
export type FileStatistics = z.infer<typeof fileStatistics>;
