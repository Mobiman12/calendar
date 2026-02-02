# Tenant-Gating via Control-Plane

Die neue Middleware (`calendar/middleware.ts`) ruft den Control-Plane-Resolver auf, um anhand der Subdomain zu prüfen, ob Tenant/App freigeschaltet sind.

- Host-Pattern: `<tenant>.booking.<domain>` (Mapping: booking → CALENDAR, timeshift → TIMESHIFT, web → WEBSITE).
- ENV: `CONTROL_PLANE_URL` (Default `http://localhost:3000`), `ENABLE_TENANT_GUARD` (auf `false` setzen zum Abschalten, z. B. lokal ohne Resolver).
- DB: `Tenant`-Tabelle + `tenantId` in `Location` (Default `legacy`). Stelle sicher, dass der gewünschte `tenantId` existiert (Migration legt `legacy` an; `DEFAULT_TENANT_ID` in `.env` für Seeds).
- Erfolgreicher Lookup setzt Header: `x-tenant-id`, `x-app-type`, `x-tenant-status`, optional `x-tenant-provision-mode`, `x-tenant-trial-ends`.
- Nachgelagerte API-Routen sollten diese Header auslesen und **alle** DB-Queries nach `tenantId` scopen (Schema-Erweiterung nötig, wenn noch keine tenantId-Spalte existiert). Bei fehlender Freischaltung liefert Middleware 403 JSON.

Beispiel zum Auslesen in einer Route:
```ts
import { requireTenantContext } from "@/lib/tenant";

export async function GET(request: NextRequest) {
  const tenant = requireTenantContext(request.headers);
  // prisma.<model>.findMany({ where: { tenantId: tenant.id } })
}
```
