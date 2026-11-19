import type { SourceOutcome } from "@connector/shared/api/search";
import type { Principal, ServicePrincipal } from "../auth/principal";
import { config } from "../config";
import type { Db } from "../db/client";
import { logger } from "../logger";
import { KINDS } from "./registry";
import { kindOf, mayUse, secretOf, usableSources } from "./service";
import { SourceError, type Adapter, type AdapterContext, type SourceRow } from "./types";

/*
 * Source use (docs/architecture.md, "Access"): the one way to run an
 * adapter. People, agents and bots get a source only when they may use it;
 * admin pages and the worker use it as Connector itself, with the source's
 * own credentials and never as a person. Every use has a time budget and
 * ends in an outcome, whether it worked or not, for the answer and the
 * activity log; a source's failure never escapes as an exception.
 */

/** What runs against a source: one of its adapter's methods, or an operation of its own. */
export type Operation<T> = (adapter: Adapter, context: AdapterContext) => Promise<T>;

export type Use<T> =
  { ok: true; value: T; outcome: SourceOutcome } | { ok: false; error: SourceError; outcome: SourceOutcome };

/** Connector itself: admin pages and the worker use the source's own credentials. */
const CONNECTOR: ServicePrincipal = {
  kind: "service",
  credentialId: "00000000-0000-0000-0000-000000000000",
  name: "Connector",
};

/**
 * Reads get SOURCE_TIMEOUT_SECONDS; a proposal makes several requests in a
 * row; a check gets a little longer, so the source's own answer comes first.
 */
function budgetMs(kind: "read" | "propose" | "check"): number {
  const seconds = config().SOURCE_TIMEOUT_SECONDS;
  if (kind === "propose") return seconds * 3000;
  if (kind === "check") return seconds * 1000 + 5000;
  return seconds * 1000;
}

const countOf = (value: unknown) =>
  Array.isArray(value) ? value.length : value === null || value === undefined ? 0 : 1;

async function run<T>(
  db: Db,
  row: SourceRow,
  principal: Principal,
  operation: Operation<T>,
  budget: number,
): Promise<Use<T>> {
  const started = performance.now();
  const signal = AbortSignal.timeout(budget);
  const late = () => new SourceError(`${row.name} did not answer in time`);
  const outcome = (ok: boolean, count: number, error: string | null): SourceOutcome => ({
    slug: row.slug,
    name: row.name,
    ok,
    count,
    ms: Math.round(performance.now() - started),
    error,
  });
  try {
    const context: AdapterContext = {
      db,
      source: row,
      config: row.config,
      secret: secretOf(row),
      principal,
      signal,
    };
    // The budget holds even when an operation does not listen to the signal.
    const value = await Promise.race([
      operation(KINDS[kindOf(row)].adapter, context),
      new Promise<never>((_, reject) =>
        signal.addEventListener("abort", () => reject(late()), { once: true }),
      ),
    ]);
    return { ok: true, value, outcome: outcome(true, countOf(value), null) };
  } catch (caught) {
    if (!(caught instanceof SourceError)) logger.error({ err: caught, sourceId: row.id }, "source failed");
    const error =
      caught instanceof SourceError
        ? caught
        : caught instanceof Error && caught.name === "TimeoutError"
          ? late()
          : new SourceError("The source failed");
    return { ok: false, error, outcome: outcome(false, 0, error.message) };
  }
}

/**
 * Every source `principal` may use, in the source order (`slugs` narrows
 * them), asked at the same time, each within its own budget. A source that
 * fails answers nothing and says why in its outcome.
 */
export async function useSources<T>(
  db: Db,
  principal: Principal,
  slugs: string[] | undefined,
  operation: Operation<T[]>,
): Promise<{ answers: { row: SourceRow; value: T[] }[]; outcomes: SourceOutcome[] }> {
  const rows = await usableSources(db, principal, slugs);
  const uses = await Promise.all(rows.map((row) => run(db, row, principal, operation, budgetMs("read"))));
  return {
    answers: rows.map((row, index) => {
      const use = uses[index]!;
      return { row, value: use.ok ? use.value : [] };
    }),
    outcomes: uses.map((use) => use.outcome),
  };
}

/** One source for `principal`; null when they may not use it (closed to them or turned off). */
export async function useSource<T>(
  db: Db,
  principal: Principal,
  row: SourceRow,
  operation: Operation<T>,
  budget: "read" | "propose" = "read",
): Promise<Use<T> | null> {
  if (!mayUse(principal, row)) return null;
  return run(db, row, principal, operation, budgetMs(budget));
}

/** For admin pages and the worker: one source as Connector itself, with its own credentials. */
export function administerSource<T>(
  db: Db,
  row: SourceRow,
  operation: Operation<T>,
  budget: "read" | "check" = "read",
): Promise<Use<T>> {
  return run(db, row, CONNECTOR, operation, budgetMs(budget));
}
