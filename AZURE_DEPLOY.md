# Azure Deployment Guide (Zero-touch API)

## Architecture

| Environment | Hosting | Database | Deploys from |
|---|---|---|---|
| Production | Azure App Service (Linux, Node 20) `app-zerotouch-api-prd` — https://app-zerotouch-api-prd-a4cgg3amfecgbear.centralus-01.azurewebsites.net | Azure SQL Database `ZeroTouch` on `sql-zerotouch-prd-01.database.windows.net` | `main` → `.github/workflows/main_app-zerotouch-api-prd.yml` |
| Development | Azure Container Apps | SQL Server (set `DB_*` on the container app) | `develop` → `.github/workflows/deploy-backend-azure.yml` |

Users sign in through Intechsys One
(https://app-intechsysone-api-prd-bxehhkf8dgcwbve9.centralus-01.azurewebsites.net). Consoles:
production https://happy-desert-04a62e310.3.azurestaticapps.net, development
https://witty-mushroom-070e3901e.6.azurestaticapps.net.

## 1) Production: App Service

The workflow runs on every push to `main`: `npm ci`, a boot check (`require('./src/server')`,
which needs no database), `npm ci --omit=dev`, zips `src`, `node_modules` and `package*.json`, and
deploys the zip with `azure/webapps-deploy@v3` (OIDC login with the `AZUREAPPSERVICE_*` secrets).

App Service settings:

- **Stack**: Node 20 LTS. Startup command empty (App Service runs `npm start` → `node src/server.js`).
  The server listens on `PORT`, which App Service sets.
- **Health check path**: `/health` (or `/ready`, which also checks the database).
- `SCM_DO_BUILD_DURING_DEPLOYMENT=false` (the zip already includes `node_modules`).

Application settings the code does **not** default (set them in the portal):

| Name | Value |
|---|---|
| `NODE_ENV` | `production` (enables the production CORS list and checks) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full JSON of the Google Zero-touch service account key (secret — never commit it) |
| `SAMSUNG_KNOX_*` | Only if Knox is used: `SAMSUNG_KNOX_ENABLED=true` plus the credentials (see `.env.example`) |

Everything else has production defaults in `src/config.js` and can be overridden with an app
setting of the same name: `DB_SERVER`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `DB_ENCRYPT`
(or a full `DB_CONNECTION_STRING`), `ONE_BASE_URL`, `ONE_APP_SLUG`, `ZERO_TOUCH_PARTNER_ID`,
`ZERO_TOUCH_BASE_URL`, `CORS_ORIGIN`.

## 2) Database: Azure SQL

The API creates its tables at startup (idempotent; safe with several instances starting at once),
so an empty database is enough. Nothing else to run.

Network: the server has *Deny public network access* enabled, so the App Service must reach it
through a private endpoint (App Service VNet integration + private endpoint for the SQL server +
`privatelink.database.windows.net` DNS zone). Alternatively allow public access with the
"Allow Azure services and resources to access this server" rule.

## 3) Development: Container Apps script

`deploy/azure/deploy.sh` builds the image in ACR and creates/updates a Container App. Required env
vars: `RESOURCE_GROUP`, `LOCATION`, `ACR_NAME`, `CONTAINER_ENV_NAME`, `CONTAINER_APP_NAME`,
`DB_SERVER`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `ZERO_TOUCH_PARTNER_ID`,
`GOOGLE_SERVICE_ACCOUNT_JSON`. Optional: `IMAGE_NAME`, `IMAGE_TAG`, `CORS_ORIGIN`,
`ONE_BASE_URL`, `ONE_APP_SLUG`.

```bash
./deploy/azure/deploy.sh
```

Without `DB_*` variables the API connects to the production database, so the development
Container App must always have them.

## 4) Health checks

- `/health`: liveness
- `/ready`: readiness (runs `SELECT 1` against the database)
