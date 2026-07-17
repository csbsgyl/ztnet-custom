-- Existing custom Planet records cannot be classified reliably. Keep them
-- unavailable to end users until an administrator generates a new Planet on
-- this server.
CREATE TYPE "PlanetOrigin" AS ENUM ('UNKNOWN', 'LOCAL_GENERATED', 'IMPORTED');

ALTER TABLE "Planet"
ADD COLUMN "origin" "PlanetOrigin" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN "downloadSha256" TEXT;
