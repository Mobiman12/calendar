# Deployment (calendar)

This app is a Next.js service. Use the Dockerfile or run it directly on a server.

## Build and run (direct)

1. Install deps
   - `pnpm install --frozen-lockfile`
2. Generate Prisma client
   - `pnpm prisma:generate`
3. Build
   - `pnpm build`
4. Start
   - `PORT=3000 pnpm start`

## Docker

- Build: `docker build -t calendar-app .`
- Run: `docker run --env-file .env -p 3002:3000 calendar-app`

## Environment

See `.env.example` for the full list. In production, set at least:

- `AUTH_SECRET`
- `TENANT_AUTH_SECRET`
- `TENANT_SSO_SECRET`
- `PROVISION_SECRET`

Optional hardening:

- `ALLOW_PLAINTEXT_PASSWORDS=false`
