FROM node:20-alpine AS base
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
# NOTE: Do NOT copy .env files into the image. Pass env vars dynamically
# via docker-compose, Azure Container Apps, or --env-file at runtime.

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>{if(!r.ok) process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
