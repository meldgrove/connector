import { Hono, type Context } from "hono";
import { createUpdatesHandler } from "@meldgrove/ui/updates/server";
import { config } from "../config";
import type { AppEnv } from "../http/env";
import { requireAdmin } from "../http/middleware";
import { logger } from "../logger";

/**
 * Updates of the app, for admins in the web app (never agents or service
 * tokens): the status, a check, an installation and the channel, through
 * the Meldgrove Updater (docs/deployment.md, Automatic updates).
 * `@meldgrove/ui` asks the updater at UPDATER_URL with UPDATER_TOKEN and
 * answers `UpdatesResponse` (a refusal as 409, the updater's 5xx as that
 * 5xx, a wrong body as 400). Connector checks the admin first; changes also
 * need the app's origin (`sameOrigin`, http/app.ts).
 */
/**
 * The shared handler's answer through Hono's context, so the headers that
 * middleware set before the route (x-request-id) stay on it.
 */
async function answer(c: Context<AppEnv>, response: Response | Promise<Response>) {
  const result = await response;
  return c.newResponse(result.body, result);
}

const router = new Hono<AppEnv>();

const updates = createUpdatesHandler(() => ({
  url: config().UPDATER_URL,
  token: config().UPDATER_TOKEN,
  appVersion: config().APP_VERSION ?? null,
  logger,
}));

router.get("/admin/updates", (c) => {
  requireAdmin(c);
  return answer(c, updates.respond("status"));
});

router.post("/admin/updates/check", (c) => {
  requireAdmin(c);
  return answer(c, updates.respond("check"));
});

router.post("/admin/updates/install", (c) => {
  requireAdmin(c);
  return answer(c, updates.respond("install", c.req.raw));
});

router.post("/admin/updates/channel", (c) => {
  requireAdmin(c);
  return answer(c, updates.respond("channel", c.req.raw));
});

export default router;
