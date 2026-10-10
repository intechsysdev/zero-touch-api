# Zero-touch API & Deployment (Intechsys)

Node.js + Express backend providing multi-tenant authentication, device provisioning, and management bridging Google Android Zero-touch Provisioning and Samsung Knox Cloud Services.

## Tech Stack

- **Node.js** + **Express**
- **SQL Server** (Azure SQL Database in production, `mssql`/tedious driver; local container for development)
- **JWT** (JSON Web Tokens)
- **Google Auth Library** (`googleapis`)
- **Samsung Knox Cloud Services API**
- **Azure App Service** (production) & **Azure Container Apps** (development)

## Repository Structure

```
├── deploy/azure/deploy.sh      # Container Apps deployment script (development environment)
├── scripts/                    # Admin CLI tools (create client, list devices, onboard client)
├── secrets/README.md           # Instructions for service account keys
├── src/
│   ├── plataformas.js          # Client ID → Zero-touch / Knox customer detection
│   ├── config.js               # Centralized configuration & environment loader
│   ├── db.js                   # SQL Server schema & connection pool
│   ├── middleware/             # One auth, tenant resolution & rate-limiting
│   ├── one/                    # Intechsys One client (auth/me, tenants, config)
│   ├── session/                # /api/v1/sesion and the SSO proxy (/api/v1/sso)
│   ├── samsung/                # Samsung Knox client & routes
│   ├── server.js               # Express application entrypoint
│   └── zerotouch/              # Google Zero-touch client, routes & synchronization
├── Dockerfile                  # Production container image definition
├── docker-compose.yml          # Local SQL Server + API orchestration
└── AZURE_DEPLOY.md             # Azure deployment guide (App Service + Azure SQL)
```

## Environment Configuration

Copy the template to create your `.env` file:

```bash
cp .env.example .env
```

Key variables:

| Variable | Description |
|---|---|
| `PORT` | Server listening port (default: `8080`) |
| `NODE_ENV` | `development` or `production` |
| `JWT_SECRET` | Secret key for signing tokens |
| `DB_SERVER`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | SQL Server connection (default: production Azure SQL). Also `DB_PORT`, `DB_ENCRYPT`, `DB_TRUST_SERVER_CERTIFICATE` |
| `DB_CONNECTION_STRING` | Optional `Server=...;Database=...;User Id=...;Password=...;Encrypt=true`; overrides the `DB_*` values |
| `ZERO_TOUCH_PARTNER_ID` | Google Zero-touch Partner ID |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google service account JSON string or secret |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to Google service account credentials file |
| `CORS_ORIGIN` | Allowed CORS origins (`*` or comma-separated domains). Unset: `*` in development; in production the consoles (prod and dev), the One portal and `localhost:5173` |

## Local Development

### 1. Start SQL Server with Docker

```bash
docker compose up -d sqlserver
```

The container creates the `ZeroTouch` database; the API creates its tables on startup. Point the
API at it with the `DB_*` values from `.env.example` (without them it uses the production database).

### 2. Install dependencies & run

```bash
npm install
npm run start
```

API will be running on `http://localhost:8080`.

### Health Check

- `GET /health`: Basic service liveness
- `GET /ready`: Readiness check (verifies database connectivity)

## Endpoints Overview

### Authentication (Intechsys One)

Users sign in through Intechsys One; there is no local login (`POST /auth/login` answers 410).

1. The console asks for the customer's **Client ID** and sends the user to One's `/autorizar`
   with `client_id=zero-touch` and `tenant_hint=<Client ID>` (OAuth code + PKCE).
2. One authenticates the user and picks the company whose zero-touch variable marked
   *"Identifica a la empresa al iniciar sesión"* (e.g. `RESELLER_PARTNER_ID`, "Partner ID de
   Reseller") has that value. The user must be a member of that company.
3. The console exchanges the code through this API (`POST /api/v1/sso/token`, forwarded to One)
   and calls the API with `Authorization: Bearer <One token>` and `X-Tenant-Id`.

- `POST /api/v1/sso/token` / `POST /api/v1/sso/logout`: forwarded to One server-to-server.
- `GET /api/v1/sesion`: user, companies (with their Client ID) and the active company with
  `clientId`, `zeroTouchAvailable`, `zeroTouchCustomerId`, `samsungAvailable`, `samsungCustomerId`.

The Client ID must match exactly the customer's `companyId` in Zero-touch (or its Knox customer
ID). If a customer's Zero-touch ID differs, set `ZERO_TOUCH_CUSTOMER_ID` for the company in One.

### Android Zero-touch (requires `Authorization: Bearer <token>`)
- `GET /zerotouch/customers`: List the reseller's customers (platform admins only)
- `GET /zerotouch/devices?customerId=...`: List provisioned devices
- `GET /zerotouch/devices/identifier-options`: List available manufacturers and models
- `GET /zerotouch/devices/buscar?imei=…` (or `?serialNumber=…&manufacturer=…&model=…`): look up one device in Zero-touch; 404 unless it belongs to the company's customer
- `POST /zerotouch/devices/claim`: Claim single device (IMEI, or serial + manufacturer + model). An optional `configurationId` is applied after the claim (`customers.devices.applyConfiguration`); if that fails the device stays claimed and `configuracion.error` says why
- `POST /zerotouch/devices/claim/bulk`: Bulk claim devices
- `POST /zerotouch/devices/unclaim`: Unclaim device — only if it belongs to the company's customer (Google's unclaim doesn't check the owner)

### Samsung Knox (requires `Authorization: Bearer <token>`)
- `GET /samsung/devices`: List Knox devices
- `POST /samsung/devices/claim/bulk`: Bulk upload/claim Samsung devices
- `POST /samsung/devices/unclaim`: Unclaim Samsung device

## Azure Production Deployment

Production runs on Azure App Service (`app-zerotouch-api-prd`) with Azure SQL Database and deploys
automatically on every push to `main` (`.github/workflows/main_app-zerotouch-api-prd.yml`).
The development environment (Container Apps) deploys from `develop`. See
[AZURE_DEPLOY.md](AZURE_DEPLOY.md), including the App Service settings that must be set by hand.
