const pool = require('../../config/db');
const { convertirAUSD, redondear } = require('../../utils/conversionMoneda');

// Cada cliente trae un arreglo de saldos, uno por cada moneda en la que debe (nunca un solo total en USD)
async function listarClientesConSaldo(req, res) {
  try {
    const clientesResultado = await pool.query('SELECT * FROM clientes WHERE activo = true ORDER BY nombre ASC');

    const saldosResultado = await pool.query(`
      SELECT cliente_id, moneda,
             SUM(CASE WHEN tipo = 'cargo' THEN monto ELSE -monto END) AS saldo
      FROM movimientos_cuenta
      GROUP BY cliente_id, moneda
      HAVING SUM(CASE WHEN tipo = 'cargo' THEN monto ELSE -monto END) > 0.01
    `);

    const saldosPorCliente = {};
    for (const fila of saldosResultado.rows) {
      if (!saldosPorCliente[fila.cliente_id]) saldosPorCliente[fila.cliente_id] = [];
      saldosPorCliente[fila.cliente_id].push({ moneda: fila.moneda, saldo: Number(fila.saldo) });
    }

    const clientes = clientesResultado.rows.map((c) => ({
      ...c,
      saldos: saldosPorCliente[c.id] || []
    }));

    res.json(clientes);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar clientes', error: error.message });
  }
}

async function buscarClientes(req, res) {
  const { q } = req.query;
  try {
    const resultado = await pool.query(
      `SELECT id, nombre, telefono FROM clientes WHERE activo = true AND nombre ILIKE $1 ORDER BY nombre ASC LIMIT 10`,
      [`%${q || ''}%`]
    );
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al buscar clientes', error: error.message });
  }
}

async function crearCliente(req, res) {
  const { nombre, telefono, identificacion, nota } = req.body;
  if (!nombre || !nombre.trim()) {
    return res.status(400).json({ message: 'El nombre es requerido' });
  }
  try {
    const resultado = await pool.query(
      `INSERT INTO clientes (nombre, telefono, identificacion, nota) VALUES ($1, $2, $3, $4) RETURNING *`,
      [nombre.trim(), telefono || null, identificacion || null, nota || null]
    );
    res.status(201).json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear cliente', error: error.message });
  }
}

// Estado de cuenta con desglose: cada cargo muestra los productos que lo componen
async function estadoDeCuenta(req, res) {
  const { id } = req.params;
  try {
    const cliente = await pool.query('SELECT * FROM clientes WHERE id = $1', [id]);
    if (cliente.rows.length === 0) {
      return res.status(404).json({ message: 'Cliente no encontrado' });
    }

    const movimientos = await pool.query(
      `SELECT mc.*, v.numero_venta, mp.nombre AS metodo_nombre
       FROM movimientos_cuenta mc
       LEFT JOIN ventas v ON v.id = mc.venta_id
       LEFT JOIN metodos_pago mp ON mp.id = mc.metodo_pago_id
       WHERE mc.cliente_id = $1
       ORDER BY mc.fecha DESC`,
      [id]
    );

    // Trae el desglose de productos para cada cargo que venga de una venta
    const ventaIds = movimientos.rows.filter((m) => m.tipo === 'cargo' && m.venta_id).map((m) => m.venta_id);
    let itemsPorVenta = {};
    if (ventaIds.length > 0) {
      const items = await pool.query(
        `SELECT dv.venta_id, dv.cantidad, dv.subtotal_original, dv.moneda_original, p.nombre
         FROM detalle_venta dv JOIN productos p ON p.id = dv.producto_id
         WHERE dv.venta_id = ANY($1::int[])`,
        [ventaIds]
      );
      for (const item of items.rows) {
        if (!itemsPorVenta[item.venta_id]) itemsPorVenta[item.venta_id] = [];
        itemsPorVenta[item.venta_id].push(item);
      }
    }

    const movimientosConDesglose = movimientos.rows.map((m) => ({
      ...m,
      productos: m.venta_id ? (itemsPorVenta[m.venta_id] || []) : []
    }));

    // Saldos agrupados por moneda (nunca un solo total en USD)
    const saldos = {};
    for (const m of movimientos.rows) {
      const signo = m.tipo === 'cargo' ? 1 : -1;
      saldos[m.moneda] = redondear((saldos[m.moneda] || 0) + signo * Number(m.monto), 2);
    }
    const saldosArray = Object.entries(saldos)
      .filter(([, saldo]) => saldo > 0.01)
      .map(([moneda, saldo]) => ({ moneda, saldo }));

    res.json({ cliente: cliente.rows[0], movimientos: movimientosConDesglose, saldos: saldosArray });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener estado de cuenta', error: error.message });
  }
}

// El abono se aplica SOLO a las deudas de la MISMA moneda (FIFO) — cada moneda es una cuenta separada
async function registrarAbono(req, res) {
  const { cliente_id, moneda, monto, metodo_pago_id, sesion_caja_id, referencia, nota } = req.body;
  const usuario_id = req.usuario.id;

  if (!cliente_id || !moneda || !monto || !metodo_pago_id) {
    return res.status(400).json({ message: 'Faltan datos requeridos' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const tasaResultado = await client.query('SELECT * FROM tasas_cambio ORDER BY fecha DESC, created_at DESC LIMIT 1');
    if (tasaResultado.rows.length === 0) {
      throw new Error('No hay tasa de cambio registrada');
    }
    const tasa = tasaResultado.rows[0];
    const montoRedondeado = redondear(monto, 2);
    const montoUsdInformativo = convertirAUSD(montoRedondeado, moneda, tasa);

    const abonoResultado = await client.query(
      `INSERT INTO movimientos_cuenta (cliente_id, tipo, moneda, monto, monto_usd, metodo_pago_id, sesion_caja_id, referencia, nota, usuario_id)
       VALUES ($1, 'abono', $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [cliente_id, moneda, montoRedondeado, montoUsdInformativo, metodo_pago_id, sesion_caja_id || null, referencia || null, nota || null, usuario_id]
    );

    // Aplica el abono a los cargos pendientes de ESA MISMA MONEDA, del más antiguo al más reciente
    let restanteAbono = montoRedondeado;
    const cargosPendientes = await client.query(
      `SELECT * FROM movimientos_cuenta
       WHERE cliente_id = $1 AND tipo = 'cargo' AND moneda = $2 AND saldo_pendiente_original > 0.01
       ORDER BY fecha ASC
       FOR UPDATE`,
      [cliente_id, moneda]
    );

    for (const cargo of cargosPendientes.rows) {
      if (restanteAbono <= 0.01) break;

      const aplicar = redondear(Math.min(restanteAbono, Number(cargo.saldo_pendiente_original)), 2);
      const nuevoSaldo = redondear(Number(cargo.saldo_pendiente_original) - aplicar, 2);

      await client.query('UPDATE movimientos_cuenta SET saldo_pendiente_original = $1 WHERE id = $2', [nuevoSaldo, cargo.id]);
      restanteAbono = redondear(restanteAbono - aplicar, 2);

      if (nuevoSaldo <= 0.01 && cargo.venta_id) {
        await client.query(`UPDATE ventas SET estado = 'completada' WHERE id = $1`, [cargo.venta_id]);
      }
    }

    await client.query('COMMIT');
    res.status(201).json(abonoResultado.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ message: 'Error al registrar abono', error: error.message });
  } finally {
    client.release();
  }
}

module.exports = { listarClientesConSaldo, buscarClientes, crearCliente, estadoDeCuenta, registrarAbono };