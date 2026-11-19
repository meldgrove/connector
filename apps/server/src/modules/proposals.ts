import { Hono } from "hono";
import { proposalSchema, type ProposalResult } from "@connector/shared/api/search";
import { parseItemId } from "@connector/shared/sources";
import { getDb } from "../db/client";
import type { AppEnv } from "../http/env";
import { AppError, notFound, validationError } from "../http/errors";
import { jsonBody, requireUser } from "../http/middleware";
import { config } from "../config";
import { logActivity } from "../search/federate";
import { proposeHandbookChange } from "../sources/handbook";
import { adapterContext, usableSources } from "../sources/service";
import { SourceError } from "../sources/types";

/**
 * Agents draft, people publish: a proposed Handbook change, made as the
 * person through their linked Handbook account and submitted for review.
 */
const router = new Hono<AppEnv>();

router.post("/proposals", async (c) => {
  const principal = requireUser(c);
  const input = await jsonBody(c, proposalSchema);
  const started = performance.now();
  const ref = input.page ? parseItemId(input.page) : null;
  if (input.page && (!ref || ref.type !== "page")) {
    throw validationError({ page: "Use a page ID from search, e.g. handbook:page:…" });
  }
  const handbooks = (await usableSources(getDb(), principal)).filter((row) => row.kind === "handbook");
  const wanted = ref?.source ?? input.source;
  const source = wanted
    ? handbooks.find((row) => row.slug === wanted)
    : handbooks.length === 1
      ? handbooks[0]
      : undefined;
  if (!source) {
    throw handbooks.length > 1 && !wanted
      ? validationError({
          source: `Name the Handbook source: ${handbooks.map((row) => row.slug).join(", ")}`,
        })
      : notFound("No Handbook source you may use");
  }
  const signal = AbortSignal.timeout(config().SOURCE_TIMEOUT_SECONDS * 3000);
  let result: ProposalResult;
  try {
    result = await proposeHandbookChange(adapterContext(getDb(), source, principal, signal), {
      title: input.title,
      description: input.description,
      page: ref && input.edits ? { id: ref.externalId, edits: input.edits } : undefined,
      newPage: input.newPage,
    });
  } catch (error) {
    if (error instanceof SourceError)
      throw new AppError(error.status === 422 ? 422 : 409, "proposal_failed", error.message);
    throw error;
  }
  await logActivity(getDb(), principal, {
    action: "propose",
    query: input.title,
    results: 1,
    sources: [
      {
        slug: source.slug,
        name: source.name,
        ok: true,
        count: 1,
        ms: Math.round(performance.now() - started),
        error: null,
      },
    ],
    ms: Math.round(performance.now() - started),
  });
  return c.json(result, 201);
});

export default router;
