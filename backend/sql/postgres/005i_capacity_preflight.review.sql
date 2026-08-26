-- REVIEW ONLY: 005i PostgreSQL容量与连接聚合只读盘点。
-- 不返回连接地址、查询正文、身份或凭据；不修改任何数据库对象或业务数据。
BEGIN;
SET TRANSACTION READ ONLY;

SELECT
  current_setting('max_connections')::integer AS database_max_connections,
  current_setting('superuser_reserved_connections')::integer
    AS database_superuser_reserved_connections,
  COALESCE((
    SELECT numbackends::integer
    FROM pg_stat_database
    WHERE datname = current_database()
  ), 0) AS current_database_connections,
  count(*) FILTER (
    WHERE datname = current_database()
      AND application_name = 'diet-secretary-backend'
  )::integer AS current_application_connections,
  count(*) FILTER (
    WHERE datname = current_database()
      AND application_name = 'diet-secretary-backend'
      AND state = 'active'
  )::integer AS active_application_connections,
  count(*) FILTER (
    WHERE datname = current_database()
      AND application_name = 'diet-secretary-backend'
      AND wait_event_type IS NOT NULL
  )::integer AS waiting_application_connections
FROM pg_stat_activity;

ROLLBACK;
