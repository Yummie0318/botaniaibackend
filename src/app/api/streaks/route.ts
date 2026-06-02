import { NextRequest } from "next/server";
import { requireAuth } from "@/lib/auth";
import { pool } from "@/lib/db";
import { fail, ok } from "@/lib/response";

export async function GET(request: NextRequest) {
  try {
    const user = await requireAuth(request);

    // Get all usage days ordered by date
    const usageResult = await pool.query(
      `
      SELECT usage_date, scan_count, identify_count
      FROM usage_daily
      WHERE user_id = $1
      ORDER BY usage_date DESC
      `,
      [user.id]
    );

    const rows = usageResult.rows;

    // Calculate current streak
    let currentStreak = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let i = 0; i < rows.length; i++) {
      const rowDate = new Date(rows[i].usage_date);
      rowDate.setHours(0, 0, 0, 0);

      const expectedDate = new Date(today);
      expectedDate.setDate(today.getDate() - i);

      if (rowDate.getTime() === expectedDate.getTime() && rows[i].scan_count > 0) {
        currentStreak++;
      } else {
        break;
      }
    }

    // Calculate longest streak
    let longestStreak = 0;
    let tempStreak = 0;

    for (let i = 0; i < rows.length; i++) {
      if (rows[i].scan_count > 0) {
        if (i === 0) {
          tempStreak = 1;
        } else {
          const prev = new Date(rows[i - 1].usage_date);
          const curr = new Date(rows[i].usage_date);
          const diffDays = Math.round(
            (prev.getTime() - curr.getTime()) / (1000 * 60 * 60 * 24)
          );
          if (diffDays === 1) {
            tempStreak++;
          } else {
            tempStreak = 1;
          }
        }
        longestStreak = Math.max(longestStreak, tempStreak);
      }
    }

    // Total stats
    const totalResult = await pool.query(
      `
      SELECT
        COALESCE(SUM(scan_count), 0)::int AS total_scans,
        COALESCE(SUM(identify_count), 0)::int AS total_identifies,
        COUNT(DISTINCT usage_date)::int AS active_days
      FROM usage_daily
      WHERE user_id = $1 AND scan_count > 0
      `,
      [user.id]
    );

    const stats = totalResult.rows[0];

    // Species count
    const speciesResult = await pool.query(
      `
      SELECT COUNT(DISTINCT si.plant_species_id)::int AS unique_species
      FROM scan_identifications si
      JOIN scans s ON s.id = si.scan_id
      WHERE s.user_id = $1 AND si.is_primary = true AND si.plant_species_id IS NOT NULL
      `,
      [user.id]
    );

    const uniqueSpecies = speciesResult.rows[0].unique_species || 0;

    // Calculate badges
    const badges = [];

    if (stats.total_scans >= 1) badges.push({ id: "first_scan", label: "First Scan", icon: "🌱", description: "Completed your first plant scan" });
    if (stats.total_scans >= 10) badges.push({ id: "ten_scans", label: "Plant Explorer", icon: "🔍", description: "Scanned 10 plants" });
    if (stats.total_scans >= 50) badges.push({ id: "fifty_scans", label: "Plant Hunter", icon: "🌿", description: "Scanned 50 plants" });
    if (uniqueSpecies >= 5) badges.push({ id: "five_species", label: "Collector", icon: "📚", description: "Identified 5 different species" });
    if (uniqueSpecies >= 20) badges.push({ id: "twenty_species", label: "Botanist", icon: "🔬", description: "Identified 20 different species" });
    if (currentStreak >= 3) badges.push({ id: "streak_3", label: "On a Roll", icon: "🔥", description: "3-day scan streak" });
    if (currentStreak >= 7) badges.push({ id: "streak_7", label: "Week Warrior", icon: "⚡", description: "7-day scan streak" });
    if (longestStreak >= 30) badges.push({ id: "streak_30", label: "Dedicated", icon: "🏆", description: "30-day scan streak" });
    if (stats.active_days >= 7) badges.push({ id: "active_7", label: "Regular", icon: "📅", description: "Active on 7 different days" });

    return ok({
      current_streak: currentStreak,
      longest_streak: longestStreak,
      total_scans: stats.total_scans,
      total_identifies: stats.total_identifies,
      active_days: stats.active_days,
      unique_species: uniqueSpecies,
      badges,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Failed to fetch streaks.", 400);
  }
}