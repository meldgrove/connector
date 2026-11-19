import { and, count, desc, eq, inArray, isNull, like, not, or, gt, sql } from "drizzle-orm";
import type { AdminStatus, Problem, SourceHealth, SourceState } from "@connector/shared/api/status";
import { SOURCE_KIND_INFO } from "@connector/shared/sources";
import { config } from "../config";
import type { Db } from "../db/client";
import {
  activity,
  credentials,
  groups,
  items,
  oauthClients,
  oauthGrants,
  sources,
  users,
} from "../db/schema";
import { getSetting } from "../core/settings";
import { REMOVED_EMAIL_DOMAIN } from "../admin/remove";
import { CONFLICT_EMAIL_DOMAIN, directoryStatus } from "../directory/sync";
import { SCIM_LAST_ERROR, SCIM_LAST_REQUEST } from "../scim/routes";
import {
  inSourceOrder,
  isWebhookKind,
  kindOf,
  secretOf,
  secretState,
  SOURCE_CHECKS_SETTING,
} from "../sources/service";
import type { SourceRow } from "../sources/types";

/*
 * The admin status page (GET /admin/status): how every source, the
 * directory, SCIM and the agents are doing, and the problems that need an
 * admin. Everything is read from the database; nothing calls the apps.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Epoch milliseconds from SQL (`extract(epoch …) * 1000`), as an ISO date. */
const isoOfMs = (value: unknown) => (typeof value === "number" ? new Date(value).toISOString() : null);
const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null);
const msOf = (value: string | null | undefined) => (value ? Date.parse(value) : 0);

type Requests = {
  total: number;
  failed: number;
  lastOkAt: number;
  lastFailedAt: number;
  lastError: string | null;
};

/** Requests of agents and bots per source slug in the last 24 hours (the activity log). */
async function requestsBySlug(db: Db): Promise<Map<string, Requests>> {
  const { rows } = await db.execute<{
    slug: string;
    total: number;
    failed: number;
    last_ok_ms: number | null;
    last_failed_ms: number | null;
    last_error: string | null;
  }>(sql`
    select s->>'slug' as slug,
           count(*)::int as total,
           (count(*) filter (where (s->>'ok')::boolean is false))::int as failed,
           (extract(epoch from max(a.created_at) filter (where (s->>'ok')::boolean)) * 1000)::float8 as last_ok_ms,
           (extract(epoch from max(a.created_at) filter (where (s->>'ok')::boolean is false)) * 1000)::float8
             as last_failed_ms,
           (array_agg(s->>'error' order by a.created_at desc) filter (where (s->>'ok')::boolean is false))[1]
             as last_error
    from ${activity} a cross join lateral jsonb_array_elements(a.sources) s
    where a.created_at > now() - interval '24 hours'
    group by 1`);
  return new Map(
    rows.map((row) => [
      row.slug,
      {
        total: row.total,
        failed: row.failed,
        lastOkAt: row.last_ok_ms ?? 0,
        lastFailedAt: row.last_failed_ms ?? 0,
        lastError: row.last_error,
      },
    ]),
  );
}

type SourceVerdict = { state: SourceState; problem: Omit<Problem, "key" | "area" | "sourceId"> | null };

/** A source's state and the problem it has, the most urgent first. */
function judgeSource(row: SourceRow, requests: Requests | undefined): SourceVerdict {
  const kind = kindOf(row);
  const name = row.name;
  const app = SOURCE_KIND_INFO[kind].label;
  if (!row.enabled) return { state: "off", problem: null };
  const secrets = secretState(row);
  if (secrets === "unreadable") {
    return {
      state: "setup",
      problem: {
        severity: "error",
        title: `Connector cannot read the credentials of ${name}`,
        detail: "ENCRYPTION_KEY changed since they were saved. Enter them again.",
      },
    };
  }
  const secret = secrets === "ok" ? secretOf(row) : {};
  const has = (key: string) => typeof secret[key] === "string" && secret[key] !== "";
  if (kind === "crm" && !has("apiKey")) {
    return {
      state: "setup",
      problem: {
        severity: "error",
        title: `${name} has no API key`,
        detail: "Create one in the CRM and add it here; until then the CRM is not searched.",
      },
    };
  }
  if (kind === "handbook" && !has("serviceToken")) {
    const linking = row.config.allowLinking !== false;
    return {
      state: "setup",
      problem: {
        severity: linking ? "warning" : "error",
        title: `${name} has no service token`,
        detail: linking
          ? "Only people who linked their Handbook account get its pages; bots get none."
          : "Nobody gets its pages until an admin adds a service token from Handbook.",
      },
    };
  }
  const webhook = isWebhookKind(kind);
  if (webhook && !has("webhookSecret")) {
    return {
      state: "setup",
      problem: {
        severity: "error",
        title: `${name} has no webhook secret`,
        detail: `Connector refuses deliveries from ${app} until both sides share a secret.`,
      },
    };
  }
  if (row.status && !row.status.ok) {
    return {
      state: "failing",
      problem: { severity: "error", title: `${name} is failing`, detail: row.status.message },
    };
  }
  // The latest request of an agent or bot failed: failing until a request works
  // again, whatever a check says (a check may test another path, e.g. the
  // service token instead of linked accounts). Earlier failures only count.
  if (requests && requests.failed > 0 && requests.lastFailedAt > requests.lastOkAt) {
    return {
      state: "failing",
      problem: {
        severity: "error",
        title: `${name} failed its latest requests`,
        detail: `${requests.failed} of ${requests.total} requests of agents and bots failed in the last 24 hours${
          requests.lastError ? `; the last one: ${requests.lastError}` : ""
        }. This clears with the next request that works.`,
      },
    };
  }
  if (webhook && !row.lastDeliveryAt) {
    return {
      state: "waiting",
      problem: {
        severity: "warning",
        title: `Waiting for the first delivery from ${name}`,
        detail: `Set WEBHOOK_URL and WEBHOOK_SECRET in ${app} and restart it. It delivers when something is published or changed there, and everything at its first nightly run (02:30).`,
      },
    };
  }
  if (!webhook && !row.status) return { state: "unchecked", problem: null };
  return { state: "ok", problem: null };
}

const TOKEN_LABEL = { service: "service token", scim: "SCIM token" } as const;

export async function adminStatus(db: Db): Promise<AdminStatus> {
  const now = Date.now();
  const problems: Problem[] = [];

  // Sources.
  const rows = inSourceOrder(await db.select().from(sources));
  const counted = await db
    .select({ sourceId: items.sourceId, value: count() })
    .from(items)
    .groupBy(items.sourceId);
  const itemCounts = new Map(counted.map((row) => [row.sourceId, row.value]));
  const requests = await requestsBySlug(db);
  const sourceHealth: SourceHealth[] = rows.map((row) => {
    const kind = kindOf(row);
    const webhook = isWebhookKind(kind);
    const used = requests.get(row.slug);
    const verdict = judgeSource(row, used);
    if (verdict.problem) {
      problems.push({ key: `source:${row.id}`, area: "source", sourceId: row.id, ...verdict.problem });
    }
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      kind,
      enabled: row.enabled,
      delivery: webhook ? "webhook" : "live",
      state: verdict.state,
      status: row.status ?? null,
      items: webhook ? (itemCounts.get(row.id) ?? 0) : null,
      lastDeliveryAt: iso(row.lastDeliveryAt),
      requests: {
        total: used?.total ?? 0,
        failed: used?.failed ?? 0,
        lastError:
          used?.lastError && used.lastFailedAt
            ? { at: new Date(used.lastFailedAt).toISOString(), message: used.lastError }
            : null,
      },
    };
  });

  // The worker: its source checks show that it runs.
  const checkMinutes = config().SOURCE_CHECK_MINUTES || null;
  const checks = await getSetting(db, SOURCE_CHECKS_SETTING);
  const lastRunAt = typeof checks?.at === "string" ? checks.at : null;
  if (checkMinutes) {
    const late = (3 * checkMinutes + 5) * MINUTE;
    const stale = lastRunAt ? now - msOf(lastRunAt) > late : process.uptime() * 1000 > late;
    if (stale) {
      problems.push({
        key: "worker",
        area: "source",
        sourceId: null,
        severity: "warning",
        title: "The worker seems to be stopped",
        detail: `It checks the live sources every ${checkMinutes} minutes, but ${
          lastRunAt ? "the last check is much older" : "it has not checked them yet"
        }. Check that the worker process runs.`,
      });
    }
  }

  // Directory.
  const directory = await directoryStatus(db);
  if (directory.mode === "keycloak") {
    const minutes = directory.syncMinutes ?? config().DIRECTORY_SYNC_MINUTES;
    const late = Math.max(3 * minutes, 30) * MINUTE;
    const lastSync = directory.lastSync;
    if (lastSync && !lastSync.ok) {
      problems.push({
        key: "directory",
        area: "directory",
        sourceId: null,
        severity: "error",
        title: "The Keycloak sync failed",
        detail: lastSync.message,
      });
    } else if (lastSync ? now - msOf(lastSync.at) > late : process.uptime() * 1000 > late) {
      problems.push({
        key: "directory",
        area: "directory",
        sourceId: null,
        severity: "warning",
        title: lastSync ? "The Keycloak sync has stopped" : "The Keycloak directory was never synced",
        detail: `The worker syncs it every ${minutes} minutes. Check that the worker runs, or sync now.`,
      });
    }
  }
  const [people] = await db
    .select({ value: count() })
    .from(users)
    .where(not(like(users.email, `%@${REMOVED_EMAIL_DOMAIN}`)));
  const [groupCount] = await db.select({ value: count() }).from(groups);
  const [conflicts] = await db
    .select({ value: count() })
    .from(users)
    .where(like(users.email, `%@${CONFLICT_EMAIL_DOMAIN}`));
  const skipped = directory.mode === "keycloak" ? (directory.lastSync?.skipped ?? 0) : 0;
  if (skipped > 0) {
    problems.push({
      key: "directory:skipped",
      area: "directory",
      sourceId: null,
      severity: "warning",
      title:
        skipped === 1
          ? "The Keycloak sync left out 1 person"
          : `The Keycloak sync left out ${skipped} people`,
      detail:
        "Their email address in Keycloak is not verified, or another person in Connector has it. Correct it in Keycloak, or remove the other person; the next sync takes them in.",
    });
  }
  if (conflicts && conflicts.value > 0) {
    problems.push({
      key: "people:conflicts",
      area: "people",
      sourceId: null,
      severity: "warning",
      title:
        conflicts.value === 1
          ? "1 person has an email address that someone else has"
          : `${conflicts.value} people have an email address that someone else has`,
      detail: `Keycloak gives them the address of another person in Connector, so the sync set theirs to …@${CONFLICT_EMAIL_DOMAIN}. Correct the address in Keycloak; the next sync takes it over.`,
    });
  }

  // Service and SCIM tokens: expired, expiring, or still sent after they ended.
  const tokens = await db
    .select({
      id: credentials.id,
      kind: credentials.kind,
      name: credentials.name,
      expiresAt: credentials.expiresAt,
      lastUsedAt: credentials.lastUsedAt,
      lastRejectedAt: credentials.lastRejectedAt,
      revokedAt: credentials.revokedAt,
    })
    .from(credentials)
    .where(
      and(
        inArray(credentials.kind, ["service", "scim"]),
        or(isNull(credentials.revokedAt), gt(credentials.lastRejectedAt, new Date(now - 7 * DAY))),
      ),
    )
    .orderBy(desc(credentials.createdAt));
  const active = tokens.filter(
    (token) => !token.revokedAt && (!token.expiresAt || token.expiresAt.getTime() > now),
  );
  for (const token of tokens) {
    const kind = token.kind === "scim" ? "scim" : "service";
    const label = TOKEN_LABEL[kind];
    const area = kind === "scim" ? "scim" : "service-tokens";
    const rejected = token.lastRejectedAt && now - token.lastRejectedAt.getTime() < 7 * DAY;
    const expired = token.expiresAt && token.expiresAt.getTime() <= now;
    if (rejected && (token.revokedAt || expired)) {
      problems.push({
        key: `token:${token.id}`,
        area,
        sourceId: null,
        severity: "error",
        title: `Something still uses the ${label} “${token.name}”`,
        detail: `It ${token.revokedAt ? "was revoked" : "expired"}, so every request with it is refused. Give the ${
          kind === "scim" ? "identity system" : "bot"
        } a new token.`,
      });
    } else if (!token.revokedAt && expired && now - token.expiresAt!.getTime() < 30 * DAY) {
      problems.push({
        key: `token:${token.id}`,
        area,
        sourceId: null,
        severity: "error",
        title: `The ${label} “${token.name}” expired`,
        detail: `Whatever uses it can no longer connect. Create a new token and replace it there.`,
      });
    } else if (
      !token.revokedAt &&
      token.expiresAt &&
      !expired &&
      token.expiresAt.getTime() - now < 14 * DAY
    ) {
      problems.push({
        key: `token:${token.id}`,
        area,
        sourceId: null,
        severity: "warning",
        title: `The ${label} “${token.name}” expires soon`,
        detail: `It stops working on ${token.expiresAt.toISOString().slice(0, 10)}. Create a new token and replace it before then.`,
      });
    }
  }

  // SCIM.
  const lastRequest = await getSetting(db, SCIM_LAST_REQUEST);
  const lastError = await getSetting(db, SCIM_LAST_ERROR);
  const request = (value: Record<string, unknown> | undefined) =>
    value && typeof value.at === "string" && typeof value.message === "string"
      ? { at: value.at, ok: value.ok === true, message: value.message }
      : null;
  const scimLastError = request(lastError);
  if (scimLastError && now - msOf(scimLastError.at) < DAY) {
    problems.push({
      key: "scim",
      area: "scim",
      sourceId: null,
      severity: "warning",
      title: "A request of the identity system failed",
      detail: scimLastError.message,
    });
  }
  const scimTokens = active.filter((token) => token.kind === "scim");
  const serviceTokens = active.filter((token) => token.kind === "service");
  const latest = (list: typeof active) =>
    list.reduce<Date | null>(
      (max, token) => (token.lastUsedAt && (!max || token.lastUsedAt > max) ? token.lastUsedAt : max),
      null,
    );

  // Agents.
  const apps = await db
    .select({
      name: oauthClients.name,
      people: sql<number>`count(distinct ${oauthGrants.userId})::int`,
      lastUsedMs: sql<number | null>`(extract(epoch from max(${oauthGrants.lastUsedAt})) * 1000)::float8`,
    })
    .from(oauthGrants)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.clientId))
    .innerJoin(users, eq(users.id, oauthGrants.userId))
    .where(and(isNull(oauthGrants.revokedAt), isNull(users.blockedAt)))
    .groupBy(oauthClients.name)
    .orderBy(sql`2 desc`, oauthClients.name);
  const [personal] = await db
    .select({ value: count() })
    .from(credentials)
    .innerJoin(users, eq(users.id, credentials.userId))
    .where(
      and(
        eq(credentials.kind, "personal"),
        isNull(credentials.revokedAt),
        or(isNull(credentials.expiresAt), gt(credentials.expiresAt, new Date(now))),
        isNull(users.blockedAt),
      ),
    );
  const {
    rows: [week],
  } = await db.execute<{ requests: number; failed: number; people: number; bots: number }>(sql`
    select count(*)::int as requests,
           (count(*) filter (
             where exists (select 1 from jsonb_array_elements(a.sources) s where (s->>'ok')::boolean is false)
           ))::int as failed,
           (count(distinct a.user_id))::int as people,
           (count(distinct a.credential_id) filter (where a.channel = 'service'))::int as bots
    from ${activity} a
    where a.created_at > now() - interval '7 days'`);

  problems.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1));
  return {
    problems,
    sources: sourceHealth,
    sourceChecks: { minutes: checkMinutes, lastRunAt },
    directory: {
      mode: directory.mode,
      syncMinutes: directory.syncMinutes,
      lastSync: directory.lastSync,
      people: people?.value ?? 0,
      groups: groupCount?.value ?? 0,
    },
    scim: {
      url: directory.scimUrl,
      tokens: scimTokens.length,
      people: directory.scimPeople,
      lastUsedAt: iso(latest(scimTokens)),
      lastRequest: request(lastRequest),
      lastError: scimLastError,
    },
    agents: {
      apps: apps.map((app) => ({ name: app.name, people: app.people, lastUsedAt: isoOfMs(app.lastUsedMs) })),
      personalTokens: personal?.value ?? 0,
      serviceTokens: serviceTokens.length,
      serviceLastUsedAt: iso(latest(serviceTokens)),
      week: {
        requests: week?.requests ?? 0,
        failed: week?.failed ?? 0,
        people: week?.people ?? 0,
        bots: week?.bots ?? 0,
      },
    },
  };
}
