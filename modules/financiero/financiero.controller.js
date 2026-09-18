const pool = require('../../config/db');

const MONEDAS = ['USD', 'COP', 'VES'];

// Tipos que suman al saldo del Financiero
const TIPOS_ENTRADA = ['deposito_cierre', 'ingreso'];
// Tipos que restan (solo admin puede registrarlos)
const TIPOS_SALIDA = ['pago_factura', 'pago_empleado', 'retiro'];
const TIPOS_VALIDOS = [...TIPOS_ENTRADA, ...TIPOS_SALIDA];

function esEntrada(tipo) {
  return TIPOS_ENTRADA.includes(tipo);
}

// Saldo disponible por moneda = entradas - salidas
async function calcularSaldos(cliente = pool) {
  const resultado = await cliente.query(
    `SELECT moneda,
            COALESCE(SUM(CASE WHEN tipo IN ('deposito_cierre','ingreso') THEN monto ELSE 0 END), 0) AS entradas,
            COALESCE(SUM(CASE WHEN tipo IN ('pago_factura','pago_empleado','retiro') THEN monto ELSE 0 END), 0) AS salidas
     FROM financiero_movimientos
     GROUP BY moneda`
  );

  const saldos = {};
  for (const m of MONEDAS) {
    const fila = resultado.rows.find((f) => f.moneda === m);
    const entradas = fila ? Number(fila.entradas) : 0;
    const salidas = fila ? Number(fila.salidas) : 0;
    saldos[m] = { entradas, salidas, saldo: entradas - salidas };
  }
  return saldos;
}

// GET /financiero/saldos — cuánto hay disponible ahora mismo, por moneda
async function obtenerSaldos(req, res) {
  try {
    res.json(await calcularSaldos());
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener saldos del financiero', error: error.message });
  }
}

// GET /financiero/movimientos — historial con filtros y paginación
async function listarMovimientos(req, res) {
  const { moneda, tipo, desde, hasta, pagina = 1, por_pagina = 20 } = req.query;

  try {
    const condiciones = [];
    const params = [];

    if (moneda) {
      params.push(moneda);
      condiciones.push(`fm.moneda = $${params.length}`);
    }
    if (tipo) {
      params.push(tipo);
      condiciones.push(`fm.tipo = $${params.length}`);
    }
    if (desde) {
      params.push(desde);
      condiciones.push(`fm.fecha >= $${params.length}`);
    }
    if (hasta) {
      params.push(hasta);
      condiciones.push(`fm.fecha <= $${params.length}`);
    }

    const where = condiciones.length > 0 ? `WHERE ${condiciones.join(' AND ')}` : '';

    const totalResultado = await pool.query(
      `SELECT COUNT(*)::int AS total FROM financiero_movimientos fm ${where}`,
      params
    );

    const limite = Math.min(Number(por_pagina) || 20, 100);
    const offset = (Math.max(Number(pagina) || 1, 1) - 1) * limite;
    params.push(limite, offset);

    const resultado = await pool.query(
      `SELECT fm.*, u.nombre AS usuario_nombre
       FROM financiero_movimientos fm
       JOIN usuarios u ON u.id = fm.usuario_id
       ${where}
       ORDER BY fm.fecha DESC, fm.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      movimientos: resultado.rows,
      total: totalResultado.rows[0].total,
      pagina: Number(pagina) || 1,
      por_pagina: limite
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al listar movimientos del financiero', error: error.message });
  }
}

// POST /financiero/movimiento — registra pago de factura, pago a empleado, retiro o ingreso manual
async function registrarMovimiento(req, res) {
  const { tipo, concepto, moneda, monto, beneficiario, referencia, nota } = req.body;
  const usuario = req.usuario;

  if (!TIPOS_VALIDOS.includes(tipo)) {
    return res.status(400).json({ message: 'Tipo de movimiento inválido' });
  }
  if (tipo === 'deposito_cierre') {
    return res.status(400).json({ message: 'Los depósitos se generan automáticamente al cerrar caja' });
  }
  if (!MONEDAS.includes(moneda)) {
    return res.status(400).json({ message: 'Moneda inválida' });
  }
  if (!concepto || !concepto.trim()) {
    return res.status(400).json({ message: 'El concepto es obligatorio' });
  }

  const montoNumero = Number(monto);
  if (!Number.isFinite(montoNumero) || montoNumero <= 0) {
    return res.status(400).json({ message: 'El monto debe ser mayor a cero' });
  }

  // Solo admin puede sacar dinero del financiero
  if (TIPOS_SALIDA.includes(tipo) && usuario.rol !== 'admin') {
    return res.status(403).json({ message: 'Solo un administrador puede registrar pagos o retiros del financiero' });
  }

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');

    // Bloquea los movimientos de esa moneda para que dos retiros simultáneos
    // no puedan dejar el saldo en negativo
    if (TIPOS_SALIDA.includes(tipo)) {
      await cliente.query(
        'SELECT id FROM financiero_movimientos WHERE moneda = $1 FOR UPDATE',
        [moneda]
      );

      const saldos = await calcularSaldos(cliente);
      const disponible = saldos[moneda].saldo;
      if (montoNumero > disponible + 0.005) {
        await cliente.query('ROLLBACK');
        return res.status(400).json({
          message: `Saldo insuficiente en ${moneda}. Disponible: ${disponible.toFixed(2)}`
        });
      }
    }

    const resultado = await cliente.query(
      `INSERT INTO financiero_movimientos (tipo, concepto, moneda, monto, beneficiario, referencia, nota, usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [tipo, concepto.trim(), moneda, montoNumero, beneficiario || null, referencia || null, nota || null, usuario.id]
    );

    await cliente.query('COMMIT');
    res.status(201).json(resultado.rows[0]);
  } catch (error) {
    await cliente.query('ROLLBACK');
    res.status(500).json({ message: 'Error al registrar movimiento', error: error.message });
  } finally {
    cliente.release();
  }
}

// GET /financiero/resumen — saldos + cuánto entró/salió en el periodo + últimos movimientos
async function resumen(req, res) {
  const { desde, hasta } = req.query;

  try {
    const saldos = await calcularSaldos();

    const condiciones = [];
    const params = [];
    if (desde) {
      params.push(desde);
      condiciones.push(`fecha >= $${params.length}`);
    }
    if (hasta) {
      params.push(hasta);
      condiciones.push(`fecha <= $${params.length}`);
    }
    const where = condiciones.length > 0 ? `WHERE ${condiciones.join(' AND ')}` : '';

    const periodo = await pool.query(
      `SELECT moneda, tipo, COALESCE(SUM(monto), 0) AS total, COUNT(*)::int AS cantidad
       FROM financiero_movimientos
       ${where}
       GROUP BY moneda, tipo
       ORDER BY moneda, tipo`,
      params
    );

    const ultimos = await pool.query(
      `SELECT fm.*, u.nombre AS usuario_nombre
       FROM financiero_movimientos fm
       JOIN usuarios u ON u.id = fm.usuario_id
       ORDER BY fm.fecha DESC, fm.id DESC
       LIMIT 10`
    );

    res.json({
      saldos,
      periodo: periodo.rows,
      ultimos_movimientos: ultimos.rows
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener resumen del financiero', error: error.message });
  }
}

// GET /financiero/depositos — qué depositó cada cierre de caja
async function listarDepositosPorCierre(req, res) {
  try {
    const resultado = await pool.query(
      `SELECT sc.id AS sesion_id, sc.fecha_apertura, sc.fecha_cierre,
              u.nombre AS cajero,
              fm.moneda, fm.monto, fm.fecha AS fecha_deposito
       FROM financiero_movimientos fm
       JOIN sesiones_caja sc ON sc.id = fm.sesion_caja_id
       JOIN usuarios u ON u.id = sc.usuario_id
       WHERE fm.tipo = 'deposito_cierre'
       ORDER BY fm.fecha DESC
       LIMIT 100`
    );
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar depósitos', error: error.message });
  }
}

module.exports = {
  obtenerSaldos,
  listarMovimientos,
  registrarMovimiento,
  resumen,
  listarDepositosPorCierre,
  calcularSaldos,
  esEntrada,
  MONEDAS
};
