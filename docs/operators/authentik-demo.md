# Authentik OIDC demo lane

This runbook rebuilds the staged click-through demo that ran on macOS with
OrbStack in August 2026: Superscriber on port 3276 in `authentik-primary`
mode, Authentik 2025.10.3 on port 9000, and a separate Superscriber database.
It is a demo fixture, not a production identity deployment. Production
configuration remains governed by [`authentik-oidc.md`](./authentik-oidc.md).

The pilot kept its root at
`~/.treehouse/runtime/superscriber-oidc-demo/`. Credentials, database files,
logs, generated role UUIDs, screenshots, and all other runtime artifacts stay
there and are never committed. Every secret below is a placeholder that the
operator must replace with a locally generated value.

## Boundaries and known pilot limitations

The existing port 3275 lane is an input, not part of this procedure. Record
its health before starting and compare it after teardown:

```bash
curl -fsS http://localhost:3275/api/health
lsof -nP -iTCP:3276 -sTCP:LISTEN
lsof -nP -iTCP:9000 -sTCP:LISTEN
```

Use one Docker context only. The observed service layout was:

| Service | Port |
|---|---:|
| Existing Superscriber lane, untouched | 3275 |
| Superscriber OIDC demo | 3276 |
| Authentik HTTP | 9000 |
| Authentik HTTPS, unused | 9443 |

The 3276 process used the 3275 lane's already provisioned `small` model with
these exact settings. In the observed pilot, the directory resolved to
`~/.treehouse/runtime/superscriber-3275/model-cache`:

```dotenv
SUPERSCRIBER_TRANSCRIBE_MODEL=small
SUPERSCRIBER_TRANSCRIBE_MODEL_DIR=<absolute path to the 3275 lane>/model-cache
SUPERSCRIBER_TRANSCRIBE_ALLOW_RUNTIME_DOWNLOAD=0
SUPERSCRIBER_TRANSCRIBE_OFFLINE=1
```

This was read-only by operating convention only. The pilot did not use a
read-only bind mount, permissions boundary, or separate cache mirror. The two
flags prevent worker downloads, but they do not prevent the model-provisioning
API from writing locks, staging files, or tiers under the configured model
directory. Do not use model provisioning or change model settings from the
3276 lane. A deployment that requires an enforced boundary must mount a
read-only cache mirror instead; that arrangement was not exercised here.

The pilot also did not establish a trusted reverse proxy. Its direct browser
requests carried no `X-Forwarded-For` header, while `trustedProxies` was
empty. Superscriber therefore classified every request as `public`, not
`management`. Break-glass disclosure and emergency actions were not reachable
in this pilot.

## 1. Create the Authentik stack

Create `authentik/.env`, set mode 600, and replace every placeholder locally:

```dotenv
AUTHENTIK_SECRET_KEY=<generate with: openssl rand -base64 60>
AUTHENTIK_POSTGRES_USER=authentik
AUTHENTIK_POSTGRES_PASSWORD=<generate with: openssl rand -hex 24>
AUTHENTIK_BOOTSTRAP_PASSWORD=<generated console administrator credential>
AUTHENTIK_BOOTSTRAP_TOKEN=<generate with: openssl rand -hex 32>
AUTHENTIK_BOOTSTRAP_EMAIL=<console administrator address>
COMPOSE_PROJECT_NAME=superscriber-oidc-demo
```

The following `authentik/docker-compose.yml` is the compose file that the
pilot ran. Authentik 2025.10 removed Redis and its related settings. The
`redis` service and `AUTHENTIK_REDIS__HOST` entries are deliberately retained
as an unused, harmless sidecar so this record matches the pinned 2025.10.3
pilot. Do not copy this historical shape into a production deployment.

The pilot resolved the displayed tags to these immutable image identities:

- Authentik `2025.10.3`:
  `ghcr.io/goauthentik/server@sha256:d2b66e851246e7299219b72a4ed43630a2c2bac3745eb665834b72963d836e64`
- PostgreSQL `16-alpine`:
  `docker.io/library/postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777`
- Redis `7.2-alpine`:
  `docker.io/library/redis@sha256:05a97a479bc73de66f087dc05b569010772880f778cc8671fa6b8aadee32e5c6`

The compose file uses the digests, not the rolling tags.

```yaml
services:
  postgresql:
    image: docker.io/library/postgres@sha256:57c72fd2a128e416c7fcc499958864df5301e940bca0a56f58fddf30ffc07777
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -d authentik -U $${POSTGRES_USER}"]
      start_period: 20s
      interval: 30s
      retries: 5
      timeout: 5s
    volumes:
      - ./data/postgresql:/var/lib/postgresql/data
    environment:
      POSTGRES_PASSWORD: "${AUTHENTIK_POSTGRES_PASSWORD}"
      POSTGRES_USER: "${AUTHENTIK_POSTGRES_USER}"
      POSTGRES_DB: authentik

  redis:
    image: docker.io/library/redis@sha256:05a97a479bc73de66f087dc05b569010772880f778cc8671fa6b8aadee32e5c6
    command: --save 60 1 --loglevel warning
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "redis-cli ping | grep PONG"]
      start_period: 20s
      interval: 30s
      retries: 5
      timeout: 3s
    volumes:
      - ./data/redis:/data

  server:
    image: ghcr.io/goauthentik/server@sha256:d2b66e851246e7299219b72a4ed43630a2c2bac3745eb665834b72963d836e64
    restart: unless-stopped
    command: server
    environment:
      AUTHENTIK_REDIS__HOST: redis
      AUTHENTIK_POSTGRESQL__HOST: postgresql
      AUTHENTIK_POSTGRESQL__USER: "${AUTHENTIK_POSTGRES_USER}"
      AUTHENTIK_POSTGRESQL__NAME: authentik
      AUTHENTIK_POSTGRESQL__PASSWORD: "${AUTHENTIK_POSTGRES_PASSWORD}"
    volumes:
      - ./data/media:/media
      - ./data/custom-templates:/templates
      - ./data/geoip:/geoip
    env_file:
      - .env
    ports:
      - "9000:9000"
      - "9443:9443"
    depends_on:
      postgresql:
        condition: service_healthy
      redis:
        condition: service_healthy

  worker:
    image: ghcr.io/goauthentik/server@sha256:d2b66e851246e7299219b72a4ed43630a2c2bac3745eb665834b72963d836e64
    restart: unless-stopped
    command: worker
    environment:
      AUTHENTIK_REDIS__HOST: redis
      AUTHENTIK_POSTGRESQL__HOST: postgresql
      AUTHENTIK_POSTGRESQL__USER: "${AUTHENTIK_POSTGRES_USER}"
      AUTHENTIK_POSTGRESQL__NAME: authentik
      AUTHENTIK_POSTGRESQL__PASSWORD: "${AUTHENTIK_POSTGRES_PASSWORD}"
    user: root
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data/media:/media
      - ./data/certs:/certs
      - ./data/custom-templates:/templates
      - ./data/geoip:/geoip
    env_file:
      - .env
    depends_on:
      postgresql:
        condition: service_healthy
      redis:
        condition: service_healthy
```

Start the stack and wait for its API:

```bash
cd authentik || exit 1
chmod 600 .env
docker compose up -d
bootstrap_token="$(sed -n 's/^AUTHENTIK_BOOTSTRAP_TOKEN=//p' .env)"
[ -n "$bootstrap_token" ] || {
  echo "AUTHENTIK_BOOTSTRAP_TOKEN is missing from .env" >&2
  exit 1
}
authentik_ready=0
for _attempt in $(seq 1 60); do
  if curl -fsS http://localhost:9000/api/v3/core/users/me/ \
    -H "Authorization: Bearer $bootstrap_token" >/dev/null 2>&1; then
    authentik_ready=1
    break
  fi
  if [ -n "$(docker compose ps --status exited -q)" ]; then
    docker compose ps
    echo "an Authentik service exited before API readiness" >&2
    exit 1
  fi
  sleep 2
done
[ "$authentik_ready" -eq 1 ] || {
  docker compose ps
  echo "Authentik authenticated API did not become ready within 120 seconds" >&2
  exit 1
}
```

## 2. Provision Authentik through its API

Create `authentik/.env.creds` with mode 600. These values are inputs to the
script and are never printed or committed:

```dotenv
OAUTH_CLIENT_SECRET=<generated OIDC client secret>
DEMO_ADMIN_PASSWORD=<generated demo administrator credential>
DEMO_REVIEWER_PASSWORD=<generated demo reviewer credential>
```

Save the following as executable `authentik/provision.sh`. This is the pilot
script with the real request bodies, response extraction, and reconciliation
rules. It requires Bash 4 or newer, `curl`, and Node.js. Re-running it reuses
groups, the scope mapping, provider, application, and users by their stable
names; it patches the provider, resets both demo passwords, and reconciles
each demo user to exactly one direct role group.

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

BASE="${AUTHENTIK_BASE_URL:-http://localhost:9000}"
APP_ORIGIN="${SUPERSCRIBER_APP_ORIGIN:-http://localhost:3276}"

read_value() {
  node -e '
    const [file, key] = process.argv.slice(1);
    const lines = require("fs").readFileSync(file, "utf8").split(/\r?\n/);
    const matches = lines.filter((line) => line.startsWith(`${key}=`));
    if (matches.length !== 1) {
      console.error(`${file} must contain exactly one ${key}= entry`);
      process.exit(1);
    }
    process.stdout.write(matches[0].slice(key.length + 1));
  ' "$1" "$2"
}

TOKEN="$(read_value .env AUTHENTIK_BOOTSTRAP_TOKEN)"
OAUTH_CLIENT_SECRET="$(read_value .env.creds OAUTH_CLIENT_SECRET)"
DEMO_ADMIN_PASSWORD="$(read_value .env.creds DEMO_ADMIN_PASSWORD)"
DEMO_REVIEWER_PASSWORD="$(read_value .env.creds DEMO_REVIEWER_PASSWORD)"

[ -n "$TOKEN" ] || { echo "missing AUTHENTIK_BOOTSTRAP_TOKEN in .env" >&2; exit 1; }
[ -n "$OAUTH_CLIENT_SECRET" ] || { echo "set OAUTH_CLIENT_SECRET" >&2; exit 1; }
[ -n "$DEMO_ADMIN_PASSWORD" ] || { echo "set DEMO_ADMIN_PASSWORD" >&2; exit 1; }
[ -n "$DEMO_REVIEWER_PASSWORD" ] || { echo "set DEMO_REVIEWER_PASSWORD" >&2; exit 1; }

api() {
  local method="$1" path="$2"
  shift 2
  curl -fsS -X "$method" "$BASE/api/v3$path" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"
}

jqe() { node -e '
  const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const expr = process.argv[1];
  const fn = new Function("d", `return (${expr})`);
  const out = fn(data);
  if (out === undefined || out === null) process.exit(1);
  console.log(out);
' "$1"; }

pk_by_name() {
  api GET "$1" | node -e '
    const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const want = process.argv[1];
    const hit = data.results.find((object) => object.managed === want || object.name === want);
    if (!hit) process.exit(1);
    console.log(hit.pk ?? hit.uuid);
  ' "$2"
}

AUTH_FLOW="$(api GET "/flows/instances/?designation=authorization" | jqe "d.results.find((flow) => flow.slug.includes('explicit-consent'))?.pk ?? d.results[0].pk")"
INVALIDATION_FLOW="$(api GET "/flows/instances/?designation=invalidation" | jqe "d.results[0].pk")"
SIGNING_KEY="$(api GET "/crypto/certificatekeypairs/?has_key=true" | jqe "d.results[0].pk")"

declare -A ROLE_GROUP
for role in uploader reviewer approver admin; do
  name="superscriber-$role"
  pk="$(api GET "/core/groups/?name=$name" | jqe "d.results[0]?.pk" || true)"
  if [ -z "$pk" ]; then
    pk="$(api POST "/core/groups/" -d "{\"name\":\"$name\",\"is_superuser\":false}" | jqe "d.pk")"
  fi
  ROLE_GROUP[$role]="$pk"
  printf '%s %s\n' "$name" "$pk"
done

ROLE_CLAIM_EXPR='return {"superscriber_role_group_ids": [str(g.pk) for g in request.user.ak_groups.all()]}'
SCOPE_PK="$(api GET "/propertymappings/provider/scope/?name=superscriber_roles" | jqe "d.results[0]?.pk" || true)"
if [ -z "$SCOPE_PK" ]; then
  SCOPE_PK="$(api POST "/propertymappings/provider/scope/" -d "$(node -e '
    console.log(JSON.stringify({
      name: "superscriber_roles",
      scope_name: "superscriber_roles",
      expression: process.argv[1],
    }))
  ' "$ROLE_CLAIM_EXPR")" | jqe "d.pk")"
fi

OPENID_PK="$(pk_by_name "/propertymappings/all/?search=openid" "goauthentik.io/providers/oauth2/scope-openid")"
PROFILE_PK="$(pk_by_name "/propertymappings/all/?search=profile" "goauthentik.io/providers/oauth2/scope-profile")"

PROVIDER_PK="$(api GET "/providers/oauth2/?name=superscriber" | jqe "d.results[0]?.pk" || true)"
PROVIDER_BODY="$(node -e '
  console.log(JSON.stringify({
    name: "superscriber",
    authorization_flow: process.argv[1],
    invalidation_flow: process.argv[2],
    client_type: "confidential",
    client_id: "superscriber",
    client_secret: process.argv[3],
    sub_mode: "user_username",
    include_claims_in_id_token: true,
    signing_key: process.argv[4],
    redirect_uris: [{
      matching_mode: "strict",
      url: process.argv[5] + "/api/auth/callback/authentik",
    }],
    property_mappings: [process.argv[6], process.argv[7], process.argv[8]],
  }))
' "$AUTH_FLOW" "$INVALIDATION_FLOW" "$OAUTH_CLIENT_SECRET" "$SIGNING_KEY" "$APP_ORIGIN" "$OPENID_PK" "$PROFILE_PK" "$SCOPE_PK")"
if [ -z "$PROVIDER_PK" ]; then
  PROVIDER_PK="$(api POST "/providers/oauth2/" -d "$PROVIDER_BODY" | jqe "d.pk")"
else
  api PATCH "/providers/oauth2/$PROVIDER_PK/" -d "$PROVIDER_BODY" >/dev/null
fi

APP_PK="$(api GET "/core/applications/?slug=superscriber" | jqe "d.results[0]?.pk" || true)"
if [ -z "$APP_PK" ]; then
  APP_PK="$(api POST "/core/applications/" -d "{\"name\":\"Superscriber\",\"slug\":\"superscriber\",\"provider\":$PROVIDER_PK}" | jqe "d.pk")"
fi

ensure_user() {
  local username="$1" display_name="$2" password="$3" target_role="$4" password_body
  local target_group="${ROLE_GROUP[$target_role]}" pk group other_role
  pk="$(api GET "/core/users/?username=$username" | jqe "d.results[0]?.pk" || true)"
  if [ -z "$pk" ]; then
    pk="$(api POST "/core/users/" -d "{\"username\":\"$username\",\"name\":\"$display_name\",\"is_active\":true}" | jqe "d.pk")"
  fi
  password_body="$(printf '%s' "$password" | node -e '
    const password = require("fs").readFileSync(0, "utf8");
    process.stdout.write(JSON.stringify({ password }));
  ')"
  api POST "/core/users/$pk/set_password/" -d "$password_body" >/dev/null
  api POST "/core/groups/$target_group/add_user/" -d "{\"pk\":$pk}" >/dev/null
  for other_role in uploader reviewer approver admin; do
    group="${ROLE_GROUP[$other_role]}"
    if [ "$other_role" != "$target_role" ]; then
      if ! api POST "/core/groups/$group/remove_user/" -d "{\"pk\":$pk}" >/dev/null; then
        echo "failed to remove $username from superscriber-$other_role ($group)" >&2
        return 1
      fi
    fi
  done
  printf '%s user_pk=%s group=%s\n' "$username" "$pk" "$target_group"
}

ensure_user "demo-admin" "Demo Admin" "$DEMO_ADMIN_PASSWORD" admin
ensure_user "demo-reviewer" "Demo Reviewer" "$DEMO_REVIEWER_PASSWORD" reviewer

ISSUER="$BASE/application/o/superscriber/"
mkdir -p ../superscriber/oidc
node -e '
  const [issuer, uploader, reviewer, approver, admin] = process.argv.slice(1);
  console.log(JSON.stringify({
    version: 1,
    issuer,
    claim: "superscriber_role_group_ids",
    groups: { uploader, reviewer, approver, admin },
  }, null, 2));
' "$ISSUER" "${ROLE_GROUP[uploader]}" "${ROLE_GROUP[reviewer]}" "${ROLE_GROUP[approver]}" "${ROLE_GROUP[admin]}" \
  > ../superscriber/oidc/role-map.json
umask 077
printf '%s' "$OAUTH_CLIENT_SECRET" > ../superscriber/oidc/client-secret
printf 'provider=%s application=%s issuer=%s\n' "$PROVIDER_PK" "$APP_PK" "$ISSUER"
```

Run it from the demo root after replacing the credential placeholders:

```bash
cd authentik || exit 1
chmod 600 .env .env.creds
chmod 700 provision.sh
./provision.sh
```

The script writes `superscriber/oidc/role-map.json` with the four generated
group UUIDs and `superscriber/oidc/client-secret` with mode 600 under the
demo root. The issuer is exactly
`http://localhost:9000/application/o/superscriber/`, including its trailing
slash. The OIDC subjects are the Authentik usernames `demo-admin` and
`demo-reviewer` because the provider uses `user_username` subject mode.

## 3. Build and configure Superscriber on port 3276

Create this layout under the demo root:

```text
superscriber/
  repo/
  oidc/role-map.json
  oidc/client-secret
  oidc/management-networks.json
  data/media/
  data/uploads/
  logs/
  pids/
  venv/
```

The pilot built source commit
`47228b986604d13311efdee4a1ed318dc5f644e3`, which was `origin/main` at build
time. The host ran Node.js `v26.7.0` and Python `3.13.14`. The source
`worker/requirements.txt` declared `faster-whisper>=1.1.0`; the installed
version was `1.2.1`, so the build command constrains the declared worker
dependency to that observed version. The Node dependency graph remains locked
by the source commit's `package-lock.json` and `npm ci`.

From the demo root, point `SOURCE_CHECKOUT` at a clean checkout of that exact
commit and run:

```bash
SOURCE_CHECKOUT="<absolute path to the Superscriber source checkout>"
EXPECTED_SOURCE_SHA=47228b986604d13311efdee4a1ed318dc5f644e3
[ "$(git -C "$SOURCE_CHECKOUT" rev-parse HEAD)" = "$EXPECTED_SOURCE_SHA" ] || {
  echo "source checkout is not the pilot commit $EXPECTED_SOURCE_SHA" >&2
  exit 1
}
[ -z "$(git -C "$SOURCE_CHECKOUT" status --porcelain --untracked-files=all)" ] || {
  echo "source checkout contains changes not present in the pilot commit" >&2
  exit 1
}
[ "$(node --version)" = "v26.7.0" ] || {
  echo "the pilot build requires Node.js v26.7.0" >&2
  exit 1
}
[ "$(python3 --version 2>&1)" = "Python 3.13.14" ] || {
  echo "the pilot build requires Python 3.13.14" >&2
  exit 1
}
mkdir -p superscriber/repo superscriber/data/media superscriber/data/uploads \
  superscriber/logs superscriber/pids
rsync -a --exclude .git --exclude .next --exclude node_modules \
  "$SOURCE_CHECKOUT/" superscriber/repo/
cd superscriber/repo || exit 1
npm ci
npm run build
mkdir -p .next/standalone/.next
cp -R .next/static .next/standalone/.next/static
cp -R public .next/standalone/public
python3 -m venv ../venv
printf 'faster-whisper==1.2.1\n' > ../worker-direct-constraints.txt
../venv/bin/python3 -m pip install \
  --constraint ../worker-direct-constraints.txt \
  --requirement worker/requirements.txt
cd ../..
```

The standalone asset copies are required because plain
`.next/standalone/server.js` does not serve them from their source locations.

Create `superscriber/app.env` with mode 600. Replace path placeholders with
absolute paths. The model path must name the existing 3275 cache and must be
the same for the app and worker:

```dotenv
SUPERSCRIBER_AUTH_MODE=authentik-primary
SUPERSCRIBER_DEPLOYMENT_PROFILE=no-mail
SUPERSCRIBER_DB_PATH=<absolute demo root>/superscriber/data/superscriber.db
SUPERSCRIBER_MEDIA_DIR=<absolute demo root>/superscriber/data/media
SUPERSCRIBER_UPLOAD_TMP_DIR=<absolute demo root>/superscriber/data/uploads
SUPERSCRIBER_ENGINE_MODE=internal
SUPERSCRIBER_APP_BASE_URL=http://localhost:3276
NEXTAUTH_URL=http://localhost:3276
SUPERSCRIBER_TRANSCRIBE_MODEL=small
SUPERSCRIBER_TRANSCRIBE_MODEL_DIR=<absolute path to the 3275 lane>/model-cache
SUPERSCRIBER_TRANSCRIBE_ALLOW_RUNTIME_DOWNLOAD=0
SUPERSCRIBER_TRANSCRIBE_OFFLINE=1
SUPERSCRIBER_OIDC_ISSUER=http://localhost:9000/application/o/superscriber/
SUPERSCRIBER_OIDC_CLIENT_ID=superscriber
SUPERSCRIBER_OIDC_CLIENT_SECRET_FILE=<absolute demo root>/superscriber/oidc/client-secret
SUPERSCRIBER_OIDC_ROLE_MAP_FILE=<absolute demo root>/superscriber/oidc/role-map.json
SUPERSCRIBER_MANAGEMENT_NETWORKS_FILE=<absolute demo root>/superscriber/oidc/management-networks.json
PORT=3276
HOSTNAME=127.0.0.1
```

The pilot mounted this exact `superscriber/oidc/management-networks.json` only
because the file is required in `authentik-primary` mode:

```json
{
  "managementNetworks": ["127.0.0.0/8"],
  "trustedProxies": []
}
```

This file does not classify a direct loopback request as management.
`evaluateSourceZone` fails closed to `public` whenever the forwarding header
is absent or `trustedProxies` is empty.

Generate separate application and engine secrets as local mode-600 files:

```bash
openssl rand -hex 32 > superscriber/auth.secret
openssl rand -hex 32 > superscriber/engine.secret
chmod 600 superscriber/app.env superscriber/auth.secret superscriber/engine.secret superscriber/oidc/client-secret
```

### Seed the two local OIDC shadow users

Initialize only the 3276 database:

```bash
cd "<absolute demo root>/superscriber/repo" || exit 1
SUPERSCRIBER_DB_PATH="<absolute demo root>/superscriber/data/superscriber.db" \
  npx tsx scripts/ensure-db.ts
```

Save the following as `superscriber/seed-users.cjs`, replace the two address
placeholders, and run it once. This is the idempotent seeding procedure used
for the pilot. It creates local role-authority rows while leaving
`password_hash` null, so the two personas authenticate only through
Authentik.

```javascript
#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const database = process.env.SUPERSCRIBER_DB_PATH;
const repo = process.env.SUPERSCRIBER_REPO;
if (!database || !repo) throw new Error("set SUPERSCRIBER_DB_PATH and SUPERSCRIBER_REPO");

const Database = require(path.join(repo, "node_modules", "better-sqlite3"));
const now = new Date().toISOString();
const personas = [
  ["<demo administrator address>", "Demo Admin", "admin"],
  ["<demo reviewer address>", "Demo Reviewer", "reviewer"],
];

const db = new Database(database, { fileMustExist: true });
const existing = db.prepare("SELECT id FROM users WHERE lower(email) = lower(?)");
const insert = db.prepare(`
  INSERT INTO users (
    id, email, display_name, password_hash, role, is_active,
    auth_version, created_at, updated_at
  ) VALUES (?, ?, ?, NULL, ?, 1, 1, ?, ?)
`);

const ids = {};
db.transaction(() => {
  for (const [address, displayName, role] of personas) {
    const row = existing.get(address);
    if (row) {
      db.prepare(
        "UPDATE users SET role = ?, is_active = 1, updated_at = ? WHERE id = ?",
      ).run(role, now, row.id);
      ids[role] = row.id;
      continue;
    }
    const id = crypto.randomUUID();
    insert.run(id, address, displayName, role, now, now);
    ids[role] = id;
  }
})();
db.close();
console.log(JSON.stringify(ids, null, 2));
```

```bash
cd "<absolute demo root>" || exit 1
SUPERSCRIBER_DB_PATH="<absolute demo root>/superscriber/data/superscriber.db" \
SUPERSCRIBER_REPO="<absolute demo root>/superscriber/repo" \
  node superscriber/seed-users.cjs
```

Record the two printed IDs in
`superscriber/identity-mapping.json`. This is the exact mapping shape used by
the pilot:

```json
[
  {
    "userId": "<printed admin user id>",
    "issuer": "http://localhost:9000/application/o/superscriber/",
    "subject": "demo-admin",
    "changeReason": "OIDC demo lane setup",
    "expectedRole": "admin"
  },
  {
    "userId": "<printed reviewer user id>",
    "issuer": "http://localhost:9000/application/o/superscriber/",
    "subject": "demo-reviewer",
    "changeReason": "OIDC demo lane setup",
    "expectedRole": "reviewer"
  }
]
```

Dry-run and then apply the links against the same database:

```bash
cd "<absolute demo root>/superscriber/repo" || exit 1
SUPERSCRIBER_DB_PATH="<absolute demo root>/superscriber/data/superscriber.db" \
  npm run identity:import -- --file ../identity-mapping.json --dry-run
SUPERSCRIBER_DB_PATH="<absolute demo root>/superscriber/data/superscriber.db" \
  npm run identity:import -- --file ../identity-mapping.json --apply \
  --linked-by "<printed admin user id>"
```

### Record the pilot's break-glass state accurately

The pilot ran only this designation command, with the real 3276 database path:

```bash
cd "<absolute demo root>/superscriber/repo" || exit 1
SUPERSCRIBER_DB_PATH="<absolute demo root>/superscriber/data/superscriber.db" \
  npm run break-glass:designate -- --user "<printed admin user id>" \
  --reason "Initial OIDC demo custodian"
```

No usable break-glass credential was established: the seeded admin retained a
null `password_hash`. No hardware keys were enrolled, no recovery codes were
issued, and no emergency sign-in was attempted. The observed pilot state was
one designation, zero keys, and zero unused recovery codes, so the
Authentication readiness result remained blocked.

An operational break-glass deployment requires a supported local custodian
credential before designation, then two separately held security keys and a
recovery-code set enrolled from the designated custodian's own signed-in
Administration session. It also requires an actual trusted-proxy management
boundary. None of those steps were exercised in this pilot; follow
[`break-glass.md`](./break-glass.md) rather than treating this fixture as a
rehearsal.

### Start and stop the observed supervisor

The pilot used `superscriber/run.sh` and `superscriber/stop.sh`, not the
repository's managed local-instance supervisor. Save these parameterized
forms, export `SUPERSCRIBER_ROOT` as the absolute `superscriber/` directory,
and make both scripts executable.

`superscriber/run.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="${SUPERSCRIBER_ROOT:?set SUPERSCRIBER_ROOT}"
REPO="$ROOT/repo"
LOG_DIR="$ROOT/logs"
PID_DIR="$ROOT/pids"
LANE_LOG="$ROOT/lane.log"
mkdir -p "$LOG_DIR" "$PID_DIR"
touch "$LANE_LOG" "$LOG_DIR/supervisor.log" "$LOG_DIR/app.log" "$LOG_DIR/worker.log"

timestamp() { date -u +%Y-%m-%dT%H:%M:%SZ; }
say_supervisor() {
  printf '[%s] [supervisor] %s\n' "$(timestamp)" "$*" >>"$LOG_DIR/supervisor.log"
  printf '[%s] [supervisor] %s\n' "$(timestamp)" "$*" >>"$LANE_LOG"
}

process_is_live() {
  local pid="$1" state
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  state="$(ps -p "$pid" -o stat= 2>/dev/null || true)"
  [[ -n "$state" && "$state" != *Z* ]]
}

process_start_fingerprint() {
  local pid="$1" started
  process_is_live "$pid" || return 1
  started="$(ps -ww -p "$pid" -o lstart= 2>/dev/null)"
  [[ -n "${started//[[:space:]]/}" ]] || return 1
  printf '%s' "$started" | cksum | awk '{ printf "%s-%s\n", $1, $2 }'
}

process_matches_identity() {
  local pid="$1" expected="$2" current
  current="$(process_start_fingerprint "$pid")" || return 1
  [[ "$current" == "$expected" ]]
}

read_pid_identity() {
  local file="$1" pid started
  [[ -f "$file" ]] || return 1
  read -r pid started <"$file" || return 1
  [[ "$pid" =~ ^[0-9]+$ && "$started" =~ ^[0-9]+-[0-9]+$ ]] || return 1
  printf '%s %s\n' "$pid" "$started"
}

clear_pid_identity() {
  local file="$1" expected="$2"
  [[ "$(cat "$file" 2>/dev/null || true)" != "$expected" ]] || rm -f "$file"
}

sweep_stale_pid_files() {
  local file identity pid started
  for file in "$PID_DIR/supervisor.pid" "$PID_DIR/app.pid" "$PID_DIR/worker.pid"; do
    identity="$(read_pid_identity "$file" 2>/dev/null || true)"
    if [ -z "$identity" ]; then
      rm -f "$file"
      continue
    fi
    read -r pid started <<<"$identity"
    process_matches_identity "$pid" "$started" || clear_pid_identity "$file" "$identity"
  done
}

signal_pid_file() {
  local signal="$1" file="$2" identity pid started
  identity="$(read_pid_identity "$file" 2>/dev/null || true)"
  if [ -z "$identity" ]; then
    rm -f "$file"
    return 0
  fi
  read -r pid started <<<"$identity"
  if process_matches_identity "$pid" "$started"; then
    kill "-$signal" "$pid" 2>/dev/null || true
  else
    clear_pid_identity "$file" "$identity"
  fi
}

pid_file_is_live() {
  local identity pid started
  identity="$(read_pid_identity "$1" 2>/dev/null || true)"
  [ -n "$identity" ] || return 1
  read -r pid started <<<"$identity"
  process_matches_identity "$pid" "$started"
}

load_env() {
  set -a
  . "$ROOT/app.env"
  set +a
  AUTH_SECRET="$(cat "$ROOT/auth.secret")"
  NEXTAUTH_SECRET="$AUTH_SECRET"
  SUPERSCRIBER_ENGINE_SHARED_SECRET="$(cat "$ROOT/engine.secret")"
  export AUTH_SECRET NEXTAUTH_SECRET SUPERSCRIBER_ENGINE_SHARED_SECRET
  export PORT=3276 HOSTNAME=127.0.0.1 NODE_ENV=production
}

next_backoff() {
  case "$1" in
    1) echo 5 ;;
    2) echo 15 ;;
    3) echo 45 ;;
    *) echo 300 ;;
  esac
}

run_role() {
  local role="$1" log consecutive=0 child_started identity_tmp published_identity
  shift
  if [ "$role" = app ]; then log="$LOG_DIR/app.log"; else log="$LOG_DIR/worker.log"; fi
  while true; do
    local started ended status wait_seconds child_pid
    started="$(date +%s)"
    say_supervisor "$role starting: $*"
    set +e
    "$@" > >(while IFS= read -r line; do
      printf '[%s] [%s] %s\n' "$(timestamp)" "$role" "$line" | tee -a "$log" >>"$LANE_LOG"
    done) 2>&1 &
    child_pid=$!
    child_started="$(process_start_fingerprint "$child_pid" 2>/dev/null || true)"
    published_identity=""
    if [ -n "$child_started" ]; then
      published_identity="$child_pid $child_started"
      identity_tmp="$PID_DIR/$role.pid.tmp.$$"
      printf '%s\n' "$published_identity" >"$identity_tmp"
      mv "$identity_tmp" "$PID_DIR/$role.pid"
    fi
    wait "$child_pid"
    status=$?
    [ -z "$published_identity" ] || clear_pid_identity "$PID_DIR/$role.pid" "$published_identity"
    set -e
    ended="$(date +%s)"
    if [ $((ended - started)) -ge 60 ]; then consecutive=0; fi
    consecutive=$((consecutive + 1))
    wait_seconds="$(next_backoff "$consecutive")"
    say_supervisor "$role exited status=$status; restart in ${wait_seconds}s"
    sleep "$wait_seconds"
  done
}

SUPERVISOR_PID=""
SUPERVISOR_STARTED=""
SUPERVISOR_IDENTITY=""
APP_LOOP_PID=""
APP_LOOP_STARTED=""
WORKER_LOOP_PID=""
WORKER_LOOP_STARTED=""

signal_loop() {
  local signal="$1" pid="$2" started="$3"
  [ -n "$pid" ] && [ -n "$started" ] || return 0
  process_matches_identity "$pid" "$started" || return 0
  kill "-$signal" "$pid" 2>/dev/null || true
}

owned_processes_are_live() {
  pid_file_is_live "$PID_DIR/app.pid" && return 0
  pid_file_is_live "$PID_DIR/worker.pid" && return 0
  if [ -n "$APP_LOOP_PID" ] && process_matches_identity "$APP_LOOP_PID" "$APP_LOOP_STARTED"; then
    return 0
  fi
  if [ -n "$WORKER_LOOP_PID" ] && process_matches_identity "$WORKER_LOOP_PID" "$WORKER_LOOP_STARTED"; then
    return 0
  fi
  return 1
}

cleanup_state() {
  signal_pid_file TERM "$PID_DIR/app.pid"
  signal_pid_file TERM "$PID_DIR/worker.pid"
  signal_loop TERM "$APP_LOOP_PID" "$APP_LOOP_STARTED"
  signal_loop TERM "$WORKER_LOOP_PID" "$WORKER_LOOP_STARTED"
  sweep_stale_pid_files
  [ -z "$SUPERVISOR_IDENTITY" ] || clear_pid_identity "$PID_DIR/supervisor.pid" "$SUPERVISOR_IDENTITY"
}

shutdown() {
  local attempts=0
  trap - INT TERM
  say_supervisor "stop requested"
  signal_pid_file TERM "$PID_DIR/app.pid"
  signal_pid_file TERM "$PID_DIR/worker.pid"
  signal_loop TERM "$APP_LOOP_PID" "$APP_LOOP_STARTED"
  signal_loop TERM "$WORKER_LOOP_PID" "$WORKER_LOOP_STARTED"
  while [ "$attempts" -lt 50 ] && owned_processes_are_live; do
    attempts=$((attempts + 1))
    sleep 0.1
  done
  if owned_processes_are_live; then
    say_supervisor "bounded shutdown expired with a verified child still running"
    exit 1
  fi
  wait "$APP_LOOP_PID" 2>/dev/null || true
  [ -z "$WORKER_LOOP_PID" ] || wait "$WORKER_LOOP_PID" 2>/dev/null || true
  exit 0
}

supervisor_is_live() {
  local identity pid started
  identity="$(read_pid_identity "$PID_DIR/supervisor.pid" 2>/dev/null || true)"
  [ -n "$identity" ] || return 1
  read -r pid started <<<"$identity"
  process_matches_identity "$pid" "$started"
}

start_supervisor() {
  local child_pid child_started identity_tmp attempts=0
  sweep_stale_pid_files
  if supervisor_is_live; then
    echo "supervisor already running: $(cat "$PID_DIR/supervisor.pid")"
    exit 0
  fi
  if lsof -nP -iTCP:3276 -sTCP:LISTEN >/dev/null; then
    echo "refusing to start with port 3276 occupied by a foreign process" >&2
    exit 1
  fi
  nohup bash "$ROOT/run.sh" --supervise >>"$LANE_LOG" 2>&1 &
  child_pid=$!
  child_started="$(process_start_fingerprint "$child_pid" 2>/dev/null || true)"
  while [ -z "$child_started" ] && [ "$attempts" -lt 10 ]; do
    attempts=$((attempts + 1))
    sleep 0.05
    child_started="$(process_start_fingerprint "$child_pid" 2>/dev/null || true)"
  done
  [ -n "$child_started" ] || {
    echo "supervisor exited before publishing its process identity" >&2
    return 1
  }
  identity_tmp="$PID_DIR/supervisor.pid.tmp.$$"
  printf '%s %s\n' "$child_pid" "$child_started" >"$identity_tmp"
  mv "$identity_tmp" "$PID_DIR/supervisor.pid"
  echo "started supervisor $child_pid"
}

case "${1:-}" in
  "") start_supervisor; exit $? ;;
  --status) if supervisor_is_live; then exit 0; else exit 1; fi ;;
  --supervise) ;;
  *) echo "usage: run.sh [--status|--supervise]" >&2; exit 64 ;;
esac

load_env
cd "$REPO"
SUPERVISOR_PID="$$"
SUPERVISOR_STARTED="$(process_start_fingerprint "$SUPERVISOR_PID")"
SUPERVISOR_IDENTITY="$SUPERVISOR_PID $SUPERVISOR_STARTED"
trap cleanup_state EXIT
trap shutdown INT TERM
(run_role app node "$REPO/.next/standalone/server.js") &
APP_LOOP_PID=$!
APP_LOOP_STARTED="$(process_start_fingerprint "$APP_LOOP_PID")"
(run_role worker env PYTHONUNBUFFERED=1 \
  SUPERSCRIBER_WORKER_PYTHON="$ROOT/venv/bin/python3" \
  bash scripts/run-worker-python.sh worker/main.py) &
WORKER_LOOP_PID=$!
WORKER_LOOP_STARTED="$(process_start_fingerprint "$WORKER_LOOP_PID")"
say_supervisor "supervising app=$APP_LOOP_PID worker=$WORKER_LOOP_PID at http://127.0.0.1:3276"
wait
```

`superscriber/stop.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
ROOT="${SUPERSCRIBER_ROOT:?set SUPERSCRIBER_ROOT}"
PID_FILE="$ROOT/pids/supervisor.pid"

process_is_live() {
  local pid="$1" state
  [[ "$pid" =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  state="$(ps -p "$pid" -o stat= 2>/dev/null || true)"
  [[ -n "$state" && "$state" != *Z* ]]
}

process_start_fingerprint() {
  local pid="$1" started
  process_is_live "$pid" || return 1
  started="$(ps -ww -p "$pid" -o lstart= 2>/dev/null)"
  [[ -n "${started//[[:space:]]/}" ]] || return 1
  printf '%s' "$started" | cksum | awk '{ printf "%s-%s\n", $1, $2 }'
}

process_matches_identity() {
  local current
  current="$(process_start_fingerprint "$1")" || return 1
  [[ "$current" == "$2" ]]
}

role_identity_if_live() {
  local role="$1" role_file role_identity role_pid role_started
  role_file="$ROOT/pids/$role.pid"
  role_identity="$(cat "$role_file" 2>/dev/null || true)"
  read -r role_pid role_started <<<"$role_identity"
  if [[ "$role_pid" =~ ^[0-9]+$ && "$role_started" =~ ^[0-9]+-[0-9]+$ ]] && \
     process_matches_identity "$role_pid" "$role_started"; then
    printf '%s\n' "$role_identity"
    return 0
  fi
  [[ "$(cat "$role_file" 2>/dev/null || true)" != "$role_identity" ]] || rm -f "$role_file"
  return 1
}

verified_children_are_live() {
  role_identity_if_live app >/dev/null && return 0
  role_identity_if_live worker >/dev/null && return 0
  return 1
}

report_verified_children() {
  local role role_identity
  for role in app worker; do
    role_identity="$(role_identity_if_live "$role" 2>/dev/null || true)"
    [ -z "$role_identity" ] || echo "verified $role process still running: $role_identity" >&2
  done
}

identity="$(cat "$PID_FILE" 2>/dev/null || true)"
read -r pid started <<<"$identity"
if [[ ! "$pid" =~ ^[0-9]+$ || ! "$started" =~ ^[0-9]+-[0-9]+$ ]] || \
   ! process_matches_identity "$pid" "$started"; then
  [[ "$(cat "$PID_FILE" 2>/dev/null || true)" != "$identity" ]] || rm -f "$PID_FILE"
  if verified_children_are_live; then
    report_verified_children
    echo "supervisor is absent but verified demo children remain" >&2
    exit 1
  fi
  echo "supervisor not running"
  exit 0
fi

kill "$pid"
attempts=0
while [ "$attempts" -lt 50 ] && process_matches_identity "$pid" "$started"; do
  attempts=$((attempts + 1))
  sleep 0.1
done
if process_matches_identity "$pid" "$started"; then
  echo "verified supervisor $pid did not stop within 5 seconds" >&2
  exit 1
fi
[[ "$(cat "$PID_FILE" 2>/dev/null || true)" != "$identity" ]] || rm -f "$PID_FILE"
attempts=0
while [ "$attempts" -lt 50 ] && verified_children_are_live; do
  attempts=$((attempts + 1))
  sleep 0.1
done
if verified_children_are_live; then
  report_verified_children
  echo "verified demo children did not stop after supervisor exit" >&2
  exit 1
fi
echo "stopped supervisor $pid"
```

Start and check the 3276 lane without exercising the live 3275 lane:

```bash
export SUPERSCRIBER_ROOT="<absolute demo root>/superscriber"
chmod 700 "$SUPERSCRIBER_ROOT/run.sh" "$SUPERSCRIBER_ROOT/stop.sh"
worker_log="$SUPERSCRIBER_ROOT/logs/worker.log"
mkdir -p "$SUPERSCRIBER_ROOT/logs"
touch "$worker_log"
worker_log_offset="$(wc -c < "$worker_log" | tr -d '[:space:]')"
bash "$SUPERSCRIBER_ROOT/run.sh"
superscriber_ready=0
api_ready=0
worker_ready=0
for _attempt in $(seq 1 60); do
  if curl -fsS http://localhost:3276/api/health >/dev/null 2>&1; then
    api_ready=1
  fi
  if tail -c "+$((worker_log_offset + 1))" "$worker_log" | \
    grep -Fq '[worker] ready with offline model'; then
    worker_ready=1
  fi
  if [ "$api_ready" -eq 1 ] && [ "$worker_ready" -eq 1 ]; then
    superscriber_ready=1
    break
  fi
  if ! bash "$SUPERSCRIBER_ROOT/run.sh" --status; then
    echo "Superscriber supervisor exited before API readiness" >&2
    exit 1
  fi
  sleep 1
done
[ "$superscriber_ready" -eq 1 ] || {
  echo "Superscriber API and offline worker did not both become ready within 60 seconds" >&2
  exit 1
}
```

## 4. Verify in a real browser

1. Open http://localhost:3276 and choose **Sign in with institutional
   account**. Sign in to Authentik as `demo-admin`, accept the consent screen,
   and verify that the callback lands on `/workspace`. `GET /api/auth/session`
   must report `"role":"admin"` and `"authSource":"authentik"`.
2. Open `GET /api/admin/auth-health` as the administrator. Verify the active
   mode, OIDC admission counters, identity-link counts, and these exact
   break-glass facts: `designated` is `true`, `enrolledKeyCount` is `0`, and
   `recoveryCodeCount` is `0`. The endpoint does not return the aggregate
   Authentication readiness result. Open **Administration > Accounts** and
   verify that **Emergency access (break-glass)** shows the same one-custodian,
   zero-key, zero-code state. Those facts are the blocked readiness inputs
   recorded by this pilot.
3. Sign out of Superscriber, then visit Authentik's
   `/if/flow/default-invalidation-flow/`. Sign in as `demo-reviewer`. The
   Administration navigation must be absent, and `/administration` must show
   the generic denial.
4. Revoke the reviewer from the repository checkout:

   ```bash
   cd "<absolute demo root>/superscriber/repo" || exit 1
   SUPERSCRIBER_DB_PATH="<absolute demo root>/superscriber/data/superscriber.db" \
     npm run auth:revoke -- --user "<printed reviewer user id>" \
     --reason "OIDC demo session revocation"
   ```

   On the next browser request, verify a return to sign-in with the
   session-expired notice. The 3276 database must contain an
   `auth.session.revoked` security event. Do not query or modify the 3275
   database.

## Teardown

Stop the same supervisor and compose project that this runbook started:

```bash
export SUPERSCRIBER_ROOT="<absolute demo root>/superscriber"
bash "$SUPERSCRIBER_ROOT/stop.sh"
cd "<absolute demo root>/authentik" || exit 1
docker compose down
curl -fsS http://localhost:3275/api/health
```

Compose uses bind-mounted directories under `authentik/data/`, so `docker
compose down -v` does not remove the pilot's Postgres or Redis data. Keep or
dispose of the entire demo root separately according to local policy. Never
remove any path belonging to the 3275 lane.
