const express = require('express');
const router = express.Router();
const verificarToken = require('../../middlewares/auth.middleware');
const {
  bloqueActual,
  abrirBloque,
  cerrarBloque,
  listarBloques,
  resumenBloque,
  ventasDelBloque
} = require('./bloques.controller');

// '/actual' va antes de '/:id' para que no lo capture la ruta con parámetro
router.get('/actual', verificarToken, bloqueActual);
router.get('/', verificarToken, listarBloques);
router.post('/abrir', verificarToken, abrirBloque);
router.post('/:id/cerrar', verificarToken, cerrarBloque);
router.get('/:id/resumen', verificarToken, resumenBloque);
router.get('/:id/ventas', verificarToken, ventasDelBloque);

module.exports = router;
