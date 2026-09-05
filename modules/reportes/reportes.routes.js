const express = require('express');
const router = express.Router();
const verificarToken = require('../../middlewares/auth.middleware');
const verificarRol = require('../../middlewares/roles.middleware');
const {
  productosMasVendidos,
  ventasPorMetodoPago,
  ventasPorMoneda,
  ventasDiarias,
  resumenDashboard
} = require('./reportes.controller');

router.get('/productos-mas-vendidos', verificarToken, verificarRol('admin'), productosMasVendidos);
router.get('/ventas-por-metodo-pago', verificarToken, verificarRol('admin'), ventasPorMetodoPago);
router.get('/ventas-por-moneda', verificarToken, verificarRol('admin'), ventasPorMoneda);
router.get('/ventas-diarias', verificarToken, verificarRol('admin'), ventasDiarias);
router.get('/resumen', verificarToken, verificarRol('admin'), resumenDashboard);

module.exports = router;