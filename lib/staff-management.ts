const STAFF_EDITING_ENABLED =
  (process.env.ENABLE_STAFF_EDITING || "").trim().toLowerCase() === "true";

// Zentraler Editor soll per Default an sein, es sei denn, explizit deaktiviert.
const CENTRAL_STAFF_EDITING_ENABLED =
  (process.env.ENABLE_CENTRAL_STAFF_EDITING || "").trim().toLowerCase() !== "false";

export const STAFF_EDITING_DISABLED_MESSAGE =
  "Die Mitarbeiterverwaltung ist zentralisiert. Änderungen im Kalender-Backoffice sind deaktiviert.";

export function isStaffEditingEnabled(): boolean {
  return STAFF_EDITING_ENABLED;
}

export function isCentralStaffEditingEnabled(): boolean {
  return CENTRAL_STAFF_EDITING_ENABLED;
}
