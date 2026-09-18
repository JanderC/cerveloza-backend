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

    // Si no mandan fondo inicial, se arrastra el que dejó el último cierre.
    // Así el efectivo que quedó físicamente en el cajón nunca se pierde de vista.
    const ultimoCierre = await pool.query(
      `SELECT fondo_siguiente_usd, fondo_siguiente_cop, fondo_siguiente_ves
       FROM sesiones_caja
       WHERE estado = 'cerrada'
       ORDER BY fecha_cierre DESC
       LIMIT 1`
    );
    const arrastre = ultimoCierre.rows[0] || {};

    const fondoUsd = fondo_inicial_usd !== undefined && fondo_inicial_usd !== null
      ? fondo_inicial_usd : Number(arrastre.fondo_siguiente_usd || 0);
    const fondoCop = fondo_inicial_cop !== undefined && fondo_inicial_cop !== null
      ? fondo_inicial_cop : Number(arrastre.fondo_siguiente_cop || 0);
    const fondoVes = fondo_inicial_ves !== undefined && fondo_inicial_ves !== null
      ? fondo_inicial_ves : Number(arrastre.fondo_siguiente_ves || 0);

    const resultado = await pool.query(
      `INSERT INTO sesiones_caja (usuario_id, fondo_inicial_usd, fondo_inicial_cop, fondo_inicial_ves)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [usuario_id, fondoUsd, fondoCop, fondoVes]
    );

    res.status(201).json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al abrir caja', error: error.message });
  }
}

// Cuánto efectivo quedó en el cajón según el último cierre (sugerencia de fondo inicial)
async function fondoArrastrado(req, res) {
  try {
    const resultado = await pool.query(
      `SELECT id, fecha_cierre, fondo_siguiente_usd, fondo_siguiente_cop, fondo_siguiente_ves
       FROM sesiones_caja
       WHERE estado = 'cerrada'
       ORDER BY fecha_cierre DESC
       LIMIT 1`
    );
    const ultimo = resultado.rows[0];
    res.json({
      ultima_sesion_id: ultimo?.id || null,
      fecha_cierre: ultimo?.fecha_cierre || null,
      fondo_siguiente_usd: Number(ultimo?.fondo_siguiente_usd || 0),
      fondo_siguiente_cop: Number(ultimo?.fondo_siguiente_cop || 0),
      fondo_siguiente_ves: Number(ultimo?.fondo_siguiente_ves || 0)
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener fondo arrastrado', error: error.message });
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
       WHERE v.sesion_caja_id = $1 AND mp.es_efectivo = true AND v.estado = 'completada'
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
       WHERE mc.sesion_caja_id = $1 AND mc.tipo = 'abono' AND mp.es_efectivo = true
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

// Cerrar sesión: calcula lo esperado, compara con el conteo físico, deja el fondo
// para el turno siguiente, deposita el resto en el Financiero y bloquea la sesión.
async function cerrarCaja(req, res) {
  const { id } = req.params;
  const {
    conteo_final_usd, conteo_final_cop, conteo_final_ves,
    fondo_siguiente_usd, fondo_siguiente_cop, fondo_siguiente_ves,
    notas_cierre
  } = req.body;
  const usuario_id = req.usuario.id;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const sesionResultado = await client.query('SELECT * FROM sesiones_caja WHERE id = $1 FOR UPDATE', [id]);
    if (sesionResultado.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Sesión no encontrada' });
    }
    const sesion = sesionResultado.rows[0];
    if (sesion.estado === 'cerrada') {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Esta sesión ya está cerrada' });
    }

    const conteos = {
      USD: Number(conteo_final_usd || 0),
      COP: Number(conteo_final_cop || 0),
      VES: Number(conteo_final_ves || 0)
    };
    const fondosSiguientes = {
      USD: Number(fondo_siguiente_usd || 0),
      COP: Number(fondo_siguiente_cop || 0),
      VES: Number(fondo_siguiente_ves || 0)
    };

    // No se puede dejar para mañana más plata de la que realmente hay en el cajón
    for (const moneda of ['USD', 'COP', 'VES']) {
      if (fondosSiguientes[moneda] > conteos[moneda] + 0.005) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          message: `El fondo que dejás para el siguiente turno en ${moneda} (${fondosSiguientes[moneda].toFixed(2)}) no puede superar lo contado (${conteos[moneda].toFixed(2)})`
        });
      }
    }

    async function calcularEsperado(moneda) {
      const ventas = await client.query(
        `SELECT COALESCE(SUM(pv.monto), 0) AS total
         FROM pagos_venta pv
         JOIN ventas v ON v.id = pv.venta_id
         JOIN metodos_pago mp ON mp.id = pv.metodo_pago_id
         WHERE v.sesion_caja_id = $1 AND mp.es_efectivo = true AND pv.moneda = $2 AND v.estado = 'completada'`,
        [id, moneda]
      );
      const ingresos = await client.query(
        `SELECT COALESCE(SUM(monto), 0) AS total FROM movimientos_caja WHERE sesion_caja_id = $1 AND tipo = 'ingreso' AND moneda = $2`,
        [id, moneda]
      );
      const egresos = await client.query(
        `SELECT COALESCE(SUM(monto), 0) AS total FROM movimientos_caja WHERE sesion_caja_id = $1 AND tipo = 'egreso' AND moneda = $2`,
        [id, moneda]
      );
      const abonos = await client.query(
        `SELECT COALESCE(SUM(mc.monto), 0) AS total
         FROM movimientos_cuenta mc
         JOIN metodos_pago mp ON mp.id = mc.metodo_pago_id
         WHERE mc.sesion_caja_id = $1 AND mc.tipo = 'abono' AND mp.es_efectivo = true AND mc.moneda = $2`,
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

    const diferenciaUsd = conteos.USD - esperadoUsd;
    const diferenciaCop = conteos.COP - esperadoCop;
    const diferenciaVes = conteos.VES - esperadoVes;

    const resultado = await client.query(
      `UPDATE sesiones_caja SET
        conteo_final_usd = $1, conteo_final_cop = $2, conteo_final_ves = $3,
        esperado_final_usd = $4, esperado_final_cop = $5, esperado_final_ves = $6,
        diferencia_usd = $7, diferencia_cop = $8, diferencia_ves = $9,
        fondo_siguiente_usd = $10, fondo_siguiente_cop = $11, fondo_siguiente_ves = $12,
        estado = 'cerrada', fecha_cierre = NOW(), notas_cierre = $13
       WHERE id = $14
       RETURNING *`,
      [
        conteos.USD, conteos.COP, conteos.VES,
        esperadoUsd, esperadoCop, esperadoVes,
        diferenciaUsd, diferenciaCop, diferenciaVes,
        fondosSiguientes.USD, fondosSiguientes.COP, fondosSiguientes.VES,
        notas_cierre || null, id
      ]
    );

    // Deposita en el Financiero el efectivo CONTADO menos el fondo que queda
    // en el cajón para el turno siguiente. Va dentro de la misma transacción:
    // si algo falla, no se cierra la caja ni se deposita a medias.
    const depositos = [];
    for (const moneda of ['USD', 'COP', 'VES']) {
      const aDepositar = Number((conteos[moneda] - fondosSiguientes[moneda]).toFixed(2));
      if (aDepositar <= 0) continue;

      const deposito = await client.query(
        `INSERT INTO financiero_movimientos (tipo, concepto, moneda, monto, sesion_caja_id, usuario_id)
         VALUES ('deposito_cierre', $1, $2, $3, $4, $5)
         RETURNING *`,
        [`Cierre de caja #${id}`, moneda, aDepositar, id, usuario_id]
      );
      depositos.push(deposito.rows[0]);
    }

    await client.query('COMMIT');

    res.json({ ...resultado.rows[0], depositos_financiero: depositos });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: 'Error al cerrar caja', error: error.message });
  } finally {
    client.release();
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

async function movimientosDelDia(req, res) {
  const { id } = req.params;
  try {
    const ventas = await pool.query(
      `SELECT v.id, v.numero_venta, v.fecha, v.estado, u.nombre AS usuario,
              COALESCE(SUM(CASE WHEN pv.moneda='USD' THEN pv.monto END),0) AS usd,
              COALESCE(SUM(CASE WHEN pv.moneda='COP' THEN pv.monto END),0) AS cop,
              COALESCE(SUM(CASE WHEN pv.moneda='VES' THEN pv.monto END),0) AS ves
       FROM ventas v
       JOIN usuarios u ON u.id = v.usuario_id
       LEFT JOIN pagos_venta pv ON pv.venta_id = v.id
       WHERE v.sesion_caja_id = $1 AND v.estado = 'completada'
       GROUP BY v.id, u.nombre`,
      [id]
    );

    const movimientos = await pool.query(
      `SELECT id, tipo, concepto, moneda, monto, fecha FROM movimientos_caja WHERE sesion_caja_id = $1`,
      [id]
    );

    const abonos = await pool.query(
      `SELECT mc.id, mc.moneda, mc.monto, mc.fecha, c.nombre AS cliente, mp.nombre AS metodo
       FROM movimientos_cuenta mc
       JOIN clientes c ON c.id = mc.cliente_id
       LEFT JOIN metodos_pago mp ON mp.id = mc.metodo_pago_id
       WHERE mc.sesion_caja_id = $1 AND mc.tipo = 'abono'`,
      [id]
    );

    const eventos = [
      ...ventas.rows.map((v) => ({ tipo: 'venta', fecha: v.fecha, detalle: `Venta ${v.numero_venta} · ${v.usuario}`, usd: Number(v.usd), cop: Number(v.cop), ves: Number(v.ves) })),
      ...movimientos.rows.map((m) => ({ tipo: m.tipo, fecha: m.fecha, detalle: m.concepto, moneda: m.moneda, monto: Number(m.monto) })),
      ...abonos.rows.map((a) => ({ tipo: 'abono', fecha: a.fecha, detalle: `Abono de ${a.cliente} (${a.metodo})`, moneda: a.moneda, monto: Number(a.monto) }))
    ].sort((a, b) => new Date(b.fecha) - new Date(a.fecha));

    res.json(eventos);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener movimientos del día', error: error.message });
  }
}


module.exports = {
  obtenerSesionAbierta,
  abrirCaja,
  fondoArrastrado,
  registrarMovimiento,
  resumenSesion,
  cerrarCaja,
  listarHistorialSesiones,
  movimientosDelDia
};