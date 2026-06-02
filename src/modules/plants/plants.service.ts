import { pool } from "@/lib/db";

export async function searchPlants(input: {
  q: string;
  limit?: number;
}) {
  const q = input.q.trim();
  const limit = Math.min(input.limit ?? 20, 50);

  if (!q) {
    return [];
  }

  const result = await pool.query(
    `
    SELECT
      id,
      common_name,
      scientific_name,
      local_name,
      category,
      edible_status,
      medicinal_status,
      toxicity_status,
      description_short
    FROM plant_species
    WHERE deleted_at IS NULL
      AND (
        common_name ILIKE $1
        OR scientific_name ILIKE $1
        OR local_name ILIKE $1
        OR search_text ILIKE $1
      )
    ORDER BY common_name ASC
    LIMIT $2
    `,
    [`%${q}%`, limit]
  );

  return result.rows;
}

export async function getPlantById(id: string) {
  const plantResult = await pool.query(
    `
    SELECT *
    FROM plant_species
    WHERE id = $1
      AND deleted_at IS NULL
    LIMIT 1
    `,
    [id]
  );

  if (plantResult.rows.length === 0) {
    return null;
  }

  const plant = plantResult.rows[0];

  const commonNames = await pool.query(
    `
    SELECT
      id,
      language_code,
      country_code,
      name,
      is_primary
    FROM plant_common_names
    WHERE plant_species_id = $1
    ORDER BY is_primary DESC, name ASC
    `,
    [id]
  );

  const benefits = await pool.query(
    `
    SELECT
      id,
      benefit_type,
      title,
      description,
      evidence_level,
      caution_notes
    FROM plant_benefits
    WHERE plant_species_id = $1
    ORDER BY created_at ASC
    `,
    [id]
  );

  const careGuide = await pool.query(
    `
    SELECT *
    FROM plant_care_guides
    WHERE plant_species_id = $1
    LIMIT 1
    `,
    [id]
  );

  const media = await pool.query(
    `
    SELECT
      id,
      media_type,
      url,
      alt_text,
      is_primary,
      sort_order
    FROM plant_media
    WHERE plant_species_id = $1
    ORDER BY is_primary DESC, sort_order ASC
    `,
    [id]
  );

  return {
    plant,
    common_names: commonNames.rows,
    benefits: benefits.rows,
    care_guide: careGuide.rows[0] ?? null,
    media: media.rows,
  };
}