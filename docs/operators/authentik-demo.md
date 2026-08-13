# Authentik OIDC demo lane (rebuildable)

Audience: operators who want a click-through Superscriber + Authentik OIDC
demo on a workstation. This is a demo fixture, not a production recipe: it
uses loopback HTTP, disposable credentials, and shares nothing with any
production identity domain. Production Authentik deployment stays governed by
`authentik-oidc.md`.

Verified once on macOS + OrbStack with Superscriber at origin/main
(Aug 2026), Authentik 2025.10.3, Postgres 16, Redis 7.2.

## Ports and isolation

Assign every service an explicit port and check it is free first. The demo
was designed to run beside another local Superscriber lane without touching
it: separate instance root, DB, logs, and ports; the transcription model
cache may be shared read-only (`SUPERSCRIBER_TRANSCRIBE_ALLOW_RUNTIME_DOWNLOAD=0`
and `SUPERSCRIBER_TRANSCRIBE_OFFLINE=1` keep it that way).

| Service | Port |
|---|---|
| Existing lane (do not touch) | 3275 |
| Superscriber demo instance | 3276 |
| Authentik HTTP | 9000 |
| Authentik HTTPS (unused) | 9443 |

Use OrbStack (or any Docker engine); never a second engine's daemon against
the same context. Demo root below is `~/.treehouse/runtime/superscriber-oidc-demo/`
- any durable non-/tmp directory works; never put instance state under /tmp.

## Step 1 - Authentik stack

`authentik/.env` (mode 600; all values generated locally, never committed):

```
AUTHENTIK_SECRET_KEY=<openssl rand -base64 60>
AUTHENTIK_TAG=2025.10.3
POSTGRES_TAG=16-alpine
REDIS_TAG=7.2-alpine
AUTHENTIK_POSTGRES_USER=authentik
AUTHENTIK_POSTGRES_PASSWORD=<openssl rand -hex 24>
AUTHENTIK_BOOTSTRAP_PASSWORD=<generated: console admin password>
AUTHENTIK_BOOTSTRAP_TOKEN=<openssl rand -hex 32: API automation token>
AUTHENTIK_BOOTSTRAP_EMAIL=<console admin email>
COMPOSE_PROJECT_NAME=superscriber-oidc-demo
```

`authentik/docker-compose.yml`: the standard Authentik compose shape with
four services - postgresql (healthcheck `pg_isready`), redis (healthcheck
`redis-cli ping`), server (publishes 9000 and 9443, `command: server`), and
worker (`command: worker`, `user: root`, mounts the docker socket). Named
volumes live under `./data/` next to the compose file. Server and worker use
`depends_on: condition: service_healthy` and read
`AUTHENTIK_POSTGRESQL__*` / `AUTHENTIK_REDIS__HOST` from the env file.

```bash
cd authentik && docker compose up -d
# wait for: curl -fsS http://localhost:9000/api/v3/root/config/
```

## Step 2 - Provision via the Authentik admin API

No hand-clicking. All calls are `curl -H "Authorization: Bearer
$AUTHENTIK_BOOTSTRAP_TOKEN" http://localhost:9000/api/v3/...` (the demo
shipped these as an idempotent `provision.sh` next to the compose file):

1. Resolve flow pks: `GET /flows/instances/?designation=authorization` (pick
   the explicit-consent slug) and `?designation=invalidation`.
2. Resolve a signing key: `GET /crypto/certificatekeypairs/?has_key=true`
   (first entry; the bundled self-signed certificate is fine for a demo).
3. Create four groups `superscriber-{uploader,reviewer,approver,admin}` via
   `POST /core/groups/`; record the pks (UUIDs) - they are the role map.
4. Create scope property mapping `superscriber_roles`
   (`POST /propertymappings/provider/scope/`) whose expression returns only
   **direct** group memberships:

   ```python
   return {"superscriber_role_group_ids": [str(g.pk) for g in request.user.ak_groups.all()]}
   ```

5. Resolve the managed openid/profile scope mappings
   (`GET /propertymappings/all/?search=openid|profile`, match on the
   `goauthentik.io/providers/oauth2/scope-*` managed names).
6. Create the OIDC provider (`POST /providers/oauth2/`):
   `client_type: confidential`, `client_id: superscriber` + a generated
   `client_secret`, `sub_mode: user_username` (deterministic `sub` = username),
   `include_claims_in_id_token: true`, the signing key from step 2, the three
   property mappings, and exactly one strict redirect URI
   `{"matching_mode": "strict", "url": "http://localhost:3276/api/auth/callback/authentik"}`.
7. Create the application (`POST /core/applications/`) with slug
   `superscriber` and the provider pk. The issuer is then exactly
   `http://localhost:9000/application/o/superscriber/` (trailing slash).
8. Create demo users (`POST /core/users/` + `POST
   /core/users/{pk}/set_password/`): one admin persona, one non-admin persona
   (e.g. reviewer). Add each to exactly its one role group
   (`POST /core/groups/{pk}/add_user/`) and remove it from the others.

## Step 3 - Superscriber instance on 3276

```
superscriber/
  repo/      built standalone app (rsync source + npm run build; then copy
             .next/static into .next/standalone/.next/static and public/ into
             .next/standalone/public - plain server.js does not serve them otherwise)
  oidc/role-map.json            the four group UUIDs from step 2, issuer as above
  oidc/client-secret            the provider client secret (mode 600, file only)
  oidc/management-networks.json {"managementNetworks":["127.0.0.0/8"],"trustedProxies":[]}
  data/ media/ uploads/ logs/ pids/ venv/ (worker/requirements.txt installed)
```

`app.env` additions over the standard local profile (see
`authentik-oidc.md` for the full config surface):

```
SUPERSCRIBER_AUTH_MODE=authentik-primary   # or dual, to keep local sign-in too
NEXTAUTH_URL=http://localhost:3276
SUPERSCRIBER_APP_BASE_URL=http://localhost:3276
SUPERSCRIBER_OIDC_ISSUER=http://localhost:9000/application/o/superscriber/
SUPERSCRIBER_OIDC_CLIENT_ID=superscriber
SUPERSCRIBER_OIDC_CLIENT_SECRET_FILE=<abs path>
SUPERSCRIBER_OIDC_ROLE_MAP_FILE=<abs path>
SUPERSCRIBER_MANAGEMENT_NETWORKS_FILE=<abs path>   # required in authentik-primary
```

Initialize the DB, seed the OIDC-only users (password_hash NULL, roles
matching their Authentik groups), then apply the governed identity links
with `expectedRole` set (`sub` is the username because of `sub_mode`):

```bash
SUPERSCRIBER_DB_PATH=... npx tsx scripts/ensure-db.ts
SUPERSCRIBER_DB_PATH=... npm run identity:import -- --file mapping.json --dry-run
SUPERSCRIBER_DB_PATH=... npm run identity:import -- --file mapping.json --apply --linked-by <admin-user-id>
```

In `authentik-primary` mode, designate a break-glass custodian or the admin
surface keeps its unenrolled warning:
`npm run break-glass:designate -- --user <admin-user-id> --reason "..."`.

Start app and worker under any supervisor; the demo used a small `run.sh`
crash-restart loop writing `logs/app.log` and `logs/worker.log`. Health:
`curl -fsS http://localhost:3276/api/health`.

## Step 4 - Verify in a real browser

1. Open http://localhost:3276 - **Sign in with institutional account** -
   Authentik login for the admin persona - consent - lands on `/workspace`
   with `GET /api/auth/session` showing `"role":"admin","authSource":"authentik"`.
2. `GET /api/admin/auth-health` (admin only): `mode`, session counts by
   source, OIDC admission counters, identity link counts.
3. Sign out both layers (Superscriber sign-out, then the Authentik
   invalidation flow `/if/flow/default-invalidation-flow/`), sign in as the
   non-admin persona: the Administration nav is gone and `/administration`
   is refused with the generic denial.
4. Revocation: `SUPERSCRIBER_DB_PATH=... npm run auth:revoke -- --user <id>
   --reason "..."`; the next page load lands on sign-in with the
   session-expired notice, and the ledger records `auth.session.revoked`
   in `security_events`.

## Teardown

```bash
# superscriber demo instance (keep or delete superscriber/ data after)
bash superscriber/stop.sh
# authentik stack; add -v to also drop the postgres/redis volumes
cd authentik && docker compose down
```

Read-back check before and after any demo work in a shared workspace:
`curl -fsS http://localhost:3275/api/health` must stay green and untouched.
