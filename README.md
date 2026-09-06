# SOC App

Orchestration for a Security Operations Centre platform: a NestJS API, a
Next.js console ("AEGIS"), and a lightweight uptime checker, wired together
with Docker Compose.

This repo is the glue, not the code — `soc-backend` and `soc-hai` are
separate git repositories with their own history and remotes; this one only
tracks `docker-compose.yml`, the environment template, and the uptime
checker itself.

## Layout

```
soc/
├── soc-backend/         separate repo — NestJS API, Prisma, PostgreSQL
├── soc-hai/              separate repo — Next.js console ("AEGIS")
├── soc-uptime-checker/   monitors Assets flagged with a monitoredUrl
├── docker-compose.yml    runs all four services together
└── .env.example          template for the one .env this reads
```

`soc-backend` and `soc-hai` must be cloned as siblings of this repo (i.e.
inside this same `soc/` folder) for the compose file's build contexts to
resolve:

```bash
git clone https://github.com/eyefkey/soc-app.git soc
cd soc
git clone https://github.com/eyefkey/soc-backend.git
git clone https://github.com/eyefkey/soc-hai.git
```

## Quick start

```bash
cp .env.example .env
```

Fill in `.env`:

- `JWT_SECRET` — generate with `node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"`
- `UPTIME_CHECKER_USERNAME` / `UPTIME_CHECKER_PASSWORD` — a service account
  with the ANALYST role (create it via the console's Users page after first
  boot, or `POST /auth/register` as an ADMIN)

Then:

```bash
docker compose up -d --build
```

| Service    | URL                     |
| ---------- | ----------------------- |
| Console    | http://localhost:3000   |
| API        | http://localhost:4000   |
| Postgres   | localhost:5432          |

Migrations apply automatically on backend startup.

## The uptime checker

`soc-uptime-checker` polls `GET /assets` every sweep and monitors whichever
Assets have `monitoredUrl` set — there's no separate target list to
maintain. To watch a site:

1. Create (or edit) an Asset in the console and set its **Monitored URL**.
2. Optionally set **failures before incident** and **incident severity** to
   override the checker's defaults for that asset.

On a sustained outage it opens an incident, raises an alert, and attaches
the asset — the same records an analyst would create by hand. It also
watches TLS certificate expiry on `https://` targets and opens a separate
incident as one approaches (`CERT_WARN_DAYS`, default 14 days).

Every sweep prints one line even when nothing's wrong
(`[ok] N asset(s) checked, all healthy`), so `docker compose logs uptime-checker`
always has a recent line to point to as proof it's alive.

Tunables (all optional, set in `.env`):

| Variable                         | Default | Meaning                                    |
| --------------------------------- | ------- | ------------------------------------------- |
| `UPTIME_CHECKER_INTERVAL_MS`      | 60000   | How often to sweep                          |
| `UPTIME_CHECKER_TIMEOUT_MS`       | 10000   | Per-check timeout                           |
| `UPTIME_CHECKER_FAIL_THRESHOLD`   | 3       | Consecutive failures before an incident      |
| `UPTIME_CHECKER_RETRIES`          | 2       | In-sweep retries before counting a failure   |
| `UPTIME_CHECKER_RETRY_DELAY_MS`   | 1000    | Delay between those retries                  |
| `UPTIME_CHECKER_CERT_WARN_DAYS`   | 14      | Days-to-expiry that triggers a cert incident |

## Other repos

- [soc-backend](https://github.com/eyefkey/soc-backend) — API, data model, auth
- [soc-hai](https://github.com/eyefkey/soc-hai) — the console UI
