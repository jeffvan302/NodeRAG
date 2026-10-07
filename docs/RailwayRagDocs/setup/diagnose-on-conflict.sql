-- Every ON CONFLICT target the upgrade uses, and whether this database
-- actually has a unique constraint that can serve as its arbiter.
with wanted(tbl, cols) as (
  values
    ('public.tenants',                       array['slug']),
    ('public.projects',                      array['tenant_id','slug']),
    ('public.silos',                         array['tenant_id','slug']),
    ('public.provider_access_configs',       array['tenant_id','provider']),
    ('public.provider_secret_refs',          array['tenant_id','provider','key_label']),
    ('public.model_task_configs',            array['tenant_id','scope_key','task_key']),
    ('public.rag_ingestion_settings',        array['tenant_id']),
    ('public.context_management_configs',    array['tenant_id','scope_key']),
    ('public.platform_runtime_settings',     array['tenant_id']),
    ('public.platform_installations',        array['id']),
    ('public.platform_migration_checksums',  array['migration_head']),
    ('public.platform_maintenance_operations', array['request_key']),
    ('public.document_project_memberships',  array['project_id','document_id']),
    ('public.storage_access_configs',        array['tenant_id','kind']),
    ('storage.buckets',                      array['id']),
    ('supabase_migrations.schema_migrations',array['version'])
)
select
  w.tbl,
  array_to_string(w.cols, ', ') as on_conflict_columns,
  coalesce((
    select string_agg(i.relname || case when x.indpred is not null then ' (PARTIAL)' else '' end, ', ')
    from pg_index x
    join pg_class i on i.oid = x.indexrelid
    where x.indrelid = to_regclass(w.tbl)
      and x.indisunique
      and (
        select array_agg(a.attname::text order by a.attname)
        from unnest(x.indkey::int2[]) k(attnum)
        join pg_attribute a on a.attrelid = x.indrelid and a.attnum = k.attnum
      ) = (select array_agg(c order by c) from unnest(w.cols) c)
  ), '*** NONE ***') as matching_unique_index
from wanted w
where to_regclass(w.tbl) is not null
order by 3 = '*** NONE ***' desc, 1;
