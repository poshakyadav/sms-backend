import { Hono } from "hono";
import { Env } from "../types/common-types";


const router = new Hono<Env>();

router.get("/", (c) => {
  return c.text("Hello Hono, I am Poshak!");
});

export default router;