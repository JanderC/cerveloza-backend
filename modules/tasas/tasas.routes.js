const express = require('express');
const router = express.Router();
const verificarToken = require('../../middlewares/auth.middleware');
const verificarRol = require('../../middlewares/roles.middleware');
const {
  registrarTasaManual,
  actualizarTasaAutomatica,
  obtenerTasaActual,
  listarHistorialTasas
} = require('./tasas.controller');

router.get('/actual', verificarToken, obtenerTasaActual);
router.get('/historial', verificarToken, listarHistorialTasas);
router.post('/manual', verificarToken, verificarRol('admin'), registrarTasaManual);
router.post('/actualizar', verificarToken, verificarRol('admin'), actualizarTasaAutomatica);

module.exports = router;