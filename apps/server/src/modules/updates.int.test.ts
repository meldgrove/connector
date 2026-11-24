import { startFakeUpdater, updaterStatus, type FakeUpdater } from "@meldgrove/ui/updates/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../db/client";
import { issueCredential } from "../auth/credentials";
import { resetConfigForTests } from "../config";
import { createToken, createUser, request, resetDatabase } from "../test/helpers";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

/** The updater's API_TOKEN, which compose.yaml sets from UPDATER_TOKEN. */
const TOKEN = "updater-token-0123456789abcdef";

let updater: FakeUpdater;

/**
 * Connector's side of the update routes: who may use them, its origin check
 * and its settings. How the answers are made (bodies, 409, 5xx, timeouts)
 * is tested in @meldgrove/ui.
 */
describe("updates API", () => {
  beforeAll(async () => {
    updater = await startFakeUpdater({ token: TOKEN });
    process.env.UPDATER_URL = updater.url;
    process.env.UPDATER_TOKEN = TOKEN;
    process.env.APP_VERSION = "0.2.0";
    resetConfigForTests();
  });
  afterAll(async () => {
    await updater.close();
    delete process.env.UPDATER_URL;
    delete process.env.UPDATER_TOKEN;
    delete process.env.APP_VERSION;
    resetConfigForTests();
  });
  beforeEach(async () => {
    await resetDatabase();
    updater.calls.length = 0;
    updater.respond(() => ({ body: updaterStatus() }));
  });

  it("is only for admins in the web app", async () => {
    const admin = await createUser({ isAdmin: true });
    const person = await createUser();
    const agent = await createToken(admin.id);
    const { secret: service } = await issueCredential(getDb(), {
      kind: "service",
      name: "Backup",
      userId: null,
      createdById: admin.id,
      expiresAt: null,
    });

    const paths: [string, string, unknown?][] = [
      ["GET", "/api/v1/admin/updates"],
      ["POST", "/api/v1/admin/updates/check", {}],
      ["POST", "/api/v1/admin/updates/install", { version: "0.2.1" }],
      ["POST", "/api/v1/admin/updates/channel", { channel: "preview" }],
    ];
    for (const [method, path, body] of paths) {
      expect((await request(method, path, { body })).status).toBe(401);
      expect((await request(method, path, { userId: person.id, body })).status).toBe(403);
      expect((await request(method, path, { token: agent, body })).status).toBe(403);
      expect((await request(method, path, { token: service, body })).status).toBe(403);
    }
    expect(updater.calls).toEqual([]);

    const status = await request("GET", "/api/v1/admin/updates", { userId: admin.id });
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(status.headers.get("x-request-id")).toBeTruthy();
    expect(status.body).toEqual({
      app: { version: "0.2.0" },
      reachable: true,
      updater: updaterStatus(),
      error: null,
    });
  });

  it("sends UPDATER_TOKEN to the updater", async () => {
    const admin = await createUser({ isAdmin: true });
    await request("GET", "/api/v1/admin/updates", { userId: admin.id });
    await request("POST", "/api/v1/admin/updates/check", { userId: admin.id, body: {} });
    expect(updater.calls.map(({ method, path, authorization }) => [method, path, authorization])).toEqual([
      ["GET", "/v1/status", `Bearer ${TOKEN}`],
      ["POST", "/v1/check", `Bearer ${TOKEN}`],
    ]);
  });

  it("installs a version and switches the channel through the updater", async () => {
    const admin = await createUser({ isAdmin: true });
    updater.respond((call) => (call.path === "/v1/install" ? { status: 202, body: updaterStatus() } : {}));
    const install = await request("POST", "/api/v1/admin/updates/install", {
      userId: admin.id,
      body: { version: "0.2.1" },
    });
    expect(install.status).toBe(202);
    expect(install.body).toMatchObject({ reachable: true, updater: updaterStatus(), error: null });

    updater.respond(() => ({ body: updaterStatus({ channel: "preview" }) }));
    const channel = await request("POST", "/api/v1/admin/updates/channel", {
      userId: admin.id,
      body: { channel: "preview" },
    });
    expect(channel.status).toBe(200);
    expect(channel.body.updater.channel).toBe("preview");

    expect(updater.calls.map(({ method, path, body }) => [method, path, body])).toEqual([
      ["POST", "/v1/install", { version: "0.2.1" }],
      ["POST", "/v1/channel", { channel: "preview" }],
    ]);
  });

  it("protects changes against other sites", async () => {
    const admin = await createUser({ isAdmin: true });
    const response = await request("POST", "/api/v1/admin/updates/install", {
      userId: admin.id,
      body: { version: "0.2.1" },
      headers: { origin: "https://evil.example.net" },
    });
    expect(response.status).toBe(403);
    expect(updater.calls).toEqual([]);
  });

  it("calls nothing when UPDATER_URL is empty", async () => {
    const admin = await createUser({ isAdmin: true });
    process.env.UPDATER_URL = "";
    resetConfigForTests();
    try {
      const response = await request("GET", "/api/v1/admin/updates", { userId: admin.id });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        app: { version: "0.2.0" },
        reachable: false,
        updater: null,
        error: null,
      });
      expect(updater.calls).toEqual([]);
    } finally {
      process.env.UPDATER_URL = updater.url;
      resetConfigForTests();
    }
  });
});
