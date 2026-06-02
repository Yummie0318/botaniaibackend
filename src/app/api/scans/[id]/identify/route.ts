import fs from "fs/promises";
import path from "path";
import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { IMAGE_STORAGE_DIR } from "@/lib/fs";
import { identifyWithPlantNet, type PlantNetResponse } from "@/lib/plantnet";
import { fail, ok } from "@/lib/response";
import { callAI } from "@/lib/gemini";
import { checkAndGrantExpertStatus } from "@/lib/expertEligibility";

type Params = {
  params: Promise<{ id: string }>;
};

type ScanImageRow = {
  id: string;
  image_role: string | null;
  sort_order: number;
  media_asset_id: string;
  media_metadata: {
    local_filename?: string;
    cloudinary_url?: string;
    storage?: string;
  } | null;
  mime_type: string | null;
  public_url: string | null;
};

type ParsedExplanation = {
  international_common_name?: string;
  localized_names?: Array<{
    country_code?: string;
    language_code?: string;
    name?: string;
  }>;
  benefits_summary?: string;
  safety_summary?: string;
  care_summary?: string;
  next_best_photo_request?: string;
  reasoning_summary?: string;
};

function extractJson(text: string) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI response did not return valid JSON.");
  return JSON.parse(match[0]);
}

function normalizeImageRole(value: unknown): string {
  const raw = String(value || "").trim().toLowerCase();
  const allowed = new Set([
    "general", "whole_plant", "leaf_closeup", "bark", "flower", "fruit",
  ]);
  return allowed.has(raw) ? raw : "general";
}

function mapImageRoleToPlantNetOrgan(
  role: string
): "auto" | "leaf" | "flower" | "fruit" | "bark" {
  const normalized = normalizeImageRole(role);
  if (normalized === "leaf_closeup") return "leaf";
  if (normalized === "flower") return "flower";
  if (normalized === "fruit") return "fruit";
  if (normalized === "bark") return "bark";
  return "auto";
}

function normalizeCategory(value: unknown): string {
  const raw = String(value || "").trim().toLowerCase();
  const allowed = new Set([
    "tree", "shrub", "herb", "vine", "grass", "fern",
    "succulent", "flower", "crop", "ornamental", "aquatic", "mushroom", "unknown",
  ]);
  if (allowed.has(raw)) return raw;
  if (raw.includes("houseplant") || raw.includes("indoor")) return "ornamental";
  if (raw.includes("ornamental")) return "ornamental";
  if (raw.includes("flower")) return "flower";
  if (raw.includes("herb")) return "herb";
  if (raw.includes("tree")) return "tree";
  if (raw.includes("shrub")) return "shrub";
  if (raw.includes("vine")) return "vine";
  if (raw.includes("fern")) return "fern";
  if (raw.includes("grass")) return "grass";
  if (raw.includes("crop")) return "crop";
  if (raw.includes("succulent")) return "succulent";
  return "unknown";
}

function normalizeEdibleStatus(value: unknown): string {
  const raw = String(value || "").trim().toLowerCase();
  if (["edible", "not_edible", "unknown", "conditional"].includes(raw)) return raw;
  if (raw === "not edible" || raw === "inedible") return "not_edible";
  return "unknown";
}

function normalizeMedicinalStatus(value: unknown): string {
  const raw = String(value || "").trim().toLowerCase();
  if (["medicinal", "not_medicinal", "unknown", "traditional_use_only"].includes(raw)) return raw;
  if (raw === "not medicinal") return "not_medicinal";
  if (raw.includes("traditional")) return "traditional_use_only";
  return "unknown";
}

function normalizeToxicityStatus(value: unknown): string {
  const raw = String(value || "").trim().toLowerCase();
  if (["non_toxic", "mildly_toxic", "toxic", "highly_toxic", "unknown"].includes(raw)) return raw;
  if (raw === "non toxic" || raw === "safe") return "non_toxic";
  if (raw === "mild toxic") return "mildly_toxic";
  if (raw === "high toxic" || raw === "very toxic") return "highly_toxic";
  return "unknown";
}

function confidenceBandFromScores(topScore: number, secondScore: number): "high" | "medium" | "low" {
  const gap = topScore - secondScore;
  if (topScore >= 0.8 && gap >= 0.2) return "high";
  if (topScore >= 0.5 && gap >= 0.1) return "medium";
  return "low";
}

function imageQualityFromImages(
  images: ScanImageRow[],
  predictedOrgans: PlantNetResponse["predictedOrgans"]
): "good" | "fair" | "poor" {
  const roles = new Set(images.map((i) => normalizeImageRole(i.image_role)));
  const organs = new Set(
    (predictedOrgans || [])
      .map((o) => String(o.organ || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const hasDetail =
    roles.has("leaf_closeup") || roles.has("flower") || roles.has("fruit") || roles.has("bark") ||
    organs.has("leaf") || organs.has("flower") || organs.has("fruit") || organs.has("bark");
  if (images.length >= 2 && hasDetail) return "good";
  if (images.length >= 1 && hasDetail) return "fair";
  return "poor";
}

function buildEvidenceVisible(
  images: ScanImageRow[],
  predictedOrgans: PlantNetResponse["predictedOrgans"]
) {
  const roles = new Set(images.map((i) => normalizeImageRole(i.image_role)));
  const organs = new Set(
    (predictedOrgans || [])
      .map((o) => String(o.organ || "").trim().toLowerCase())
      .filter(Boolean)
  );
  return {
    leaf:       roles.has("leaf_closeup") || organs.has("leaf"),
    bark:       roles.has("bark")         || organs.has("bark"),
    flower:     roles.has("flower")       || organs.has("flower"),
    fruit:      roles.has("fruit")        || organs.has("fruit"),
    whole_plant: roles.has("whole_plant") || roles.has("general"),
  };
}

function buildNextPhotoRequest(
  categoryGuess: string,
  evidence: { leaf: boolean; bark: boolean; flower: boolean; fruit: boolean; whole_plant: boolean }
) {
  if (!evidence.leaf) return "Please take a close-up photo of a single leaf, showing its shape and edges clearly.";
  if (categoryGuess === "tree" && !evidence.bark && !evidence.flower && !evidence.fruit)
    return "Please add another photo showing the bark, flowers, or fruits/seed pods if available.";
  if (!evidence.flower && !evidence.fruit) return "Please add another photo showing flowers or fruit if available.";
  if (!evidence.whole_plant) return "Please add another photo showing the whole plant or overall tree shape.";
  return "Please add another clearer photo from a different angle.";
}

// ── Image fetcher: handles both Cloudinary and local storage ─────────────────

async function fetchImageBuffer(item: ScanImageRow): Promise<Buffer | null> {
  const meta = item.media_metadata;

  // Cloudinary — fetch from URL
  if (meta?.storage === "cloudinary" && meta?.cloudinary_url) {
    try {
      const res = await fetch(meta.cloudinary_url);
      if (!res.ok) return null;
      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch {
      return null;
    }
  }

  // Also try public_url if it looks like a Cloudinary URL
  if (item.public_url && item.public_url.includes("cloudinary.com")) {
    try {
      const res = await fetch(item.public_url);
      if (!res.ok) return null;
      const arrayBuffer = await res.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } catch {
      return null;
    }
  }

  // Local storage fallback
  if (meta?.local_filename) {
    try {
      const filepath = path.join(IMAGE_STORAGE_DIR, meta.local_filename);
      return await fs.readFile(filepath);
    } catch {
      return null;
    }
  }

  return null;
}

async function upsertLocalizedNames(
  plantSpeciesId: string,
  localizedNames: ParsedExplanation["localized_names"]
) {
  if (!Array.isArray(localizedNames)) return;
  for (const item of localizedNames) {
    const countryCode  = typeof item?.country_code  === "string" ? item.country_code.trim().toUpperCase()  : null;
    const languageCode = typeof item?.language_code === "string" ? item.language_code.trim().toLowerCase() : "en";
    const name         = typeof item?.name          === "string" ? item.name.trim() : "";
    if (!countryCode || !name) continue;
    await pool.query(
      `
      INSERT INTO plant_common_names (plant_species_id, language_code, country_code, name, is_primary)
      VALUES ($1, $2, $3, $4, FALSE)
      ON CONFLICT (plant_species_id, language_code, name) DO NOTHING
      `,
      [plantSpeciesId, languageCode, countryCode, name]
    );
  }
}

async function findOrCreatePlantSpecies(input: {
  scientificName: string;
  commonName: string;
  familyName?: string | null;
  genusName?: string | null;
  category?: string;
  descriptionShort?: string | null;
  metadata?: Record<string, unknown>;
}) {
const result = await pool.query(
    `INSERT INTO plant_species (scientific_name, common_name, family_name, genus_name, category, description_short, confidence_source, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, 'plantnet', $7)
     ON CONFLICT (scientific_name) DO UPDATE SET updated_at = NOW()
     RETURNING id`,
    [
      input.scientificName, input.commonName,
      input.familyName || null, input.genusName || null,
      normalizeCategory(input.category),
      input.descriptionShort || null,
      JSON.stringify(input.metadata || { source: "plantnet" }),
    ]
  );
  return result.rows[0].id as string;
}

async function explainWithGemini(input: {
  countryCode?: string | null;
  languageCode?: string | null;
  bestScientificName: string;
  bestCommonName: string;
  category: string;
  confidenceBand: "high" | "medium" | "low";
  imageQuality: "good" | "fair" | "poor";
  evidenceVisible: { leaf: boolean; bark: boolean; flower: boolean; fruit: boolean; whole_plant: boolean };
  alternatives: Array<{ common_name: string; scientific_name: string; score: number }>;
  defaultNextPhotoRequest: string;
}): Promise<ParsedExplanation | null> {
  const promptData = {
    best_match_scientific_name: input.bestScientificName,
    best_match_common_name: input.bestCommonName,
    category: input.category,
    confidence_band: input.confidenceBand,
    image_quality: input.imageQuality,
    user_country: input.countryCode || "unknown",
    user_language: input.languageCode || "unknown",
    evidence_visible: input.evidenceVisible,
    alternatives: input.alternatives,
    default_next_best_photo_request: input.defaultNextPhotoRequest,
  };

  const prompt = `You are a plant knowledge assistant for a mobile plant identification app.
The plant species has already been identified by a recognition system. Your job is to provide accurate knowledge about it.

Return ONLY valid JSON with no markdown, no backticks, no extra text.

Input data:
${JSON.stringify(promptData, null, 2)}

Based on the scientific name "${input.bestScientificName}" and common name "${input.bestCommonName}", provide accurate plant information.

Return exactly this JSON shape:
{
  "international_common_name": "string — the most widely known English common name",
  "localized_names": [
    {
      "country_code": "PH",
      "language_code": "tl",
      "name": "Filipino or Tagalog name for this plant if one exists"
    }
  ],
  "benefits_summary": "2-3 sentences about nutritional, medicinal, ecological, or practical uses of this specific plant species",
  "safety_summary": "2-3 sentences about toxicity, edibility, safe handling, or any known risks for this specific plant species. If non-toxic, say so clearly.",
  "care_summary": "2-3 sentences about watering, sunlight, soil type, and growing tips specific to this plant species",
  "next_best_photo_request": "A specific photo tip to improve identification confidence based on what evidence is missing",
  "reasoning_summary": "1-2 sentences explaining why this species was matched based on the visible evidence"
}

Rules:
- ALWAYS write real content for benefits_summary, safety_summary, and care_summary based on your knowledge of the scientific name. Never return null, empty string, or a dash for these three fields.
- If user_country is PH, only include a localized name if it is a genuine, widely-used Filipino or Tagalog name. Do NOT transliterate English words into Filipino spelling. If no real local name exists, return an empty array for localized_names.
- Keep each summary to 2-3 sentences, practical and accurate.
- Do not change or question the species identity — just explain it.
- Return ONLY the JSON object, nothing else.`;

  const raw = await callAI(prompt);
  console.log("=== AI RAW RESPONSE ===", raw);
  if (!raw) { console.error("=== ALL AI PROVIDERS RETURNED NULL ==="); return null; }

  try {
    const parsed = extractJson(raw) as ParsedExplanation;
    console.log("=== GEMINI PARSED ===", JSON.stringify(parsed, null, 2));
    return parsed;
  } catch (err) {
    console.error("Failed to parse Gemini response:", err, "\nRaw:", raw);
    return null;
  }
}

// ── Main handler ─────────────────────────────────────────────────────────────

export async function POST(request: NextRequest, { params }: Params) {
  let scanId = "";

  try {
    const user = await requireAuth(request);
    const { id } = await params;
    scanId = id;

    const scanResult = await pool.query(
      `
      SELECT s.*, m.public_url AS image_url, m.id AS media_asset_id, m.metadata AS media_metadata, m.mime_type
      FROM scans s
      LEFT JOIN media_assets m ON m.id = s.image_asset_id
      WHERE s.id = $1 AND s.user_id = $2
      LIMIT 1
      `,
      [id, user.id]
    );

    if (scanResult.rows.length === 0) return fail("Scan not found.", 404);
    const scan = scanResult.rows[0];

    const scanImagesResult = await pool.query(
      `
      SELECT si.id, si.image_role, si.sort_order, ma.id AS media_asset_id,
             ma.metadata AS media_metadata, ma.mime_type, ma.public_url
      FROM scan_images si
      JOIN media_assets ma ON ma.id = si.media_asset_id
      WHERE si.scan_id = $1
      ORDER BY si.sort_order ASC, si.created_at ASC
      `,
      [id]
    );

    const attachedImages = scanImagesResult.rows as ScanImageRow[];

    await pool.query(`UPDATE scans SET status = 'processing', updated_at = NOW() WHERE id = $1`, [id]);

    // ── Build image buffers for PlantNet ─────────────────────────────────────
    const plantnetFiles: Array<{
      filename: string;
      mimeType: string;
      buffer: Buffer;
      organ: "auto" | "leaf" | "flower" | "fruit" | "bark";
    }> = [];

    if (attachedImages.length > 0) {
      const bufferResults = await Promise.all(
              attachedImages.map(async (item) => {
                const buffer = await fetchImageBuffer(item);
                if (!buffer) return null;
                return {
                  filename: item.media_metadata?.local_filename || `${item.media_asset_id}.jpg`,
                  mimeType: item.mime_type || "image/jpeg",
                  buffer,
                  organ: mapImageRoleToPlantNetOrgan(item.image_role || "general"),
                };
              })
            );
            plantnetFiles.push(...bufferResults.filter(Boolean) as typeof plantnetFiles);
    } else {
      // Fallback to scan's primary image
      const fallbackRow: ScanImageRow = {
        id: scan.media_asset_id || "",
        image_role: "general",
        sort_order: 1,
        media_asset_id: scan.media_asset_id || "",
        media_metadata: scan.media_metadata,
        mime_type: scan.mime_type,
        public_url: scan.image_url,
      };
      const buffer = await fetchImageBuffer(fallbackRow);
      if (!buffer) return fail("No usable image found for this scan.", 400);
      plantnetFiles.push({
        filename: scan.media_metadata?.local_filename || `${scan.media_asset_id}.jpg`,
        mimeType: scan.mime_type || "image/jpeg",
        buffer,
        organ: "auto",
      });
    }

    if (plantnetFiles.length === 0) return fail("No usable images were found for this scan.", 400);

    // ── PlantNet identification ───────────────────────────────────────────────
    let plantnet: PlantNetResponse;
    try {
      plantnet = await identifyWithPlantNet({
        files: plantnetFiles.slice(0, 5),
        lang: scan.metadata?.language_code || "en",
        includeRelatedImages: true,
        nbResults: 5,
      });
    } catch (plantnetError) {
      const message = plantnetError instanceof Error ? plantnetError.message : "";
      const isNoPlant = message.includes("404") || message.includes("no result");

      await pool.query(
        `UPDATE scans SET status = 'completed', completed_at = NOW(),
         ai_provider = 'plantnet', ai_model = 'plantnet_identify',
         prompt_version = 'v3_plantnet', response_payload = $2, updated_at = NOW()
         WHERE id = $1`,
        [id, JSON.stringify({ provider: "plantnet", error: message })]
      );

      return ok({
        scan_id: id,
        identification: null,
        not_a_plant: isNoPlant,
        raw_result: {
          confidence_band: "low", image_quality: "poor",
          needs_more_images: !isNoPlant, safety_to_display_full_result: false,
          reasoning_summary: isNoPlant
            ? "No plant was detected in this image. Please take a clear photo of a plant."
            : "The plant recognizer encountered an error. Please try again with a clearer photo.",
          next_best_photo_request: isNoPlant
            ? "Please point your camera at a plant — a leaf, flower, or whole plant works best."
            : "Please try again with a clearer, well-lit photo of the plant.",
          evidence_visible: { leaf: false, bark: false, flower: false, fruit: false, whole_plant: false },
          alternatives: [],
        },
      });
    }

    const results = Array.isArray(plantnet.results) ? plantnet.results : [];

    // Not a plant check
    const topResultScore = Number(results[0]?.score || 0);
    if (results.length > 0 && topResultScore < 0.02) {
      await pool.query(
        `UPDATE scans SET status = 'completed', completed_at = NOW(),
         ai_provider = 'plantnet', ai_model = 'plantnet_identify',
         prompt_version = 'v3_plantnet', response_payload = $2, updated_at = NOW()
         WHERE id = $1`,
        [id, JSON.stringify({ provider: "plantnet", raw: plantnet, not_a_plant: true })]
      );
      return ok({
        scan_id: id, identification: null, not_a_plant: true,
        raw_result: {
          confidence_band: "low", image_quality: "poor",
          needs_more_images: false, safety_to_display_full_result: false,
          reasoning_summary: "This image does not appear to contain a plant. Please take a photo of a plant.",
          next_best_photo_request: "Point your camera at a plant — a leaf, flower, or the whole plant works best.",
          evidence_visible: { leaf: false, bark: false, flower: false, fruit: false, whole_plant: false },
          alternatives: [],
        },
      });
    }

    if (results.length === 0) {
      await pool.query(
        `UPDATE scans SET status = 'completed', completed_at = NOW(),
         ai_provider = 'plantnet', ai_model = 'plantnet_identify',
         prompt_version = 'v3_plantnet', response_payload = $2, updated_at = NOW()
         WHERE id = $1`,
        [id, JSON.stringify({
          provider: "plantnet", raw: plantnet,
          confidence_band: "low", image_quality: "poor", needs_more_images: true,
          safety_to_display_full_result: false,
          reasoning_summary: "The plant recognizer could not find a reliable match from the current images.",
          next_best_photo_request: "Please add a clearer photo showing the leaf, flower, fruit, or bark.",
          evidence_visible: { leaf: false, bark: false, flower: false, fruit: false, whole_plant: true },
          alternatives: [],
        })]
      );
      await checkAndGrantExpertStatus(user.id);
      return ok({
        scan_id: id, identification: null,
        raw_result: {
          confidence_band: "low", image_quality: "poor",
          needs_more_images: true, safety_to_display_full_result: false,
          reasoning_summary: "The plant recognizer could not find a reliable match from the current images.",
          next_best_photo_request: "Please add a clearer photo showing the leaf, flower, fruit, or bark.",
          evidence_visible: { leaf: false, bark: false, flower: false, fruit: false, whole_plant: true },
          alternatives: [],
        },
      });
    }

    const top        = results[0];
    const second     = results[1];
    const topScore   = Number(top?.score   || 0);
    const secondScore = Number(second?.score || 0);

    const bestScientificName = top?.species?.scientificNameWithoutAuthor || top?.species?.scientificName || "Unknown species";
    const bestCommonName     = top?.species?.commonNames?.[0] || bestScientificName;
    const familyName         = top?.species?.family?.scientificName || null;
    const genusName          = top?.species?.genus?.scientificName  || null;
    const categoryGuess      = normalizeCategory(top?.species?.family?.scientificName || top?.species?.genus?.scientificName || "unknown");

    const confidenceBand  = confidenceBandFromScores(topScore, secondScore);
    const imageQuality    = imageQualityFromImages(attachedImages, plantnet.predictedOrgans);
    const evidenceVisible = buildEvidenceVisible(attachedImages, plantnet.predictedOrgans);

    let needsMoreImages = confidenceBand === "low";
    if (imageQuality === "poor") needsMoreImages = true;
    if (!evidenceVisible.leaf && !evidenceVisible.flower && !evidenceVisible.fruit) needsMoreImages = true;

    const defaultNextPhotoRequest  = buildNextPhotoRequest(categoryGuess, evidenceVisible);
    const safetyToDisplayFullResult = !needsMoreImages && confidenceBand !== "low";

    const alternatives = results.slice(1, 4).map((item) => ({
      common_name:     item?.species?.commonNames?.[0] || item?.species?.scientificNameWithoutAuthor || item?.species?.scientificName || "Alternative match",
      scientific_name: item?.species?.scientificNameWithoutAuthor || item?.species?.scientificName || "Unknown species",
      score:           Number(item?.score || 0),
      confidence_band: confidenceBandFromScores(Number(item?.score || 0), 0),
      category: "unknown", edible_status: "unknown", medicinal_status: "unknown", toxicity_status: "unknown",
      reasoning: "Alternative match suggested by the plant-recognition engine.",
      related_images: item?.images || [],
    }));

    const explanation = await explainWithGemini({
      countryCode: scan.country_code || null,
      languageCode: scan.metadata?.language_code || null,
      bestScientificName, bestCommonName, category: categoryGuess,
      confidenceBand, imageQuality, evidenceVisible,
      alternatives: alternatives.map((a) => ({ common_name: a.common_name, scientific_name: a.scientific_name, score: a.score })),
      defaultNextPhotoRequest,
    });

    console.log("=== EXPLANATION RESULT ===", JSON.stringify(explanation, null, 2));

    const plantSpeciesId = await findOrCreatePlantSpecies({
      scientificName: bestScientificName, commonName: bestCommonName,
      familyName, genusName, category: categoryGuess,
      descriptionShort: explanation?.reasoning_summary || "Identified through plant-recognition service.",
      metadata: { source: "plantnet", top_score: topScore, family_name: familyName, genus_name: genusName },
    });

    await upsertLocalizedNames(plantSpeciesId, explanation?.localized_names);
    await pool.query(`DELETE FROM scan_identifications WHERE scan_id = $1`, [id]);

    const structuredPrimary = {
      provider: "plantnet",
      best_match_common_name: bestCommonName,
      best_match_scientific_name: bestScientificName,
      international_common_name: explanation?.international_common_name || bestCommonName,
      confidence_band: confidenceBand, image_quality: imageQuality,
      reasoning_summary: explanation?.reasoning_summary || "This result was chosen from the top-ranked plant-recognition matches.",
      benefits_summary: explanation?.benefits_summary || null,
      safety_summary:   explanation?.safety_summary   || null,
      care_summary:     explanation?.care_summary     || null,
      category: normalizeCategory(categoryGuess),
      edible_status:    normalizeEdibleStatus("unknown"),
      medicinal_status: normalizeMedicinalStatus("unknown"),
      toxicity_status:  normalizeToxicityStatus("unknown"),
      needs_more_images: needsMoreImages,
      next_best_photo_request: explanation?.next_best_photo_request || defaultNextPhotoRequest,
      safety_to_display_full_result: safetyToDisplayFullResult,
      evidence_visible: evidenceVisible, alternatives,
      localized_names: explanation?.localized_names || [],
      plantnet_top_result: top,
      predicted_organs: plantnet.predictedOrgans || [],
      related_images: top?.images || [],
      raw_results_count: results.length,
    };

    const primaryInsert = await pool.query(
      `
      INSERT INTO scan_identifications (
        scan_id, plant_species_id, rank_order,
        predicted_common_name, predicted_scientific_name, confidence_score,
        is_primary, reasoning_summary, benefits_summary, safety_summary, care_summary, structured_result
      )
      VALUES ($1, $2, 1, $3, $4, $5, TRUE, $6, $7, $8, $9, $10)
      RETURNING *
      `,
      [
        id, plantSpeciesId, bestCommonName, bestScientificName, topScore,
        structuredPrimary.reasoning_summary, structuredPrimary.benefits_summary,
        structuredPrimary.safety_summary, structuredPrimary.care_summary,
        JSON.stringify(structuredPrimary),
      ]
    );

    await Promise.all(alternatives.map((alt, i) =>
      pool.query(
        `INSERT INTO scan_identifications (
          scan_id, plant_species_id, rank_order,
          predicted_common_name, predicted_scientific_name, confidence_score,
          is_primary, reasoning_summary, benefits_summary, safety_summary, care_summary, structured_result
        ) VALUES ($1, NULL, $2, $3, $4, $5, FALSE, $6, NULL, NULL, NULL, $7)`,
        [id, i + 2, alt.common_name, alt.scientific_name, alt.score, alt.reasoning, JSON.stringify(alt)]
      )
    ));

    await pool.query(
      `UPDATE scans SET status = 'completed', completed_at = NOW(),
       ai_provider = 'plantnet', ai_model = 'openrouter-mistral-7b',
       prompt_version = 'v4_openrouter', response_payload = $2, updated_at = NOW()
       WHERE id = $1`,
      [id, JSON.stringify({ provider: "plantnet+gemini", raw: plantnet, explanation: explanation || null, primary: structuredPrimary })]
    );

    await pool.query(
      `
      INSERT INTO usage_daily (user_id, usage_date, scan_count, identify_count)
      VALUES ($1, CURRENT_DATE, 1, 1)
      ON CONFLICT (user_id, usage_date)
      DO UPDATE SET scan_count = usage_daily.scan_count + 1, identify_count = usage_daily.identify_count + 1, updated_at = NOW()
      `,
      [user.id]
    );

    await checkAndGrantExpertStatus(user.id);

    return ok({ scan_id: id, identification: primaryInsert.rows[0], raw_result: structuredPrimary });
  } catch (error) {
    if (scanId) {
      try {
        await pool.query(
          `UPDATE scans SET status = 'failed', failure_reason = $2, updated_at = NOW() WHERE id = $1`,
          [scanId, error instanceof Error ? error.message : "Identification failed"]
        );
      } catch {}
    }
    return fail(error instanceof Error ? error.message : "Identification failed.", 400);
  }
}