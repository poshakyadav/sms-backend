import { relations } from "drizzle-orm";
import { schoolsSchema } from "./schools";
import { schoolThemeConfigsSchema } from "./school-theme-configs";

export const schoolThemeConfigsRelations = relations(
  schoolThemeConfigsSchema,
  ({ one }) => ({
    school: one(schoolsSchema, {
      fields: [schoolThemeConfigsSchema.schoolId],
      references: [schoolsSchema.id],
    }),
  })
);

export const schoolsRelations = relations(schoolsSchema, ({ one }) => ({
  activeTheme: one(schoolThemeConfigsSchema, {
    fields: [schoolsSchema.activeThemeId],
    references: [schoolThemeConfigsSchema.id],
  }),
}));
