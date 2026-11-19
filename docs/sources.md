# Sources

A source is one connected app. Admins connect sources under
**Administration → Sources**; each has a kind, an address, credentials,
and the people who may use it.

| Kind               | Holds                                                      | How Connector reads it                                                |
| ------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| Meldgrove Handbook | Policies, guides, playbooks                                | Live, through its API (service token, or the person's linked account) |
| Meldgrove Logbook  | Decisions, updates, learnings                              | Its webhook; Connector keeps a search index                           |
| Meldgrove Library  | Studies, reports, articles with source notes               | Its webhook; Connector keeps a search index                           |
| Meldgrove CRM      | Contacts, organizations, deals, events, meetings, segments | Live, through its API (API key)                                       |

Live sources answer at every request, so nothing is copied and nothing
gets stale. Webhook sources send each published item and each change;
Connector stores the item as sent, replaces it on every change, deletes it
when the app removes it, and deletes everything of a source when the source
is removed.

Items have IDs of the form `<source slug>:<type>:<id in the app>`, e.g.
`logbook:decision:0196…`. Every item links back to its page in the app.

## Who may use a source

- **Everyone signed in**, or only members of the groups listed under
  _Access groups_ (Keycloak paths count their subgroups: `/staff` admits
  `/staff/it`). Groups come from the sign-in, the Keycloak directory and
  SCIM ([Identity and access](identity-and-access.md)).
- **Service tokens** (bots such as the Support Agent) read a source only
  when _Service tokens may read_ is on, and then only content meant for
  everyone who may use it.
- Each app's own rules apply on top; see each kind below.
- Admins see sources in the admin pages, but search them only when they
  are in the access groups themselves.

Make the access groups match who may use the app itself. A service token or
API key sees more than a single person might; Connector shows its results
only to the people the source is open to.

## Source order

When sources disagree, the higher level wins. Every result carries its
level; agents get the order in the MCP instructions.

1. **Purpose and rules**: Handbook pages in the spaces listed as _rule
   spaces_.
2. **Decisions in force**: Logbook decisions that no newer decision
   replaced; the newest wins.
3. **Knowledge base**: other Handbook pages.
4. **Logbook history**: updates, learnings, and decisions that are no longer
   in force.
5. **Records**: CRM records.
6. **Library**: notes about outside sources.

Search merges each source's best results first and lets the higher level
win within a round. `get_context` groups a topic by level and adds hints:
a decision newer than a page on the same topic, and decisions replaced by
another.

## Meldgrove Handbook

1. In Handbook, create a service token under **Administration → Service
   tokens** (it reads every page that is not a draft).
2. In Connector, connect a source of the kind Handbook with Handbook's
   public address (its `APP_URL`; linked accounts need it) and the token. List the spaces that hold the purpose and the
   rules (e.g. `purpose,policies`) as _rule spaces_.
3. Set _Access groups_ to the groups that may sign in to Handbook
   (Handbook's `ACCESS_GROUPS`), or leave it empty when everyone may.
4. **Check** shows the number of spaces Connector can read.

### Linked accounts

With _People may link their Handbook account_ on (the default), people
link their account under **Settings → Linked accounts**. Connector then
reads Handbook as that person (Handbook shows editors their drafts, as in
the browser) and agents can propose changes as that person
(`propose_handbook_change`): Connector starts a change set in the page's
space, makes the change, and submits it for review. Editors merge it in
Handbook; nothing goes live from Connector.

Linking uses Handbook's OAuth server the way MCP clients do: protected
resource metadata, authorization server metadata, dynamic client
registration (Connector registers itself once, as "Meldgrove Connector",
or `<APP_NAME> (Meldgrove Connector)` with another `APP_NAME`),
authorization code with PKCE and the
resource indicator. The redirect address is
`<APP_URL>/api/v1/links/callback`; Handbook accepts it when Connector runs
on https (or on localhost). Handbook's sign-in server must be on the
source's address; Connector refuses others, because its client secret and
the tokens go there. Changing a source's address to another host removes
its stored credentials and the linked accounts. Tokens are stored encrypted; Connector
refreshes them, and removes the link when Handbook ends it (the person
links again). Unlinking revokes the tokens at Handbook.

## Meldgrove Logbook

1. In Connector, connect a source of the kind Logbook with Logbook's
   address (for display), then **Generate webhook secret** and copy it.
2. In Logbook, set `WEBHOOK_URL` to the webhook address Connector shows
   (`<APP_URL>/hooks/<slug>`) and `WEBHOOK_SECRET` to the secret, and
   restart it.
3. Logbook sends changes within a minute; its first nightly run (02:30)
   sends every entry. The source's status shows the last delivery.

Logbook sends published updates, learnings and logged decisions, and
decided or rejected proposals; never drafts or open proposals. Everyone
with access to Logbook reads every entry, so Connector shows them to
everyone the source is open to: set _Access groups_ to Logbook's access
group. Decisions carry _in force_, _superseded by LB-…_ or _rejected_.

## Meldgrove Library

1. In Connector, connect a source of the kind Library, generate its webhook
   secret, and set Library's `WEBHOOK_URL` and `WEBHOOK_SECRET` as for
   Logbook. Library resends every note in its first nightly run.
2. Notes for everyone are shown to everyone the source is open to. **Team
   notes** are shown only to the team: to members of the Keycloak group the
   note names (Library with `DIRECTORY=keycloak`, Connector with
   `DIRECTORY=keycloak`), or to members of `<team group prefix>/<team
name>` when a _team group prefix_ is set (e.g. `/teams` for
   `/teams/Programs`). Without either, nobody sees team notes in Connector.

Library removes a note from Connector when it is unpublished, made private
or deleted.

## Meldgrove CRM

1. In the CRM, an admin creates an API key under **Administration → API
   keys**: role viewer, the `:read` scopes of the record types to search
   (and `activities:read` for the timeline). A key sees the records shared
   with it or with the whole organization, plus its own.
2. Share with the key what everyone who may use the source may see, and
   set _Access groups_ accordingly (e.g. the fundraising team).
3. In Connector, connect a source of the kind CRM with the CRM's address,
   the key, and the record types to search.

Connector does not use CRM webhooks: their payloads skip the CRM's sharing
rules.

## Meldgrove Support Agent (a bot that reads)

The Support Agent answers questions in Slack from knowledge sources. One
Connector service token gives it every source opened to service tokens:

1. In Connector, open the sources the bot may read to service tokens, and
   create a service token under **Administration → Service tokens**.
2. In the Support Agent, add a knowledge source of the kind _Search API_:
   - URL: `<APP_URL>/api/v1/knowledge/search`
   - Authentication: bearer, the service token
   - Body template and paths: keep the defaults
     (`{"query": "{{query}}", "limit": "{{limit}}"}`; results `results`,
     title `title`, URL `url`, text `text`, section `section`): Connector
     answers in the Support Agent's standard contract.

Anything the bot gets can reach everyone in its channels, so open only
sources meant for all of them.

## Meldgrove IAM (people and groups)

IAM provisions people and fills groups through SCIM 2.0
([Identity and access](identity-and-access.md#scim-20)): add Connector in
IAM as a _SCIM 2.0_ app with Connector's SCIM address and a SCIM token.
IAM imports groups and does not create them, so create the groups IAM
should fill under **Administration → Directory** first.

## Apps without an interface yet

Meldgrove Helpdesk and Reimbursements have no interface for other servers
(no API tokens, webhooks or MCP server), so Connector cannot read them yet.
