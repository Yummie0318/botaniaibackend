import { pool } from "@/lib/db";
import type { CreateScanInput } from "./scans.schema";

export async function createScan(userId: string, input: CreateScanInput) {
  const {
    image_asset_id,
    scan_type = "identify",
    source = "camera",
    latitude = null,
    longitude = null,
    country_code = null,
    region_name = null,
    city_name = null,
    metadata = {},
  } = input;

  const result = await pool.query(
    `
    INSERT INTO scans (
      user_id,
      image_asset_id,
      scan_type,
      status,
      source,
      latitude,
      longitude,
      country_code,
      region_name,
      city_name,
      captured_at,
      metadata
    )
    VALUES (
      $1, $2, $3, 'queued', $4, $5, $6, $7, $8, $9, NOW(), $10
    )
    RETURNING *
    `,
    [
      userId,
      image_asset_id,
      scan_type,
      source,
      latitude,
      longitude,
      country_code,
      region_name,
      city_name,
      JSON.stringify(metadata),
    ]
  );

  return result.rows[0];
}

export async function getUserScans(userId: string, input?: { limit?: number; offset?: number }) {
  const limit = Math.min(input?.limit ?? 20, 100);
  const offset = Math.max(input?.offset ?? 0, 0);

  const result = await pool.query(
    `
    SELECT
      s.id,
      s.scan_type,
      s.status,
      s.source,
      s.created_at,
      s.completed_at,
      m.public_url AS image_url,
      si.predicted_common_name,
      si.predicted_scientific_name,
      si.confidence_score,
      si.is_primary
    FROM scans s
    LEFT JOIN media_assets m
      ON m.id = s.image_asset_id
    LEFT JOIN scan_identifications si
      ON si.scan_id = s.id
     AND si.is_primary = TRUE
    WHERE s.user_id = $1
    ORDER BY s.created_at DESC
    LIMIT $2 OFFSET $3
    `,
    [userId, limit, offset]
  );

  return result.rows;
}

export async function getUserScanById(userId: string, scanId: string) {
  const scanResult = await pool.query(
    `
    SELECT
      s.*,
      m.public_url AS image_url
    FROM scans s
    LEFT JOIN media_assets m
      ON m.id = s.image_asset_id
    WHERE s.id = $1
      AND s.user_id = $2
    LIMIT 1
    `,
    [scanId, userId]
  );

  if (scanResult.rows.length === 0) {
    return null;
  }

  const identifications = await pool.query(
    `
    SELECT *
    FROM scan_identifications
    WHERE scan_id = $1
    ORDER BY rank_order ASC, confidence_score DESC
    `,
    [scanId]
  );

  const diagnoses = await pool.query(
    `
    SELECT *
    FROM scan_diagnoses
    WHERE scan_id = $1
    ORDER BY rank_order ASC, confidence_score DESC
    `,
    [scanId]
  );

  return {
    scan: scanResult.rows[0],
    identifications: identifications.rows,
    diagnoses: diagnoses.rows,
  };
}

export async function getOwnedScanForIdentification(userId: string, scanId: string) {
  const result = await pool.query(
    `
    SELECT
      s.*,
      m.public_url AS image_url,
      m.id AS media_asset_id
    FROM scans s
    LEFT JOIN media_assets m
      ON m.id = s.image_asset_id
    WHERE s.id = $1
      AND s.user_id = $2
    LIMIT 1
    `,
    [scanId, userId]
  );

  return result.rows[0] ?? null;
}

export async function markScanProcessing(scanId: string) {
  await pool.query(
    `
    UPDATE scans
    SET
      status = 'processing',
      updated_at = NOW()
    WHERE id = $1
    `,
    [scanId]
  );
}

export async function markScanCompleted(input: {
  scanId: string;
  aiProvider: string;
  aiModel: string;
  promptVersion: string;
  responsePayload: unknown;
}) {
  const { scanId, aiProvider, aiModel, promptVersion, responsePayload } = input;

  await pool.query(
    `
    UPDATE scans
    SET
      status = 'completed',
      completed_at = NOW(),
      ai_provider = $2,
      ai_model = $3,
      prompt_version = $4,
      response_payload = $5,
      updated_at = NOW()
    WHERE id = $1
    `,
    [scanId, aiProvider, aiModel, promptVersion, JSON.stringify(responsePayload)]
  );
}

export async function markScanFailed(scanId: string, failureReason: string) {
  await pool.query(
    `
    UPDATE scans
    SET
      status = 'failed',
      failure_reason = $2,
      updated_at = NOW()
    WHERE id = $1
    `,
    [scanId, failureReason]
  );
}

export async function replacePrimaryIdentification(input: {
  scanId: string;
  plantSpeciesId: string | null;
  predictedCommonName: string;
  predictedScientificName?: string | null;
  confidenceScore: number;
  reasoningSummary?: string | null;
  benefitsSummary?: string | null;
  safetySummary?: string | null;
  careSummary?: string | null;
  structuredResult?: unknown;
}) {
  const {
    scanId,
    plantSpeciesId,
    predictedCommonName,
    predictedScientificName = null,
    confidenceScore,
    reasoningSummary = null,
    benefitsSummary = null,
    safetySummary = null,
    careSummary = null,
    structuredResult = {},
  } = input;

  await pool.query(`DELETE FROM scan_identifications WHERE scan_id = $1`, [scanId]);

  const result = await pool.query(
    `
    INSERT INTO scan_identifications (
      scan_id,
      plant_species_id,
      rank_order,
      predicted_common_name,
      predicted_scientific_name,
      confidence_score,
      is_primary,
      reasoning_summary,
      benefits_summary,
      safety_summary,
      care_summary,
      structured_result
    )
    VALUES (
      $1, $2, 1, $3, $4, $5, TRUE, $6, $7, $8, $9, $10
    )
    RETURNING *
    `,
    [
      scanId,
      plantSpeciesId,
      predictedCommonName,
      predictedScientificName,
      confidenceScore,
      reasoningSummary,
      benefitsSummary,
      safetySummary,
      careSummary,
      JSON.stringify(structuredResult),
    ]
  );

  return result.rows[0];
}

export async function findOrCreatePlantSpeciesFromAi(input: {
  predictedCommonName: string;
  predictedScientificName?: string | null;
  category?: string | null;
  edibleStatus?: string | null;
  medicinalStatus?: string | null;
  toxicityStatus?: string | null;
  descriptionShort?: string | null;
}) {
  const {
    predictedCommonName,
    predictedScientificName = null,
    category = "unknown",
    edibleStatus = "unknown",
    medicinalStatus = "unknown",
    toxicityStatus = "unknown",
    descriptionShort = null,
  } = input;

  const existing = await pool.query(
    `
    SELECT id
    FROM plant_species
    WHERE LOWER(scientific_name) = LOWER($1)
       OR LOWER(common_name) = LOWER($2)
    LIMIT 1
    `,
    [predictedScientificName || "", predictedCommonName]
  );

  if (existing.rows.length > 0) {
    return existing.rows[0].id as string;
  }

  const insertResult = await pool.query(
    `
    INSERT INTO plant_species (
      scientific_name,
      common_name,
      category,
      edible_status,
      medicinal_status,
      toxicity_status,
      description_short,
      confidence_source,
      metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'ai', $8)
    RETURNING id
    `,
    [
      predictedScientificName || predictedCommonName,
      predictedCommonName,
      category,
      edibleStatus,
      medicinalStatus,
      toxicityStatus,
      descriptionShort,
      JSON.stringify({ ai_generated: true }),
    ]
  );

  return insertResult.rows[0].id as string;
}

export async function incrementDailyUsage(userId: string, type: "identify" | "disease" | "chat" = "identify") {
  let scanField = "scan_count";
  let typeField = "identify_count";

  if (type === "disease") {
    typeField = "disease_count";
  } else if (type === "chat") {
    scanField = "scan_count";
    typeField = "ai_chat_count";
  }

  await pool.query(
    `
    INSERT INTO usage_daily (
      user_id,
      usage_date,
      scan_count,
      identify_count,
      disease_count,
      ai_chat_count
    )
    VALUES (
      $1,
      CURRENT_DATE,
      $2,
      $3,
      $4,
      $5
    )
    ON CONFLICT (user_id, usage_date)
    DO UPDATE SET
      scan_count = usage_daily.scan_count + $2,
      identify_count = usage_daily.identify_count + $3,
      disease_count = usage_daily.disease_count + $4,
      ai_chat_count = usage_daily.ai_chat_count + $5,
      updated_at = NOW()
    `,
    [
      userId,
      1,
      type === "identify" ? 1 : 0,
      type === "disease" ? 1 : 0,
      type === "chat" ? 1 : 0,
    ]
  );
}