import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client";
import { resetConfigForTests } from "../config";
import { credentials, groups, users } from "../db/schema";
import { createGroup, createToken, createUser, request, resetDatabase } from "../test/helpers";
import type { KeycloakClient, KeycloakUser } from "./keycloak";
import { syncDirectory } from "./sync";

vi.mock("../auth/resolve", () => import("../test/resolve-mock"));

function realm(
  people: KeycloakUser[],
  memberships: Record<string, { id: string; path: string; members: string[] }>,
): KeycloakClient {
  return {
    userGroups: async () => [],
    users: async () => people,
    groups: async () => Object.values(memberships).map(({ id, path }) => ({ id, path })),
    directMembers: async (groupId) => {
      const group = Object.values(memberships).find((item) => item.id === groupId);
      return people.filter((person) => group?.members.includes(person.id));
    },
    membersOf: async () => new Map(),
    check: async () => undefined,
  };
}

describe("Keycloak directory sync", () => {
  beforeEach(resetDatabase);

  it("keeps people, groups and memberships in step, and blocks disabled people", async () => {
    const ada = await createUser({ email: "ada@example.org", name: "Ada" });
    const agent = await createToken(ada.id, "Claude");
    await createGroup("Finance", [ada.id]);
    const people: KeycloakUser[] = [
      { id: "kc-ada", email: "ada@example.org", firstName: "Ada", lastName: "Lovelace", enabled: true },
      { id: "kc-rita", email: "Rita@example.org", firstName: "Rita", lastName: "Reader", enabled: true },
      { id: "kc-bot", username: "bot", enabled: true },
    ];
    await syncDirectory(
      realm(people, {
        staff: { id: "g-staff", path: "/staff", members: [] },
        it: { id: "g-it", path: "/staff/it", members: ["kc-ada"] },
        programs: { id: "g-programs", path: "/teams/Programs", members: ["kc-rita"] },
      }),
    );
    const rows = await getDb().select().from(users);
    expect(rows.map((row) => [row.email, row.name, row.directorySource]).sort()).toEqual([
      ["ada@example.org", "Ada Lovelace", "keycloak"],
      ["rita@example.org", "Rita Reader", "keycloak"],
    ]);
    const me = await request("GET", "/api/v1/me", { token: agent });
    expect(me.body.groups).toEqual(["/staff/it", "Finance"]);
    const rita = rows.find((row) => row.email === "rita@example.org")!;
    const people2 = await request("GET", "/api/v1/people?q=programs", { userId: ada.id });
    expect(people2.body.items).toEqual([
      expect.objectContaining({ email: "rita@example.org", groups: ["/teams/Programs"] }),
    ]);

    // Ada is disabled, Rita leaves her team, the team group goes.
    people[0]!.enabled = false;
    await syncDirectory(realm(people, { it: { id: "g-it", path: "/staff/it", members: ["kc-ada"] } }));
    expect((await request("GET", "/api/v1/me", { token: agent })).status).toBe(401);
    const [revoked] = await getDb().select().from(credentials).where(eq(credentials.userId, ada.id));
    expect(revoked!.revokedAt).not.toBeNull();
    expect((await getDb().select().from(groups)).map((group) => group.name).sort()).toEqual([
      "/staff/it",
      "Finance",
    ]);
    expect((await request("GET", "/api/v1/people?q=rita", { userId: rita.id })).body.items[0].groups).toEqual(
      [],
    );

    // Enabled again: the directory lifts its own block (tokens stay revoked).
    people[0]!.enabled = true;
    await syncDirectory(realm(people, {}));
    const [back] = await getDb().select().from(users).where(eq(users.id, ada.id));
    expect(back!.blockedAt).toBeNull();
    // Deleted in Keycloak: blocked.
    await syncDirectory(realm([people[0]!], {}));
    const [gone] = await getDb().select().from(users).where(eq(users.id, rita.id));
    expect(gone).toMatchObject({ blockedBy: "directory" });
    const status = await request("GET", "/api/v1/admin/directory", {
      userId: (await createUser({ isAdmin: true })).id,
    });
    expect(status.body.lastSync).toMatchObject({ ok: true, people: 1 });
  });
});

describe("Keycloak directory sync with ACCESS_GROUPS", () => {
  beforeEach(resetDatabase);

  it("lists only people who may use Connector and blocks those who leave the groups", async () => {
    process.env.ACCESS_GROUPS = "/staff";
    resetConfigForTests();
    try {
      const people: KeycloakUser[] = [
        { id: "kc-rita", email: "rita@example.org", firstName: "Rita", enabled: true },
        { id: "kc-gina", email: "gina@example.org", firstName: "Gina", enabled: true },
        { id: "kc-root", email: "root@example.org", firstName: "Root", enabled: true },
      ];
      await syncDirectory(
        realm(people, {
          it: { id: "g-it", path: "/staff/it", members: ["kc-rita"] },
          guests: { id: "g-guests", path: "/guests", members: ["kc-gina"] },
        }),
      );
      const emails = (await getDb().select().from(users)).map((row) => row.email).sort();
      expect(emails).toEqual(["rita@example.org", "root@example.org"]);
      // Rita moves to the guests: blocked.
      await syncDirectory(
        realm(people, { guests: { id: "g-guests", path: "/guests", members: ["kc-gina", "kc-rita"] } }),
      );
      const [rita] = await getDb().select().from(users).where(eq(users.email, "rita@example.org"));
      expect(rita).toMatchObject({ blockedBy: "directory" });
    } finally {
      delete process.env.ACCESS_GROUPS;
      resetConfigForTests();
    }
  });
});
