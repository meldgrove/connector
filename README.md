# Meldgrove Connector

The memory layer of the Meldgrove apps: one connection for AI agents and
bots to everything an organization keeps in its Handbook, Logbook, Library
and CRM. Connector asks each app when someone asks, checks what that person
may see before it returns anything, links every result to its source, and
orders results by which source wins when they disagree.

- **One MCP connection for every agent.** Claude, ChatGPT, Le Chat and any
  other MCP client connect once, with OAuth sign-in or a personal token, and
  reach all connected apps. `search` and `fetch` follow the shape ChatGPT
  needs for company knowledge and deep research.
- **Deep Meldgrove integrations.** Handbook pages (live, with the person's
  own Handbook account when linked), Logbook decisions, updates and
  learnings and Library notes (by signed webhooks), CRM contacts,
  organizations, deals, events and meetings (live, with an API key).
- **Source order.** Purpose and rules, decisions in force, knowledge base,
  logbook history, records, library: every result carries its level, and
  `get_context` groups a topic by it and points out decisions that are newer
  than a page or replaced by another.
- **Permissions before content.** Each source is open to everyone signed in
  or to some groups; each app's own rules apply on top (Library team notes,
  CRM sharing, Handbook drafts). Agents act as their person, never as
  admins. Bots read only sources opened to them.
- **Agents draft, people publish.** Agents propose Handbook changes as the
  person; editors review and merge them in Handbook.
- **Open standards.** OpenID Connect sign-in (Keycloak or any provider),
  the Keycloak Admin API for people and groups, SCIM 2.0 for identity
  systems such as Meldgrove IAM, OAuth 2.1 and MCP for agents, OAuth 2.1
  with dynamic client registration for linked accounts.
- **Oversight.** An activity log of what agents and bots asked and which
  sources answered, an audit log of admin changes, error reports to Sentry
  without personal data.
- **A knowledge source for bots.** The Meldgrove Support Agent (and other
  bots) search every source through one API.

Hono server, React web app, PostgreSQL, one Docker image.

## Documentation

- [User guide](docs/user-guide.md): searching, context, connecting your AI,
  linked accounts.
- [Sources](docs/sources.md): connecting Handbook, Logbook, Library and CRM;
  the Support Agent and IAM.
- [Agents and MCP](docs/agents.md): connecting Claude, ChatGPT, Le Chat and
  other agents; tools; bots.
- [Identity and access](docs/identity-and-access.md): sign-in, groups, the
  directory (Keycloak, SCIM), who may use which source.
- [Deployment](docs/deployment.md): Coolify or a Debian server, upgrades,
  automatic updates, backups, Sentry.
- [Configuration](docs/configuration.md): every environment variable.
- [Architecture](docs/architecture.md): how it works inside.
- [Contributing](CONTRIBUTING.md): development setup, checks, releases.

## Quick start (development)

```sh
docker compose -f compose.dev.yaml up -d   # PostgreSQL 18 and a Keycloak with test users
cp .env.example .env.local
npm ci
npm run dev
```

Open http://localhost:5173 and sign in as `ada@example.org` (password
`connector-dev`), an admin. Connect a source under **Administration →
Sources**.
