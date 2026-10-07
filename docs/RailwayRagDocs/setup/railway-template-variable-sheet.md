# Railway Template Variable Sheet

Generated from `platform/railway-template.v1.json` by
`node scripts/print-template-sheet.mjs`. Do not edit by hand: regenerate it
when the template specification changes.

Paste each value exactly, including the `${{...}}` reference syntax. A value in
parentheses is an instruction, not something to type.

10 canonical shared variables and 47 service bindings/settings across 8 services.

| Variable | Description | Value |
| --- | --- | --- |
| `shared.ADMIN_AUTH_ENABLED` | Fail-closed switch for issuing new browser login sessions. Set false to lock browser login without disabling API keys or opening protected routes. | `true` |
| `shared.ADMIN_SESSION_SECRET` | Root used to sign admin/user sessions and derive private service credentials and local-vault encryption. | `${{ secret(48) }}` |
| `shared.ADMIN_SETUP_ENABLED` | Fail-closed switch for administrator setup and recovery token use. Set false after setup unless recovery is needed. | `true` |
| `shared.ADMIN_SETUP_TOKEN` | One-time administrator setup and recovery token. Rotate it to recover access. | `${{ secret(32) }}` |
| `shared.BACKUP_ENCRYPTION_KEY` | Installation recovery credential used to encrypt every S3 backup and database-transfer archive. | `${{ secret(48) }}` |
| `shared.POSTGREST_AUTHENTICATOR_PASSWORD` | Generated login credential used only between private PostgREST and PostgreSQL. | `${{ secret(48) }}` |
| `shared.POSTGREST_JWT_SECRET` | PostgREST JWT signing root shared only with PostgREST and Maintenance registration. | `${{ secret(48) }}` |
| `shared.RAILWAY_POSTGRES_PASSWORD` | Generated owner password shared only by the private PostgreSQL service and Maintenance bootstrap reconciliation. | `${{ secret(48) }}` |
| `shared.RAILWAY_POSTGREST_BASE_URL` | Private address of the installation-local PostgREST data API. | `http://postgrest.railway.internal:3000` |
| `shared.SETTINGS_SERVICE_URL` | Private address of the installation-local encrypted settings vault. | `http://${{settings.RAILWAY_PRIVATE_DOMAIN}}:8082` |
| `web.ADMIN_AUTH_ENABLED` | Allows new browser login sessions. Set false to lock login without disabling API-key access or opening protected routes. | `${{ shared.ADMIN_AUTH_ENABLED }}` |
| `web.ADMIN_SESSION_SECRET` | Signs administrator session cookies. Changing it logs everyone out. | `${{ shared.ADMIN_SESSION_SECRET }}` |
| `web.ADMIN_SETUP_ENABLED` | Allows the setup/recovery token to be used. Set false after setup and true again only for deliberate recovery. | `${{ shared.ADMIN_SETUP_ENABLED }}` |
| `web.ADMIN_SETUP_TOKEN` | One-time passphrase for creating the first administrator. Shown after deploy and consumed on use. | `${{ shared.ADMIN_SETUP_TOKEN }}` |
| `web.PORT` | Port this service listens on, pinned so other services reach it at a known address. | `8080` |
| `web.SETTINGS_SERVICE_URL` | Private HTTP URL for the settings service; never publicly exposed. | `${{ shared.SETTINGS_SERVICE_URL }}` |
| `worker.ADMIN_SESSION_SECRET` | Signs administrator session cookies. Changing it logs everyone out. | `${{ shared.ADMIN_SESSION_SECRET }}` |
| `worker.SETTINGS_SERVICE_URL` | Private HTTP URL for the settings service; never publicly exposed. | `${{ shared.SETTINGS_SERVICE_URL }}` |
| `maintenance.ADMIN_SESSION_SECRET` | Signs administrator session cookies. Changing it logs everyone out. | `${{ shared.ADMIN_SESSION_SECRET }}` |
| `maintenance.BACKUP_ENCRYPTION_KEY` | Cryptographically random value of at least 32 characters. Transfer, manual, and scheduled archives fail closed when it is absent. | `${{ shared.BACKUP_ENCRYPTION_KEY }}` |
| `maintenance.PORT` | Port this service listens on, pinned so other services reach it at a known address. | `8081` |
| `maintenance.POSTGREST_JWT_SECRET` | At least 32 random characters generated once; never stored in Settings or sent as a bearer token. | `${{ shared.POSTGREST_JWT_SECRET }}` |
| `maintenance.RAILWAY_POSTGRES_DATABASE` | Non-empty database name referenced from the PostgreSQL service POSTGRES_DB value. | `${{postgres.POSTGRES_DB}}` |
| `maintenance.RAILWAY_POSTGRES_HOST` | Railway private DNS name ending in .railway.internal; public database hosts are refused by bootstrap. | `${{postgres.RAILWAY_PRIVATE_DOMAIN}}` |
| `maintenance.RAILWAY_POSTGRES_PASSWORD` | At least 32 random characters, generated once by the Railway template and shared only with Maintenance and PostgreSQL. | `${{ shared.RAILWAY_POSTGRES_PASSWORD }}` |
| `maintenance.RAILWAY_POSTGRES_PORT` | Valid TCP port referenced from the PostgreSQL service PGPORT value. | `${{postgres.PGPORT}}` |
| `maintenance.RAILWAY_POSTGRES_TLS_MODE` | One of disable, prefer, require, or verify_full. Railway private networking defaults to disable. | `disable` |
| `maintenance.RAILWAY_POSTGRES_USER` | Non-empty owner role referenced from the PostgreSQL service POSTGRES_USER value. | `${{postgres.POSTGRES_USER}}` |
| `maintenance.RAILWAY_POSTGREST_BASE_URL` | Private HTTP railway.internal URL for the supervised PostgREST endpoint. | `${{ shared.RAILWAY_POSTGREST_BASE_URL }}` |
| `maintenance.SETTINGS_SERVICE_URL` | Private HTTP URL for the settings service; never publicly exposed. | `${{ shared.SETTINGS_SERVICE_URL }}` |
| `scheduler.ADMIN_SESSION_SECRET` | Signs administrator session cookies. Changing it logs everyone out. | `${{ shared.ADMIN_SESSION_SECRET }}` |
| `scheduler.SETTINGS_SERVICE_URL` | Private HTTP URL for the settings service; never publicly exposed. | `${{ shared.SETTINGS_SERVICE_URL }}` |
| `embeddings.ADMIN_SESSION_SECRET` | Signs administrator session cookies. Changing it logs everyone out. | `${{ shared.ADMIN_SESSION_SECRET }}` |
| `embeddings.PORT` | Port this service listens on, pinned so other services reach it at a known address. | `8080` |
| `embeddings.SETTINGS_SERVICE_URL` | Private HTTP URL for the settings service; never publicly exposed. | `${{ shared.SETTINGS_SERVICE_URL }}` |
| `settings.ADMIN_SESSION_SECRET` | Signs administrator session cookies. Changing it logs everyone out. | `${{ shared.ADMIN_SESSION_SECRET }}` |
| `settings.PORT` | Port this service listens on, pinned so other services reach it at a known address. | `8082` |
| `postgrest.ADMIN_SESSION_SECRET` | Signs administrator session cookies. Changing it logs everyone out. | `${{ shared.ADMIN_SESSION_SECRET }}` |
| `postgrest.PORT` | Port this service listens on, pinned so other services reach it at a known address. | `3000` |
| `postgrest.POSTGREST_AUTHENTICATOR_PASSWORD` | At least 32 random characters generated once and available only to the PostgREST supervisor. | `${{ shared.POSTGREST_AUTHENTICATOR_PASSWORD }}` |
| `postgrest.POSTGREST_JWT_SECRET` | At least 32 random characters generated once; never stored in Settings or sent as a bearer token. | `${{ shared.POSTGREST_JWT_SECRET }}` |
| `postgrest.RAILWAY_DOCKERFILE_PATH` | Repository-relative path to an existing Dockerfile. | `Dockerfile.postgrest` |
| `postgrest.RAILWAY_POSTGRES_DATABASE` | Non-empty database name referenced from the PostgreSQL service POSTGRES_DB value. | `${{postgres.POSTGRES_DB}}` |
| `postgrest.RAILWAY_POSTGRES_HOST` | Railway private DNS name ending in .railway.internal; public database hosts are refused by bootstrap. | `${{postgres.RAILWAY_PRIVATE_DOMAIN}}` |
| `postgrest.RAILWAY_POSTGRES_PASSWORD` | At least 32 random characters, generated once by the Railway template and shared only with Maintenance and PostgreSQL. | `${{ shared.RAILWAY_POSTGRES_PASSWORD }}` |
| `postgrest.RAILWAY_POSTGRES_PORT` | Valid TCP port referenced from the PostgreSQL service PGPORT value. | `${{postgres.PGPORT}}` |
| `postgrest.RAILWAY_POSTGRES_TLS_MODE` | One of disable, prefer, require, or verify_full. Railway private networking defaults to disable. | `disable` |
| `postgrest.RAILWAY_POSTGRES_USER` | Non-empty owner role referenced from the PostgreSQL service POSTGRES_USER value. | `${{postgres.POSTGRES_USER}}` |
| `postgrest.SETTINGS_SERVICE_URL` | Private HTTP URL for the settings service; never publicly exposed. | `${{ shared.SETTINGS_SERVICE_URL }}` |
| `postgres.PGDATA` | Child directory of the Railway volume mount at /var/lib/postgresql/data. | `/var/lib/postgresql/data/pgdata` |
| `postgres.PGPORT` | Valid PostgreSQL TCP port. | `5432` |
| `postgres.POSTGRES_DB` | Valid PostgreSQL database name. | `bubble_rag` |
| `postgres.POSTGRES_INITDB_ARGS` | Initialization flags that enable data checksums and UTF-8 on a new cluster. | `--data-checksums --encoding=UTF8` |
| `postgres.POSTGRES_PASSWORD` | Direct reference to the generated RAILWAY_POSTGRES_PASSWORD shared variable; never a literal template value. | `${{ shared.RAILWAY_POSTGRES_PASSWORD }}` |
| `postgres.POSTGRES_USER` | Valid PostgreSQL owner role name. | `bubble_rag_owner` |
| `postgres.RAILWAY_DOCKERFILE_PATH` | Repository-relative path to an existing Dockerfile. | `Dockerfile.postgres` |
| `postgres.RAILWAY_RUN_UID` | Run the official entrypoint as root initially so it can establish ownership on Railway's root-owned volume before dropping to postgres. | `0` |

## Do not add these

Railway supplies them to every deployment. Setting one overrides the real
value, and overriding the project or environment id defeats the check that
stops one project's promotion from redeploying another.

```
embeddings.RAILWAY_ENVIRONMENT
maintenance.RAILWAY_ENVIRONMENT_ID
maintenance.RAILWAY_ENVIRONMENT_NAME
maintenance.RAILWAY_GIT_COMMIT_SHA
maintenance.RAILWAY_PROJECT_ID
maintenance.RAILWAY_PROJECT_NAME
maintenance.RAILWAY_SERVICE_ID
maintenance.RAILWAY_SERVICE_NAME
postgrest.RAILWAY_ENVIRONMENT
scheduler.RAILWAY_ENVIRONMENT
settings.RAILWAY_ENVIRONMENT
settings.RAILWAY_GIT_COMMIT_SHA
web.RAILWAY_ENVIRONMENT
worker.RAILWAY_ENVIRONMENT
```
