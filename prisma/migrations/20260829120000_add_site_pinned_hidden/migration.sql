-- AlterTable
-- Favorites ("pin the important projects") and hiding ("hide the dead ones") used to live in
-- React state only, so both were forgotten on the next page load — the README promised
-- persistence that did not exist. They are workspace properties, not per-browser preferences:
-- shelving a dead property is a decision about the workspace. Server rows also let the
-- site-wide reports exclude hidden sites the way they already exclude archived ones, which a
-- localStorage set could never enforce.
ALTER TABLE "Site" ADD COLUMN "pinned" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Site" ADD COLUMN "hidden" BOOLEAN NOT NULL DEFAULT false;
