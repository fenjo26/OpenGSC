# Team collaboration — technical plan

Status: implemented in 1.4.0, 12 August 2026. This document is the design it was built from; the
numbers in section 1 describe what was there before. Sections 8 and 9 record the order the work was
done in and what was deliberately left out.

## 1. What exists today

Nothing. There is no `Team`, `Member`, `Invitation` or `Role` table in `prisma/schema.prisma`, and
no API route behind the Team screens. `TeamsSection` and `MembersSection` in
`src/app/settings/page.tsx` are static JSX: the team name is built in the component
(`${user.name.split(" ")[0]}'s Team`), the single member row is always the signed-in user, the
count badge is a hardcoded string in the locale files, and the **Invite** button has no `onClick`
at all. That is why it does nothing on the live instance. In 1.4.0 those screens are hidden behind
`NEXT_PUBLIC_EXPERIMENTAL_TEAM_UI=1` — nothing was removed, because there was nothing behind them.

Two facts about the current auth shape matter for everything below:

- **The owner is whoever signed in first** (`prisma.user.findFirst({ orderBy: { id: "asc" } })`).
- **Any Google account that reaches the login page is linked to the owner** as an additional
  Search Console connection. It does not get a session — it is redirected to `/settings` — but the
  `Account` row is created first, so a stranger who finds the URL can attach their Google account
  and their GSC properties to someone else's instance. This is the mechanism that lets the owner
  add a second Google account, and it cannot tell the two situations apart.

## 2. The model

**A workspace is the owner's account.** Members do not get their own data; they act on the owner's
data with a role. This fits the existing schema exactly — every table is already scoped by
`userId`, so no row has to move, no data has to be migrated, and API keys, quotas and OAuth
connections stay where they are: with the owner, who pays for them.

**Members do not sign in with Google, and the reason is not technical.** An agency's employees have
their own Google accounts, and those accounts carry their own Search Console properties — personal
sites, old projects, a friend's shop. Signing a member in through Google would pull that person's
properties into the agency workspace, which is both wrong and something no employee agreed to. Work
and personal must not mix, in either direction: the agency does not want a contractor's blog in its
portfolio, and the contractor does not want the agency's instance holding their private OAuth
tokens.

So a member is invited by email and signs in with a password they set from the invite link, through
a NextAuth Credentials provider. Their account has no Google connection at all — it is a login, not
an identity that owns data. Two rules follow, and they are enforced on the server, not just hidden
in the UI:

- **Only the owner can connect a Google account.** If a client property has to enter the workspace,
  the owner connects it. A member cannot add one, deliberately or accidentally.
- **A Google sign-in that is not the owner's is rejected outright** — it no longer attaches itself
  to the workspace as an extra Search Console connection. That also closes the hole described above
  as a side effect.

```
Owner  ── Google OAuth ──▶  User(id=owner)  ──owns──▶  every Site, metric, key, job
Member ── email+password ─▶  User(id=member) ──Membership(role)──▶ acts on owner's data
```

## 3. Schema

```prisma
model Membership {
  id          String    @id @default(cuid())
  ownerId     String    // the workspace this membership grants access to
  userId      String?   // set once the invite is accepted
  email       String    // invited address, lowercased
  role        String    @default("viewer") // viewer | editor | admin
  status      String    @default("invited") // invited | active | suspended
  inviteHash  String?   @unique // sha-256 of the single-use token; never the token itself
  inviteExpiresAt DateTime?
  invitedById String
  invitedAt   DateTime  @default(now())
  acceptedAt  DateTime?
  lastSeenAt  DateTime?

  @@unique([ownerId, email])
  @@index([userId])
}
```

`User` gains `passwordHash String?` (bcryptjs is already a dependency) and `workspaceName String?`
so "Ruslan's Team" stops being generated in the component. The owner keeps `passwordHash` null and
continues to use Google.

Everything is additive; no existing column changes meaning.

## 4. Roles

| Capability | viewer | editor | admin | owner |
|---|:--:|:--:|:--:|:--:|
| Read every dashboard, report, audit, rank, backlink | ✓ | ✓ | ✓ | ✓ |
| Export, share links | ✓ | ✓ | ✓ | ✓ |
| Run free actions: site audit, sitemap sync, `analyze_text`, Related Intent | | ✓ | ✓ | ✓ |
| Edit content: SEO Tools drafts, Content Operations up to review, Outreach, annotations, tags | | ✓ | ✓ | ✓ |
| Spend money: AI generation/rewrite, `research_keywords`, SERP rank checks, indexer submits | | | ✓ | ✓ |
| Create GitHub pull requests | | | ✓ | ✓ |
| Invite, change roles, suspend members | | | ✓ | ✓ |
| API keys, Google connections, MCP tokens, instance update, delete a site | | | | ✓ |

### The owner is a super admin, and there is exactly one

The first account — the one that connected Google and owns the data — is the super admin. It cannot
be deleted, cannot be demoted, and cannot be suspended, by anyone including itself. Every screen
that lists members renders that row without destructive controls, and the server rejects the
operation as well, so a crafted request cannot orphan a workspace.

Who may act on whom:

| Actor | Can create | Can change role of | Can suspend / remove |
|---|---|---|---|
| Owner | viewer, editor, admin | anyone except themselves | anyone except themselves |
| Admin | viewer, editor | viewer, editor | viewer, editor |
| Editor / viewer | — | — | — |

An admin cannot create, promote, demote or remove another admin. Without that rule two admins can
lock each other out, and the owner discovers it after the fact. Promotion to admin stays an owner
decision, which matches what the role actually grants: the ability to spend the owner's money.

**Ownership transfer** is a separate owner-only action: pick an active admin, confirm, and the two
rows swap roles in one transaction. It exists so the workspace survives the owner leaving the
agency — without it the only path is editing the database by hand.

Two rules make this defensible rather than decorative:

1. **Anything that spends the owner's money needs `admin`.** The app's existing "show the price
   first" contract does not survive a viewer with a Generate button.
2. **Anything that can lock the owner out or leak credentials is owner-only.** Keys, OAuth,
   the update button, and destructive deletes.

## 5. The resolver — the bulk of the work

Today **112 of 134 route handlers** derive identity inline:

```ts
const session = await getServerSession(authOptions);
const userId = (session?.user as any)?.id as string | undefined;
if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
```

That becomes one helper:

```ts
const ws = await getWorkspace();               // { ownerId, actorId, role } | null
if (!ws) return unauthorized();
if (!can(ws, "spend")) return forbidden();     // only where the route spends or mutates
const userId = ws.ownerId;                     // every existing query keeps working unchanged
```

Notes that decide whether this is safe:

- `userId` keeps meaning "the owner", so no query, index or DTO changes. The diff in each route is
  the header, not the body.
- The resolver reads `Membership` on every request, so suspending a member takes effect
  immediately even though sessions are JWT and cannot be revoked.
- `can()` is a pure function over the table in section 4, unit-testable without a database.
- Migration is mechanical but must not be blind: a codemod for the header, then a route-by-route
  review of which capability each one needs. Routes that only read need no gate at all.
- MCP tokens live on `User.mcpToken`. A member's token resolves through the same helper and
  inherits their role, so a viewer's agent cannot start a paid job.

## 6. Creating an account

There are two ways to add a person, and both produce the same `Membership` row. The agency case —
"create a login, give it to the employee, they start working" — is the default.

**A. Admin sets the credentials (default).** The admin enters an email, a role and a starting
password, or takes the generated one. The account works immediately. The password is stored as a
bcrypt hash and the row is marked `mustChangePassword`, so the member is required to set their own
on first sign-in. That last part matters: without it the admin permanently knows a credential that
can act as that person, and "who approved this pull request" stops being answerable. With it, the
starting password is a delivery mechanism, not a shared secret.

**B. Invite link.** For remote contractors, or when the admin would rather not handle a password at
all. A single-use token is generated, only its SHA-256 is stored, and it expires in 72 hours. The
link is shown for copying — Telegram, Slack, anything. No mail server is required.

In both cases:

- Sign-in for members goes through a NextAuth Credentials provider: bcrypt compare, a fixed-cost
  failure path so timing cannot reveal whether the address exists, and a rate limit per IP and per
  email.
- Minimum 12 characters, and the password may not contain the email's local part.
- Suspend or remove takes effect on the next request, because the resolver reads `Membership` every
  time.
- A password reset issues a fresh temporary password or link. Nobody, including the owner, can read
  an existing one.

The Google sign-in callback changes to: allow the owner, allow linking a new Google account **only
while an owner session is active**, reject everything else.

## 7. UI

- Settings → Team becomes real: workspace name, member list with role, status, last seen, the add
  form, role change, suspend, remove. The flag is dropped once it works.
- **The screen explains the roles, on the screen.** A compact reference sits above the member list —
  four rows, one line each on what that role can and cannot do, with the money boundary stated
  plainly ("admin and owner can spend your API credits"). The same one-liner appears next to the
  role selector when adding a person and when changing someone's role, because that is the moment
  the decision is actually made. Nobody should have to open documentation to find out what they are
  granting.
- The owner row shows a crown and no destructive controls, so the "cannot be removed" rule is
  visible rather than discovered by clicking.
- Every screen already reads its own data, so member views need no rewrite. Buttons that a role
  cannot use are hidden, and the server checks the same capability — the hidden button is
  convenience, the server gate is the rule.
- A small "you are viewing <workspace> as <role>" line in the top bar, so nobody misreads whose
  data they are looking at.
- All new strings in the seven locales, as usual.

## 8. Order of work

1. Schema, `can()` and its unit tests. No behaviour change yet.
2. Credentials provider, account creation (both paths), forced first-password change, member
   sign-in. Behind the existing flag.
3. Resolver + codemod across the 112 handlers, reviewed in batches by area (GSC, SEO Tools,
   indexer, settings, MCP). This is where a regression would hurt, so it lands as its own commits.
4. Capability gates on the spend/mutate routes.
5. Real Team UI including the role reference and ownership transfer, i18n, and the flag removed.
6. Harden the Google callback; drop the "any Google account attaches to the owner" path.
7. Documentation: README support contract stops saying single-operator, ARCHITECTURE gets the
   workspace model, MCP-SETUP gets role behaviour for tokens.

Steps 1–2 are self-contained and safe to ship dark. Step 3 is the one that needs a careful review
pass and a full manual run over the app afterwards.

## 9. Deliberately out of scope

- Multi-tenancy. One instance still serves one workspace; members join the owner's, they do not
  bring their own sites — see section 2 for why that is the point rather than a limitation.
- Per-member billing or quotas. The owner's keys pay for everything; `admin` is the boundary.
- SSO, SCIM, 2FA. Reasonable later, not part of a first working version.
- White-label. Unrelated to collaboration and often confused with it.
