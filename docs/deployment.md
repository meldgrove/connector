# Deployment

For the person who runs Meldgrove Connector on a server: requirements, the
setup on [Coolify](#coolify) or on a [Debian server](#debian),
[settings from the command line](#settings-from-the-command-line), upgrades,
automatic updates, backups, Sentry and troubleshooting. Every environment
variable is described in [Configuration](configuration.md).

## Requirements

- **Coolify, or a server with Debian 12 or later** (or a similar system with
  systemd and apt, such as Ubuntu 24.04), with Docker Engine and its Compose
  plugin.
- **PostgreSQL 16 or later.**
- **A reverse proxy that terminates HTTPS**: Coolify's own, or Caddy on
  Debian.
- **An OpenID Connect provider** for sign-in (Keycloak, Microsoft Entra ID,
  Google, Authentik, …), see [Identity and access](identity-and-access.md).
- **The Meldgrove apps to connect** (Handbook, Logbook, Library, CRM),
  reachable from Connector's server; Logbook and Library must reach
  Connector's `/hooks/` addresses ([Sources](sources.md)).

## What runs

Each [release](https://github.com/meldgrove/connector/releases) publishes the
image `ghcr.io/meldgrove/connector` for linux/amd64 and linux/arm64, tagged
with its version (`0.1.0`), its series (`0.1`; from 1.0.0 the major version,
`1`) and `latest`. A release that needs manual steps starts a new series, so
the releases within a series install without anyone acting. Every change on
`main` whose checks pass is published as a preview, tagged `0.1.1-preview.3`
(three changes after 0.1.0) and `preview`.

| File                    | Contains                                                                           |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `Dockerfile`            | The image. Its command (`all`, `web`, `worker`, `migrate`, `cli`) picks the role.  |
| `compose.yaml`          | A one-off `migrate`, the web app (`web`), the `worker` and the optional `updater`. |
| `compose.postgres.yaml` | Adds a PostgreSQL 18 container, for servers without a database of their own.       |

The image runs as an unprivileged user (uid 1000). `web` listens on port
3000, published on `127.0.0.1:3000` for a reverse proxy on the same machine;
`CONNECTOR_PORT` changes the host port. Everything Connector keeps is in
PostgreSQL; the image needs no volume. The branch `stable` is at the newest
release; `main` has changes that are not released yet.

The reverse proxy must pass `/mcp`, `/oauth/*`, `/.well-known/*`,
`/scim/v2/*` and `/hooks/*` to the app unchanged (agents, identity systems
and webhooks connect there), and must not buffer or cache `/mcp`:
`/mcp` streams its answers as events (nginx: `proxy_buffering off;` for
`/mcp`). The app compresses its responses itself (scripts and styles with
brotli or gzip; JSON and HTML with gzip; never `/mcp`), so the proxy needs
no compression of its own. A proxy that
compresses anyway must leave `/mcp` alone.

### One container

Platforms that run a single image (no Compose) can use the command `all`
with `RUN_MIGRATIONS=true`: the web app and the worker then share one
process.

## Coolify

1. **Database:** create a PostgreSQL resource (16 or later) and copy its
   internal URL.
2. **Application:** create a Docker Compose resource from the public
   repository `https://github.com/meldgrove/connector`, branch `stable`,
   Docker Compose location `/compose.yaml`. Under Advanced, set Auto deploy
   to "Manual deployments only", so that only releases deploy, and turn on
   "Connect To Predefined Network", so that the app reaches the database.
3. **Domain:** assign the domain, such as `https://connector.example.org`,
   to `web`, port 3000.
4. **Register the app at your provider** with the redirect URL
   `<APP_URL>/api/auth/callback/oidc` ([Identity and access](identity-and-access.md)).
5. **Environment variables** of the resource: `CONNECTOR_VERSION` (a series
   such as `0.1`, see [Automatic updates](#automatic-updates)), `APP_URL`
   (the domain), `DATABASE_URL` (the database's internal URL), a new
   `AUTH_SECRET` and `ENCRYPTION_KEY` (each `openssl rand -base64 32`), an
   `UPDATER_TOKEN` (`openssl rand -hex 32`), the `OIDC_*` values, your
   address in `ADMIN_EMAILS`, `DIRECTORY` (`keycloak` with a Keycloak
   service account), and `SEARCH_LANGUAGES` for the languages of your
   Logbook and Library.
6. **Deploy**, open `APP_URL`, sign in, and connect the first source with
   its guide under **Administration → Status** ([Sources](sources.md)), or
   [without a browser](#settings-from-the-command-line).
7. **Automatic updates:** set them up [on Coolify](#on-coolify).
8. **Backups:** for [Meldgrove Backups](#backups), add `BACKUP_URL` and
   `BACKUP_TOKEN` (from the app's source in Backups) to the environment
   variables and redeploy.

## Debian

On a server with Debian 12 or later, or a similar system such as Ubuntu,
run the commands as root (`sudo -i`).

1. **Docker:** install Docker Engine and the Compose plugin from Docker's
   apt repository ([Debian](https://docs.docker.com/engine/install/debian/),
   [Ubuntu](https://docs.docker.com/engine/install/ubuntu/)), and Git:
   `apt install git`.
2. **Get the files** at the newest release:

   ```sh
   git clone --branch stable https://github.com/meldgrove/connector.git /srv/connector
   cd /srv/connector
   ```

3. **Register the app at your provider** with the redirect URL
   `<APP_URL>/api/auth/callback/oidc` ([Identity and access](identity-and-access.md)).
4. **Create `.env`** from `.env.example` (`cp .env.example .env`,
   `chmod 600 .env`) and set production values: `CONNECTOR_VERSION` (a
   series such as `0.1`), `APP_URL`, `DATABASE_URL`, a new `AUTH_SECRET`
   and `ENCRYPTION_KEY` (each `openssl rand -base64 32`), an `UPDATER_TOKEN`
   (`openssl rand -hex 32`), the `OIDC_*` values, your address in
   `ADMIN_EMAILS`, `DIRECTORY`, and `SEARCH_LANGUAGES` for the languages of
   your Logbook and Library. Remove
   `NODE_ENV=development`, `RUN_MIGRATIONS` and
   `OAUTH_ALLOW_PRIVATE_CLIENT_URLS`. With an `https` `APP_URL`, the app
   does not start with the example `AUTH_SECRET` or `ENCRYPTION_KEY`, or with
   `OAUTH_ALLOW_PRIVATE_CLIENT_URLS`. Without a database of your own, add
   `COMPOSE_FILE=compose.yaml:compose.postgres.yaml`, a `POSTGRES_PASSWORD`
   (`openssl rand -hex 32`) and
   `DATABASE_URL=postgres://connector:<POSTGRES_PASSWORD>@postgres:5432/connector`.
5. **Start:** `docker compose up -d --pull always`.
6. **HTTPS:** point the domain's DNS at the server, install Caddy
   (`apt install caddy`), and replace `/etc/caddy/Caddyfile` with:

   ```text
   connector.example.org {
   	reverse_proxy 127.0.0.1:3000
   }
   ```

   Then `systemctl reload caddy`. Caddy gets the certificate itself, and it
   passes the event streams of `/mcp` through without buffering. With
   `CONNECTOR_PORT` set, use that port instead of 3000.

7. Open `APP_URL`, sign in, and connect the first source with its guide
   under **Administration → Status** ([Sources](sources.md)), or
   [without a browser](#settings-from-the-command-line).
8. **Automatic updates:** set them up [on Debian](#on-debian).

## Settings from the command line

`cli` is Connector's operator command. It sets what admins set under
**Administration**, the sources and the tokens, with the same checks, and
the audit log names the `operator` and the command. On the server, in
`/srv/connector`:

```sh
docker compose run --rm -T migrate cli settings list
```

On Coolify, run `cli settings list` in a terminal of the `web` container
(or anywhere with `docker compose exec web cli settings list`).

| Command                                        | What it does                                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli settings list [--json]`                   | Every source with its ID: set, or incomplete (its secret is missing or unreadable), with hints; never a secret                                    |
| `cli settings show sources [--id <id>]`        | Every source, or one, as JSON, as the admin page reads it                                                                                         |
| `cli settings show sources --id <id> --spaces` | The spaces of a Handbook, for `ruleSpaces`                                                                                                        |
| `cli settings apply sources [--id <id>]`       | Reads the JSON body of the admin page from stdin and saves it; without `--id`, connects a new source and prints its ID. Prints what `show` prints |
| `cli settings test sources --id <id>`          | What the page's **Check** button does                                                                                                             |
| `cli settings remove sources --id <id>`        | Removes the source and everything Connector kept of it                                                                                            |
| `cli tokens create <kind> …`                   | Issues a token and prints it once, alone on stdout ([below](#tokens))                                                                             |
| `cli tokens list [--json]`                     | The service and SCIM tokens: name, first characters, dates                                                                                        |
| `cli tokens revoke <id>`                       | Ends a service or SCIM token for good                                                                                                             |
| `cli help`                                     | The commands                                                                                                                                      |

Secrets go only on stdin, never in an argument: arguments show in `ps` and
the shell history. Pasted into a terminal, the body is not shown; end it
with Ctrl-D. Exit codes: 0 done, 1 refused (the page's message on stderr),
2 a wrong command or a body that is not JSON.

An AI agent with access to the server sets a secret like this: the secret
arrives as a file, the agent pipes the body into `cli settings apply`, runs
`cli settings test`, and deletes the file.

```sh
jq -n --rawfile token handbook-token.txt \
  '{kind: "handbook", slug: "handbook", name: "Handbook",
    config: {baseUrl: "https://handbook.example.org"},
    secret: {serviceToken: ($token | rtrimstr("\n"))}}' |
  docker compose run --rm -T migrate cli settings apply sources
docker compose run --rm -T migrate cli settings test sources --id <id>
rm handbook-token.txt
```

### sources

A new source names its `kind`, a `slug` (it starts item IDs and the webhook
address, and cannot change later), a `name` and its `config`; the rest is
optional:

```json
{
  "kind": "handbook",
  "slug": "handbook",
  "name": "Handbook",
  "description": "Policies and guides",
  "enabled": true,
  "accessGroups": ["/staff"],
  "serviceAccess": false,
  "config": {
    "baseUrl": "https://handbook.example.org",
    "ruleSpaces": ["policies"],
    "allowLinking": true
  },
  "secret": { "serviceToken": "<Handbook's service token>" }
}
```

```json
{
  "kind": "crm",
  "slug": "crm",
  "name": "CRM",
  "accessGroups": ["/staff/fundraising"],
  "config": { "baseUrl": "https://crm.example.org", "types": ["contact", "organization", "deal"] },
  "secret": { "apiKey": "<the CRM's API key>" }
}
```

```json
{
  "kind": "logbook",
  "slug": "logbook",
  "name": "Logbook",
  "config": { "baseUrl": "https://logbook.example.org" }
}
```

```json
{
  "kind": "library",
  "slug": "library",
  "name": "Library",
  "config": { "baseUrl": "https://library.example.org", "teamGroupPrefix": "/teams" }
}
```

With `--id`, a body changes only the fields it names; `config` is replaced
as a whole, and the kind and the slug stay:
`{ "accessGroups": ["/staff"], "secret": { "apiKey": "<a new key>" } }`. A
secret that is left out or empty stays as saved. A Handbook or CRM that
moves to another host loses its secret and its linked accounts, as on the
page: send the new secret along, or apply it next.

### Tokens

| Kind             | Options                                           | For                                                                                                  |
| ---------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `service`        | `--name <name> [--expires-in-days <days>\|never]` | Bots such as the Support Agent; stderr names the search URL                                          |
| `scim`           | `--name <name> [--expires-in-days <days>\|never]` | Identity systems such as Meldgrove IAM; stderr names the SCIM base URL                               |
| `webhook-secret` | `--source <id>`                                   | Logbook and Library: a new webhook secret that replaces the one before; stderr names the webhook URL |

Run these in the running container, with `docker compose exec`: the token
is alone on stdout, so `> file` keeps only the token, and Docker does not log
it (it logs what `docker compose run` prints). On Coolify, run
`cli tokens create …` in a terminal of the `web` container.

```sh
(umask 077; docker compose exec -T web cli tokens create service --name "Support Agent" > token.txt)
```

Without `--expires-in-days`, a token stops working after 90 days.

Connect a Logbook (or a Library) without a browser, in Connector's folder
and then in Logbook's:

```sh
docker compose run --rm -T migrate cli settings apply sources < logbook.json   # prints the ID
(umask 077; docker compose exec -T web cli tokens create webhook-secret --source <id> > secret.txt)

cd /srv/logbook
jq -n --rawfile secret /srv/connector/secret.txt \
  '{url: "https://connector.example.org/hooks/logbook", secret: ($secret | rtrimstr("\n"))}' |
  docker compose run --rm -T migrate cli settings apply webhook
rm /srv/connector/secret.txt
```

Logbook and Library up to 0.3.2 have no `cli settings apply webhook`
([Sources](sources.md#meldgrove-logbook)).

## Health checks

- `GET /-/livez`: the web process runs.
- `GET /-/readyz`: it reaches the database.
- The worker touches `/tmp/worker-heartbeat` every few seconds;
  `compose.yaml` checks its age. It stops while a job runs far longer than
  it should (the hourly cleanup 30 minutes, rebuilding the search index 4
  hours), so the check fails and the platform can restart the worker.
- Database connections give up after 10 seconds of waiting for a
  connection, end statements after `DATABASE_STATEMENT_TIMEOUT_SECONDS`
  and transactions left idle for a minute, and probe idle connections for
  lost ones.

Docker Compose marks a container whose check fails as unhealthy, but does
not restart it. Set up an uptime check from outside the server (your
monitoring or an uptime service) on `<APP_URL>/-/readyz`, so that someone
hears when the app is down.

## Upgrades

1. Read the release notes. Releases with **Upgrade steps needed** start a
   new series and list what to do.
2. Take the steps, then move to the new series:
   - **Coolify:** change `CONNECTOR_VERSION` in the resource's environment
     variables and redeploy. Coolify reads `compose.yaml` from `stable`,
     which is at the newest release.
   - **Debian:** in `/srv/connector`, run `git pull` (the newest release's
     `compose.yaml`), change `CONNECTOR_VERSION` in `.env`, and run
     `docker compose up -d --pull always`. With
     [automatic updates](#on-debian), run `git pull`, then install it with
     the update button (**Install anyway…**) or
     `docker compose exec updater updater install <version>` instead: it
     goes back to the version before if the new one does not become
     healthy.

The `migrate` service applies database migrations before `web` and `worker`
start.

## Automatic updates

The `updater` service ([meldgrove/updater](https://github.com/meldgrove/updater))
keeps Connector current. On Debian, it follows one of two channels:

- **Stable** (default): releases. A release in the running series installs
  automatically once it has been out for three days (`UPDATE_COOLDOWN`: `0`
  installs within the hour, `7d` waits a week). A release with upgrade steps
  starts a new series: the updater reports it, but never installs it on its
  own.
- **Preview**: every change on `main` as soon as its checks pass, before it
  is released, and every release. Previews install within the hour. New
  features first, and now and then a new bug; previews have no release
  notes.

With `UPDATE_WINDOW` (such as `02:00-05:00`, in the time zone `TZ`),
automatic installs happen only then. Switching from Preview back to Stable
installs nothing and never goes back to an older version.

**The update button:** admins see an update icon in the header. It checks on
click, shows an available update with its changes, installs it on request
(**Install now**), shows the progress, reloads the page when the new version
runs, and says why an installation failed. With automatic updates off on
the server, it still shows new releases, but nothing installs from the app.
Admins choose the channel under **Administration → Updates**. The app
reaches the updater at `UPDATER_URL` (`http://updater:8080` in
`compose.yaml`). On the server, `docker compose exec updater updater status`
shows the same, and `docker compose logs updater` says what the updater
did. With `UPDATER_TOKEN` set, the app sends it and the updater refuses
requests without it. Never publish the updater's port. Without the token,
everything works as before; see
[Protect the update service](#protect-the-update-service).

Set up [backups](#backups) first: migrations run without anyone watching.

### On Coolify

On Coolify, the image tag in `CONNECTOR_VERSION` decides what installs: a
series such as `0.1` gets its releases, `latest` every release (also those
with upgrade steps), `preview` every preview (the unstable channel). Admins
cannot switch the channel in the app.

1. Under Settings > Advanced, turn on API Access if it is off.
2. Under Keys & Tokens > API Tokens, create a token with only the `deploy`
   permission; clear `read`. Coolify shows it only once.
3. In the Connector resource, select Webhooks and copy Deploy Webhook.
4. In the resource's environment variables, set `UPDATE_DEPLOY_HOOK_URL` to
   the webhook and `UPDATE_DEPLOY_HOOK_TOKEN` to the token, then redeploy.

The `updater` log then names the tag it watches.

### On Debian

As root in `/srv/connector`, with `UPDATE_DEPLOY_HOOK_URL` empty:

```sh
docker compose up -d --pull always
docker compose run --rm -T --pull always updater host-setup > updater-setup.sh
sh updater-setup.sh
```

The first command starts the version in `CONNECTOR_VERSION`, which the
updater takes as installed. The second writes the setup script from the
updater's image; read it before you run it. The script installs a systemd
unit that waits for the updater's requests. For each installation, it writes
the exact version into `CONNECTOR_VERSION` in `.env`, pulls the image, runs
`docker compose up -d --wait` (migrations first), and goes back to the
version before when the app does not become healthy. It installs images,
not files: when a release changes `compose.yaml`, its upgrade steps say so.
`journalctl -u meldgrove-updater-connector.service` shows each installation;
`sh updater-setup.sh remove` switches it off.

```sh
docker compose exec updater updater channel preview   # or stable
docker compose exec updater updater install 0.2.0     # now, also a new series
```

The update button and **Administration → Updates** do the same in the app.
A version that failed to install is not tried again automatically; a newer
one is.

### Protect the update service

Recommended for installations without `UPDATER_TOKEN`. Without it, the
updater takes requests from anything on the app's Docker network, and
**Administration → Updates** warns about it (updater 0.2.4 and later).
Nothing else changes: the app and its updates work as before. The app and
the updater both read the token from `UPDATER_TOKEN`.

1. Make a token: `openssl rand -hex 32`.
2. Set it and restart:
   - **Coolify:** add `UPDATER_TOKEN` to the resource's environment
     variables and redeploy.
   - **Debian:** in `/srv/connector`, add `UPDATER_TOKEN=<token>` to `.env`,
     run `git pull` (the newest `compose.yaml` passes the token to the
     updater), then `docker compose up -d`.
3. Open **Administration → Updates**: it shows the update status. A
   message that names `UPDATER_TOKEN` means the app and the updater do not
   have the same token yet. On Coolify, check the resource's environment
   variable and redeploy; on Debian, check `.env` and run
   `docker compose up -d` again.

## Backups

### With Meldgrove Backups

The `backup-agent` service in `compose.yaml` sends the database to
[Meldgrove Backups](https://github.com/meldgrove/backups) when Backups asks.
While `BACKUP_URL` is empty, it idles.

1. In Backups, add a source of the kind **Meldgrove app**, and put the two
   lines it shows (`BACKUP_URL`, `BACKUP_TOKEN`) into `.env`.
2. Run `docker compose up -d`, then check the agent:
   `docker compose exec backup-agent backup-agent check`.
3. Let the backup end before the update window (`UPDATE_WINDOW`): automatic
   updates run migrations without anyone present.

Keep `ENCRYPTION_KEY` apart from the backups: a restore needs it, the backups
do not hold it, and Backups shows the name on the source page.

With [automatic updates](#automatic-updates), run the updater's host setup
again once the app's folder has updater 0.2.2 or later (`git pull`): its
deploy script then pulls the agent's image with each update. Without it:
`docker compose pull backup-agent && docker compose up -d`.

To restore, follow the
[agent's guide](https://github.com/meldgrove/backup-agent#restore).

### By hand

Back up together:

- the PostgreSQL database (`pg_dump`, or the `postgres` volume): sources
  and their encrypted credentials, the index of Logbook and Library,
  people, groups, linked accounts, tokens (as hashes), the logs;
- `ENCRYPTION_KEY` (keep it apart from the database backup): without it the
  stored credentials cannot be read, and admins enter them again.

The index of webhook sources can also be rebuilt: Logbook and Library
resend every item in their nightly run once the receiver lacks it. Test a
restore once: restore the database on another machine, start the app with
the same `ENCRYPTION_KEY`, and **Check** each source.

## Error reports and performance data (Sentry)

With `SENTRY_DSN` set, the server and the web app send error reports to
Sentry (or a compatible service). The release is `connector@<version>`, so
reports link to the code: release builds upload their source maps to
Sentry. The web app's source maps are not in the image, so browsers cannot
download them.

- **Errors:** crashes, failed requests and errors the server logs, from the
  server and from browsers.
- **Performance:** set `SENTRY_TRACES_SAMPLE_RATE` (e.g. `0.2`) to trace
  that share of requests and page loads.
- **Logs:** warnings and errors of the server.
- **Cron monitors:** the worker's cleanup job checks in as `connector-prune`,
  the Keycloak directory sync as `connector-directory-sync`.

Reports never contain item texts, titles, search words, names, email
addresses, tokens, request data or variables; error messages are left out because database
errors can quote values. There are no session replays.

## Logs

Every process logs JSON lines to standard output (`docker compose logs
web`). Logs carry identifiers (source, link, request), never item texts,
search words or email addresses. Sign-ins that were refused log the reason (`sign-in
refused: email domain not allowed`, `… not in ACCESS_GROUPS`, `… blocked`,
`… email address not verified by the provider`).

## Hardening

- Serve the app over HTTPS only.
- Use your organization's own identity provider, where people cannot choose
  their email address themselves. With a public provider (e.g. Google),
  set `ALLOWED_EMAIL_DOMAINS` or `ACCESS_GROUPS`; without either, the
  server logs a warning at start.
- Keep `OIDC_REQUIRE_EMAIL_VERIFIED` on unless your provider does not send
  `email_verified` ([Identity and access](identity-and-access.md#verified-email-addresses)).
- When someone leaves, block them in the app for immediate effect
  ([Identity and access](identity-and-access.md#when-someone-leaves)).
- Keep `ADMIN_EMAILS` to one or two people.
- Open each source only to the groups that may use the app itself, and to
  service tokens only where everyone in the bot's audience may read it
  ([Sources](sources.md#who-may-use-a-source)).
- Give Connector the narrowest credentials at each app: a Handbook service
  token, a CRM API key with the viewer role and read scopes only.
- Agents only propose Handbook changes; editors decide. Read the diff
  before merging, also when an agent made it: content can contain
  instructions meant to mislead agents.
- Keep `ENCRYPTION_KEY` secret and out of the database backup.
