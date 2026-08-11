# OpenGSC release checklist

Use this checklist for every public release. `package.json` is the source of the displayed app
version; README badges, CHANGELOG, Settings and MCP must agree with it.

1. Choose the exact release commit. Do not attach a retroactive tag to a later `main` commit.
2. Update `package.json` and add the matching top section to `CHANGELOG.md`.
3. Run `npm run check`, `npx tsc --noEmit` and `npm run build`.
4. Test the additive SQLite migration on a copy and keep the pre-update backup.
5. Merge the reviewed commit, then create the annotated tag `vX.Y.Z` on that exact commit.
6. Create the GitHub Release from the matching CHANGELOG section and link upgrade/rollback notes.
7. Verify README badges, Settings → System, MCP `initialize`/`get_capabilities` and the Update
   banner all report the same version.
8. Smoke-test a fresh SQLite install and an update from the previous supported release.

MySQL/MariaDB is experimental and is not a release gate until its support RFC and CI matrix are
accepted. Do not publish a GitHub Release before the tag exists and the upgrade path has passed.
