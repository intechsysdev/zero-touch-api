const express = require('express');
const { syncUserTenants } = require('../one');
const { asegurarPlataformas, resumenPlataformas } = require('../plataformas');

const router = express.Router();

/**
 * Endpoint de Sesión (Consola SPA / Frontend)
 * GET /api/v1/sesion (o /api/v1/session)
 * Retorna el usuario autenticado en One, las empresas por las que llega a zero-touch y la empresa
 * activa con su Client ID y las plataformas (Zero-touch, Samsung Knox) en las que existe.
 */
router.get('/', async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: 'No hay sesión de usuario activa.' });
    }

    let empresas = [];
    try {
      empresas = await syncUserTenants(req.user.token);
    } catch (syncError) {
      console.warn('No se pudieron sincronizar las empresas de One:', syncError.message);
    }

    // La empresa activa se resolvió antes de sincronizar: refrescar con los datos
    // y plataformas recién sincronizados desde One (incluyendo SAMSUNG_KNOX_CUSTOMER_ID)
    let tenantActivo = req.tenant || null;
    const activa = tenantActivo && empresas.find((e) => e.one_tenant_id === tenantActivo.oneTenantId);
    if (activa) {
      const client = await asegurarPlataformas(activa);
      const plataformas = resumenPlataformas(client);
      tenantActivo = {
        ...tenantActivo,
        clientId: client.client_id,
        companyName: client.company_name,
        ...plataformas,
      };
    }

    return res.json({
      usuario: {
        id: req.user.id,
        email: req.user.email,
        nombre: req.user.fullName,
        esPlatformAdmin: req.user.isPlatformAdmin,
        roles: req.user.roles || [],
      },
      empresas: empresas.map((e) => {
        const p = resumenPlataformas(e);
        return {
          id: e.id || null,
          clientId: e.client_id,
          nombre: e.company_name,
          slug: e.one_slug,
          oneTenantId: e.one_tenant_id,
          rol: e.role || 'Member',
          zeroTouchAvailable: p.zeroTouchAvailable,
          zeroTouchCustomerName: e.zero_touch_customer_name || null,
          zeroTouchCustomerId: p.zeroTouchCustomerId,
          samsungAvailable: p.samsungAvailable,
          samsungCustomerId: e.samsung_customer_id || null,
          platformType: p.platformType,
          estaActiva: e.is_active ?? true,
        };
      }),
      tenantActivo,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = {
  sessionRouter: router,
};
