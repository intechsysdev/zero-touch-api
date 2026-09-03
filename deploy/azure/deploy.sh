#!/usr/bin/env bash
set -euo pipefail

: "${RESOURCE_GROUP:?RESOURCE_GROUP is required}"
: "${LOCATION:?LOCATION is required}"
: "${ACR_NAME:?ACR_NAME is required}"
: "${CONTAINER_ENV_NAME:?CONTAINER_ENV_NAME is required}"
: "${CONTAINER_APP_NAME:?CONTAINER_APP_NAME is required}"
: "${PG_SERVER_NAME:?PG_SERVER_NAME is required}"
: "${PG_ADMIN_USER:?PG_ADMIN_USER is required}"
: "${PG_ADMIN_PASSWORD:?PG_ADMIN_PASSWORD is required}"
: "${JWT_SECRET:?JWT_SECRET is required}"
: "${ZERO_TOUCH_PARTNER_ID:?ZERO_TOUCH_PARTNER_ID is required}"
: "${GOOGLE_SERVICE_ACCOUNT_JSON:?GOOGLE_SERVICE_ACCOUNT_JSON is required}"

IMAGE_NAME=${IMAGE_NAME:-intechsys-backend}
IMAGE_TAG=${IMAGE_TAG:-v1}
PG_DB_NAME=${PG_DB_NAME:-intechsys_zt}
CORS_ORIGIN=${CORS_ORIGIN:-*}

az group create -n "$RESOURCE_GROUP" -l "$LOCATION" >/dev/null

if ! az acr show -n "$ACR_NAME" -g "$RESOURCE_GROUP" >/dev/null 2>&1; then
  az acr create -n "$ACR_NAME" -g "$RESOURCE_GROUP" --sku Basic >/dev/null
fi

az acr build -r "$ACR_NAME" -t "$IMAGE_NAME:$IMAGE_TAG" .

if ! az postgres flexible-server show -g "$RESOURCE_GROUP" -n "$PG_SERVER_NAME" >/dev/null 2>&1; then
  az postgres flexible-server create \
    --resource-group "$RESOURCE_GROUP" \
    --name "$PG_SERVER_NAME" \
    --location "$LOCATION" \
    --admin-user "$PG_ADMIN_USER" \
    --admin-password "$PG_ADMIN_PASSWORD" \
    --sku-name Standard_B1ms \
    --tier Burstable \
    --storage-size 32 >/dev/null
fi

az postgres flexible-server db create \
  --resource-group "$RESOURCE_GROUP" \
  --server-name "$PG_SERVER_NAME" \
  --name "$PG_DB_NAME" >/dev/null

if ! az containerapp env show -g "$RESOURCE_GROUP" -n "$CONTAINER_ENV_NAME" >/dev/null 2>&1; then
  az containerapp env create \
    --name "$CONTAINER_ENV_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" >/dev/null
fi

DB_URL="postgres://${PG_ADMIN_USER}:${PG_ADMIN_PASSWORD}@${PG_SERVER_NAME}.postgres.database.azure.com:5432/${PG_DB_NAME}?sslmode=require"
IMAGE_REF="${ACR_NAME}.azurecr.io/${IMAGE_NAME}:${IMAGE_TAG}"

if ! az containerapp show -g "$RESOURCE_GROUP" -n "$CONTAINER_APP_NAME" >/dev/null 2>&1; then
  az containerapp create \
    --name "$CONTAINER_APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --environment "$CONTAINER_ENV_NAME" \
    --image "$IMAGE_REF" \
    --target-port 8080 \
    --ingress external \
    --registry-server "${ACR_NAME}.azurecr.io" \
    --min-replicas 1 \
    --max-replicas 3 \
    --secrets \
      jwt-secret="$JWT_SECRET" \
      db-url="$DB_URL" \
      google-sa-json="$GOOGLE_SERVICE_ACCOUNT_JSON" \
    --env-vars \
      NODE_ENV=production \
      PORT=8080 \
      JWT_EXPIRES_IN=8h \
      ZERO_TOUCH_BASE_URL=https://androiddeviceprovisioning.googleapis.com/v1 \
      ZERO_TOUCH_PARTNER_ID="$ZERO_TOUCH_PARTNER_ID" \
      CORS_ORIGIN="$CORS_ORIGIN" \
      TRUST_PROXY=true \
      JWT_SECRET=secretref:jwt-secret \
      DB_URL=secretref:db-url \
      GOOGLE_SERVICE_ACCOUNT_JSON=secretref:google-sa-json >/dev/null
else
  az containerapp update \
    --name "$CONTAINER_APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --image "$IMAGE_REF" \
    --set-env-vars \
      NODE_ENV=production \
      PORT=8080 \
      JWT_EXPIRES_IN=8h \
      ZERO_TOUCH_BASE_URL=https://androiddeviceprovisioning.googleapis.com/v1 \
      ZERO_TOUCH_PARTNER_ID="$ZERO_TOUCH_PARTNER_ID" \
      CORS_ORIGIN="$CORS_ORIGIN" \
      TRUST_PROXY=true >/dev/null

  az containerapp secret set \
    --name "$CONTAINER_APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --secrets \
      jwt-secret="$JWT_SECRET" \
      db-url="$DB_URL" \
      google-sa-json="$GOOGLE_SERVICE_ACCOUNT_JSON" >/dev/null

  az containerapp update \
    --name "$CONTAINER_APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --set-env-vars \
      JWT_SECRET=secretref:jwt-secret \
      DB_URL=secretref:db-url \
      GOOGLE_SERVICE_ACCOUNT_JSON=secretref:google-sa-json >/dev/null
fi

FQDN=$(az containerapp show -g "$RESOURCE_GROUP" -n "$CONTAINER_APP_NAME" --query properties.configuration.ingress.fqdn -o tsv)
echo "Backend deployed: https://${FQDN}"
