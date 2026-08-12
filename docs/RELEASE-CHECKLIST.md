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
9. Review `git status` before committing and never stage a database. `dev.db` and `prisma/dev.db`
   are tracked for historical reasons and a local one usually carries real data; `data/` and the
   updater's `backups/` are ignored on purpose. Stage explicit paths, not `git add -A`.
10. Update `docs/SITE-COPY-1.4.0.md` (or its successor) and apply it to opengsc.org, so the public
    site and the repository describe the same product.

## Deferred: untracking `dev.db`

`dev.db` should not be in the repository at all, but removing it has to wait one release. The
updater runs `git reset --hard origin/main`, so a commit that deletes the file also deletes it on
any install still using the template default (`file:./dev.db`) — and the backup that protects them
only runs before the reset from 1.4.0 onward. Once every supported install has updated through a
release carrying that ordering, `git rm --cached dev.db prisma/dev.db` is safe. Production installs
point `DATABASE_URL` at `data/prod.db` and are unaffected either way.

MySQL/MariaDB is experimental and is not a release gate until its support RFC and CI matrix are
accepted. Do not publish a GitHub Release before the tag exists and the upgrade path has passed.
