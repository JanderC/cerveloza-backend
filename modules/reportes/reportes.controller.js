const pool = require('../../config/db');

// Productos más vendidos (por cantidad total vendida)
async function productosMasVendidos(req, res) {
  const { desde, hasta, limite } = req.query;

  try {
    let query = `
      SELECT p.id, p.nombre, p.codigo,
             SUM(dv.cantidad) AS cantidad_total,
             SUM(dv.subtotal_usd) AS total_usd
      FROM detalle_venta dv
      JOIN productos p ON p.id = dv.producto_id
      JOIN ventas v ON v.id = dv.venta_id
      WHERE v.estado = 'completada'
    `;
    const params = [];

    if (desde && hasta) {
      query += ` AND v.fecha BETWEEN $1 AND $2`;
      params.push(desde, hasta);
    }

    query += `
      GROUP BY p.id, p.nombre, p.codigo
      ORDER BY cantidad_total DESC
      LIMIT $${params.length + 1}
    `;
    params.push(limite || 10);

    const resultado = await pool.query(query, params);
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener productos más vendidos', error: error.message });
  }
}

// Distribución de ventas por método de pago (para el gráfico de torta)
async function ventasPorMetodoPago(req, res) {
  const { desde, hasta } = req.query;

  try {
    let query = `
      SELECT pv.metodo,
             SUM(pv.monto_equivalente_usd) AS total_usd,
             COUNT(*) AS cantidad_pagos
      FROM pagos_venta pv
      JOIN ventas v ON v.id = pv.venta_id
      WHERE v.estado = 'completada'
    `;
    const params = [];

    if (desde && hasta) {
      query += ` AND v.fecha BETWEEN $1 AND $2`;
      params.push(desde, hasta);
    }

    query += ' GROUP BY pv.metodo ORDER BY total_usd DESC';

    const resultado = await pool.query(query, params);
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener ventas por método de pago', error: error.message });
  }
}

// Distribución de ventas por moneda usada al pagar (otro corte útil para la torta)
async function ventasPorMoneda(req, res) {
  const { desde, hasta } = req.query;

  try {
    let query = `
      SELECT pv.moneda,
             SUM(pv.monto_equivalente_usd) AS total_usd
      FROM pagos_venta pv
      JOIN ventas v ON v.id = pv.venta_id
      WHERE v.estado = 'completada'
    `;
    const params = [];

    if (desde && hasta) {
      query += ` AND v.fecha BETWEEN $1 AND $2`;
      params.push(desde, hasta);
    }

    query += ' GROUP BY pv.moneda ORDER BY total_usd DESC';

    const resultado = await pool.query(query, params);
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener ventas por moneda', error: error.message });
  }
}

// Ventas totales agrupadas por día (para gráfico de línea/barra de tendencia)
async function ventasDiarias(req, res) {
  const { desde, hasta } = req.query;

  try {
    let query = `
      SELECT DATE(v.fecha) AS dia,
             SUM(v.total_usd) AS total_usd,
             COUNT(*) AS cantidad_ventas
      FROM ventas v
      WHERE v.estado = 'completada'
    `;
    const params = [];

    if (desde && hasta) {
      query += ` AND v.fecha BETWEEN $1 AND $2`;
      params.push(desde, hasta);
    }

    query += ' GROUP BY DATE(v.fecha) ORDER BY dia ASC';

    const resultado = await pool.query(query, params);
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener ventas diarias', error: error.message });
  }
}

// Resumen rápido para las tarjetas del dashboard (hoy vs total del mes)
async function resumenDashboard(req, res) {
  try {
    const hoy = await pool.query(`
      SELECT COALESCE(SUM(total_usd), 0) AS total_usd, COUNT(*) AS cantidad
      FROM ventas
      WHERE estado = 'completada' AND DATE(fecha) = CURRENT_DATE
    `);

    const mes = await pool.query(`
      SELECT COALESCE(SUM(total_usd), 0) AS total_usd, COUNT(*) AS cantidad
      FROM ventas
      WHERE estado = 'completada' AND DATE_TRUNC('month', fecha) = DATE_TRUNC('month', CURRENT_DATE)
    `);

    const stockBajo = await pool.query(`
      SELECT COUNT(*) AS cantidad FROM productos WHERE activo = true AND stock <= 5
    `);

    res.json({
      hoy: hoy.rows[0],
      mes: mes.rows[0],
      productos_stock_bajo: stockBajo.rows[0].cantidad
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener resumen', error: error.message });
  }
}

module.exports = {
  productosMasVendidos,
  ventasPorMetodoPago,
  ventasPorMoneda,
  ventasDiarias,
  resumenDashboard
};