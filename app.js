const express = require('express');
const cors = require('cors');
require('dotenv').config();
const pool = require('./config/db');
const authRoutes = require('./modules/auth/auth.routes');
const usuariosRoutes = require('./modules/usuarios/usuarios.routes');
const productosRoutes = require('./modules/productos/productos.routes');
const ventasRoutes = require('./modules/ventas/ventas.routes');
const tasasRoutes = require('./modules/tasas/tasas.routes');
const reportesRoutes = require('./modules/reportes/reportes.routes');

const iniciarCronTasas = require('./utils/cronTasas');
const app = express();


iniciarCronTasas();
app.use(cors());
app.use(express.json());

// Ruta de prueba para verificar que el servidor y la DB responden
app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ status: 'ok', db_time: result.rows[0].now });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});
app.use('/api/tasas', tasasRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/usuarios', usuariosRoutes);
app.use('/api/productos', productosRoutes);
app.use('/api/ventas', ventasRoutes);
app.use('/api/reportes', reportesRoutes);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});