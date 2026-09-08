const pool = require('../../config/db');
const { convertirAUSD } = require('../../utils/conversionMoneda');

// Listar clientes con su saldo pendiente calculado al vuelo
async function listarClientesConSaldo(req, res) {
  try {
    const resultado = await pool.query(`
      SELECT c.id, c.nombre, c.telefono, c.identificacion,
             COALESCE(SUM(CASE WHEN mc.tipo = 'cargo' THEN mc.monto_usd ELSE -mc.monto_usd END), 0) AS saldo_usd
      FROM clientes c
      LEFT JOIN movimientos_cuenta mc ON mc.cliente_id = c.id
      WHERE c.activo = true
      GROUP BY c.id, c.nombre, c.telefono, c.identificacion
      ORDER BY saldo_usd DESC
    `);
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar clientes', error: error.message });
  }
}

// Buscar clientes por nombre (para el buscador rápido en Ventas)
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

// Crear cliente rápido (desde Ventas o desde la pantalla de Clientes)
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

// Estado de cuenta completo de un cliente (todos los cargos y abonos)
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

    const saldoUsd = movimientos.rows.reduce(
      (acc, m) => acc + (m.tipo === 'cargo' ? Number(m.monto_usd) : -Number(m.monto_usd)),
      0
    );

    res.json({ cliente: cliente.rows[0], movimientos: movimientos.rows, saldo_usd: saldoUsd });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener estado de cuenta', error: error.message });
  }
}

// Registrar un abono (pago parcial o total de la deuda)
async function registrarAbono(req, res) {
  const { cliente_id, moneda, monto, metodo_pago_id, sesion_caja_id, referencia, nota } = req.body;
  const usuario_id = req.usuario.id;

  if (!cliente_id || !moneda || !monto || !metodo_pago_id) {
    return res.status(400).json({ message: 'Faltan datos requeridos' });
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
      `INSERT INTO movimientos_cuenta (cliente_id, tipo, moneda, monto, monto_usd, metodo_pago_id, sesion_caja_id, referencia, nota, usuario_id)
       VALUES ($1, 'abono', $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [cliente_id, moneda, monto, montoUsd, metodo_pago_id, sesion_caja_id || null, referencia || null, nota || null, usuario_id]
    );

    res.status(201).json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al registrar abono', error: error.message });
  }
}

module.exports = {
  listarClientesConSaldo,
  buscarClientes,
  crearCliente,
  estadoDeCuenta,
  registrarAbono
};