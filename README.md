## Calendar Project

This repository hosts the scheduling platform described in the roadmap (Next.js 15, App Router, PostgreSQL, Prisma, Redis, BullMQ, Vitest). The initial milestone (P0 + ticket 1) is implemented and ready for local development.

### Prerequisites

- Node.js ≥ 20 (Corepack enabled so `pnpm` is available)
- Docker Desktop (or compatible runtime) with the Compose plugin

### One-Time Setup

```bash
cd /Users/larsbirndt/Projects/calendar/codex
pnpm setup
```

The setup script will:

1. Copy `.env.example` to `.env` (if missing)
2. Start PostgreSQL 15 & Redis 7 via Docker Compose
3. Install npm dependencies
4. Apply Prisma migrations
5. Seed demo data (location, staff, services, schedules)

> If Docker is not installed, the script will abort and tell you how to proceed. Install Docker Desktop, then re-run `pnpm setup`.

### Daily Workflow

```bash
pnpm dev
```

The application runs at [http://localhost:3002](http://localhost:3002). Stop containers when you are done:

```bash
docker compose down
```

### Useful Commands

| Command | Description |
| --- | --- |
| `pnpm dev` | Next.js dev server on port 3002 |
| `pnpm build && pnpm start` | Production build & serve (port 3002) |
| `pnpm lint` | ESLint (Next core-web-vitals) |
| `pnpm typecheck` | TypeScript `--noEmit` |
| `pnpm test` | Vitest (passes with no tests today) |
| `pnpm prisma:migrate:deploy` | Apply pending migrations |
| `pnpm prisma:seed` | Seed demo data |
| `pnpm worker:notifications` | Start BullMQ notifications worker (reminder/follow-up) |
| `pnpm setup` | Full local bootstrap (described above) |
| `pnpm snapshot -- --label <tag>` | Verifiziere kritische Dateien und erstelle ein Backup-ZIP |

### Database & Redis

Service definitions live in `docker-compose.yml`. Ports:

- PostgreSQL: `localhost:5432` (user/pass/db: `codex`)
- Redis: `localhost:6379`

You can inspect data using `pnpm prisma studio` once the containers are running.

### Background Workers

- Start the BullMQ notifications worker with `pnpm worker:notifications`.
- Queue dispatch is toggled via `NOTIFICATIONS_QUEUE_ENABLED` (defaults to true when Redis is configured).
- Reminder jobs (T-24h/T-2h) and follow-up jobs (T+2h) are created automatically after successful checkout.
- SMS-Zustellung aktivierst du, indem du Twilio-Keys setzt (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`) und Kund:innen eine Telefonnummer + SMS-Consent geben.

### Backups & Restore

- `pnpm snapshot -- --label <info>` erstellt geprüfte Backups parallel in `.backups/`, `calendar_backups/` und `~/CalendarBackups/codex-calendar/`.
- Automatisierte Nightlies laufen über `scripts/run-auto-backup.sh`; Logs findest du unter `.backups/logs/`.
- Der komplette Wiederherstellungsablauf (inkl. Git-Snapshots, Docker-Tipps und Checkliste) ist in `docs/recovery-playbook.md` beschrieben.

### SMS Notifications

- `.env` oder `.env.local` muss folgende Variablen enthalten:
  - `TWILIO_ACCOUNT_SID`
  - `TWILIO_AUTH_TOKEN`
  - `TWILIO_FROM_NUMBER` (im E.164-Format, z. B. `+491234567890`)
- Kunden benötigen eine gültige Telefonnummer und müssen im Checkout ein SMS-Consent erteilen (`ConsentScope.SMS`).
- Sobald diese Bedingungen erfüllt sind, erstellt der Checkout zusätzlich SMS-Jobs für Erinnerungen (T-24h/T-2h) und Follow-ups; der Notifications-Worker liefert sie via Twilio aus.
- Wenn `CONTROL_PLANE_SMS_URL` gesetzt ist, wird der Versand über die Control Plane (seven.io) abgewickelt.

### WhatsApp Notifications (via Control Plane)

- Voraussetzung: WhatsApp-Konfiguration je Tenant in der Control Plane (Tab **WhatsApp**).
- `.env` oder `.env.local` muss enthalten:
  - `CONTROL_PLANE_WHATSAPP_URL` (z. B. `http://localhost:3003`)
  - `PROVISION_SECRET` (muss mit Control Plane übereinstimmen)
  - optional `WHATSAPP_ALLOW_TEXT_FALLBACK=true` (falls Template fehlt)
- Der Kalender ruft intern `POST /api/internal/whatsapp/send` der Control Plane auf und übergibt Templates:
  - `bookingConfirmation`, `reminder`, `followUpThanks`, `followUpNoShow`

### Actions Center (Reserve with Google)

- Aktiviere den Adapter mit `ACTIONS_CENTER_SHARED_SECRET` in `.env` oder `.env.local`.
- Jeder Request braucht diese Header:
  - `x-ac-timestamp` (Unix ms)
  - `x-ac-nonce` (UUID, wird gegen Replay geschützt)
  - `x-ac-signature` = HMAC-SHA256-hex von `${timestamp}.${nonce}.${rawBody}`

Beispiel (lokal):

```bash
SECRET="change-me"
TS="$(date +%s000)"
NONCE="$(uuidgen)"
BODY='{"tenant":"murmelcreation","location":"meissen"}'
SIG="$(node -e 'const c=require("crypto");const payload=process.env.TS+"."+process.env.NONCE+"."+process.env.BODY;process.stdout.write(c.createHmac("sha256",process.env.SECRET).update(payload).digest("hex"));')"

curl -s http://localhost:3002/api/google/actions-center/v1/merchants \
  -H "content-type: application/json" \
  -H "x-ac-timestamp: $TS" \
  -H "x-ac-nonce: $NONCE" \
  -H "x-ac-signature: $SIG" \
  -d "$BODY"
```

Verfügbare Endpunkte:

- `GET /api/google/actions-center/v1/merchants`
- `GET /api/google/actions-center/v1/services`
- `GET /api/google/actions-center/v1/availability`
- `GET|POST /api/google/actions-center/v1/bookings`
- `POST /api/google/actions-center/v1/bookings/create`
- `POST /api/google/actions-center/v1/bookings/update`
- `POST /api/google/actions-center/v1/bookings/cancel`

### GDPR Export

A GDPR export for individual customers is available under `GET /api/customers/[customerId]/export`.
The response is a ZIP archive containing JSON, CSV and ICS assets. Access is logged via the audit trail.

### Load Testing

Example k6 scripts live in `loadtests/`. Use `pnpm k6:booking` (requires the k6 CLI) to run the booking availability stage load test.
Override the target app via `BASE_URL`, the location via `LOCATION_SLUG`, and optionally `SERVICE_ID`.

### Background Workers

- `pnpm worker:notifications` startet den BullMQ-Worker für Reminder und Follow-ups.
- Komfort: `pnpm dev:all` fährt Dev-Server *und* Worker parallel (braucht Redis).
- Queue lässt sich mit `NOTIFICATIONS_QUEUE_ENABLED=false` deaktivieren.
