# Zero-touch API & Deployment (Intechsys)

Node.js + Express backend providing multi-tenant authentication, device provisioning, and management bridging Google Android Zero-touch Provisioning and Samsung Knox Cloud Services.

## Tech Stack

- **Node.js** + **Express**
- **PostgreSQL** (Azure Database for PostgreSQL Flexible Server or local container)
- **JWT** (JSON Web Tokens)
- **Google Auth Library** (`googleapis`)
- **Samsung Knox Cloud Services API**
- **Docker** & **Azure Container Apps**

## Repository Structure

```
├── deploy/azure/deploy.sh      # Azure deployment script (ACR, PostgreSQL, Container Apps)
├── scripts/                    # Admin CLI tools (create client, list devices, onboard client)
├── secrets/README.md           # Instructions for service account keys
├── src/
│   ├── plataformas.js          # Client ID → Zero-touch / Knox customer detection
│   ├── config.js               # Centralized configuration & environment loader
│   ├── db.js                   # PostgreSQL schema & connection pool
│   ├── middleware/             # One auth, tenant resolution & rate-limiting
│   ├── one/                    # Intechsys One client (auth/me, tenants, config)
│   ├── session/                # /api/v1/sesion and the SSO proxy (/api/v1/sso)
│   ├── samsung/                # Samsung Knox client & routes
│   ├── server.js               # Express application entrypoint
│   └── zerotouch/              # Google Zero-touch client, routes & synchronization
├── Dockerfile                  # Production container image definition
├── docker-compose.yml          # Local PostgreSQL + API orchestration
└── AZURE_DEPLOY.md             # Complete step-by-step Azure deployment guide
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
| `DB_URL` | PostgreSQL connection string |
| `ZERO_TOUCH_PARTNER_ID` | Google Zero-touch Partner ID |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Google service account JSON string or secret |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to Google service account credentials file |
| `CORS_ORIGIN` | Allowed CORS origins (`*` or comma-separated domains) |

## Local Development

### 1. Start PostgreSQL with Docker

```bash
docker compose up -d postgres
```

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

To deploy the entire stack to Azure (Container Registry, Flexible Server PostgreSQL, and Container Apps), follow [AZURE_DEPLOY.md](AZURE_DEPLOY.md) or run:

```bash
./deploy/azure/deploy.sh
```
