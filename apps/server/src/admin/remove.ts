import { eq, or, sql } from "drizzle-orm";
import { REMOVED_PERSON_NAME } from "@connector/shared/api/users";
import type { Db } from "../db/client";
import {
  accounts,
  auditLog,
  credentials,
  groupMembers,
  linkRequests,
  oauthGrants,
  oauthRequests,
  sessions,
  sourceLinks,
  users,
} from "../db/schema";
import type { UserPrincipal } from "../auth/principal";
import { isEnvironmentAdmin } from "../auth/bootstrap";
import { audit } from "../core/audit";
import { conflict, notFound } from "../http/errors";

/**
 * Removed people keep their row, so that the audit and activity logs still
 * name someone, under an address that no provider can sign in with
 * (`.invalid` is reserved) and that keeps emails unique.
 */
export const REMOVED_EMAIL_DOMAIN = "removed.invalid";

export const isRemoved = (user: { email: string }) => user.email.endsWith(`@${REMOVED_EMAIL_DOMAIN}`);

/** What audit summaries say instead of a removed person's email. */
const REMOVED_IN_SUMMARIES = "a removed person";

/**
 * Removes a person while the logs stay readable: their name and email are
 * replaced; their provider accounts, sessions, tokens, connected apps,
 * pending app sign-ins, linked accounts and group memberships are deleted;
 * the audit log loses their email. If they sign in again, they come back as
 * a new, empty person. Not for people in ADMIN_EMAILS, and not for yourself.
 * `actor` null: the directory (SCIM) removed them.
 */
export async function removePerson(db: Db, actor: UserPrincipal | null, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    if (!user || isRemoved(user)) throw notFound("No such person");
    if (actor && user.id === actor.id) throw conflict("You cannot remove yourself", "self_change");
    if (user.adminSource === "environment" || isEnvironmentAdmin(user.email)) {
      throw conflict("This person is an admin through ADMIN_EMAILS; change it there", "environment_admin");
    }

    await tx.delete(sessions).where(eq(sessions.userId, user.id));
    await tx.delete(accounts).where(eq(accounts.userId, user.id));
    // Personal tokens and the tokens of connected apps; service tokens have no person.
    await tx.delete(credentials).where(eq(credentials.userId, user.id));
    await tx.delete(oauthGrants).where(eq(oauthGrants.userId, user.id));
    await tx.delete(oauthRequests).where(eq(oauthRequests.userId, user.id));
    await tx.delete(sourceLinks).where(eq(sourceLinks.userId, user.id));
    await tx.delete(linkRequests).where(eq(linkRequests.userId, user.id));
    await tx.delete(groupMembers).where(eq(groupMembers.userId, user.id));
    await tx
      .update(users)
      .set({
        email: `removed-${user.id}@${REMOVED_EMAIL_DOMAIN}`,
        name: REMOVED_PERSON_NAME,
        emailVerified: false,
        image: null,
        title: null,
        isAdmin: false,
        adminSource: null,
        // Nothing can sign in as this row; blocked in case a sign-in raced the removal.
        blockedAt: sql`now()`,
        blockedBy: "app",
        signInGroups: [],
        directorySource: null,
        directoryId: null,
        lastSignInAt: null,
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, user.id));

    // The audit log shows the placeholder name as the actor (null would read as "System").
    await tx
      .update(auditLog)
      .set({ actorEmail: REMOVED_PERSON_NAME })
      .where(or(eq(auditLog.actorUserId, user.id), eq(auditLog.actorEmail, user.email)));
    await tx
      .update(auditLog)
      .set({ summary: sql`replace(${auditLog.summary}, ${user.email}, ${REMOVED_IN_SUMMARIES})` })
      .where(sql`strpos(${auditLog.summary}, ${user.email}) > 0`);
    await audit(tx, actor, {
      action: "person.removed",
      entityType: "user",
      entityId: user.id,
      summary: actor ? "Removed a person" : "The directory removed a person",
    });
  });
}
