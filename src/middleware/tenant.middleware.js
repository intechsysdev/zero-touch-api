const { oneConfig } = require('../one');
const { getClientByOneTenantId } = require('../db');
const { syncUserTenants } = require('../one');
const { asegurarPlataformas, resumenPlataformas } = require('../plataformas');

/**
 * Middleware de Resolución de Tenant (Empresa).
 * Equivalente a ResolucionTenantMiddleware.cs en .NET.
 *
 * Flujo:
 * 1. Lee la cabecera 'X-Tenant-Id' (o req.headers['x-tenant-id']).
 * 2. Si es usuario autenticado con One:
 *    - Valida que el usuario tenga membresía en la empresa especificada (o sea PlatformAdmin).
 *    - Busca la empresa en PostgreSQL por 'one_tenant_id'.
 *    - Si no existe aún en la BD local, ejecuta auto-sincronización con One.
 *    - Deja al día en qué plataformas (Zero-touch, Knox) existe su Client ID.
 *    - Adjunta req.tenant y req.auth.clientDbId para los controladores de Zero Touch / Knox.
 */
async function resolveTenant(req, res, next) {
  // Si ya fue resuelto previamente (por ejemplo, por apiKeyMiddleware), continuar
  if (req.tenant) {
    return next();
  }

  // 1. Caso: Usuario autenticado vía One
  if (req.auth && req.auth.authType === 'one' && req.user) {
    const tenantHeader =
      req.headers[oneConfig.constants.cabeceraTenant.toLowerCase()] ||
      req.headers['x-tenant-id'] ||
      req.query?.tenantId;

    let targetTenantId = tenantHeader ? String(tenantHeader).trim() : null;
    const explicito = Boolean(targetTenantId);

    // Si no envió cabecera, verificar si tiene solo una membresía asignada
    if (!targetTenantId) {
      const memberships = req.user.memberships || [];
      if (memberships.length === 1) {
        targetTenantId = memberships[0].tenantId;
      }
    }

    // Sin empresa elegida se sigue sin ella: la sesión responde con la lista para que la consola
    // elija, y las rutas de equipos la exigen con requireTenant.
    if (!targetTenantId) {
      return next();
    }

    // Validar que el usuario tenga acceso al tenant especificado
    const membership = (req.user.memberships || []).find(
      (m) => String(m.tenantId).toLowerCase() === targetTenantId.toLowerCase()
    );

    if (!membership && !req.user.isPlatformAdmin) {
      return res.status(403).json({
        message: 'Acceso no autorizado para la empresa especificada en X-Tenant-Id.',
      });
    }

    // 2. Buscar empresa en PostgreSQL por one_tenant_id
    let client = null;
    try {
      client = await getClientByOneTenantId(targetTenantId);

      // Si aún no está en la base de datos local, auto-sincronizar con One
      if (!client) {
        try {
          await syncUserTenants(req.user.token);
          client = await getClientByOneTenantId(targetTenantId);
        } catch (syncError) {
          console.warn('Auto-sincronización de tenants falló:', syncError.message);
        }
      }

      if (client?.is_active) {
        client = await asegurarPlataformas(client);
      }
    } catch (dbError) {
      console.error('Error de BD al consultar la empresa:', dbError.message);
      return res.status(503).json({ message: 'No se pudo cargar la empresa. Intente de nuevo en un momento.' });
    }

    // La única empresa del usuario puede no tener zero-touch: entonces no hay empresa activa.
    if (!client && !explicito) {
      return next();
    }

    if (!client) {
      return res.status(404).json({
        message:
          'La empresa especificada no se encuentra registrada o sincronizada en el sistema local.',
      });
    }

    if (!client.is_active) {
      return res.status(403).json({
        message: 'La empresa se encuentra inactiva.',
      });
    }

    // Adjuntar tenant y compatibilizar con los controladores existentes
    const plataformas = resumenPlataformas(client);

    req.tenant = {
      id: client.id,
      clientDbId: client.id,
      clientId: client.client_id,
      companyName: client.company_name,
      oneTenantId: client.one_tenant_id,
      oneSlug: client.one_slug,
      ...plataformas,
      role: membership?.role || (req.user.isPlatformAdmin ? 'PlatformAdmin' : 'Member'),
    };

    req.auth.clientDbId = client.id;
    req.auth.clientId = client.client_id;
    req.auth.companyName = client.company_name;
    // Las rutas de Knox leen de aquí el cliente autorizado.
    req.auth.samsungCustomerId = plataformas.samsungCustomerId;

    return next();
  }

  return next();
}

/**
 * Middleware estricto que exige que un tenant haya sido resuelto.
 */
function requireTenant(req, res, next) {
  if (!req.tenant) {
    return res.status(400).json({
      message: 'Esta operación requiere que se especifique una empresa activa (X-Tenant-Id).',
    });
  }
  next();
}

module.exports = {
  resolveTenant,
  requireTenant,
};

