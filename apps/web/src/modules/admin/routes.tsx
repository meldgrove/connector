import type { ReactNode } from "react";
import { createRoute, type AnyRoute } from "@tanstack/react-router";
import { appRoute, requireAdmin } from "@/routes/app";
import { AdminActivityPage } from "./activity-page";
import { AdminDirectoryPage } from "./directory-page";
import { AdminPeoplePage } from "./people-page";
import { AdminServiceTokensPage } from "./service-tokens-page";
import { AdminSourcesPage } from "./sources-page";

const page = (path: string, component: () => ReactNode) =>
  createRoute({ getParentRoute: () => appRoute, path, beforeLoad: requireAdmin(), component });

/** Routes of this module inside the signed-in app (children of appRoute). */
export const routes: AnyRoute[] = [
  page("/admin/sources", AdminSourcesPage),
  page("/admin/people", AdminPeoplePage),
  page("/admin/directory", AdminDirectoryPage),
  page("/admin/service-tokens", AdminServiceTokensPage),
  page("/admin/activity", AdminActivityPage),
];
