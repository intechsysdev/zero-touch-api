#!/usr/bin/env bash
# Despliegue en Azure Container Apps (ambiente de desarrollo). Producción corre en App Service
# (app-zerotouch-api-prd) y se despliega con .github/workflows/main_app-zerotouch-api-prd.yml.
# La base de datos es SQL Server: este script no la crea, solo le dice al contenedor cómo llegar.
set -euo pipefail

: "${RESOURCE_GROUP:?RESOURCE_GROUP is required}"
: "${LOCATION:?LOCATION is required}"
: "${ACR_NAME:?ACR_NAME is required}"
: "${CONTAINER_ENV_NAME:?CONTAINER_ENV_NAME is required}"
: "${CONTAINER_APP_NAME:?CONTAINER_APP_NAME is required}"
: "${DB_SERVER:?DB_SERVER is required}"
: "${DB_NAME:?DB_NAME is required}"
: "${DB_USER:?DB_USER is required}"
: "${DB_PASSWORD:?DB_PASSWORD is required}"
: "${ZERO_TOUCH_PARTNER_ID:?ZERO_TOUCH_PARTNER_ID is required}"
: "${GOOGLE_SERVICE_ACCOUNT_JSON:?GOOGLE_SERVICE_ACCOUNT_JSON is required}"

IMAGE_NAME=${IMAGE_NAME:-intechsys-backend}
IMAGE_TAG=${IMAGE_TAG:-v1}
CORS_ORIGIN=${CORS_ORIGIN:-*}
ONE_BASE_URL=${ONE_BASE_URL:-https://app-intechsysone-api-prd-bxehhkf8dgcwbve9.centralus-01.azurewebsites.net}
ONE_APP_SLUG=${ONE_APP_SLUG:-zero-touch}

az group create -n "$RESOURCE_GROUP" -l "$LOCATION" >/dev/null

if ! az acr show -n "$ACR_NAME" -g "$RESOURCE_GROUP" >/dev/null 2>&1; then
  az acr create -n "$ACR_NAME" -g "$RESOURCE_GROUP" --sku Basic >/dev/null
fi

az acr build -r "$ACR_NAME" -t "$IMAGE_NAME:$IMAGE_TAG" .

if ! az containerapp env show -g "$RESOURCE_GROUP" -n "$CONTAINER_ENV_NAME" >/dev/null 2>&1; then
  az containerapp env create \
    --name "$CONTAINER_ENV_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" >/dev/null
fi

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
      db-password="$DB_PASSWORD" \
      google-sa-json="$GOOGLE_SERVICE_ACCOUNT_JSON" \
    --env-vars \
      NODE_ENV=production \
      PORT=8080 \
      ZERO_TOUCH_BASE_URL=https://androiddeviceprovisioning.googleapis.com/v1 \
      ZERO_TOUCH_PARTNER_ID="$ZERO_TOUCH_PARTNER_ID" \
      ONE_BASE_URL="$ONE_BASE_URL" \
      ONE_APP_SLUG="$ONE_APP_SLUG" \
      CORS_ORIGIN="$CORS_ORIGIN" \
      TRUST_PROXY=true \
      DB_SERVER="$DB_SERVER" \
      DB_NAME="$DB_NAME" \
      DB_USER="$DB_USER" \
      DB_PASSWORD=secretref:db-password \
      GOOGLE_SERVICE_ACCOUNT_JSON=secretref:google-sa-json >/dev/null
else
  az containerapp update \
    --name "$CONTAINER_APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --image "$IMAGE_REF" \
    --set-env-vars \
      NODE_ENV=production \
      PORT=8080 \
      ZERO_TOUCH_BASE_URL=https://androiddeviceprovisioning.googleapis.com/v1 \
      ZERO_TOUCH_PARTNER_ID="$ZERO_TOUCH_PARTNER_ID" \
      ONE_BASE_URL="$ONE_BASE_URL" \
      ONE_APP_SLUG="$ONE_APP_SLUG" \
      CORS_ORIGIN="$CORS_ORIGIN" \
      TRUST_PROXY=true \
      DB_SERVER="$DB_SERVER" \
      DB_NAME="$DB_NAME" \
      DB_USER="$DB_USER" >/dev/null

  az containerapp secret set \
    --name "$CONTAINER_APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --secrets \
      db-password="$DB_PASSWORD" \
      google-sa-json="$GOOGLE_SERVICE_ACCOUNT_JSON" >/dev/null

  az containerapp update \
    --name "$CONTAINER_APP_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --set-env-vars \
      DB_PASSWORD=secretref:db-password \
      GOOGLE_SERVICE_ACCOUNT_JSON=secretref:google-sa-json >/dev/null
fi

FQDN=$(az containerapp show -g "$RESOURCE_GROUP" -n "$CONTAINER_APP_NAME" --query properties.configuration.ingress.fqdn -o tsv)
echo "Backend deployed: https://${FQDN}"
