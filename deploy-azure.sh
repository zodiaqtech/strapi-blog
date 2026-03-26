#!/bin/bash
# ══════════════════════════════════════════════════════════════════════════════
#  Strapi Blog — Azure Deployment Script
#  Provisions: Resource Group, ACR, PostgreSQL, Blob Storage, Container Apps
#  Usage: bash deploy-azure.sh [--skip-db-restore] [--skip-media-upload]
# ══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
info()    { echo -e "${BLUE}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[✓]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }
step()    { echo -e "\n${BLUE}━━━ $* ━━━${NC}"; }

# ── Flags ─────────────────────────────────────────────────────────────────────
SKIP_DB_RESTORE=false
SKIP_MEDIA_UPLOAD=false
SKIP_ACR_BUILD=false
for arg in "$@"; do
  case $arg in
    --skip-db-restore)   SKIP_DB_RESTORE=true ;;
    --skip-media-upload) SKIP_MEDIA_UPLOAD=true ;;
    --skip-acr-build)    SKIP_ACR_BUILD=true ;;
  esac
done

# ══════════════════════════════════════════════════════════════════════════════
#  ①  CONFIGURATION — edit these values before running
# ══════════════════════════════════════════════════════════════════════════════
# Resolve absolute path to this script's directory (works regardless of cwd)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

RESOURCE_GROUP="strapi-blog-rg"
LOCATION="centralus"                       # az account list-locations -o table
APP_NAME="strapi-blog"                     # base name — must be lowercase, no spaces

# Container Registry (globally unique)
ACR_NAME="${APP_NAME//-/}acr"              # e.g. strapiblogacr

# PostgreSQL (globally unique)
PG_SERVER_NAME="${APP_NAME}-pgserver"
PG_DATABASE="strapi_db"
PG_ADMIN_USER="strapi_admin"
PG_ADMIN_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=' | head -c 24)Aa1!"

# Storage Account (3-24 chars, lowercase + numbers only, globally unique)
STORAGE_ACCOUNT="${APP_NAME//-/}media"    # e.g. strapiblogmedia
STORAGE_CONTAINER="strapi-uploads"

# Container Apps
CONTAINER_ENV="${APP_NAME}-env"
CONTAINER_APP="${APP_NAME}-app"
CONTAINER_IMAGE="${ACR_NAME}.azurecr.io/${APP_NAME}:latest"

# Strapi secrets (auto-generated — store these somewhere safe!)
APP_KEYS="$(openssl rand -hex 16),$(openssl rand -hex 16),$(openssl rand -hex 16),$(openssl rand -hex 16)"
API_TOKEN_SALT="$(openssl rand -hex 32)"
ADMIN_JWT_SECRET="$(openssl rand -hex 32)"
TRANSFER_TOKEN_SALT="$(openssl rand -hex 32)"
JWT_SECRET="$(openssl rand -hex 32)"

# DB backup path (one level up from strapi-blog/)
DB_BACKUP="$(cd "$(dirname "$0")/.." && pwd)/strapi_db (1).sql.gz"

# Media path (local uploads directory — populated by download_media.sh)
MEDIA_DIR="$(cd "$(dirname "$0")" && pwd)/public/uploads"

# ══════════════════════════════════════════════════════════════════════════════
#  ②  PRE-FLIGHT CHECKS
# ══════════════════════════════════════════════════════════════════════════════
step "Pre-flight checks"

command -v az   >/dev/null 2>&1 || error "Azure CLI not installed. Run: brew install azure-cli"
command -v docker >/dev/null 2>&1 || error "Docker not installed."

info "Checking Azure login..."
az account show >/dev/null 2>&1 || { info "Not logged in — running az login..."; az login; }

SUBSCRIPTION_ID=$(az account show --query id -o tsv)
SUBSCRIPTION_NAME=$(az account show --query name -o tsv)
success "Logged in to: ${SUBSCRIPTION_NAME} (${SUBSCRIPTION_ID})"

# ══════════════════════════════════════════════════════════════════════════════
#  ③  RESOURCE GROUP
# ══════════════════════════════════════════════════════════════════════════════
step "Resource Group"

if az group show --name "$RESOURCE_GROUP" >/dev/null 2>&1; then
  warn "Resource group '${RESOURCE_GROUP}' already exists — skipping creation"
else
  az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none
  success "Created resource group: ${RESOURCE_GROUP} (${LOCATION})"
fi

# ══════════════════════════════════════════════════════════════════════════════
#  ④  AZURE CONTAINER REGISTRY
# ══════════════════════════════════════════════════════════════════════════════
step "Azure Container Registry"

if az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  warn "ACR '${ACR_NAME}' already exists — skipping creation"
else
  az acr create \
    --name "$ACR_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --sku Basic \
    --admin-enabled true \
    --output none
  success "Created ACR: ${ACR_NAME}"
fi

if [ "$SKIP_ACR_BUILD" = false ]; then
  info "Building and pushing Docker image..."
  az acr build \
    --registry "$ACR_NAME" \
    --image "${APP_NAME}:latest" \
    --file "${SCRIPT_DIR}/Dockerfile" \
    "${SCRIPT_DIR}"
  success "Image pushed: ${CONTAINER_IMAGE}"
else
  warn "Skipping ACR build (--skip-acr-build) — using existing image in registry"
fi

ACR_PASSWORD=$(az acr credential show --name "$ACR_NAME" --query "passwords[0].value" -o tsv)

# ══════════════════════════════════════════════════════════════════════════════
#  ⑤  AZURE POSTGRESQL FLEXIBLE SERVER
# ══════════════════════════════════════════════════════════════════════════════
step "PostgreSQL Flexible Server"

if az postgres flexible-server show --name "$PG_SERVER_NAME" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  warn "PostgreSQL server '${PG_SERVER_NAME}' already exists — skipping creation"
else
  info "Creating PostgreSQL server (takes ~3 minutes)..."
  az postgres flexible-server create \
    --name "$PG_SERVER_NAME" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --admin-user "$PG_ADMIN_USER" \
    --admin-password "$PG_ADMIN_PASSWORD" \
    --database-name "$PG_DATABASE" \
    --sku-name "Standard_B1ms" \
    --tier "Burstable" \
    --storage-size 32 \
    --version 14 \
    --public-access 0.0.0.0 \
    --yes \
    --output none
  success "Created PostgreSQL server: ${PG_SERVER_NAME}"
fi

# Allow Azure services to connect
az postgres flexible-server firewall-rule create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$PG_SERVER_NAME" \
  --rule-name "AllowAzureServices" \
  --start-ip-address 0.0.0.0 \
  --end-ip-address 0.0.0.0 \
  --output none 2>/dev/null || true

# Allow your current IP (for the DB restore below)
MY_IP=$(curl -s https://api.ipify.org)
az postgres flexible-server firewall-rule create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$PG_SERVER_NAME" \
  --rule-name "DeployClient" \
  --start-ip-address "$MY_IP" \
  --end-ip-address "$MY_IP" \
  --output none 2>/dev/null || true

PG_HOST="${PG_SERVER_NAME}.postgres.database.azure.com"
success "PostgreSQL host: ${PG_HOST}"

# ── Restore database backup ───────────────────────────────────────────────────
if [ "$SKIP_DB_RESTORE" = false ]; then
  step "Database Restore"
  if [ -f "$DB_BACKUP" ]; then
    info "Restoring backup from: ${DB_BACKUP}"
    info "Waiting 30s for PostgreSQL to be fully ready..."
    sleep 30
    PGPASSWORD="$PG_ADMIN_PASSWORD" gunzip -c "$DB_BACKUP" \
      | sed "s/strapi_db_owner/${PG_ADMIN_USER}/g" \
      | psql "host=${PG_HOST} dbname=${PG_DATABASE} user=${PG_ADMIN_USER} sslmode=require" \
      && success "Database restored successfully!" \
      || warn "DB restore had warnings — check output above"
  else
    warn "DB backup not found at: ${DB_BACKUP}  — skipping restore"
    warn "You can restore manually later with:"
    warn "  PGPASSWORD='${PG_ADMIN_PASSWORD}' gunzip -c 'strapi_db (1).sql.gz' | psql \"host=${PG_HOST} dbname=${PG_DATABASE} user=${PG_ADMIN_USER} sslmode=require\""
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════
#  ⑥  AZURE BLOB STORAGE
# ══════════════════════════════════════════════════════════════════════════════
step "Azure Blob Storage"

if az storage account show --name "$STORAGE_ACCOUNT" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  warn "Storage account '${STORAGE_ACCOUNT}' already exists — skipping creation"
else
  az storage account create \
    --name "$STORAGE_ACCOUNT" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --sku Standard_LRS \
    --kind StorageV2 \
    --allow-blob-public-access true \
    --output none
  success "Created storage account: ${STORAGE_ACCOUNT}"
fi

STORAGE_KEY=$(az storage account keys list \
  --account-name "$STORAGE_ACCOUNT" \
  --resource-group "$RESOURCE_GROUP" \
  --query "[0].value" -o tsv)

STORAGE_URL="https://${STORAGE_ACCOUNT}.blob.core.windows.net"

# Create container with public blob access
az storage container create \
  --name "$STORAGE_CONTAINER" \
  --account-name "$STORAGE_ACCOUNT" \
  --account-key "$STORAGE_KEY" \
  --public-access blob \
  --output none 2>/dev/null || true
success "Storage container ready: ${STORAGE_CONTAINER}"

# ── Upload media files ────────────────────────────────────────────────────────
if [ "$SKIP_MEDIA_UPLOAD" = false ]; then
  step "Media Upload to Azure Blob"
  if [ -d "$MEDIA_DIR" ] && [ "$(ls -A "$MEDIA_DIR" 2>/dev/null)" ]; then
    FILE_COUNT=$(find "$MEDIA_DIR" -type f | wc -l | tr -d ' ')
    info "Uploading ${FILE_COUNT} media files to Azure Blob Storage..."
    az storage blob upload-batch \
      --account-name "$STORAGE_ACCOUNT" \
      --account-key "$STORAGE_KEY" \
      --destination "$STORAGE_CONTAINER" \
      --source "$MEDIA_DIR" \
      --overwrite \
      --output none
    success "Uploaded ${FILE_COUNT} files to ${STORAGE_URL}/${STORAGE_CONTAINER}"
  else
    warn "No media files found at ${MEDIA_DIR} — skipping upload"
    warn "Run download_media.sh first, then re-run with --skip-db-restore"
  fi
fi

# ══════════════════════════════════════════════════════════════════════════════
#  ⑦  CONTAINER APPS ENVIRONMENT + APP
# ══════════════════════════════════════════════════════════════════════════════
step "Container Apps Environment"

if az containerapp env show --name "$CONTAINER_ENV" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  warn "Container Apps environment '${CONTAINER_ENV}' already exists — skipping"
else
  az containerapp env create \
    --name "$CONTAINER_ENV" \
    --resource-group "$RESOURCE_GROUP" \
    --location "$LOCATION" \
    --output none
  success "Created Container Apps environment: ${CONTAINER_ENV}"
fi

step "Container App — Strapi"

# Build env-vars string for Container App
ENV_VARS=(
  "NODE_ENV=production"
  "DATABASE_CLIENT=postgres"
  "DATABASE_HOST=${PG_HOST}"
  "DATABASE_PORT=5432"
  "DATABASE_NAME=${PG_DATABASE}"
  "DATABASE_USERNAME=${PG_ADMIN_USER}"
  "DATABASE_PASSWORD=${PG_ADMIN_PASSWORD}"
  "DATABASE_SSL=true"
  "APP_KEYS=${APP_KEYS}"
  "API_TOKEN_SALT=${API_TOKEN_SALT}"
  "ADMIN_JWT_SECRET=${ADMIN_JWT_SECRET}"
  "TRANSFER_TOKEN_SALT=${TRANSFER_TOKEN_SALT}"
  "JWT_SECRET=${JWT_SECRET}"
  "STORAGE_ACCOUNT=${STORAGE_ACCOUNT}"
  "STORAGE_ACCOUNT_KEY=${STORAGE_KEY}"
  "STORAGE_CONTAINER_NAME=${STORAGE_CONTAINER}"
  "STORAGE_URL=${STORAGE_URL}"
)

ENV_VARS_STR=$(printf '%s ' "${ENV_VARS[@]}")

if az containerapp show --name "$CONTAINER_APP" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  info "Updating existing Container App..."
  az containerapp update \
    --name "$CONTAINER_APP" \
    --resource-group "$RESOURCE_GROUP" \
    --image "$CONTAINER_IMAGE" \
    --set-env-vars $ENV_VARS_STR \
    --output none
else
  info "Creating Container App..."
  az containerapp create \
    --name "$CONTAINER_APP" \
    --resource-group "$RESOURCE_GROUP" \
    --environment "$CONTAINER_ENV" \
    --image "$CONTAINER_IMAGE" \
    --registry-server "${ACR_NAME}.azurecr.io" \
    --registry-username "$ACR_NAME" \
    --registry-password "$ACR_PASSWORD" \
    --target-port 1337 \
    --ingress external \
    --min-replicas 1 \
    --max-replicas 3 \
    --cpu 0.5 \
    --memory 1Gi \
    --set-env-vars $ENV_VARS_STR \
    --output none
fi

APP_URL=$(az containerapp show \
  --name "$CONTAINER_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --query "properties.configuration.ingress.fqdn" -o tsv)

# Update PUBLIC_URL now that we know the app URL
az containerapp update \
  --name "$CONTAINER_APP" \
  --resource-group "$RESOURCE_GROUP" \
  --set-env-vars "PUBLIC_URL=https://${APP_URL}" \
  --output none

success "Container App deployed: https://${APP_URL}"

# ══════════════════════════════════════════════════════════════════════════════
#  ⑧  SAVE CREDENTIALS
# ══════════════════════════════════════════════════════════════════════════════
step "Saving credentials"

SECRETS_FILE="${SCRIPT_DIR}/.azure-secrets.env"
cat > "$SECRETS_FILE" << SECRETS
# ── Azure Deployment Secrets ── $(date)
# ⚠️  DO NOT commit this file to git

# App URL
PUBLIC_URL=https://${APP_URL}

# Database
DATABASE_HOST=${PG_HOST}
DATABASE_NAME=${PG_DATABASE}
DATABASE_USERNAME=${PG_ADMIN_USER}
DATABASE_PASSWORD=${PG_ADMIN_PASSWORD}
DATABASE_SSL=true

# Storage
STORAGE_ACCOUNT=${STORAGE_ACCOUNT}
STORAGE_ACCOUNT_KEY=${STORAGE_KEY}
STORAGE_CONTAINER_NAME=${STORAGE_CONTAINER}
STORAGE_URL=${STORAGE_URL}

# Strapi secrets
APP_KEYS=${APP_KEYS}
API_TOKEN_SALT=${API_TOKEN_SALT}
ADMIN_JWT_SECRET=${ADMIN_JWT_SECRET}
TRANSFER_TOKEN_SALT=${TRANSFER_TOKEN_SALT}
JWT_SECRET=${JWT_SECRET}

# ACR
ACR_NAME=${ACR_NAME}
ACR_PASSWORD=${ACR_PASSWORD}
SECRETS

chmod 600 "$SECRETS_FILE"
success "Credentials saved to: ${SECRETS_FILE}"

# ══════════════════════════════════════════════════════════════════════════════
#  ⑨  SUMMARY
# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo -e "${GREEN}══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}  ✅  DEPLOYMENT COMPLETE${NC}"
echo -e "${GREEN}══════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  🌐  Strapi Admin :  ${BLUE}https://${APP_URL}/admin${NC}"
echo -e "  🔌  API Base     :  ${BLUE}https://${APP_URL}/api${NC}"
echo -e "  🗄️   DB Host      :  ${PG_HOST}"
echo -e "  📦  Storage      :  ${STORAGE_URL}/${STORAGE_CONTAINER}"
echo ""
echo -e "  📄  All secrets saved to: ${SECRETS_FILE}"
echo ""
echo -e "${YELLOW}  Next steps:${NC}"
echo -e "  1. Open https://${APP_URL}/admin and log in"
echo -e "  2. Set up GitHub secrets for CI/CD (see .github/workflows/deploy.yml)"
echo -e "     AZURE_CREDENTIALS   — service principal JSON"
echo -e "     ACR_NAME            — ${ACR_NAME}"
echo -e "     ACR_PASSWORD        — (in .azure-secrets.env)"
echo -e "     CONTAINER_APP_NAME  — ${CONTAINER_APP}"
echo -e "     RESOURCE_GROUP      — ${RESOURCE_GROUP}"
echo ""
