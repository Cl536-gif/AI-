# PolarDB PostgreSQL Supabase deployment status

## Confirmed architecture

- SQLite remains the local development and regression-test store.
- PolarDB PostgreSQL 16 Supabase is the intended production store.
- The application uses `@supabase/supabase-js` through `SupabaseUserStore`.
- MCP is not part of the runtime path.

## Compatibility

This product uses PolarDB PostgreSQL 16 and a managed Supabase application
layer based on PostgREST. The existing PostgreSQL schema, PL/pgSQL transaction
functions and RPC adapter remain the correct technical direction. They still
must be reviewed and deployed against the real cluster before production use.

The following production work is still required before changing
`USER_STORE_ADAPTER`:

1. Review and apply the PostgreSQL user-data schema.
2. Implement the public `diet_user_store_execute` RPC dispatcher as the single
   server-side transaction boundary.
3. Rebuild the three critical atomic operations: profile update, initial-plan
   activation, and identity merge.
4. Run normal-commit and injected-failure rollback tests against the real cloud
   instance and retain the exact output.

Never describe cloud persistence or transaction rollback as verified until
those tests run against the real PolarDB PostgreSQL Supabase project.
