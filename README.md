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
│   ├── auth.service.js         # Authentication & JWT issuance
│   ├── config.js               # Centralized configuration & environment loader
│   ├── db.js                   # PostgreSQL schema & connection pool
│   ├── middleware/             # Auth & rate-limiting middleware
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

### Authentication
- `POST /auth/login`
  - Body: `{ "email": "...", "clientId": "CLI-1001", "password": "..." }`
  - Returns JWT access token, company name, customer IDs, and available platforms.

### Android Zero-touch (requires `Authorization: Bearer <token>`)
- `GET /zerotouch/customers`: List accessible customers
- `GET /zerotouch/devices?customerId=...`: List provisioned devices
- `GET /zerotouch/devices/identifier-options`: List available manufacturers and models
- `POST /zerotouch/devices/claim`: Claim single device
- `POST /zerotouch/devices/claim/bulk`: Bulk claim devices
- `POST /zerotouch/devices/unclaim`: Unclaim device

### Samsung Knox (requires `Authorization: Bearer <token>`)
- `GET /samsung/devices`: List Knox devices
- `POST /samsung/devices/claim/bulk`: Bulk upload/claim Samsung devices
- `POST /samsung/devices/unclaim`: Unclaim Samsung device

## Azure Production Deployment

To deploy the entire stack to Azure (Container Registry, Flexible Server PostgreSQL, and Container Apps), follow [AZURE_DEPLOY.md](AZURE_DEPLOY.md) or run:

```bash
./deploy/azure/deploy.sh
```
