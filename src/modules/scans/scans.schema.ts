import { z } from "zod";

export const createScanSchema = z.object({
  image_asset_id: z.string().uuid(),
  scan_type: z
    .enum(["identify", "disease", "care", "safety", "multi_scan"])
    .default("identify"),
  source: z
    .enum(["camera", "gallery", "import", "api"])
    .default("camera"),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  country_code: z.string().max(10).nullable().optional(),
  region_name: z.string().max(120).nullable().optional(),
  city_name: z.string().max(120).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

export type CreateScanInput = z.infer<typeof createScanSchema>;