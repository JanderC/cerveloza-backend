const cron = require('node-cron');
const pool = require('../config/db');

async function cerrarCajasAbiertasAutomaticamente() {
  try {
    const abiertas = await pool.query(`SELECT * FROM sesiones_caja WHERE estado = 'abierta'`);

    for (const sesion of abiertas.rows) {
      // El "esperado" se calcula igual que en un cierre manual, y se usa también como "contado"
      // ya que nadie hizo el conteo físico — queda documentado que fue automático.
      async function calcularEsperado(moneda) {
        const ventas = await pool.query(
          `SELECT COALESCE(SUM(pv.monto), 0) AS total
           FROM pagos_venta pv JOIN ventas v ON v.id = pv.venta_id JOIN metodos_pago mp ON mp.id = pv.metodo_pago_id
           WHERE v.sesion_caja_id = $1 AND mp.nombre = 'Efectivo' AND pv.moneda = $2 AND v.estado = 'completada'`,
          [sesion.id, moneda]
        );
        const ingresos = await pool.query(`SELECT COALESCE(SUM(monto),0) AS total FROM movimientos_caja WHERE sesion_caja_id=$1 AND tipo='ingreso' AND moneda=$2`, [sesion.id, moneda]);
        const egresos = await pool.query(`SELECT COALESCE(SUM(monto),0) AS total FROM movimientos_caja WHERE sesion_caja_id=$1 AND tipo='egreso' AND moneda=$2`, [sesion.id, moneda]);
        const abonos = await pool.query(
          `SELECT COALESCE(SUM(mc.monto),0) AS total FROM movimientos_cuenta mc JOIN metodos_pago mp ON mp.id=mc.metodo_pago_id
           WHERE mc.sesion_caja_id=$1 AND mc.tipo='abono' AND mp.nombre='Efectivo' AND mc.moneda=$2`,
          [sesion.id, moneda]
        );
        const fondoInicial = Number(sesion[`fondo_inicial_${moneda.toLowerCase()}`]);
        return fondoInicial + Number(ventas.rows[0].total) + Number(ingresos.rows[0].total) - Number(egresos.rows[0].total) + Number(abonos.rows[0].total);
      }

      const esperadoUsd = await calcularEsperado('USD');
      const esperadoCop = await calcularEsperado('COP');
      const esperadoVes = await calcularEsperado('VES');

      await pool.query(
        `UPDATE sesiones_caja SET
          conteo_final_usd = $1, conteo_final_cop = $2, conteo_final_ves = $3,
          esperado_final_usd = $1, esperado_final_cop = $2, esperado_final_ves = $3,
          diferencia_usd = 0, diferencia_cop = 0, diferencia_ves = 0,
          estado = 'cerrada', fecha_cierre = NOW(),
          notas_cierre = 'Cierre automático a medianoche — nadie cerró la caja manualmente, no se hizo conteo físico.'
         WHERE id = $4`,
        [esperadoUsd, esperadoCop, esperadoVes, sesion.id]
      );

      console.log(`[CRON] Caja ${sesion.id} cerrada automáticamente a medianoche`);
    }
  } catch (error) {
    console.error('[CRON] Error al cerrar cajas automáticamente:', error.message);
  }
}

function iniciarCronCaja() {
  // Todos los días a la medianoche, EXPLÍCITAMENTE en hora de Venezuela (evita el bug de que
  // un cron sin zona horaria se dispare a las 8pm por la diferencia UTC-4 del servidor)
  cron.schedule('0 0 * * *', cerrarCajasAbiertasAutomaticamente, { timezone: 'America/Caracas' });
  console.log('Cron de cierre automático de caja programado: medianoche, hora de Venezuela');
}

module.exports = iniciarCronCaja;