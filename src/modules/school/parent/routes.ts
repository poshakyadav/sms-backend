// src/modules/school/parent/routes.ts
// Production-grade parent routes: children view + child dashboard + parent-student assignment management

import { Hono } from "hono";
import {
  requirePermission,
  schoolJwtMiddleware,
  schoolTokenValidationMiddleware,
} from "../../../middleware/school-auth";
import { SchoolEnv } from "../../../types/common-types";
import {
  getParentChildren,
  getParentChildDashboard,
  removeParentFromStudent,
  updateParentStudentRelationship,
  assignParentToStudent,
  getStudentParents,
  searchParents,
  searchStudents,
} from "./services";
import z from "zod";
import { zValidator } from "@hono/zod-validator";

const parentRouter = new Hono<SchoolEnv>();

parentRouter.use("*", schoolJwtMiddleware, schoolTokenValidationMiddleware);

// ==================== SEARCH STUDENTS (for admin parent-link UI) ====================
// GET /school/parent/search-students?q=<name_or_email>
// Permission: users.list (staff who manage users / assign parents)
// Returns students enriched with their current enrollment (class + section + roll number)
 
parentRouter.get(
  "/search-students",
  requirePermission("users.list"),
  async (c) => {
    try {
      const schoolCode = c.get("schoolCode")!;
      const query = c.req.query("q") ?? "";
 
      if (query.trim().length < 2) {
        return c.json({ success: true, students: [] });
      }
 
      const students = await searchStudents(c.env, schoolCode, query.trim());
      return c.json({ success: true, students });
    } catch (error: any) {
      console.error("Search students error:", error);
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ==================== GET PARENT'S OWN CHILDREN ====================
// Used by the logged-in parent to see their linked children
parentRouter.get(
  "/children",
  requirePermission("attendance.student.view"),
  async (c) => {
    try {
      const user = c.get("user")!;
      const schoolCode = c.get("schoolCode")!;
      const children = await getParentChildren(c.env, schoolCode, user.id);
      return c.json({ success: true, children });
    } catch (error: any) {
      console.error("Get parent children error:", error);
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ==================== GET CHILD DASHBOARD DATA ====================
// GET /school/parent/child/:studentId/dashboard
parentRouter.get(
  "/child/:studentId/dashboard",
  requirePermission("attendance.student.view"),
  async (c) => {
    try {
      const user = c.get("user")!;
      const studentId = parseInt(c.req.param("studentId"));
      const schoolCode = c.get("schoolCode")!;

      if (isNaN(studentId)) {
        return c.json({ success: false, error: "Invalid student ID" }, 400);
      }

      const dashboard = await getParentChildDashboard(
        c.env,
        schoolCode,
        user.id,
        studentId
      );

      return c.json({ success: true, ...dashboard });
    } catch (error: any) {
      console.error("Get child dashboard error:", error);
      return c.json(
        { success: false, error: error.message },
        error.message === "Unauthorized" ? 403 : 500
      );
    }
  }
);

// ==================== SEARCH PARENTS (for admin assignment UI) ====================
// GET /school/parent/search?q=<name_or_email>
// Permission: users.list (staff who manage users)
parentRouter.get("/search", requirePermission("users.list"), async (c) => {
  try {
    const schoolCode = c.get("schoolCode")!;
    const query = c.req.query("q") ?? "";

    if (query.trim().length < 2) {
      return c.json({ success: true, parents: [] });
    }

    const parents = await searchParents(c.env, schoolCode, query.trim());
    return c.json({ success: true, parents });
  } catch (error: any) {
    console.error("Search parents error:", error);
    return c.json({ success: false, error: error.message }, 500);
  }
});

// ==================== GET PARENTS LINKED TO A STUDENT ====================
// GET /school/parent/student/:studentId/parents
parentRouter.get(
  "/student/:studentId/parents",
  requirePermission("users.list"),
  async (c) => {
    try {
      const studentId = parseInt(c.req.param("studentId"));
      const schoolCode = c.get("schoolCode")!;

      if (isNaN(studentId)) {
        return c.json({ success: false, error: "Invalid student ID" }, 400);
      }

      const parents = await getStudentParents(c.env, schoolCode, studentId);
      return c.json({ success: true, parents });
    } catch (error: any) {
      console.error("Get student parents error:", error);
      return c.json({ success: false, error: error.message }, 500);
    }
  }
);

// ==================== ASSIGN PARENT TO STUDENT ====================
// POST /school/parent/student/:studentId/assign
const assignParentSchema = z.object({
  parentUserId: z.number().int().positive(),
  relationship: z.string().min(1).max(50), // "Father", "Mother", "Guardian"
  isPrimary: z.boolean().default(false),
});

parentRouter.post(
  "/student/:studentId/assign",
  requirePermission("parents.manage"),
  zValidator("json", assignParentSchema),
  async (c) => {
    try {
      const studentId = parseInt(c.req.param("studentId"));
      const schoolCode = c.get("schoolCode")!;
      const { parentUserId, relationship, isPrimary } = c.req.valid("json");

      if (isNaN(studentId)) {
        return c.json({ success: false, error: "Invalid student ID" }, 400);
      }

      const result = await assignParentToStudent(
        c.env,
        schoolCode,
        studentId,
        parentUserId,
        relationship,
        isPrimary
      );

      return c.json({ success: true, ...result }, 201);
    } catch (error: any) {
      console.error("Assign parent error:", error);
      return c.json(
        { success: false, error: error.message || "Failed to assign parent" },
        400
      );
    }
  }
);

// ==================== UPDATE PARENT-STUDENT RELATIONSHIP ====================
// PUT /school/parent/student/:studentId/parent/:parentUserId
const updateRelationSchema = z.object({
  relationship: z.string().min(1).max(50).optional(),
  isPrimary: z.boolean().optional(),
});

parentRouter.put(
  "/student/:studentId/parent/:parentUserId",
  requirePermission("parents.manage"),
  zValidator("json", updateRelationSchema),
  async (c) => {
    try {
      const studentId = parseInt(c.req.param("studentId"));
      const parentUserId = parseInt(c.req.param("parentUserId"));
      const schoolCode = c.get("schoolCode")!;
      const data = c.req.valid("json");

      if (isNaN(studentId) || isNaN(parentUserId)) {
        return c.json({ success: false, error: "Invalid IDs" }, 400);
      }

      await updateParentStudentRelationship(
        c.env,
        schoolCode,
        studentId,
        parentUserId,
        data
      );

      return c.json({ success: true, message: "Relationship updated" });
    } catch (error: any) {
      console.error("Update parent relationship error:", error);
      return c.json(
        { success: false, error: error.message || "Failed to update" },
        400
      );
    }
  }
);

// ==================== REMOVE PARENT FROM STUDENT ====================
// DELETE /school/parent/student/:studentId/parent/:parentUserId
parentRouter.delete(
  "/student/:studentId/parent/:parentUserId",
  requirePermission("parents.manage"),
  async (c) => {
    try {
      const studentId = parseInt(c.req.param("studentId"));
      const parentUserId = parseInt(c.req.param("parentUserId"));
      const schoolCode = c.get("schoolCode")!;

      if (isNaN(studentId) || isNaN(parentUserId)) {
        return c.json({ success: false, error: "Invalid IDs" }, 400);
      }

      await removeParentFromStudent(c.env, schoolCode, studentId, parentUserId);

      return c.json({ success: true, message: "Parent removed from student" });
    } catch (error: any) {
      console.error("Remove parent error:", error);
      return c.json(
        { success: false, error: error.message || "Failed to remove parent" },
        400
      );
    }
  }
);

export default parentRouter;
