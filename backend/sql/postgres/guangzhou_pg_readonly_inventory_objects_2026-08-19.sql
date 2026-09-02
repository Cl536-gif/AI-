-- Guangzhou PostgreSQL read-only inventory: database objects.
-- Safety contract: SELECT only. No transaction state, temp objects, DDL or DML.

SELECT 'environment' AS section,
       current_database() AS database_name,
       current_user AS session_user,
       inet_server_addr()::text AS server_address,
       inet_server_port() AS server_port,
       version() AS server_version;

SELECT 'database_capacity' AS section,
       d.datname AS database_name,
       pg_size_pretty(pg_database_size(d.datname)) AS total_size,
       pg_database_size(d.datname) AS total_bytes
FROM pg_database d
WHERE d.datname = current_database();

SELECT 'extensions' AS section,
       e.extname,
       e.extversion,
       n.nspname AS schema_name,
       r.rolname AS owner
FROM pg_extension e
JOIN pg_namespace n ON n.oid = e.extnamespace
JOIN pg_roles r ON r.oid = e.extowner
ORDER BY e.extname;

SELECT 'roles' AS section,
       rolname,
       rolsuper,
       rolinherit,
       rolcreaterole,
       rolcreatedb,
       rolcanlogin,
       rolreplication,
       rolbypassrls,
       rolconnlimit,
       rolvaliduntil
FROM pg_roles
ORDER BY rolname;

SELECT 'role_memberships' AS section,
       member.rolname AS member_name,
       granted.rolname AS granted_role,
       m.admin_option
FROM pg_auth_members m
JOIN pg_roles granted ON granted.oid = m.roleid
JOIN pg_roles member ON member.oid = m.member
ORDER BY member.rolname, granted.rolname;

SELECT 'schemas' AS section,
       n.nspname AS schema_name,
       r.rolname AS owner,
       n.nspacl::text AS acl
FROM pg_namespace n
JOIN pg_roles r ON r.oid = n.nspowner
WHERE n.nspname = 'app'
ORDER BY n.nspname;

SELECT 'tables' AS section,
       n.nspname AS schema_name,
       c.relname AS table_name,
       r.rolname AS owner,
       c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS force_rls,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
       pg_total_relation_size(c.oid) AS total_bytes
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_roles r ON r.oid = c.relowner
WHERE n.nspname = 'app'
  AND c.relkind = 'r'
ORDER BY c.relname;

SELECT 'sequences' AS section,
       schemaname AS schema_name,
       sequencename AS sequence_name,
       sequenceowner AS owner,
       data_type,
       start_value,
       min_value,
       max_value,
       increment_by,
       cycle,
       cache_size,
       last_value
FROM pg_sequences
WHERE schemaname = 'app'
ORDER BY sequencename;

SELECT 'functions' AS section,
       n.nspname AS schema_name,
       p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS identity_arguments,
       pg_get_function_result(p.oid) AS result_type,
       r.rolname AS owner,
       l.lanname AS language,
       p.prosecdef AS security_definer,
       p.provolatile AS volatility,
       p.proacl::text AS acl,
       md5(pg_get_functiondef(p.oid)) AS definition_md5
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
JOIN pg_roles r ON r.oid = p.proowner
JOIN pg_language l ON l.oid = p.prolang
WHERE n.nspname = 'app'
ORDER BY p.proname, pg_get_function_identity_arguments(p.oid);

SELECT 'rls_policies' AS section,
       schemaname AS schema_name,
       tablename AS table_name,
       policyname AS policy_name,
       permissive,
       roles,
       cmd,
       qual,
       with_check
FROM pg_policies
WHERE schemaname = 'app'
ORDER BY tablename, policyname;

SELECT 'table_grants' AS section,
       table_schema,
       table_name,
       grantee,
       privilege_type,
       is_grantable
FROM information_schema.role_table_grants
WHERE table_schema = 'app'
ORDER BY table_name, grantee, privilege_type;

SELECT 'routine_grants' AS section,
       routine_schema,
       routine_name,
       specific_name,
       grantee,
       privilege_type,
       is_grantable
FROM information_schema.role_routine_grants
WHERE routine_schema = 'app'
ORDER BY routine_name, specific_name, grantee, privilege_type;

