# Backend Intechsys (Node.js)

Backend para autenticar clientes con email + password + clientId, emitir JWT y actuar como puente hacia Google Zero-touch.

## Dónde crear esto

Se crea en una carpeta separada del front:

- backend_intechsys
- zerotouch_intechsys

Asi puedes desplegar backend y app de forma independiente.

## Stack

- Node.js + Express
- PostgreSQL
- JWT
- Google Auth Library

## Configuracion

1. Usa .env para local.
2. Usa .env.production para despliegues empresariales.
3. Usa .env.docker para stack completo en Docker.

Variables:

- NODE_ENV
- PORT
- JWT_SECRET
- JWT_EXPIRES_IN
- DB_URL
- ZERO_TOUCH_BASE_URL
- ZERO_TOUCH_PARTNER_ID
- CORS_ORIGIN
- TRUST_PROXY
- GOOGLE_SERVICE_ACCOUNT_JSON (opcional)
- GOOGLE_APPLICATION_CREDENTIALS (opcional)

## Levantar PostgreSQL local

1. docker compose up -d

Esto inicia backend + postgres en contenedores.

## Ejecutar

1. npm install
2. npm run start

Servidor:

- http://localhost:8080

Health:

- GET /health
- GET /ready

## Endpoint de login

POST /auth/login

Body JSON:

{
  "email": "cliente.demo@intechsys.com",
  "password": "CLI-1001",
  "clientId": "CLI-1001"
}

## Regla solicitada por ustedes

En este MVP, el password debe ser igual al clientId.

## Endpoints Zero-touch (siempre via backend)

Todos requieren header Authorization: Bearer <accessToken>

- GET /zerotouch/customers
- GET /zerotouch/devices?customerId=123456789&pageSize=20&pageToken=
- POST /zerotouch/devices/claim
- POST /zerotouch/devices/unclaim

## Credencial de servicio en Docker

1. Copia tu archivo JSON real de service account a:
  backend_intechsys/secrets/google-service-account.json
2. docker-compose ya lo monta en:
  /app/secrets/google-service-account.json
3. .env.docker ya referencia:
  GOOGLE_APPLICATION_CREDENTIALS=/app/secrets/google-service-account.json

Si no montas este archivo, los endpoints /zerotouch/* devolveran error de credenciales.

Ejemplo POST /zerotouch/configurations

{
  "customerName": "customers/123456789",
  "payload": {
    "configurationName": "perfil-default",
    "dpcResourcePath": "customers/123456789/dpcs/123456",
    "dpcExtras": "{\"android.app.extra.PROVISIONING_DEVICE_ADMIN_PACKAGE_DOWNLOAD_LOCATION\":\"https://...\"}"
  }
}

## Respuesta esperada por Flutter

{
  "accessToken": "...",
  "companyName": "Cliente Demo Intechsys",
  "email": "cliente.demo@intechsys.com",
  "clientId": "CLI-1001",
  "zeroTouchCustomerName": "customers/123456789"
}

## Datos seed iniciales

Se crean automaticamente al iniciar por primera vez:

- email: cliente.demo@intechsys.com
- clientId: CLI-1001
- password: CLI-1001

## Flujo recomendado para Flutter

1. Flutter hace login a POST /auth/login.
2. Backend devuelve JWT.
3. Flutter usa JWT para llamar endpoints /zerotouch/* del backend.
4. Solo backend llama Google Zero-touch API.

## Despliegue empresarial

1. Imagen Docker: Dockerfile
2. Orquestacion local/entorno controlado: docker-compose.yml
3. Guia Azure: AZURE_DEPLOY.md

La app Flutter solo debe apuntar al backend publico y nunca a Google Zero-touch.

## Siguiente paso recomendado

1. Agregar refresh token rotativo.
2. Agregar RBAC por cliente y rol.
3. Persistir cache de dispositivos y jobs de sincronizacion.
