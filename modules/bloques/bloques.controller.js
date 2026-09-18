const pool = require('../../config/db');

const MONEDAS = ['USD', 'COP', 'VES'];

// Devuelve el bloque abierto usando el cliente/transacción que se le pase.
// Si no hay ninguno, abre uno automáticamente: nunca se debe bloquear una venta
// porque nadie se acordó de abrir el bloque.
async function obtenerOCrearBloqueAbierto(cliente, usuario_id) {
  const existente = await cliente.query(
    `SELECT * FROM bloques_venta WHERE estado = 'abierto' LIMIT 1`
  );
  if (existente.rows.length > 0) return existente.rows[0];

  const creado = await cliente.query(
    `INSERT INTO bloques_venta (nombre, usuario_apertura_id, notas)
     VALUES ($1, $2, $3)
     RETURNING *`,
    ['Bloque automático', usuario_id, 'Abierto automáticamente al registrar una venta sin bloque activo.']
  );
  const bloque = creado.rows[0];

  const conNumero = await cliente.query(
    `UPDATE bloques_venta SET numero = $1 WHERE id = $2 RETURNING *`,
    [`BLQ-${String(bloque.id).padStart(5, '0')}`, bloque.id]
  );
  return conNumero.rows[0];
}

// Totales de un bloque: cuántas ventas, cuánto por moneda y por método de pago
async function calcularResumenBloque(bloqueId, cliente = pool) {
  const totales = await cliente.query(
    `SELECT pv.moneda, COALESCE(SUM(pv.monto), 0) AS total
     FROM pagos_venta pv
     JOIN ventas v ON v.id = pv.venta_id
     WHERE v.bloque_id = $1 AND v.estado = 'completada'
     GROUP BY pv.moneda`,
    [bloqueId]
  );

  const porMetodo = await cliente.query(
    `SELECT mp.nombre AS metodo, mp.es_efectivo, pv.moneda, COALESCE(SUM(pv.monto), 0) AS total
     FROM pagos_venta pv
     JOIN ventas v ON v.id = pv.venta_id
     JOIN metodos_pago mp ON mp.id = pv.metodo_pago_id
     WHERE v.bloque_id = $1 AND v.estado = 'completada'
     GROUP BY mp.nombre, mp.es_efectivo, pv.moneda
     ORDER BY pv.moneda, mp.nombre`,
    [bloqueId]
  );

  const conteo = await cliente.query(
    `SELECT
       COUNT(*) FILTER (WHERE estado = 'completada')::int AS completadas,
       COUNT(*) FILTER (WHERE estado = 'fiado')::int AS fiadas,
       COUNT(*)::int AS total
     FROM ventas WHERE bloque_id = $1`,
    [bloqueId]
  );

  const fiado = await cliente.query(
    `SELECT mc.moneda, COALESCE(SUM(mc.monto), 0) AS total
     FROM movimientos_cuenta mc
     JOIN ventas v ON v.id = mc.venta_id
     WHERE v.bloque_id = $1 AND mc.tipo = 'cargo'
     GROUP BY mc.moneda`,
    [bloqueId]
  );

  const porMoneda = {};
  for (const m of MONEDAS) {
    const fila = totales.rows.find((f) => f.moneda === m);
    porMoneda[m] = fila ? Number(fila.total) : 0;
  }

  return {
    ventas: conteo.rows[0],
    totales_por_moneda: porMoneda,
    por_metodo: porMetodo.rows,
    fiado_otorgado: fiado.rows
  };
}

// GET /bloques/actual — el bloque abierto con su resumen (null si no hay ninguno)
async function bloqueActual(req, res) {
  try {
    const resultado = await pool.query(
      `SELECT b.*, u.nombre AS usuario_apertura_nombre
       FROM bloques_venta b
       JOIN usuarios u ON u.id = b.usuario_apertura_id
       WHERE b.estado = 'abierto'
       LIMIT 1`
    );
    if (resultado.rows.length === 0) return res.json(null);

    const bloque = resultado.rows[0];
    const resumen = await calcularResumenBloque(bloque.id);
    res.json({ ...bloque, resumen });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener el bloque actual', error: error.message });
  }
}

// POST /bloques/abrir
async function abrirBloque(req, res) {
  const { nombre, notas } = req.body;
  const usuario_id = req.usuario.id;

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');

    const abierto = await cliente.query(`SELECT id, numero FROM bloques_venta WHERE estado = 'abierto' LIMIT 1`);
    if (abierto.rows.length > 0) {
      await cliente.query('ROLLBACK');
      return res.status(409).json({
        message: `Ya hay un bloque abierto (${abierto.rows[0].numero}). Cerralo antes de abrir otro.`
      });
    }

    const creado = await cliente.query(
      `INSERT INTO bloques_venta (nombre, usuario_apertura_id, notas)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [nombre?.trim() || null, usuario_id, notas?.trim() || null]
    );
    const bloque = creado.rows[0];

    const conNumero = await cliente.query(
      `UPDATE bloques_venta SET numero = $1 WHERE id = $2 RETURNING *`,
      [`BLQ-${String(bloque.id).padStart(5, '0')}`, bloque.id]
    );

    await cliente.query('COMMIT');
    res.status(201).json(conNumero.rows[0]);
  } catch (error) {
    await cliente.query('ROLLBACK');
    res.status(500).json({ message: 'Error al abrir el bloque', error: error.message });
  } finally {
    cliente.release();
  }
}

// POST /bloques/:id/cerrar
async function cerrarBloque(req, res) {
  const { id } = req.params;
  const { notas } = req.body;
  const usuario_id = req.usuario.id;

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');

    const resultado = await cliente.query('SELECT * FROM bloques_venta WHERE id = $1 FOR UPDATE', [id]);
    if (resultado.rows.length === 0) {
      await cliente.query('ROLLBACK');
      return res.status(404).json({ message: 'Bloque no encontrado' });
    }
    if (resultado.rows[0].estado === 'cerrado') {
      await cliente.query('ROLLBACK');
      return res.status(400).json({ message: 'Este bloque ya está cerrado' });
    }

    // El resumen se calcula ANTES de cerrar, para devolverlo junto con el cierre
    const resumen = await calcularResumenBloque(id, cliente);

    const cerrado = await cliente.query(
      `UPDATE bloques_venta
       SET estado = 'cerrado', fecha_cierre = NOW(), usuario_cierre_id = $1,
           notas = COALESCE($2, notas)
       WHERE id = $3
       RETURNING *`,
      [usuario_id, notas?.trim() || null, id]
    );

    await cliente.query('COMMIT');
    res.json({ ...cerrado.rows[0], resumen });
  } catch (error) {
    await cliente.query('ROLLBACK');
    res.status(500).json({ message: 'Error al cerrar el bloque', error: error.message });
  } finally {
    cliente.release();
  }
}

// GET /bloques — historial
async function listarBloques(req, res) {
  const { estado, pagina = 1, por_pagina = 20 } = req.query;
  try {
    const params = [];
    let where = '';
    if (estado) {
      params.push(estado);
      where = `WHERE b.estado = $${params.length}`;
    }

    const totalResultado = await pool.query(
      `SELECT COUNT(*)::int AS total FROM bloques_venta b ${where}`,
      params
    );

    const limite = Math.min(Number(por_pagina) || 20, 100);
    const offset = (Math.max(Number(pagina) || 1, 1) - 1) * limite;
    params.push(limite, offset);

    const resultado = await pool.query(
      `SELECT b.*,
              ua.nombre AS usuario_apertura_nombre,
              uc.nombre AS usuario_cierre_nombre,
              (SELECT COUNT(*)::int FROM ventas v WHERE v.bloque_id = b.id) AS cantidad_ventas
       FROM bloques_venta b
       JOIN usuarios ua ON ua.id = b.usuario_apertura_id
       LEFT JOIN usuarios uc ON uc.id = b.usuario_cierre_id
       ${where}
       ORDER BY b.fecha_apertura DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      bloques: resultado.rows,
      total: totalResultado.rows[0].total,
      pagina: Number(pagina) || 1,
      por_pagina: limite
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al listar bloques', error: error.message });
  }
}

// GET /bloques/:id/resumen
async function resumenBloque(req, res) {
  const { id } = req.params;
  try {
    const bloque = await pool.query(
      `SELECT b.*, ua.nombre AS usuario_apertura_nombre, uc.nombre AS usuario_cierre_nombre
       FROM bloques_venta b
       JOIN usuarios ua ON ua.id = b.usuario_apertura_id
       LEFT JOIN usuarios uc ON uc.id = b.usuario_cierre_id
       WHERE b.id = $1`,
      [id]
    );
    if (bloque.rows.length === 0) {
      return res.status(404).json({ message: 'Bloque no encontrado' });
    }
    res.json({ ...bloque.rows[0], resumen: await calcularResumenBloque(id) });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener el resumen del bloque', error: error.message });
  }
}

// GET /bloques/:id/ventas — las ventas del bloque, sin filtrar por fecha
async function ventasDelBloque(req, res) {
  const { id } = req.params;
  try {
    const resultado = await pool.query(
      `SELECT v.*, u.nombre AS vendedor, c.nombre AS cliente_nombre,
        COALESCE(SUM(CASE WHEN pv.moneda = 'USD' THEN pv.monto END), 0) AS monto_usd,
        COALESCE(SUM(CASE WHEN pv.moneda = 'COP' THEN pv.monto END), 0) AS monto_cop,
        COALESCE(SUM(CASE WHEN pv.moneda = 'VES' THEN pv.monto END), 0) AS monto_ves
       FROM ventas v
       JOIN usuarios u ON u.id = v.usuario_id
       LEFT JOIN clientes c ON c.id = v.cliente_id
       LEFT JOIN pagos_venta pv ON pv.venta_id = v.id
       WHERE v.bloque_id = $1
       GROUP BY v.id, u.nombre, c.nombre
       ORDER BY v.fecha DESC`,
      [id]
    );
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener las ventas del bloque', error: error.message });
  }
}

module.exports = {
  bloqueActual,
  abrirBloque,
  cerrarBloque,
  listarBloques,
  resumenBloque,
  ventasDelBloque,
  obtenerOCrearBloqueAbierto,
  calcularResumenBloque
};
