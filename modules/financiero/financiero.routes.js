const express = require('express');
const router = express.Router();
const verificarToken = require('../../middlewares/auth.middleware');
const {
  obtenerSaldos,
  listarMovimientos,
  registrarMovimiento,
  resumen,
  listarDepositosPorCierre
} = require('./financiero.controller');

router.get('/saldos', verificarToken, obtenerSaldos);
router.get('/resumen', verificarToken, resumen);
router.get('/movimientos', verificarToken, listarMovimientos);
router.get('/depositos', verificarToken, listarDepositosPorCierre);

// La restricción a rol admin para pagos y retiros se valida dentro del controller,
// porque los ingresos manuales sí los puede registrar cualquier usuario autenticado.
router.post('/movimiento', verificarToken, registrarMovimiento);

module.exports = router;
