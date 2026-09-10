const pool = require('../../config/db');
const { convertirAUSD } = require('../../utils/conversionMoneda');

// Obtiene la sesión abierta actualmente (si existe)
async function obtenerSesionAbierta(req, res) {
  try {
    const resultado = await pool.query(
      `SELECT sc.*, u.nombre AS usuario_nombre
       FROM sesiones_caja sc
       JOIN usuarios u ON u.id = sc.usuario_id
       WHERE sc.estado = 'abierta'
       ORDER BY sc.fecha_apertura DESC
       LIMIT 1`
    );
    res.json(resultado.rows[0] || null);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener la sesión de caja', error: error.message });
  }
}

// Abre una nueva sesión (falla si ya hay una abierta)
async function abrirCaja(req, res) {
  const { fondo_inicial_usd, fondo_inicial_cop, fondo_inicial_ves } = req.body;
  const usuario_id = req.usuario.id;

  try {
    const existente = await pool.query(`SELECT id FROM sesiones_caja WHERE estado = 'abierta'`);
    if (existente.rows.length > 0) {
      return res.status(409).json({ message: 'Ya hay una sesión de caja abierta' });
    }

    const resultado = await pool.query(
      `INSERT INTO sesiones_caja (usuario_id, fondo_inicial_usd, fondo_inicial_cop, fondo_inicial_ves)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [usuario_id, fondo_inicial_usd || 0, fondo_inicial_cop || 0, fondo_inicial_ves || 0]
    );

    res.status(201).json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al abrir caja', error: error.message });
  }
}

// Registrar ingreso/egreso manual
async function registrarMovimiento(req, res) {
  const { sesion_caja_id, tipo, concepto, moneda, monto } = req.body;
  const usuario_id = req.usuario.id;

  if (!['ingreso', 'egreso'].includes(tipo)) {
    return res.status(400).json({ message: 'Tipo de movimiento inválido' });
  }

  try {
    const tasaResultado = await pool.query(
      'SELECT * FROM tasas_cambio ORDER BY fecha DESC, created_at DESC LIMIT 1'
    );
    if (tasaResultado.rows.length === 0) {
      return res.status(400).json({ message: 'No hay tasa de cambio registrada' });
    }
    const tasa = tasaResultado.rows[0];
    const montoUsd = convertirAUSD(monto, moneda, tasa);

    const resultado = await pool.query(
      `INSERT INTO movimientos_caja (sesion_caja_id, tipo, concepto, moneda, monto, monto_usd, usuario_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [sesion_caja_id, tipo, concepto, moneda, monto, montoUsd, usuario_id]
    );

    res.status(201).json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al registrar movimiento', error: error.message });
  }
}

// Resumen en vivo del turno (para mostrar mientras la caja está abierta)
async function resumenSesion(req, res) {
  const { id } = req.params;

  try {
    const sesionResultado = await pool.query('SELECT * FROM sesiones_caja WHERE id = $1', [id]);
    if (sesionResultado.rows.length === 0) {
      return res.status(404).json({ message: 'Sesión no encontrada' });
    }
    const sesion = sesionResultado.rows[0];

    // Ventas en efectivo de esta sesión, por moneda
    const ventasEfectivo = await pool.query(
      `SELECT pv.moneda, SUM(pv.monto) AS total
       FROM pagos_venta pv
       JOIN ventas v ON v.id = pv.venta_id
       JOIN metodos_pago mp ON mp.id = pv.metodo_pago_id
       WHERE v.sesion_caja_id = $1 AND mp.nombre = 'Efectivo' AND v.estado = 'completada'
       GROUP BY pv.moneda`,
      [id]
    );

    const pagosPorMetodo = await pool.query(
  `SELECT mp.nombre AS metodo, pv.moneda, SUM(pv.monto) AS total
   FROM pagos_venta pv
   JOIN ventas v ON v.id = pv.venta_id
   JOIN metodos_pago mp ON mp.id = pv.metodo_pago_id
   WHERE v.sesion_caja_id = $1 AND v.estado = 'completada'
   GROUP BY mp.nombre, pv.moneda
   ORDER BY pv.moneda, mp.nombre`,
  [id]
);

    // Ingresos y egresos manuales, por moneda
    const movimientos = await pool.query(
      `SELECT tipo, moneda, SUM(monto) AS total
       FROM movimientos_caja
       WHERE sesion_caja_id = $1
       GROUP BY tipo, moneda`,
      [id]
    );

    // Abonos en efectivo recibidos en este turno
    const abonosEfectivo = await pool.query(
      `SELECT mc.moneda, SUM(mc.monto) AS total
       FROM movimientos_cuenta mc
       JOIN metodos_pago mp ON mp.id = mc.metodo_pago_id
       WHERE mc.sesion_caja_id = $1 AND mc.tipo = 'abono' AND mp.nombre = 'Efectivo'
       GROUP BY mc.moneda`,
      [id]
    );

    // Total fiado otorgado en el turno (informativo, no afecta efectivo)
    const fiadoOtorgado = await pool.query(
      `SELECT COALESCE(SUM(mc.monto_usd), 0) AS total_usd
       FROM movimientos_cuenta mc
       WHERE mc.sesion_caja_id = $1 AND mc.tipo = 'cargo'`,
      [id]
    );

    res.json({
  sesion,
  ventas_efectivo: ventasEfectivo.rows,
  movimientos: movimientos.rows,
  abonos_efectivo: abonosEfectivo.rows,
  fiado_otorgado_usd: fiadoOtorgado.rows[0].total_usd,
  pagos_por_metodo: pagosPorMetodo.rows
});
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener resumen', error: error.message });
  }
}

// Cerrar sesión: calcula lo esperado, compara con el conteo físico, y bloquea la sesión
async function cerrarCaja(req, res) {
  const { id } = req.params;
  const { conteo_final_usd, conteo_final_cop, conteo_final_ves, notas_cierre } = req.body;

  try {
    const sesionResultado = await pool.query('SELECT * FROM sesiones_caja WHERE id = $1', [id]);
    if (sesionResultado.rows.length === 0) {
      return res.status(404).json({ message: 'Sesión no encontrada' });
    }
    const sesion = sesionResultado.rows[0];
    if (sesion.estado === 'cerrada') {
      return res.status(400).json({ message: 'Esta sesión ya está cerrada' });
    }

    async function calcularEsperado(moneda) {
      const ventas = await pool.query(
        `SELECT COALESCE(SUM(pv.monto), 0) AS total
         FROM pagos_venta pv
         JOIN ventas v ON v.id = pv.venta_id
         JOIN metodos_pago mp ON mp.id = pv.metodo_pago_id
         WHERE v.sesion_caja_id = $1 AND mp.nombre = 'Efectivo' AND pv.moneda = $2 AND v.estado = 'completada'`,
        [id, moneda]
      );
      const ingresos = await pool.query(
        `SELECT COALESCE(SUM(monto), 0) AS total FROM movimientos_caja WHERE sesion_caja_id = $1 AND tipo = 'ingreso' AND moneda = $2`,
        [id, moneda]
      );
      const egresos = await pool.query(
        `SELECT COALESCE(SUM(monto), 0) AS total FROM movimientos_caja WHERE sesion_caja_id = $1 AND tipo = 'egreso' AND moneda = $2`,
        [id, moneda]
      );
      const abonos = await pool.query(
        `SELECT COALESCE(SUM(mc.monto), 0) AS total
         FROM movimientos_cuenta mc
         JOIN metodos_pago mp ON mp.id = mc.metodo_pago_id
         WHERE mc.sesion_caja_id = $1 AND mc.tipo = 'abono' AND mp.nombre = 'Efectivo' AND mc.moneda = $2`,
        [id, moneda]
      );

      const fondoInicial = Number(sesion[`fondo_inicial_${moneda.toLowerCase()}`]);
      return (
        fondoInicial +
        Number(ventas.rows[0].total) +
        Number(ingresos.rows[0].total) -
        Number(egresos.rows[0].total) +
        Number(abonos.rows[0].total)
      );
    }

    const esperadoUsd = await calcularEsperado('USD');
    const esperadoCop = await calcularEsperado('COP');
    const esperadoVes = await calcularEsperado('VES');

    const diferenciaUsd = Number(conteo_final_usd || 0) - esperadoUsd;
    const diferenciaCop = Number(conteo_final_cop || 0) - esperadoCop;
    const diferenciaVes = Number(conteo_final_ves || 0) - esperadoVes;

    const resultado = await pool.query(
      `UPDATE sesiones_caja SET
        conteo_final_usd = $1, conteo_final_cop = $2, conteo_final_ves = $3,
        esperado_final_usd = $4, esperado_final_cop = $5, esperado_final_ves = $6,
        diferencia_usd = $7, diferencia_cop = $8, diferencia_ves = $9,
        estado = 'cerrada', fecha_cierre = NOW(), notas_cierre = $10
       WHERE id = $11
       RETURNING *`,
      [
        conteo_final_usd || 0, conteo_final_cop || 0, conteo_final_ves || 0,
        esperadoUsd, esperadoCop, esperadoVes,
        diferenciaUsd, diferenciaCop, diferenciaVes,
        notas_cierre || null, id
      ]
    );

    res.json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al cerrar caja', error: error.message });
  }
}

// Historial de sesiones cerradas
async function listarHistorialSesiones(req, res) {
  try {
    const resultado = await pool.query(
      `SELECT sc.*, u.nombre AS usuario_nombre
       FROM sesiones_caja sc
       JOIN usuarios u ON u.id = sc.usuario_id
       WHERE sc.estado = 'cerrada'
       ORDER BY sc.fecha_cierre DESC
       LIMIT 30`
    );
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar historial', error: error.message });
  }
}

module.exports = {
  obtenerSesionAbierta,
  abrirCaja,
  registrarMovimiento,
  resumenSesion,
  cerrarCaja,
  listarHistorialSesiones
};