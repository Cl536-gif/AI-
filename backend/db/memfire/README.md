# 已归档的 MemFire 部署草稿

> 正式环境目标已经改为阿里云 PolarDB PostgreSQL 16 Supabase。
> 本目录不再代表当前部署配置；其中 PostgreSQL SQL 草稿可作为迁移来源，
> 但必须先迁入 `db/polardb-supabase/`、复核，并在真实实例上验证。
> 当前状态以 `db/polardb-supabase/README.md` 为准。

## Role

- SQLite remains the local development/regression store.
- PolarDB PostgreSQL Supabase is the only intended production store.
- MCP is not part of this runtime path.

## Historical connection settings (do not use for the new deployment)

Keep secrets in `backend/.env` and never commit them:

```dotenv
MEMFIRE_URL=https://your-project-url
MEMFIRE_SERVICE_ROLE_KEY=your-service-role-key
MEMFIRE_DATABASE_URL=postgresql://... # admin/direct database connection for migrations and transaction tests
USER_STORE_ADAPTER=memfire
```

The first two values are used by the application. `MEMFIRE_DATABASE_URL` is
used only by deployment/verification tooling; SQL migrations and the private
fault-injection harness cannot be executed through the public application RPC.

## Order

1. Apply `001_user_data_schema.sql`.
2. Apply `002_critical_transaction_functions.sql`.
3. Apply the complete public `diet_user_store_execute` dispatcher before
   switching `USER_STORE_ADAPTER=memfire`.
4. Run `900_failure_injection_verification.sql` with an admin/direct connection.

The verification script leaves no test rows behind. Every scenario is wrapped
in an outer transaction and ends with `ROLLBACK`.

## Expected evidence

The report must retain, for each of the three critical transactions:

- state before the call;
- normal call result and state after commit;
- injected failpoint and exact PostgreSQL error;
- state after the failed call, proving every affected table stayed unchanged.

Never describe the cloud transaction test as passed unless the output came
from the real MemFire PostgreSQL project.
