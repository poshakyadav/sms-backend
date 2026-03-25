import z from "zod";
import {
  schoolJwtMiddleware,
  schoolPermissionMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../../middleware/school-auth";
import { SchoolRole } from "../../../../types/school-role";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { SchoolEnv } from "../../../../types/common-types";
import {
  createBulkMappings,
  createNextMapping,
  deleteMapping,
  getClassSectionMappings,
  updateMapping,
} from "./services";

const classSectionMappingsRouter = new Hono<SchoolEnv>();

classSectionMappingsRouter.use(
  "*",
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware
);

// ==================== Class-Section Mappings CRUD ====================

/**
 * Goal: Allow admin to define "what is the next class-section for each current class-section"
 * (e.g. Class 1-A → Class 2-A, Class 10-Com → Class 11-Com, Nursery-A → LKG-A, etc.)
 *
 * =======
 * Global (reusable): send without academicYearId
 * Year-specific: send with academicYearId
 */
/**
 * How "Create Once & Reuse Every Year" Now Works
 * - Create a global mapping → omit academicYearId (or send null).
 * Example: 1-A → 2-A
 * This mapping will be used every year automatically.
 *
 * - Create a year-specific mapping → send academicYearId.
 * This overrides the global one only for that year.
 *
 * - During promotion → the code first looks for year-specific, then global, then falls back to same section.
 */
// Example: POST /class-section-mappings
// ==================== Schema (Fixed typo + bulk support) ====================
const singleMappingSchema = z.object({
  currentClassSectionId: z.number().int().positive(),
  nextClassSectionId: z.number().int().positive(),
  academicYearId: z.number().int().positive().optional().nullable(),
});

const bulkMappingSchema = z.array(singleMappingSchema);

// ==================== Single Create ====================
classSectionMappingsRouter.post(
  "/",
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL]),
  zValidator("json", singleMappingSchema),
  async (c) => {
    const data = c.req.valid("json");
    const schoolCode = c.get("schoolCode")!;
    const result = await createNextMapping(c.env, schoolCode, data);
    return c.json(result, 201);
  }
);

/**
 * How to Use Bulk Create (UI-Friendly)
 * Request:
 * POST /class-section-mappings/bulk
    [
    { "currentClassSectionId": 10, "nextClassSectionId": 15 },
    { "currentClassSectionId": 30, "nextClassSectionId": 35, "academicYearId": 5 }
    ]
 * 
 * Response (UI-friendly):
 * {
    "message": "Successfully created 2 mappings",
    "created": 2,
    "mappings": [
        {
        "id": 45,
        "currentDisplayName": "Class 1 - A",
        "nextDisplayName": "Class 2 - A",
        "isGlobal": true,
        ...
        }
    ]
    }
 */
// ==================== BULK CREATE (New) ====================
classSectionMappingsRouter.post(
  "/bulk",
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL]),
  zValidator("json", bulkMappingSchema),
  async (c) => {
    const data = c.req.valid("json");
    const schoolCode = c.get("schoolCode")!;
    const result = await createBulkMappings(c.env, schoolCode, data);
    return c.json(result, 201);
  }
);

// ==================== Get All (UI-friendly) ====================
classSectionMappingsRouter.get(
  "/",
  schoolPermissionMiddleware([
    SchoolRole.SCHOOL_OWNER,
    SchoolRole.PRINCIPAL,
    SchoolRole.MANAGER,
  ]),
  async (c) => {
    const schoolCode = c.get("schoolCode")!;
    const mappings = await getClassSectionMappings(c.env, schoolCode);
    return c.json({ mappings });
  }
);

// ==================== Update ====================
classSectionMappingsRouter.put(
  "/:id",
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER, SchoolRole.PRINCIPAL]),
  zValidator("json", singleMappingSchema.partial()),
  async (c) => {
    const id = parseInt(c.req.param("id"));
    const data = c.req.valid("json");
    const schoolCode = c.get("schoolCode")!;
    const result = await updateMapping(c.env, schoolCode, id, data);
    return c.json(result);
  }
);

// ==================== Delete ====================
classSectionMappingsRouter.delete(
  "/:id",
  schoolPermissionMiddleware([SchoolRole.SCHOOL_OWNER]),
  async (c) => {
    const id = parseInt(c.req.param("id"));
    const schoolCode = c.get("schoolCode")!;
    const result = await deleteMapping(c.env, schoolCode, id);
    return c.json(result);
  }
);

export default classSectionMappingsRouter;
