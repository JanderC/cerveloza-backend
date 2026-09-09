const pool = require('../../config/db');

// Registrar una salida de inventario sin venta (colaboración, muestra, regalo)
async function crearColaboracion(req, res) {
  const { producto_id, cantidad, receptor, motivo, sesion_caja_id } = req.body;
  const usuario_id = req.usuario.id;

  if (!producto_id || !cantidad || cantidad <= 0) {
    return res.status(400).json({ message: 'Producto y cantidad son requeridos' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const productoResultado = await client.query(
      'SELECT * FROM productos WHERE id = $1 AND activo = true FOR UPDATE',
      [producto_id]
    );
    if (productoResultado.rows.length === 0) {
      throw new Error('Producto no encontrado');
    }
    const producto = productoResultado.rows[0];

    if (producto.stock < cantidad) {
      throw new Error(`Stock insuficiente (disponible: ${producto.stock})`);
    }

    await client.query('UPDATE productos SET stock = stock - $1 WHERE id = $2', [cantidad, producto.id]);

    const resultado = await client.query(
      `INSERT INTO colaboraciones (producto_id, cantidad, costo_unitario_original, moneda_original, receptor, motivo, sesion_caja_id, usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        producto.id, cantidad, producto.precio_compra, producto.moneda_base,
        receptor || null, motivo || null, sesion_caja_id || null, usuario_id
      ]
    );

    await client.query('COMMIT');
    res.status(201).json(resultado.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ message: error.message });
  } finally {
    client.release();
  }
}

// Historial de colaboraciones (el "kardex")
async function listarColaboraciones(req, res) {
  const { desde, hasta } = req.query;
  try {
    let query = `
      SELECT col.*, p.nombre AS producto_nombre, p.codigo AS producto_codigo, u.nombre AS usuario_nombre
      FROM colaboraciones col
      JOIN productos p ON p.id = col.producto_id
      JOIN usuarios u ON u.id = col.usuario_id
    `;
    const params = [];

    if (desde && hasta) {
      query += ` WHERE col.fecha BETWEEN $1 AND $2`;
      params.push(desde, hasta);
    }

    query += ' ORDER BY col.fecha DESC';

    const resultado = await pool.query(query, params);
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar colaboraciones', error: error.message });
  }
}

// Resumen: total invertido en colaboraciones (a costo), para saber el impacto real
async function resumenColaboraciones(req, res) {
  const { desde, hasta } = req.query;
  try {
    let query = `
      SELECT moneda_original AS moneda, SUM(cantidad) AS cantidad_total, SUM(cantidad * costo_unitario_original) AS costo_total
      FROM colaboraciones
    `;
    const params = [];

    if (desde && hasta) {
      query += ` WHERE fecha BETWEEN $1 AND $2`;
      params.push(desde, hasta);
    }

    query += ' GROUP BY moneda_original';

    const resultado = await pool.query(query, params);
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener resumen', error: error.message });
  }
}

module.exports = { crearColaboracion, listarColaboraciones, resumenColaboraciones };