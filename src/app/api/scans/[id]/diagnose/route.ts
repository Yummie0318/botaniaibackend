import fs from "fs/promises";
import path from "path";
import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { IMAGE_STORAGE_DIR } from "@/lib/fs";
import { fail, ok } from "@/lib/response";
import { callAI } from "@/lib/gemini";
import { checkAndGrantExpertStatus } from "@/lib/expertEligibility";

type Params = { params: Promise<{ id: string }> };

function extractJson(text: string) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("AI response did not return valid JSON.");
  return JSON.parse(match[0]);
}

export async function POST(request: NextRequest, { params }: Params) {
  let scanId = "";

  try {
    const user = await requireAuth(request);
    const { id } = await params;
    scanId = id;

    // Get scan
    const scanResult = await pool.query(
      `
      SELECT s.*, m.metadata AS media_metadata, m.mime_type, m.public_url AS image_url
      FROM scans s
      LEFT JOIN media_assets m ON m.id = s.image_asset_id
      WHERE s.id = $1 AND s.user_id = $2
      LIMIT 1
      `,
      [id, user.id]
    );

    if (scanResult.rows.length === 0) return fail("Scan not found.", 404);
    const scan = scanResult.rows[0];

    // Get scan images
    const imagesResult = await pool.query(
      `
      SELECT si.*, ma.metadata AS media_metadata, ma.mime_type, ma.public_url
      FROM scan_images si
      JOIN media_assets ma ON ma.id = si.media_asset_id
      WHERE si.scan_id = $1
      ORDER BY si.sort_order ASC
      `,
      [id]
    );

    // Build image description for AI
    const imageCount = imagesResult.rows.length || 1;

    await pool.query(
      `UPDATE scans SET status = 'processing', updated_at = NOW() WHERE id = $1`,
      [id]
    );

    // Get plant name from existing identification if available
    const identResult = await pool.query(
      `
      SELECT predicted_common_name, predicted_scientific_name
      FROM scan_identifications
      WHERE scan_id = $1 AND is_primary = true
      LIMIT 1
      `,
      [id]
    );

    const plantName = identResult.rows[0]?.predicted_common_name || "Unknown plant";
    const scientificName = identResult.rows[0]?.predicted_scientific_name || "";

    // Build AI prompt
    const prompt = `You are a plant disease and health diagnosis assistant for a mobile app.
A user has submitted ${imageCount} photo(s) of a plant that may be sick or unhealthy.
${plantName !== "Unknown plant" ? `The plant has been identified as ${plantName} (${scientificName}).` : "The plant species is unknown."}

Based on common plant diseases, pests, and health issues, provide a diagnosis.
Since you cannot actually see the image, provide the most likely diagnosis for a sick ${plantName} plant.

Return ONLY valid JSON with no markdown, no backticks, no extra text.

Return exactly this JSON shape:
{
  "diagnosis_name": "string — name of the disease, pest, or condition",
  "diagnosis_type": "disease",
  "confidence": 0.6,
  "symptoms_detected": "string — 2-3 sentences describing typical symptoms of this condition",
  "treatment_summary": "string — 2-3 sentences on how to treat this condition",
  "prevention_summary": "string — 2-3 sentences on how to prevent this in the future",
  "severity": "mild",
  "is_urgent": false,
  "alternatives": [
    {
      "diagnosis_name": "string",
      "diagnosis_type": "disease",
      "confidence": 0.3,
      "symptoms_detected": "string"
    }
  ]
}

Rules:
- diagnosis_type must be one of: disease, watering, nutrition, pest, environmental, general_health
- confidence must be between 0 and 1
- severity must be one of: mild, moderate, severe
- alternatives should have 2 other possible diagnoses
- ALWAYS fill symptoms_detected, treatment_summary, prevention_summary with real content
- Return ONLY the JSON object, nothing else.`;

    const raw = await callAI(prompt);
    console.log("=== DISEASE AI RESPONSE ===", raw);

    if (!raw) {
      await pool.query(
        `UPDATE scans SET status = 'failed', failure_reason = 'AI provider unavailable', updated_at = NOW() WHERE id = $1`,
        [id]
      );
      return fail("AI diagnosis service is unavailable. Please try again.", 503);
    }

    let parsed: any;
    try {
      parsed = extractJson(raw);
    } catch {
      await pool.query(
        `UPDATE scans SET status = 'failed', failure_reason = 'AI parse error', updated_at = NOW() WHERE id = $1`,
        [id]
      );
      return fail("Failed to parse AI response.", 500);
    }

    // Validate diagnosis_type
    const validTypes = ["disease", "watering", "nutrition", "pest", "environmental", "general_health"];
    const diagnosisType = validTypes.includes(parsed.diagnosis_type) ? parsed.diagnosis_type : "disease";

    // Validate confidence
    const confidence = Math.min(1, Math.max(0, Number(parsed.confidence) || 0.5));

    // Save diagnosis
    await pool.query(`DELETE FROM scan_diagnoses WHERE scan_id = $1`, [id]);

    const diagnosisInsert = await pool.query(
      `
      INSERT INTO scan_diagnoses (
        scan_id,
        plant_species_id,
        diagnosis_type,
        rank_order,
        confidence_score,
        diagnosis_name,
        symptoms_detected,
        treatment_summary,
        prevention_summary,
        structured_result
      )
      VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9)
      RETURNING *
      `,
      [
        id,
        identResult.rows[0] ? null : null,
        diagnosisType,
        confidence,
        parsed.diagnosis_name || "Unknown condition",
        parsed.symptoms_detected || null,
        parsed.treatment_summary || null,
        parsed.prevention_summary || null,
        JSON.stringify({
          ...parsed,
          plant_name: plantName,
          scientific_name: scientificName,
          image_count: imageCount,
        }),
      ]
    );

    // Save alternatives
if (Array.isArray(parsed.alternatives)) {
      await Promise.all(parsed.alternatives.slice(0, 2).map((alt: any, i: number) => {
        const altType = validTypes.includes(alt.diagnosis_type) ? alt.diagnosis_type : "disease";
        const altConf = Math.min(1, Math.max(0, Number(alt.confidence) || 0.2));
        return pool.query(
          `INSERT INTO scan_diagnoses (
            scan_id, diagnosis_type, rank_order,
            confidence_score, diagnosis_name,
            symptoms_detected, structured_result
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, altType, i + 2, altConf, alt.diagnosis_name || "Alternative", alt.symptoms_detected || null, JSON.stringify(alt)]
        );
      }));
    }

    // Update scan status
    await pool.query(
      `
      UPDATE scans SET
        status = 'completed',
        completed_at = NOW(),
        ai_provider = 'openrouter',
        ai_model = 'openrouter-auto',
        prompt_version = 'v1_disease',
        scan_type = 'disease',
        response_payload = $2,
        updated_at = NOW()
      WHERE id = $1
      `,
      [id, JSON.stringify({ provider: "openrouter", diagnosis: parsed })]
    );

    // Update usage
    await pool.query(
      `
      INSERT INTO usage_daily (user_id, usage_date, scan_count, identify_count)
      VALUES ($1, CURRENT_DATE, 1, 0)
      ON CONFLICT (user_id, usage_date)
      DO UPDATE SET scan_count = usage_daily.scan_count + 1, updated_at = NOW()
      `,
      [user.id]
    );

   await checkAndGrantExpertStatus(user.id);
    return ok({
      scan_id: id,
      diagnosis: diagnosisInsert.rows[0],
      structured: parsed,
    });
  } catch (error) {
    if (scanId) {
      try {
        await pool.query(
          `UPDATE scans SET status = 'failed', failure_reason = $2, updated_at = NOW() WHERE id = $1`,
          [scanId, error instanceof Error ? error.message : "Diagnosis failed"]
        );
      } catch {}
    }
    return fail(error instanceof Error ? error.message : "Diagnosis failed.", 400);
  }
}