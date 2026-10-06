const express = require('express');
const { syncUserTenants } = require('../one');
const { getClientByDbId } = require('../db');

const router = express.Router();

/**
 * Endpoint de Sesión (Consola SPA / Frontend)
 * GET /api/v1/sesion (o /api/v1/session)
 * Retorna la información del usuario autenticado y las empresas asignadas para zero-touch.
 */
router.get('/', async (req, res, next) => {
  try {
    // 1. Caso: Usuario autenticado con One
    if (req.auth && req.auth.authType === 'one' && req.user) {
      let empresasSincronizadas = [];
      try {
        empresasSincronizadas = await syncUserTenants(req.user.token);
      } catch (syncError) {
        console.warn('Advertencia BD al sincronizar empresas:', syncError.message);
        try {
          const { listUserAppTenants } = require('../one');
          const directTenants = await listUserAppTenants(req.user.token);
          empresasSincronizadas = directTenants.map((t) => ({
            one_tenant_id: t.tenantId,
            company_name: t.name || t.slug,
            one_slug: t.slug,
            client_id: t.slug,
            role: t.role || (req.user.isPlatformAdmin ? 'PlatformAdmin' : 'Member'),
            is_active: true,
          }));
        } catch (oneListError) {
          empresasSincronizadas = [];
        }
      }

      return res.json({
        usuario: {
          id: req.user.id,
          email: req.user.email,
          nombre: req.user.fullName,
          esPlatformAdmin: req.user.isPlatformAdmin,
          roles: req.user.roles || [],
        },
        empresas: empresasSincronizadas.map((e) => ({
          id: e.id || null,
          clientId: e.client_id,
          nombre: e.company_name,
          slug: e.one_slug,
          oneTenantId: e.one_tenant_id,
          rol: e.role || 'Member',
          zeroTouchCustomerName: e.zero_touch_customer_name || null,
          estaActiva: e.is_active ?? true,
        })),
        tenantActivo: req.tenant || null,
      });
    }

    // 2. Caso: Usuario autenticado con token local clásico
    if (req.auth && req.auth.clientDbId) {
      const client = await getClientByDbId(Number(req.auth.clientDbId));
      return res.json({
        usuario: {
          id: req.auth.sub,
          email: req.auth.email || `client-${req.auth.clientId}@intechsys.local`,
          nombre: req.auth.clientId,
          esPlatformAdmin: false,
          roles: [req.auth.role || 'admin'],
        },
        empresas: client
          ? [
              {
                id: client.id,
                clientId: client.client_id,
                nombre: client.company_name,
                slug: client.one_slug || client.client_id,
                oneTenantId: client.one_tenant_id,
                rol: 'Admin',
                zeroTouchCustomerName: client.zero_touch_customer_name,
                estaActiva: client.is_active,
              },
            ]
          : [],
        tenantActivo: req.tenant || null,
      });
    }

    return res.status(401).json({ message: 'No hay sesión de usuario activa.' });
  } catch (error) {
    next(error);
  }
});

module.exports = {
  sessionRouter: router,
};

