import { and, asc, eq, ilike, inArray, notLike, or, sql } from "drizzle-orm";
import type { Person, PersonUpdate } from "@connector/shared/api/users";
import type { Db, DbOrTx } from "../db/client";
import { groupMembers, groups, sessions, users } from "../db/schema";
import type { UserPrincipal } from "../auth/principal";
import { revokeAgentAccess } from "../auth/credentials";
import { audit } from "../core/audit";
import { conflict, notFound } from "../http/errors";
import { isRemoved, REMOVED_EMAIL_DOMAIN } from "./remove";

const iso = (value: Date | null) => (value ? value.toISOString() : null);

export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, "\\$&");
}

export async function listPeople(db: Db, q: string | undefined, ids?: string[]): Promise<Person[]> {
  const rows = await db
    .select()
    .from(users)
    .where(
      and(
        notLike(users.email, `%@${REMOVED_EMAIL_DOMAIN}`),
        q ? or(ilike(users.email, `%${escapeLike(q)}%`), ilike(users.name, `%${escapeLike(q)}%`)) : undefined,
        ids ? inArray(users.id, ids) : undefined,
      ),
    )
    .orderBy(asc(users.email))
    .limit(500);
  const memberships = await db
    .select({ userId: groupMembers.userId, name: groups.name })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .orderBy(asc(groups.name));
  return rows.map((user) => ({
    id: user.id,
    email: user.email,
    name: user.name || user.email,
    title: user.title,
    isAdmin: user.isAdmin,
    adminSource: user.isAdmin ? (user.adminSource === "environment" ? "environment" : "app") : null,
    blocked: user.blockedAt !== null,
    directory:
      user.directorySource === "scim" || user.directorySource === "keycloak" ? user.directorySource : null,
    groups: [
      ...new Set([
        ...user.signInGroups,
        ...memberships.filter((row) => row.userId === user.id).map((row) => row.name),
      ]),
    ].sort((a, b) => a.localeCompare(b)),
    lastSignInAt: iso(user.lastSignInAt),
    createdAt: user.createdAt.toISOString(),
  }));
}

/**
 * Makes a person admin or not, blocks or unblocks them. People listed in
 * ADMIN_EMAILS stay admins; nobody changes their own admin rights or blocks
 * themselves. Blocking ends their sessions and revokes their personal
 * tokens and connected apps for good: unblocking does not bring them back.
 */
export async function updatePerson(
  db: Db,
  actor: UserPrincipal,
  userId: string,
  input: PersonUpdate,
): Promise<Person> {
  await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    if (!user || isRemoved(user)) throw notFound("No such person");
    if (user.id === actor.id && (input.isAdmin === false || input.blocked === true)) {
      throw conflict("You cannot remove your own admin rights or block yourself", "self_change");
    }
    if (user.adminSource === "environment" && (input.isAdmin === false || input.blocked === true)) {
      throw conflict("This person is an admin through ADMIN_EMAILS; change it there", "environment_admin");
    }
    const changes: string[] = [];
    const set: Partial<typeof users.$inferInsert> = {};
    if (input.isAdmin !== undefined && input.isAdmin !== user.isAdmin) {
      set.isAdmin = input.isAdmin;
      set.adminSource = input.isAdmin ? "app" : null;
      changes.push(
        input.isAdmin ? `Made ${user.email} an admin` : `Removed the admin rights of ${user.email}`,
      );
    }
    if (input.blocked !== undefined && input.blocked !== (user.blockedAt !== null)) {
      set.blockedAt = input.blocked ? new Date() : null;
      set.blockedBy = input.blocked ? "app" : null;
      changes.push(`${input.blocked ? "Blocked" : "Unblocked"} ${user.email}`);
      if (input.blocked) {
        await tx.delete(sessions).where(eq(sessions.userId, user.id));
        await revokeAgentAccess(tx, user.id);
      }
    }
    if (changes.length === 0) return;
    await tx
      .update(users)
      .set({ ...set, updatedAt: sql`now()` })
      .where(eq(users.id, user.id));
    await audit(tx, actor, {
      action: "person.updated",
      entityType: "user",
      entityId: user.id,
      summary: changes.join("; "),
    });
  });
  const [person] = await listPeople(db, undefined, [userId]);
  return person!;
}

/**
 * Blocks or unblocks a person on the directory's word (SCIM `active`,
 * Keycloak `enabled`). The directory lifts only its own blocks, never an
 * admin's. Blocking ends sessions and revokes agents for good.
 */
export async function setDirectoryActive(tx: DbOrTx, userId: string, active: boolean) {
  const [user] = await tx
    .select({
      id: users.id,
      blockedAt: users.blockedAt,
      blockedBy: users.blockedBy,
      adminSource: users.adminSource,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) return;
  if (!active && !user.blockedAt && user.adminSource !== "environment") {
    await tx
      .update(users)
      .set({ blockedAt: sql`now()`, blockedBy: "directory", updatedAt: sql`now()` })
      .where(eq(users.id, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await revokeAgentAccess(tx, userId);
  } else if (active && user.blockedAt && user.blockedBy === "directory") {
    await tx
      .update(users)
      .set({ blockedAt: null, blockedBy: null, updatedAt: sql`now()` })
      .where(eq(users.id, userId));
  }
}
