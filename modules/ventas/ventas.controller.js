const pool = require('../../config/db');
const { convertirAUSD } = require('../../utils/conversionMoneda');

function generarNumeroVenta() {
  const timestamp = Date.now().toString().slice(-10);
  return `VTA-${timestamp}`;
}

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
  const { productos, pagos, cliente_id, sesion_caja_id, moneda_venta } = req.body;
  const usuario_id = req.usuario.id;

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

      // Determina el precio exacto a usar: precio fijo manual (si aplica a la moneda de venta) o conversión normal
      let precioUnitarioUSD;
      let precioUnitarioOriginal;
      let monedaOriginal;

      if (moneda_venta && moneda_venta !== producto.moneda_base) {
        const campoManual = `precio_manual_${moneda_venta.toLowerCase()}`;
        if (producto[campoManual] != null) {
          precioUnitarioOriginal = Number(producto[campoManual]);
          monedaOriginal = moneda_venta;
          precioUnitarioUSD = convertirAUSD(precioUnitarioOriginal, moneda_venta, tasa);
        }
      }

      if (precioUnitarioUSD === undefined) {
        precioUnitarioUSD = convertirAUSD(producto.precio_venta, producto.moneda_base, tasa);
        precioUnitarioOriginal = Number(producto.precio_venta);
        monedaOriginal = producto.moneda_base;
      }

      const subtotalUSD = precioUnitarioUSD * item.cantidad;
      totalUSD += subtotalUSD;
      const subtotalOriginal = precioUnitarioOriginal * item.cantidad;

      detalles.push({
        producto_id: producto.id,
        cantidad: item.cantidad,
        precio_unitario_usd: precioUnitarioUSD,
        subtotal_usd: subtotalUSD,
        precio_unitario_original: precioUnitarioOriginal,
        subtotal_original: subtotalOriginal,
        moneda_original: monedaOriginal
      });

      await client.query('UPDATE productos SET stock = stock - $1 WHERE id = $2', [
        item.cantidad,
        producto.id
      ]);
    }

    let totalPagadoUSD = 0;
    const pagosCalculados = [];

    for (const pago of pagos) {
      const metodoResultado = await client.query(
        'SELECT id, nombre FROM metodos_pago WHERE id = $1 AND activo = true',
        [pago.metodo_pago_id]
      );
      if (metodoResultado.rows.length === 0) {
        throw new Error('Método de pago inválido');
      }

      const montoEquivalenteUSD = convertirAUSD(pago.monto, pago.moneda, tasa);
      totalPagadoUSD += montoEquivalenteUSD;
      pagosCalculados.push({ ...pago, monto_equivalente_usd: montoEquivalenteUSD });
    }

    // Si falta dinero por cubrir, solo se permite si hay un cliente asignado (fiado)
    const faltante = totalUSD - totalPagadoUSD;
    if (faltante > 0.05 && !cliente_id) {
      throw new Error(
        `El monto pagado (${totalPagadoUSD.toFixed(2)} USD) es menor al total de la venta (${totalUSD.toFixed(2)} USD)`
      );
    }

    const numeroVenta = generarNumeroVenta();
    const ventaResultado = await client.query(
      `INSERT INTO ventas (numero_venta, usuario_id, total_usd, tasa_id, estado, cliente_id, sesion_caja_id)
       VALUES ($1, $2, $3, $4, 'completada', $5, $6)
       RETURNING *`,
      [numeroVenta, usuario_id, totalUSD, tasa.id, cliente_id || null, sesion_caja_id || null]
    );
    const venta = ventaResultado.rows[0];

    for (const detalle of detalles) {
      await client.query(
        `INSERT INTO detalle_venta (venta_id, producto_id, cantidad, precio_unitario_usd, subtotal_usd, precio_unitario_original, subtotal_original, moneda_original)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          venta.id, detalle.producto_id, detalle.cantidad, detalle.precio_unitario_usd, detalle.subtotal_usd,
          detalle.precio_unitario_original, detalle.subtotal_original, detalle.moneda_original
        ]
      );
    }

    for (const pago of pagosCalculados) {
      await client.query(
        `INSERT INTO pagos_venta (venta_id, moneda, metodo_pago_id, monto, monto_equivalente_usd, referencia)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [venta.id, pago.moneda, pago.metodo_pago_id, pago.monto, pago.monto_equivalente_usd, pago.referencia || null]
      );
    }

    // Si quedó saldo sin cubrir y hay cliente, se registra como cargo (fiado)
    if (faltante > 0.05 && cliente_id) {
      await client.query(
        `INSERT INTO movimientos_cuenta (cliente_id, tipo, moneda, monto, monto_usd, venta_id, sesion_caja_id, usuario_id)
         VALUES ($1, 'cargo', 'USD', $2, $2, $3, $4, $5)`,
        [cliente_id, faltante, venta.id, sesion_caja_id || null, usuario_id]
      );
    }

    await client.query('COMMIT');

    res.status(201).json({
      venta,
      detalles,
      pagos: pagosCalculados,
      vuelto_usd: Math.max(0, totalPagadoUSD - totalUSD)
    });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(400).json({ message: error.message });
  } finally {
    client.release();
  }
}

async function listarVentas(req, res) {
  const { desde, hasta } = req.query;

  try {
    let query = `
      SELECT
        v.*,
        u.nombre AS vendedor,
        COALESCE(SUM(CASE WHEN pv.moneda = 'USD' THEN pv.monto END), 0) AS monto_usd,
        COALESCE(SUM(CASE WHEN pv.moneda = 'COP' THEN pv.monto END), 0) AS monto_cop,
        COALESCE(SUM(CASE WHEN pv.moneda = 'VES' THEN pv.monto END), 0) AS monto_ves
      FROM ventas v
      JOIN usuarios u ON u.id = v.usuario_id
      LEFT JOIN pagos_venta pv ON pv.venta_id = v.id
    `;
    const params = [];

    if (desde && hasta) {
      query += ` WHERE v.fecha BETWEEN $1 AND $2`;
      params.push(desde, hasta);
    }

    query += ` GROUP BY v.id, u.nombre ORDER BY v.fecha DESC`;

    const resultado = await pool.query(query, params);
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar ventas', error: error.message });
  }
}

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

    const pagos = await pool.query(
      `SELECT pv.*, mp.nombre AS metodo_nombre
       FROM pagos_venta pv
       JOIN metodos_pago mp ON mp.id = pv.metodo_pago_id
       WHERE pv.venta_id = $1`,
      [id]
    );

    res.json({ venta: venta.rows[0], detalles: detalles.rows, pagos: pagos.rows });
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener venta', error: error.message });
  }
}

module.exports = { crearVenta, listarVentas, obtenerVentaPorId };