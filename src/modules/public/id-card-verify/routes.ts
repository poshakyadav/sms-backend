// src/modules/public/id-card-verify/routes.ts
//
// PUBLIC, UNAUTHENTICATED router. Mount this in src/index.ts alongside
// publicSchoolRequestsRouter, e.g.:
//
//   import idCardVerifyRouter from "./modules/public/id-card-verify/routes";
//   ...
//   app.route("/verify", idCardVerifyRouter);
//
// IMPORTANT: this needs its own DB connection resolution since there is no
// JWT / X-School-Code header on a public QR scan — the school is identified
// implicitly because verificationToken is GLOBALLY unique across this
// school's Turso DB (each school has its own DB per your architecture, so
// the route only ever needs getSchoolDB scoped to whichever DB binding this
// worker instance is deployed against). If your deployment serves multiple
// schools from a single worker (multi-tenant routing), pass the schoolCode
// as a query param or path segment instead, e.g. /verify/:schoolCode/:token
// — adjust based on how getSchoolDB resolves tenancy elsewhere in this app.

import { Hono } from "hono";
import { getSchoolDB } from "../../../db/school-client";
import { Env } from "../../../types/common-types";
import { verifyIdCardToken } from "../../school/id-cards/services";

const idCardVerifyRouter = new Hono<Env>();

idCardVerifyRouter.get("/:token", async (c) => {
  try {
    const token = c.req.param("token");
    if (!token || token.length < 16) {
      return c.json({ valid: false, status: "NOT_FOUND" }, 404);
    }

    // See note above re: tenancy resolution — using a schoolCode query param
    // as the simplest correct option given the existing per-school DB model.
    const schoolCode = c.req.query("school");
    if (!schoolCode) {
      return c.json(
        {
          valid: false,
          status: "NOT_FOUND",
          error: "Missing school reference",
        },
        400
      );
    }

    const db = await getSchoolDB(c.env, schoolCode);
    const result = await verifyIdCardToken(db, token);

    // Always 200 — the "validity" is communicated in the response body, not
    // the HTTP status, so the frontend verification page can render a clean
    // "invalid/expired" UI rather than handling a 4xx for a legitimate scan
    // of a revoked/expired card.
    return c.json(result);
  } catch (error: any) {
    return c.json(
      { valid: false, status: "NOT_FOUND", error: "Verification failed" },
      500
    );
  }
});

export default idCardVerifyRouter;
