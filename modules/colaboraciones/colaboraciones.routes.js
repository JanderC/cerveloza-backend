const express = require('express');
const router = express.Router();
const verificarToken = require('../../middlewares/auth.middleware');
const { crearColaboracion, listarColaboraciones, resumenColaboraciones } = require('./colaboraciones.controller');

router.post('/', verificarToken, crearColaboracion);
router.get('/', verificarToken, listarColaboraciones);
router.get('/resumen', verificarToken, resumenColaboraciones);

module.exports = router;