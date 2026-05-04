import { and, eq, sql } from "drizzle-orm";
import {
  schoolsSchema,
  schoolThemeConfigsSchema,
} from "../../../db/schemas/school";

// ==================== PREDEFINED THEMES ====================
// 10 Production-Grade Predefined Themes (full design tokens)
const PREDEFINED_THEMES = [
  {
    themeName: "Classic Blue",
    config: JSON.stringify({
      "--color-primary": "#3b82f6",
      "--color-primary-light": "#60a5fa",
      "--color-primary-dark": "#1e40af",
      "--color-on-primary": "#ffffff",
      "--color-secondary": "#8b5cf6",
      "--color-on-secondary": "#ffffff",
      "--color-success": "#10b981",
      "--color-warning": "#f59e0b",
      "--color-error": "#ef4444",
      "--color-info": "#3b82f6",
      "--color-bg-main": "#f8fafc",
      "--color-bg-surface": "#ffffff",
      "--color-bg-card": "#ffffff",
      "--color-border": "#e2e8f0",
      "--color-divider": "#f1f5f9",
      "--color-text-primary": "#0f172a",
      "--color-text-secondary": "#64748b",
      "--color-text-muted": "#94a3b8",
      "--color-hover": "#f1f5f9",
      "--color-active": "#e0f2fe",
      "--shadow-sm": "0 1px 3px rgba(0, 0, 0, 0.1)",
      "--shadow-md": "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
      "--radius-sm": "8px",
      "--radius-md": "12px",
      "--radius-lg": "16px",
    }),
  },
  {
    themeName: "Forest Green",
    config: JSON.stringify({
      "--color-primary": "#10b981",
      "--color-primary-light": "#34d399",
      "--color-primary-dark": "#059669",
      "--color-on-primary": "#ffffff",
      "--color-secondary": "#f59e0b",
      "--color-on-secondary": "#000000",
      "--color-success": "#10b981",
      "--color-warning": "#f59e0b",
      "--color-error": "#ef4444",
      "--color-info": "#0ea5e9",
      "--color-bg-main": "#f8fafc",
      "--color-bg-surface": "#ffffff",
      "--color-bg-card": "#ffffff",
      "--color-border": "#e2e8f0",
      "--color-divider": "#f1f5f9",
      "--color-text-primary": "#052e16",
      "--color-text-secondary": "#166534",
      "--color-text-muted": "#4b7c5e",
      "--color-hover": "#f0fdf4",
      "--color-active": "#dcfce7",
      "--shadow-sm": "0 1px 3px rgba(0, 0, 0, 0.1)",
      "--shadow-md": "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
      "--radius-sm": "8px",
      "--radius-md": "12px",
      "--radius-lg": "16px",
    }),
  },
  {
    themeName: "Royal Purple",
    config: JSON.stringify({
      "--color-primary": "#8b5cf6",
      "--color-primary-light": "#a78bfa",
      "--color-primary-dark": "#6d28d9",
      "--color-on-primary": "#ffffff",
      "--color-secondary": "#ec4899",
      "--color-on-secondary": "#ffffff",
      "--color-success": "#10b981",
      "--color-warning": "#f59e0b",
      "--color-error": "#ef4444",
      "--color-info": "#8b5cf6",
      "--color-bg-main": "#f8fafc",
      "--color-bg-surface": "#ffffff",
      "--color-bg-card": "#ffffff",
      "--color-border": "#e2e8f0",
      "--color-divider": "#f1f5f9",
      "--color-text-primary": "#1e1133",
      "--color-text-secondary": "#6b4e9e",
      "--color-text-muted": "#9f8ac4",
      "--color-hover": "#f3e8ff",
      "--color-active": "#ede9fe",
      "--shadow-sm": "0 1px 3px rgba(0, 0, 0, 0.1)",
      "--shadow-md": "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
      "--radius-sm": "8px",
      "--radius-md": "12px",
      "--radius-lg": "16px",
    }),
  },
  {
    themeName: "Sunrise Orange",
    config: JSON.stringify({
      "--color-primary": "#f59e0b",
      "--color-primary-light": "#fbbf24",
      "--color-primary-dark": "#b45309",
      "--color-on-primary": "#ffffff",
      "--color-secondary": "#ec4899",
      "--color-on-secondary": "#ffffff",
      "--color-success": "#10b981",
      "--color-warning": "#f59e0b",
      "--color-error": "#ef4444",
      "--color-info": "#0ea5e9",
      "--color-bg-main": "#fffbeb",
      "--color-bg-surface": "#ffffff",
      "--color-bg-card": "#ffffff",
      "--color-border": "#fed7aa",
      "--color-divider": "#fef3c7",
      "--color-text-primary": "#431407",
      "--color-text-secondary": "#9c6644",
      "--color-text-muted": "#d97706",
      "--color-hover": "#fff7ed",
      "--color-active": "#fefce8",
      "--shadow-sm": "0 1px 3px rgba(0, 0, 0, 0.1)",
      "--shadow-md": "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
      "--radius-sm": "8px",
      "--radius-md": "12px",
      "--radius-lg": "16px",
    }),
  },
  {
    themeName: "Ocean Teal",
    config: JSON.stringify({
      "--color-primary": "#14b8a6",
      "--color-primary-light": "#5eead4",
      "--color-primary-dark": "#0f766e",
      "--color-on-primary": "#ffffff",
      "--color-secondary": "#0ea5e9",
      "--color-on-secondary": "#ffffff",
      "--color-success": "#10b981",
      "--color-warning": "#f59e0b",
      "--color-error": "#ef4444",
      "--color-info": "#0ea5e9",
      "--color-bg-main": "#f0fdfa",
      "--color-bg-surface": "#ffffff",
      "--color-bg-card": "#ffffff",
      "--color-border": "#ccfbf1",
      "--color-divider": "#f0fdfa",
      "--color-text-primary": "#134e4a",
      "--color-text-secondary": "#0f766e",
      "--color-text-muted": "#5eead4",
      "--color-hover": "#f0fdfa",
      "--color-active": "#ccfbf1",
      "--shadow-sm": "0 1px 3px rgba(0, 0, 0, 0.1)",
      "--shadow-md": "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
      "--radius-sm": "8px",
      "--radius-md": "12px",
      "--radius-lg": "16px",
    }),
  },
  {
    themeName: "Warm Terracotta",
    config: JSON.stringify({
      "--color-primary": "#f97316",
      "--color-primary-light": "#fb923c",
      "--color-primary-dark": "#c2410f",
      "--color-on-primary": "#ffffff",
      "--color-secondary": "#db2777",
      "--color-on-secondary": "#ffffff",
      "--color-success": "#10b981",
      "--color-warning": "#f59e0b",
      "--color-error": "#ef4444",
      "--color-info": "#0ea5e9",
      "--color-bg-main": "#fff7ed",
      "--color-bg-surface": "#ffffff",
      "--color-bg-card": "#ffffff",
      "--color-border": "#fed7aa",
      "--color-divider": "#ffedd5",
      "--color-text-primary": "#431407",
      "--color-text-secondary": "#9c6644",
      "--color-text-muted": "#f59e0b",
      "--color-hover": "#fff7ed",
      "--color-active": "#ffedd5",
      "--shadow-sm": "0 1px 3px rgba(0, 0, 0, 0.1)",
      "--shadow-md": "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
      "--radius-sm": "8px",
      "--radius-md": "12px",
      "--radius-lg": "16px",
    }),
  },
  {
    themeName: "Deep Indigo",
    config: JSON.stringify({
      "--color-primary": "#6366f1",
      "--color-primary-light": "#818cf8",
      "--color-primary-dark": "#4338ca",
      "--color-on-primary": "#ffffff",
      "--color-secondary": "#ec4899",
      "--color-on-secondary": "#ffffff",
      "--color-success": "#10b981",
      "--color-warning": "#f59e0b",
      "--color-error": "#ef4444",
      "--color-info": "#6366f1",
      "--color-bg-main": "#f8fafc",
      "--color-bg-surface": "#ffffff",
      "--color-bg-card": "#ffffff",
      "--color-border": "#e0e7ff",
      "--color-divider": "#f0f0ff",
      "--color-text-primary": "#1e1133",
      "--color-text-secondary": "#4338ca",
      "--color-text-muted": "#818cf8",
      "--color-hover": "#f0f0ff",
      "--color-active": "#e0e7ff",
      "--shadow-sm": "0 1px 3px rgba(0, 0, 0, 0.1)",
      "--shadow-md": "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
      "--radius-sm": "8px",
      "--radius-md": "12px",
      "--radius-lg": "16px",
    }),
  },
  {
    themeName: "Fresh Mint",
    config: JSON.stringify({
      "--color-primary": "#22d3ee",
      "--color-primary-light": "#67e8f9",
      "--color-primary-dark": "#0891b2",
      "--color-on-primary": "#0f172a",
      "--color-secondary": "#a78bfa",
      "--color-on-secondary": "#ffffff",
      "--color-success": "#10b981",
      "--color-warning": "#f59e0b",
      "--color-error": "#ef4444",
      "--color-info": "#22d3ee",
      "--color-bg-main": "#f0fdfa",
      "--color-bg-surface": "#ffffff",
      "--color-bg-card": "#ffffff",
      "--color-border": "#a5f4f4",
      "--color-divider": "#ccfbf1",
      "--color-text-primary": "#134e4a",
      "--color-text-secondary": "#0f766e",
      "--color-text-muted": "#67e8f9",
      "--color-hover": "#f0fdfa",
      "--color-active": "#ccfbf1",
      "--shadow-sm": "0 1px 3px rgba(0, 0, 0, 0.1)",
      "--shadow-md": "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
      "--radius-sm": "8px",
      "--radius-md": "12px",
      "--radius-lg": "16px",
    }),
  },
  {
    themeName: "Elegant Slate",
    config: JSON.stringify({
      "--color-primary": "#64748b",
      "--color-primary-light": "#94a3b8",
      "--color-primary-dark": "#334155",
      "--color-on-primary": "#ffffff",
      "--color-secondary": "#ec4899",
      "--color-on-secondary": "#ffffff",
      "--color-success": "#10b981",
      "--color-warning": "#f59e0b",
      "--color-error": "#ef4444",
      "--color-info": "#64748b",
      "--color-bg-main": "#f8fafc",
      "--color-bg-surface": "#ffffff",
      "--color-bg-card": "#ffffff",
      "--color-border": "#e2e8f0",
      "--color-divider": "#f1f5f9",
      "--color-text-primary": "#0f172a",
      "--color-text-secondary": "#475569",
      "--color-text-muted": "#64748b",
      "--color-hover": "#f1f5f9",
      "--color-active": "#e2e8f0",
      "--shadow-sm": "0 1px 3px rgba(0, 0, 0, 0.1)",
      "--shadow-md": "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
      "--radius-sm": "8px",
      "--radius-md": "12px",
      "--radius-lg": "16px",
    }),
  },
  {
    themeName: "Vibrant Coral",
    config: JSON.stringify({
      "--color-primary": "#f43f5e",
      "--color-primary-light": "#fb7185",
      "--color-primary-dark": "#9f1239",
      "--color-on-primary": "#ffffff",
      "--color-secondary": "#8b5cf6",
      "--color-on-secondary": "#ffffff",
      "--color-success": "#10b981",
      "--color-warning": "#f59e0b",
      "--color-error": "#ef4444",
      "--color-info": "#3b82f6",
      "--color-bg-main": "#fff1f2",
      "--color-bg-surface": "#ffffff",
      "--color-bg-card": "#ffffff",
      "--color-border": "#fecdd3",
      "--color-divider": "#fce7f3",
      "--color-text-primary": "#881337",
      "--color-text-secondary": "#9f1239",
      "--color-text-muted": "#fb7185",
      "--color-hover": "#fff1f2",
      "--color-active": "#fce7f3",
      "--shadow-sm": "0 1px 3px rgba(0, 0, 0, 0.1)",
      "--shadow-md": "0 4px 6px -1px rgba(0, 0, 0, 0.1)",
      "--radius-sm": "8px",
      "--radius-md": "12px",
      "--radius-lg": "16px",
    }),
  },
];

// ==================== SERVICE ====================

export const schoolSettingsService = {
  /**
   * Returns the currently active theme.
   * No join to `schools` needed — already in the right DB.
   */
  async getActiveTheme(db: any, _schoolCode: string) {
    const result = await db
      .select({
        id: schoolThemeConfigsSchema.id,
        themeName: schoolThemeConfigsSchema.themeName,
        config: schoolThemeConfigsSchema.config,
        isCustomTheme: schoolThemeConfigsSchema.isCustomTheme,
      })
      .from(schoolThemeConfigsSchema)
      .where(eq(schoolThemeConfigsSchema.isActive, true))
      .get();

    return result
      ? { ...result, config: JSON.parse(result.config || "{}") }
      : null;
  },

  /**
   * Lists all themes for the school (predefined first, then custom).
   */
  async getAllThemes(db: any, _schoolCode: string) {
    return db
      .select({
        id: schoolThemeConfigsSchema.id,
        themeName: schoolThemeConfigsSchema.themeName,
        isCustomTheme: schoolThemeConfigsSchema.isCustomTheme,
        isActive: schoolThemeConfigsSchema.isActive,
        createdAt: schoolThemeConfigsSchema.createdAt,
      })
      .from(schoolThemeConfigsSchema)
      .orderBy(schoolThemeConfigsSchema.isCustomTheme) // false (0) sorts before true (1)
      .all();
  },

  /**
   * Activates a theme. Deactivates all others first.
   * No schoolId filter needed — single school per DB.
   */
  async activateTheme(
    db: any,
    _schoolCode: string,
    themeId: number
  ): Promise<boolean> {
    // 1. Verify the theme exists before touching anything
    const target = await db
      .select({ id: schoolThemeConfigsSchema.id })
      .from(schoolThemeConfigsSchema)
      .where(eq(schoolThemeConfigsSchema.id, themeId))
      .get();

    if (!target) return false;

    // 2. Deactivate all themes (safe without schoolId filter — single school DB)
    await db.update(schoolThemeConfigsSchema).set({ isActive: false });

    // 3. Activate the chosen theme
    await db
      .update(schoolThemeConfigsSchema)
      .set({ isActive: true })
      .where(eq(schoolThemeConfigsSchema.id, themeId));

    return true;
  },

  /**
   * Creates a new custom theme (inactive by default).
   * Must be explicitly activated via activateTheme().
   */
  async createCustomTheme(
    db: any,
    _schoolCode: string,
    themeName: string,
    config: Record<string, string>
  ) {
    // Guard: no duplicate theme names
    const existing = await db
      .select({ id: schoolThemeConfigsSchema.id })
      .from(schoolThemeConfigsSchema)
      .where(eq(schoolThemeConfigsSchema.themeName, themeName))
      .get();

    if (existing) {
      throw new Error(`A theme named "${themeName}" already exists`);
    }

    const [newTheme] = await db
      .insert(schoolThemeConfigsSchema)
      .values({
        schoolId: 1, // Always 1 — single school per DB
        themeName,
        config: JSON.stringify(config),
        isCustomTheme: true,
        isActive: false,
      })
      .returning();

    return newTheme;
  },

  /**
   * Deletes a custom theme.
   * Guards:
   *   - Cannot delete predefined/system themes (isCustomTheme = false)
   *   - Cannot delete the currently active theme
   */
  async deleteCustomTheme(db: any, _schoolCode: string, themeId: number) {
    const theme = await db
      .select({
        id: schoolThemeConfigsSchema.id,
        isCustomTheme: schoolThemeConfigsSchema.isCustomTheme,
        isActive: schoolThemeConfigsSchema.isActive,
      })
      .from(schoolThemeConfigsSchema)
      .where(eq(schoolThemeConfigsSchema.id, themeId))
      .get();

    if (!theme) {
      throw new Error("Theme not found");
    }

    if (!theme.isCustomTheme) {
      throw new Error("Cannot delete predefined system themes");
    }

    if (theme.isActive) {
      throw new Error(
        "Cannot delete the currently active theme. Activate another theme first."
      );
    }

    await db
      .delete(schoolThemeConfigsSchema)
      .where(eq(schoolThemeConfigsSchema.id, themeId));
  },

  /**
   * Seeds all 10 predefined themes on first school signup.
   * Activates "Classic Blue" by default (index 0).
   * Fully idempotent — skips if themes already exist.
   */
  async seedPredefinedThemes(db: any, _schoolCode: string) {
    const existing = await db
      .select({ id: schoolThemeConfigsSchema.id })
      .from(schoolThemeConfigsSchema)
      .limit(1)
      .get();

    if (existing) {
      console.log("✅ Themes already seeded, skipping.");
      return;
    }

    for (let i = 0; i < PREDEFINED_THEMES.length; i++) {
      const theme = PREDEFINED_THEMES[i];
      await db.insert(schoolThemeConfigsSchema).values({
        schoolId: 1,
        themeName: theme.themeName,
        config: theme.config,
        isCustomTheme: false,
        isActive: i === 0, // Only "Classic Blue" (index 0) is active by default
      })
      .onConflictDoNothing(); // ← safe re-run guard
    }

    console.log(
      `✅ Seeded ${PREDEFINED_THEMES.length} themes. "Classic Blue" is active.`
    );
  },
};
