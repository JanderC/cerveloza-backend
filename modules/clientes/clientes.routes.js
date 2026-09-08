const express = require('express');
const router = express.Router();
const verificarToken = require('../../middlewares/auth.middleware');
const {
  listarClientesConSaldo,
  buscarClientes,
  crearCliente,
  estadoDeCuenta,
  registrarAbono
} = require('./clientes.controller');

router.get('/', verificarToken, listarClientesConSaldo);
router.get('/buscar', verificarToken, buscarClientes);
router.post('/', verificarToken, crearCliente);
router.get('/:id/estado-cuenta', verificarToken, estadoDeCuenta);
router.post('/abono', verificarToken, registrarAbono);

module.exports = router;