-- AlterTable
ALTER TABLE "Staff" ADD COLUMN     "calendarOrder" INTEGER;

WITH ordered AS (
    SELECT
        "id",
        ROW_NUMBER() OVER (
            PARTITION BY "locationId"
            ORDER BY
                COALESCE("displayName", "lastName", 'zzzz'),
                COALESCE("firstName", 'zzzz'),
                "createdAt"
        ) - 1 AS rn
    FROM "Staff"
)
UPDATE "Staff" AS s
SET "calendarOrder" = ordered.rn
FROM ordered
WHERE ordered."id" = s."id";
