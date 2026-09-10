# AgentBase production deployment

Recommended temporary topology while the product is being built:

- Web: Vercel (`apps/web`)
- API: container service using `Dockerfile.api`
- Worker: container service using `Dockerfile.worker`
- Database: managed PostgreSQL 16+

## Required environment variables

Both API and worker require `DATABASE_URL`. For providers that require TLS, set `DATABASE_SSL=true`. If the provider gives a private/internal CA or explicitly documents relaxed certificate verification, set `DATABASE_SSL_REJECT_UNAUTHORIZED=false`; otherwise leave it true.

API production variables should include `NODE_ENV=production`, `CORS_ORIGINS=https://<your-vercel-host>`, `TRUST_PROXY=true`, and the rate-limit variables from `.env.example`.

The web service needs `NEXT_PUBLIC_AGENTBASE_API=https://<api-host>`. Redeploy the Vercel project after setting it.

## Start behavior

Both production containers run database migrations before starting. Migrations use a PostgreSQL advisory lock, so API and worker can start concurrently without applying the same migration twice.

## Health checks

- Liveness: `GET /health`
- Readiness: `GET /ready`

Use `/ready` for platform health checks because it returns HTTP 503 when PostgreSQL is unavailable.

## Railway-style setup

Create one PostgreSQL service and two services from the same GitHub repository. For the API service use `Dockerfile.api`; for the worker use `Dockerfile.worker`. Give both services the same `DATABASE_URL`. Only the API service needs a public domain. Then set the public API URL in Vercel as `NEXT_PUBLIC_AGENTBASE_API`.
