const { oneConfig } = require('../one');
const { getClientByOneTenantId, getClientByDbId } = require('../db');
const { syncUserTenants } = require('../one');

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
 *    - Adjunta req.tenant y req.auth.clientDbId para los controladores de Zero Touch / Knox.
 * 3. Si es usuario con token local:
 *    - Carga la empresa correspondiente a req.auth.clientDbId.
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

    // Si no envió cabecera, verificar si tiene solo una membresía asignada
    if (!targetTenantId) {
      const memberships = req.user.memberships || [];
      if (memberships.length === 1) {
        targetTenantId = memberships[0].tenantId;
      }
    }

    if (!targetTenantId) {
      // Si no hay tenant seleccionado y es PlatformAdmin, permitir continuar sin tenant
      if (req.user.isPlatformAdmin) {
        return next();
      }

      // Si el usuario tiene múltiples empresas y no indicó cuál usar
      const memberships = req.user.memberships || [];
      if (memberships.length > 1) {
        return res.status(400).json({
          message:
            'Debe especificar la cabecera X-Tenant-Id indicando la empresa a gestionar.',
          availableTenants: memberships.map((m) => ({
            tenantId: m.tenantId,
            name: m.tenantName || m.name,
            slug: m.tenantSlug || m.slug,
          })),
        });
      }

      return res.status(403).json({
        message: 'El usuario no tiene ninguna empresa asignada en One.',
      });
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
    } catch (dbError) {
      console.warn('Advertencia BD al consultar tenant:', dbError.message);
      // Fallback provisional si la BD no está disponible en entorno actual
      client = {
        id: targetTenantId,
        client_id: targetTenantId,
        company_name: membership?.tenantName || 'Empresa One',
        one_tenant_id: targetTenantId,
        one_slug: membership?.tenantSlug || targetTenantId,
        is_active: true,
      };
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
    req.tenant = {
      id: client.id,
      clientDbId: client.id,
      clientId: client.client_id,
      companyName: client.company_name,
      oneTenantId: client.one_tenant_id,
      oneSlug: client.one_slug,
      zeroTouchCustomerName: client.zero_touch_customer_name,
      role: membership?.role || (req.user.isPlatformAdmin ? 'PlatformAdmin' : 'Member'),
    };

    req.auth.clientDbId = client.id;
    req.auth.clientId = client.client_id;
    req.auth.companyName = client.company_name;

    return next();
  }

  // 2. Caso: Usuario autenticado con token local clásico
  if (req.auth && req.auth.clientDbId) {
    try {
      const client = await getClientByDbId(Number(req.auth.clientDbId));
      if (!client || !client.is_active) {
        return res.status(403).json({ message: 'Cliente inactivo o no encontrado.' });
      }

      req.tenant = {
        id: client.id,
        clientDbId: client.id,
        clientId: client.client_id,
        companyName: client.company_name,
        oneTenantId: client.one_tenant_id,
        oneSlug: client.one_slug,
        zeroTouchCustomerName: client.zero_touch_customer_name,
        role: req.auth.role || 'admin',
      };
      return next();
    } catch (error) {
      return res.status(500).json({ message: 'Error cargando datos de la empresa.' });
    }
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

