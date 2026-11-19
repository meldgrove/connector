import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { AdminStatus } from "@connector/shared/api/status";
import { getDb } from "../db/client";
import { activity, credentials, items, oauthClients, oauthGrants, sources } from "../db/schema";
import { putSetting } from "../core/settings";
import { checkLiveSources } from "../sources/service";
import { bearerOf, startFakeApp, type FakeApp } from "../test/fake-app";
import {
  createAdminToken,
  createSource,
  createToken,
  createUser,
  request,
  resetDatabase,
} from "../test/helpers";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

let handbook: FakeApp;

beforeAll(async () => {
  handbook = await startFakeApp((req) => {
    if (bearerOf(req) !== "hb_right")
      return { status: 401, json: { error: { code: "unauthorized", message: "Unknown token" } } };
    if (req.path === "/api/v1/spaces")
      return {
        json: {
          items: [
            { slug: "purpose", name: "Purpose and rules" },
            { slug: "it", name: "IT" },
          ],
        },
      };
    if (req.path === "/api/v1/search") return { json: { items: [] } };
    return { status: 404, json: {} };
  });
});
afterAll(() => handbook.close());

async function status(adminId: string): Promise<AdminStatus> {
  const response = await request("GET", "/api/v1/admin/status", { userId: adminId });
  expect(response.status).toBe(200);
  return response.body as AdminStatus;
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

describe("admin status", () => {
  beforeEach(resetDatabase);

  it("is for admins only", async () => {
    const admin = await createUser({ isAdmin: true });
    const rita = await createUser();
    expect((await request("GET", "/api/v1/admin/status", { userId: rita.id })).status).toBe(403);
    expect(
      (await request("GET", "/api/v1/admin/status", { token: await createToken(admin.id) })).status,
    ).toBe(403);
    expect((await request("GET", "/api/v1/admin/status", { userId: admin.id })).status).toBe(200);
  });

  it("tells how each source is doing and what needs an admin", async () => {
    const admin = await createUser({ isAdmin: true });
    const noToken = await createSource({
      kind: "handbook",
      slug: "handbook",
      name: "Handbook",
      config: { baseUrl: handbook.url, ruleSpaces: [], allowLinking: true },
    });
    const crm = await createSource({
      kind: "crm",
      name: "CRM",
      config: { baseUrl: "https://crm.example.org", types: ["contact"] },
      secret: { apiKey: "crm_key" },
    });
    await getDb()
      .update(sources)
      .set({ status: { at: minutesAgo(5).toISOString(), ok: false, message: "CRM refused the credentials" } })
      .where(eq(sources.id, crm.id));
    const logbook = await createSource({
      kind: "logbook",
      name: "Logbook",
      config: { baseUrl: "https://logbook.example.org" },
      secret: { webhookSecret: "a-long-enough-webhook-secret" },
    });
    const library = await createSource({
      kind: "library",
      name: "Library",
      config: { baseUrl: "https://library.example.org", teamGroupPrefix: null },
      secret: { webhookSecret: "a-long-enough-webhook-secret" },
    });
    await getDb()
      .update(sources)
      .set({
        lastDeliveryAt: minutesAgo(10),
        status: { at: minutesAgo(10).toISOString(), ok: true, message: "Received LIB-1" },
      })
      .where(eq(sources.id, library.id));
    for (const externalId of ["n1", "n2"]) {
      await getDb().insert(items).values({
        sourceId: library.id,
        externalId,
        type: "note",
        title: externalId,
        url: "https://library.example.org/n/1",
      });
    }
    const off = await createSource({
      kind: "crm",
      slug: "old-crm",
      name: "Old CRM",
      config: { baseUrl: "https://old.example.org", types: ["contact"] },
      enabled: false,
    });
    const unreadable = await createSource({
      kind: "handbook",
      slug: "wiki",
      name: "Wiki",
      config: { baseUrl: "https://wiki.example.org", ruleSpaces: [], allowLinking: false },
    });
    await getDb()
      .update(sources)
      .set({ secretEncrypted: "not-encrypted" })
      .where(eq(sources.id, unreadable.id));

    // People whose address clashed, tokens that end, and a failed SCIM request.
    await createUser({ email: "conflict-1@conflict.invalid" });
    await createAdminToken("service", "Support Agent");
    await getDb()
      .update(credentials)
      .set({ expiresAt: new Date(Date.now() + 5 * 86_400_000) })
      .where(eq(credentials.name, "Support Agent"));
    await createAdminToken("scim", "Old IAM token");
    await getDb()
      .update(credentials)
      .set({ revokedAt: minutesAgo(60), lastRejectedAt: minutesAgo(2) })
      .where(eq(credentials.name, "Old IAM token"));
    await putSetting(getDb(), "scim.last_error", {
      at: minutesAgo(3).toISOString(),
      ok: false,
      message: "PATCH /Groups failed (HTTP 400): A member is not a known user",
    });

    // Agents: two people connected Claude; one used a token this week.
    const rita = await createUser({ name: "Rita" });
    const [client] = await getDb()
      .insert(oauthClients)
      .values({
        clientId: "claude",
        registration: "dynamic",
        name: "Claude",
        redirectUris: ["https://claude.ai/cb"],
      })
      .returning();
    for (const userId of [admin.id, rita.id]) {
      await getDb()
        .insert(oauthGrants)
        .values({
          clientId: client!.id,
          userId,
          redirectUri: "https://claude.ai/cb",
          lastUsedAt: minutesAgo(1),
        });
    }
    await createToken(rita.id);
    await getDb()
      .insert(activity)
      .values({
        userId: rita.id,
        actor: "Rita",
        channel: "oauth",
        client: "Claude",
        action: "search",
        query: "trains",
        results: 2,
        sources: [{ slug: "library", ok: true, count: 2 }],
      });

    const body = await status(admin.id);
    const bySlug = Object.fromEntries(body.sources.map((source) => [source.slug, source]));
    expect(bySlug.handbook).toMatchObject({ state: "setup", delivery: "live" });
    expect(bySlug.crm).toMatchObject({ state: "failing", status: { ok: false } });
    expect(bySlug.logbook).toMatchObject({ state: "waiting", delivery: "webhook", items: 0 });
    expect(bySlug.library).toMatchObject({
      state: "ok",
      items: 2,
      requests: { total: 1, failed: 0, lastError: null },
    });
    expect(bySlug["old-crm"]).toMatchObject({ state: "off" });
    expect(bySlug.wiki).toMatchObject({ state: "setup" });
    // The source order: Handbook first, the Library last.
    expect(body.sources.map((source) => source.kind)).toEqual([
      "handbook",
      "handbook",
      "logbook",
      "crm",
      "crm",
      "library",
    ]);

    const problems = Object.fromEntries(body.problems.map((problem) => [problem.key, problem]));
    expect(problems[`source:${noToken.id}`]).toMatchObject({
      severity: "warning",
      title: "Handbook has no service token",
      area: "source",
      sourceId: noToken.id,
    });
    expect(problems[`source:${crm.id}`]).toMatchObject({
      severity: "error",
      title: "CRM is failing",
      detail: "CRM refused the credentials",
    });
    expect(problems[`source:${logbook.id}`]).toMatchObject({
      severity: "warning",
      title: "Waiting for the first delivery from Logbook",
    });
    expect(problems[`source:${unreadable.id}`]).toMatchObject({
      severity: "error",
      title: "Connector cannot read the credentials of Wiki",
    });
    expect(problems[`source:${library.id}`]).toBeUndefined();
    expect(problems[`source:${off.id}`]).toBeUndefined();
    expect(problems["people:conflicts"]).toMatchObject({ area: "people", severity: "warning" });
    expect(Object.values(problems).find((p) => p.title.includes("Support Agent"))).toMatchObject({
      severity: "warning",
      title: "The service token “Support Agent” expires soon",
      area: "service-tokens",
    });
    expect(Object.values(problems).find((p) => p.title.includes("Old IAM token"))).toMatchObject({
      severity: "error",
      title: "Something still uses the SCIM token “Old IAM token”",
      area: "scim",
    });
    expect(problems.scim).toMatchObject({
      detail: "PATCH /Groups failed (HTTP 400): A member is not a known user",
    });
    // Errors come first.
    const severities = body.problems.map((problem) => problem.severity);
    expect(severities).toEqual([...severities].sort());

    expect(body.scim).toMatchObject({ tokens: 0, lastError: { ok: false } });
    expect(body.agents).toMatchObject({
      apps: [{ name: "Claude", people: 2 }],
      personalTokens: 1,
      serviceTokens: 1,
      week: { requests: 1, failed: 0, people: 1, bots: 0 },
    });
    expect(body.directory).toMatchObject({ mode: "oidc", people: 3, groups: 0 });
    expect(JSON.stringify(body)).not.toContain("crm_key");
    expect(JSON.stringify(body)).not.toContain("a-long-enough-webhook-secret");
  });

  it("notices sources that fail agents' requests, until a check works again", async () => {
    const admin = await createUser({ isAdmin: true });
    const rita = await createUser({ name: "Rita" });
    const source = await createSource({
      kind: "handbook",
      config: { baseUrl: handbook.url, ruleSpaces: [], allowLinking: false },
      secret: { serviceToken: "hb_wrong" },
    });
    const token = await createToken(rita.id);
    expect((await request("GET", "/api/v1/search?q=vpn", { token })).status).toBe(200);
    const [logged] = await getDb().select().from(activity);
    expect(logged!.sources).toEqual([
      { slug: "handbook", ok: false, count: 0, error: "Handbook refused the credentials: Unknown token" },
    ]);

    let body = await status(admin.id);
    expect(body.sources[0]).toMatchObject({
      state: "failing",
      requests: {
        total: 1,
        failed: 1,
        lastError: { message: "Handbook refused the credentials: Unknown token" },
      },
    });
    expect(body.problems[0]).toMatchObject({
      key: `source:${source.id}`,
      severity: "error",
      title: "handbook failed its latest requests",
    });
    expect(body.agents.week).toMatchObject({ requests: 1, failed: 1 });

    // The admin fixes the token; the next check clears the problem.
    await request("PATCH", `/api/v1/admin/sources/${source.id}`, {
      userId: admin.id,
      body: { secret: { serviceToken: "hb_right" } },
    });
    expect(
      (await request("POST", `/api/v1/admin/sources/${source.id}/check`, { userId: admin.id })).body,
    ).toMatchObject({ ok: true });
    body = await status(admin.id);
    expect(body.sources[0]).toMatchObject({ state: "ok", requests: { failed: 1 } });
    expect(body.problems.find((problem) => problem.key === `source:${source.id}`)).toBeUndefined();
  });

  it("the worker checks live sources and leaves webhook sources alone", async () => {
    const admin = await createUser({ isAdmin: true });
    const good = await createSource({
      kind: "handbook",
      config: { baseUrl: handbook.url, ruleSpaces: ["purpose"], allowLinking: true },
      secret: { serviceToken: "hb_right" },
    });
    const bad = await createSource({
      kind: "handbook",
      slug: "other",
      config: { baseUrl: handbook.url, ruleSpaces: [], allowLinking: true },
      secret: { serviceToken: "hb_revoked" },
    });
    const logbook = await createSource({
      kind: "logbook",
      config: { baseUrl: "https://logbook.example.org" },
    });
    expect(await checkLiveSources(getDb())).toBe(2);
    const rows = Object.fromEntries((await getDb().select().from(sources)).map((row) => [row.id, row]));
    expect(rows[good.id]!.status).toMatchObject({ ok: true, message: "Reached Handbook: 2 spaces" });
    expect(rows[bad.id]!.status).toMatchObject({
      ok: false,
      message: "Handbook refused the credentials: Unknown token",
    });
    expect(rows[logbook.id]!.status).toBeNull();
    const body = await status(admin.id);
    expect(body.sourceChecks).toMatchObject({ minutes: 15 });
    expect(Date.now() - Date.parse(body.sourceChecks.lastRunAt!)).toBeLessThan(60_000);
    expect(body.problems.find((problem) => problem.key === "worker")).toBeUndefined();

    // Checks that stopped long ago point at the worker.
    await putSetting(getDb(), "source_checks", { at: minutesAgo(120).toISOString() });
    expect((await status(admin.id)).problems.find((problem) => problem.key === "worker")).toMatchObject({
      title: "The worker seems to be stopped",
    });
  });

  it("lists Handbook's spaces for choosing the rule spaces", async () => {
    const admin = await createUser({ isAdmin: true });
    const source = await createSource({
      kind: "handbook",
      config: { baseUrl: handbook.url, ruleSpaces: [], allowLinking: true },
      secret: { serviceToken: "hb_right" },
    });
    const spaces = await request("GET", `/api/v1/admin/sources/${source.id}/spaces`, { userId: admin.id });
    expect(spaces.body).toEqual({
      items: [
        { slug: "purpose", name: "Purpose and rules" },
        { slug: "it", name: "IT" },
      ],
    });
    const rita = await createUser();
    expect(
      (await request("GET", `/api/v1/admin/sources/${source.id}/spaces`, { userId: rita.id })).status,
    ).toBe(403);
    await request("PATCH", `/api/v1/admin/sources/${source.id}`, {
      userId: admin.id,
      body: { secret: { serviceToken: "hb_wrong" } },
    });
    const refused = await request("GET", `/api/v1/admin/sources/${source.id}/spaces`, { userId: admin.id });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe("Handbook refused the credentials: Unknown token");
    const logbook = await createSource({
      kind: "logbook",
      config: { baseUrl: "https://logbook.example.org" },
    });
    expect(
      (await request("GET", `/api/v1/admin/sources/${logbook.id}/spaces`, { userId: admin.id })).status,
    ).toBe(409);
  });

  it("records how SCIM requests went, without IDs or filter values", async () => {
    const admin = await createUser({ isAdmin: true });
    const token = await createAdminToken("scim", "IAM");
    await request("GET", `/scim/v2/Users?filter=${encodeURIComponent('userName eq "rita@example.org"')}`, {
      token,
    });
    let body = await status(admin.id);
    expect(body.scim).toMatchObject({
      tokens: 1,
      lastRequest: { ok: true, message: "GET /Users" },
      lastError: null,
    });
    expect(body.scim.lastUsedAt).not.toBeNull();

    // A lookup of a missing person is normal; a failed change is not.
    await request("GET", "/scim/v2/Users/0b5a3e5e-3c1f-4d8e-9f3a-000000000000", { token });
    expect((await status(admin.id)).scim.lastError).toBeNull();
    await request("GET", `/scim/v2/Users?filter=${encodeURIComponent('nickName co "rita@example.org"')}`, {
      token,
    });
    body = await status(admin.id);
    expect(body.scim.lastError).toMatchObject({
      ok: false,
      message: "GET /Users failed (HTTP 400): invalidFilter",
    });
    expect(JSON.stringify(body)).not.toContain("rita@example.org");
    await request("PATCH", "/scim/v2/Users/0b5a3e5e-3c1f-4d8e-9f3a-000000000000", {
      token,
      body: {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", value: { active: false } }],
      },
    });
    body = await status(admin.id);
    expect(body.scim.lastError).toMatchObject({ message: "PATCH /Users failed (HTTP 404): No such user" });
    expect(body.scim.lastRequest).toMatchObject({ ok: false });
    expect(body.problems.find((problem) => problem.key === "scim")).toMatchObject({
      area: "scim",
      detail: "PATCH /Users failed (HTTP 404): No such user",
    });
  });

  it("notices revoked service and SCIM tokens that are still sent", async () => {
    const admin = await createUser({ isAdmin: true });
    const scim = await createAdminToken("scim", "IAM");
    const bot = await createAdminToken("service", "Support Agent");
    // An unknown token with the right prefix changes nothing.
    expect((await request("GET", "/scim/v2/Users", { token: "cn_scim_unknown" })).status).toBe(401);
    expect((await status(admin.id)).problems).toEqual([]);

    await getDb().update(credentials).set({ revokedAt: new Date() });
    expect((await request("GET", "/scim/v2/Users", { token: scim })).status).toBe(401);
    expect(
      (await request("POST", "/api/v1/knowledge/search", { token: bot, body: { query: "vpn" } })).status,
    ).toBe(401);
    const rejected = await getDb()
      .select({ name: credentials.name, at: credentials.lastRejectedAt })
      .from(credentials);
    expect(rejected.every((row) => row.at !== null)).toBe(true);
    const titles = (await status(admin.id)).problems.map((problem) => problem.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        "Something still uses the SCIM token “IAM”",
        "Something still uses the service token “Support Agent”",
      ]),
    );
  });
});
