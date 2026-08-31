# Staging environment

A second, fully separate copy of the Worker's data (own `TENANTS`/`BOOKINGS`
KV, own `LEDGER_DB`) for trying feature work before it touches a real
client. Same codebase, same `src/`, deployed via `wrangler.toml`'s
`[env.staging]` block — one Worker script, two independent runtime configs.

## What's already done

- `TENANTS-staging` KV namespace (id `e37d25ba95f84456b9b0b13de2ad6757`)
- `BOOKINGS-staging` KV namespace (id `af89eb524ae84cc0845caefbf70dfc98`)
- `homs-ledger-staging` D1 database (id `051289d3-0730-427f-8052-5166c01cabd2`),
  schema applied from `schema/homs_ledger_schema.sql`
- `[env.staging]` section in `wrangler.toml` wiring all three to a
  `homs-invoicing-worker-0e0e-staging` Worker name
- `staging` git branch, created off `main`

## What you still need to do (one-time, manual)

Cloudflare's dashboard doesn't expose a "create a new Worker" API — this
part has to be clicked through by hand:

1. **Workers & Pages → Create → Worker.** Name it exactly
   `homs-invoicing-worker-0e0e-staging` (must match `wrangler.toml`'s
   `[env.staging] name`, or the bindings below won't attach to it).
2. **Settings → Build → Connect to Git**, same `firecracker80/homs-invoicing-worker`
   repo, but set the **branch to `staging`** (not `main`) and the **deploy
   command to** `npx wrangler deploy --env staging` (not the bare
   `npx wrangler deploy` production uses — without `--env staging` it'll
   deploy the production config to this worker instead).
3. Push once to `staging` (see below) to confirm the build fires and the
   new Worker comes up at
   `https://homs-invoicing-worker-0e0e-staging.yari-058.workers.dev`.

## Day-to-day: using it

Add a `TENANTS-staging` entry the same way you'd onboard any client (see
`ONBOARDING.md`), but **never point it at a real tenant's live GHL PIT,
PayPal live credentials, or production Airtable base.** Use a sandbox GHL
sub-account, PayPal *sandbox* app, and either a throwaway Airtable base or
none at all. The point of staging is that breaking it costs nothing —
don't undercut that by wiring it to anything real.

Work on a feature branch off `staging` (or commit to `staging` directly for
small things), push, let Workers Builds deploy it, test against the
staging Worker's URL. Nothing here ever reaches a real client until you
promote it.

## Promoting to production

Once a change is verified on staging:

```bash
git checkout main
git pull origin main
git merge staging
git push origin main
```

This is a normal merge — `main`'s Workers Build fires automatically and
ships to production the same way it always has. `staging` doesn't need to
be reset after; the next round of feature work just keeps branching from
wherever `staging` currently sits (or you can fast-forward it to `main`
first with `git checkout staging && git merge main && git push origin staging`
if you want it to start clean).

## Guardrail

Config in `[env.staging]` only takes effect when the Worker is deployed
with `--env staging`. If you ever deploy by hand instead of through Workers
Builds, double-check which command you're running — `npx wrangler deploy`
with no flag always means production.
