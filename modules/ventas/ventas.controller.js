const pool = require('../../config/db');
const { convertirAUSD } = require('../../utils/conversionMoneda');

function generarNumeroVenta() {
  const timestamp = Date.now().toString().slice(-10);
  return `VTA-${timestamp}`;
}

// Obtiene la tasa de cambio más reciente registrada
async function obtenerTasaVigente(client) {
  const resultado = await client.query(
    'SELECT * FROM tasas_cambio ORDER BY fecha DESC, created_at DESC LIMIT 1'
  );
  if (resultado.rows.length === 0) {
    throw new Error('No hay una tasa de cambio registrada. Registra una tasa antes de vender.');
  }
  return resultado.rows[0];
}

async function crearVenta(req, res) {
  const { productos, pagos } = req.body;
  const usuario_id = req.usuario.id; // viene del token JWT

  if (!productos || productos.length === 0) {
    return res.status(400).json({ message: 'Debe incluir al menos un producto' });
  }
  if (!pagos || pagos.length === 0) {
    return res.status(400).json({ message: 'Debe incluir al menos un método de pago' });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const tasa = await obtenerTasaVigente(client);
    let totalUSD = 0;
    const detalles = [];

    // Validar stock y calcular subtotales
    for (const item of productos) {
      const resultadoProducto = await client.query(
        'SELECT * FROM productos WHERE id = $1 AND activo = true FOR UPDATE',
        [item.producto_id]
      );

      if (resultadoProducto.rows.length === 0) {
        throw new Error(`Producto con id ${item.producto_id} no encontrado`);
      }

      const producto = resultadoProducto.rows[0];

      if (producto.stock < item.cantidad) {
        throw new Error(`Stock insuficiente para "${producto.nombre}" (disponible: ${producto.stock})`);
      }

      const precioUnitarioUSD = convertirAUSD(producto.precio_venta, producto.moneda_base, tasa);
      const subtotalUSD = precioUnitarioUSD * item.cantidad;
      totalUSD += subtotalUSD;

      detalles.push({
        producto_id: producto.id,
        cantidad: item.cantidad,
        precio_unitario_usd: precioUnitarioUSD,
        subtotal_usd: subtotalUSD
      });

      // Descontar stock
      await client.query('UPDATE productos SET stock = stock - $1 WHERE id = $2', [
        item.cantidad,
        producto.id
      ]);
    }

    // Validar que la suma de los pagos (convertidos a USD) cubra el total
    let totalPagadoUSD = 0;
    const pagosCalculados = [];

    for (const pago of pagos) {
      const montoEquivalenteUSD = convertirAUSD(pago.monto, pago.moneda, tasa);
      totalPagadoUSD += montoEquivalenteUSD;
      pagosCalculados.push({ ...pago, monto_equivalente_usd: montoEquivalenteUSD });
    }

    const diferencia = Math.abs(totalPagadoUSD - totalUSD);
    if (diferencia > 0.05) {
      // margen de tolerancia de 5 centavos por redondeos de conversión
      throw new Error(
        `El monto pagado (${totalPagadoUSD.toFixed(2)} USD) no coincide con el total de la venta (${totalUSD.toFixed(2)} USD)`
      );
    }

    // Crear la venta
    const numeroVenta = generarNumeroVenta();
    const ventaResultado = await client.query(
      `INSERT INTO ventas (numero_venta, usuario_id, total_usd, tasa_id, estado)
       VALUES ($1, $2, $3, $4, 'completada')
       RETURNING *`,
      [numeroVenta, usuario_id, totalUSD, tasa.id]
    );
    const venta = ventaResultado.rows[0];

    // Insertar detalle de productos vendidos
    for (const detalle of detalles) {
      await client.query(
        `INSERT INTO detalle_venta (venta_id, producto_id, cantidad, precio_unitario_usd, subtotal_usd)
         VALUES ($1, $2, $3, $4, $5)`,
        [venta.id, detalle.producto_id, detalle.cantidad, detalle.precio_unitario_usd, detalle.subtotal_usd]
      );
    }

    // Insertar los pagos (puede ser 1 o varios, ej. mitad COP mitad VES)
    for (const pago of pagosCalculados) {
      await client.query(
        `INSERT INTO pagos_venta (venta_id, moneda, metodo, monto, monto_equivalente_usd)
         VALUES ($1, $2, $3, $4, $5)`,
        [venta.id, pago.moneda, pago.metodo, pago.monto, pago.monto_equivalente_usd]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({ venta, detalles, pagos: pagosCalculados });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ message: error.message });
  } finally {
    client.release();
  }
}

// Listar ventas (con filtro opcional por fecha, para el módulo de reportes/tabla diaria)
async function listarVentas(req, res) {
  const { desde, hasta } = req.query;

  try {
    let query = `
      SELECT v.*, u.nombre AS vendedor
      FROM ventas v
      JOIN usuarios u ON u.id = v.usuario_id
    `;
    const params = [];

    if (desde && hasta) {
      query += ` WHERE v.fecha BETWEEN $1 AND $2`;
      params.push(desde, hasta);
    }

    query += ' ORDER BY v.fecha DESC';

    const resultado = await pool.query(query, params);
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar ventas', error: error.message });
  }
}

// Detalle completo de una venta (para ver el ticket/factura)
async function obtenerVentaPorId(req, res) {
  const { id } = req.params;

  try {
    const venta = await pool.query('SELECT * FROM ventas WHERE id = $1', [id]);
    if (venta.rows.length === 0) {
      return res.status(404).json({ message: 'Venta no encontrada' });
    }

    const detalles = await pool.query(
      `SELECT dv.*, p.nombre, p.codigo
       FROM detalle_venta dv
       JOIN productos p ON p.id = dv.producto_id
       WHERE dv.venta_id = $1`,
      [id]
    );

    const pagos = await pool.query('SELECT * FROM pagos_venta WHERE venta_id = $1', [id]);

    res.json({ venta: venta.rows[0], detalles: detalles.rows, pagos: pagos.rows });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener venta', error: error.message });
  }
}

module.exports = { crearVenta, listarVentas, obtenerVentaPorId };