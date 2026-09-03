# Azure Deployment Guide (Backend Intechsys)

## Architecture

- Azure Container Apps: Node.js backend
- Azure Database for PostgreSQL Flexible Server
- Azure Key Vault: JWT and Google credentials
- Azure Container Registry (ACR)

## 1) One-command deploy script

Use script:

- deploy/azure/deploy.sh

Required env vars:

- RESOURCE_GROUP
- LOCATION
- ACR_NAME
- CONTAINER_ENV_NAME
- CONTAINER_APP_NAME
- PG_SERVER_NAME
- PG_ADMIN_USER
- PG_ADMIN_PASSWORD
- JWT_SECRET
- ZERO_TOUCH_PARTNER_ID
- GOOGLE_SERVICE_ACCOUNT_JSON

Optional env vars:

- IMAGE_NAME (default: intechsys-backend)
- IMAGE_TAG (default: v1)
- PG_DB_NAME (default: intechsys_zt)
- CORS_ORIGIN (default: *)

Run:

```bash
cd backend_intechsys
./deploy/azure/deploy.sh
```

The script creates/updates:

- Resource group
- ACR + image build
- PostgreSQL flexible server + DB
- Container Apps env
- Container App with secrets and env vars

At the end it prints backend URL.

## 2) Manual commands (alternative)

Set variables:

- RESOURCE_GROUP
- LOCATION
- ACR_NAME
- IMAGE_NAME=intechsys-backend
- IMAGE_TAG=v1

Commands:

```bash
az group create -n $RESOURCE_GROUP -l $LOCATION
az acr create -n $ACR_NAME -g $RESOURCE_GROUP --sku Basic
az acr build -r $ACR_NAME -t $IMAGE_NAME:$IMAGE_TAG .
```

## 3) Create PostgreSQL Flexible Server

```bash
az postgres flexible-server create \
  --resource-group $RESOURCE_GROUP \
  --name intechsys-postgres-prod \
  --location $LOCATION \
  --admin-user pgadmin \
  --admin-password '<strong-password>' \
  --sku-name Standard_B1ms \
  --tier Burstable \
  --storage-size 32
```

Create DB:

```bash
az postgres flexible-server db create \
  --resource-group $RESOURCE_GROUP \
  --server-name intechsys-postgres-prod \
  --database-name intechsys_zt
```

## 4) Create Container Apps environment

```bash
az containerapp env create \
  --name intechsys-env \
  --resource-group $RESOURCE_GROUP \
  --location $LOCATION
```

## 5) Deploy container app

```bash
az containerapp create \
  --name intechsys-backend \
  --resource-group $RESOURCE_GROUP \
  --environment intechsys-env \
  --image $ACR_NAME.azurecr.io/$IMAGE_NAME:$IMAGE_TAG \
  --target-port 8080 \
  --ingress external \
  --registry-server $ACR_NAME.azurecr.io \
  --min-replicas 1 \
  --max-replicas 3 \
  --env-vars \
    NODE_ENV=production \
    PORT=8080 \
    JWT_EXPIRES_IN=8h \
    ZERO_TOUCH_BASE_URL=https://androiddeviceprovisioning.googleapis.com \
    TRUST_PROXY=true
```

## 6) Set secrets and sensitive vars

Use Key Vault and set Container App secrets:

- JWT_SECRET
- DB_URL
- GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS

Then bind secrets as env vars in Container App revision.

## 7) Health checks

Configure readiness/liveness with:

- /health
- /ready

## 8) Flutter app points only to backend URL

Run Flutter with:

```bash
flutter run --dart-define=BACKEND_BASE_URL=https://<your-backend-domain>
```

Never call Google Zero-touch directly from Flutter.

## 9) Validate Zero-touch flow

1. Login:

```bash
curl -X POST https://<your-backend-domain>/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"cliente.demo@intechsys.com","password":"CLI-1001","clientId":"CLI-1001"}'
```

2. Customers with token:

```bash
curl -H "Authorization: Bearer <token>" \
  https://<your-backend-domain>/zerotouch/customers
```
