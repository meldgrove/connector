# User guide

Connector brings together what your organization keeps in its Handbook,
Logbook, Library and CRM, for you and for your AI assistant. You see only
what you may see in each app.

## Searching

Type into the search box on the home page or under **Search**. Connector
asks every source you may use at once and shows:

- each result's source, type (page, decision, note, contact, …) and date;
- its level in the **source order**, which decides when sources disagree:
  purpose and rules first, then decisions in force, the knowledge base, the
  logbook's history, records, and the library;
- its status, e.g. a decision that is _in force_ or _superseded by LB-14_.

Open a result in its app, or **Preview** it here. Filter by source with the
chips above the results. When a source does not answer, the page says so.

## Context

**Context** shows everything on a topic, grouped by the source order, with
hints: a decision newer than a Handbook page on the same topic, or a
decision replaced by another. This is what your AI assistant gets when it
asks Connector for context.

## People

**People** finds colleagues by name, email address, job title or group.

## Connecting your AI

**Connect your AI** shows Connector's MCP address and the steps for Claude,
ChatGPT, Le Chat and other assistants. You approve the connection once.
Your assistant then works as you: it sees what you see, cites the source of
every claim, and can propose Handbook changes for you to review in
Handbook. Remove a connection under **Settings → Connected apps**.

Scripts and command-line agents can use a **personal token**
(**Settings → Personal tokens**).

## Linked accounts

Under **Settings → Linked accounts**, link your Handbook account. Connector
then reads Handbook as you (you see your drafts, if you edit a space) and
your assistant can propose changes in your name. Unlink any time.

## Your groups

**Settings** lists your groups. They decide which sources you may use; ask
an admin if a source is missing.

## Admins

- **Status**: what needs an admin (failing sources, tokens that expire or
  were revoked but are still sent, a stopped sync), every source's state,
  the directory, and how much agents and bots use Connector. Each app has
  a setup guide here: Handbook, Logbook, Library, CRM, Meldgrove IAM and
  the Support Agent ([Sources](sources.md#setup-guides-and-status)).
- **Sources**: connect Handbook, Logbook, Library and CRM, decide who may
  use them, check them ([Sources](sources.md)).
- **People**: admins, blocking, removal.
- **Directory**: the Keycloak sync, SCIM tokens for Meldgrove IAM, groups.
- **Service tokens**: bots such as the Support Agent.
- **Activity**: what agents and bots asked. **Audit log**: admin changes.
- **Updates**: the installed version and the channel: **Stable**
  (releases, recommended) or **Preview** (every change before it is
  released). An update icon in the header shows a new version with a dot:
  click it for the changes and **Install now**. Connector restarts for a
  moment, and the page reloads when the new version runs. A warning
  triangle means an installation failed; the icon says why, and the
  version before keeps running. The server must run the updater
  ([Deployment](deployment.md#automatic-updates)).
