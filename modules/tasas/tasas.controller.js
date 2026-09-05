const pool = require('../../config/db');
const axios = require('axios');

// Registrar una tasa manualmente (el cliente puede corregir/forzar un valor)
async function registrarTasaManual(req, res) {
  const { usd_ves, usd_cop } = req.body;

  if (!usd_ves || !usd_cop) {
    return res.status(400).json({ message: 'usd_ves y usd_cop son requeridos' });
  }

  const ves_cop = Number(usd_cop) / Number(usd_ves);

  try {
    const resultado = await pool.query(
      `INSERT INTO tasas_cambio (fecha, usd_ves, usd_cop, ves_cop, fuente)
       VALUES (CURRENT_DATE, $1, $2, $3, 'manual')
       RETURNING *`,
      [usd_ves, usd_cop, ves_cop]
    );
    res.status(201).json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al registrar tasa', error: error.message });
  }
}

// Lógica pura de obtención + guardado, SIN req/res, para reutilizar en el cron
async function obtenerYGuardarTasaBCV() {
  const [respuestaVE, respuestaCO] = await Promise.all([
    axios.get('https://ve.dolarapi.com/v1/dolares'),
    axios.get('https://co.dolarapi.com/v1/cotizaciones/usd')
  ]);

  const dataVE = respuestaVE.data.find((d) => d.fuente === 'oficial');
  if (!dataVE) {
    throw new Error('No se encontró la tasa oficial de Venezuela');
  }
  const usd_ves = dataVE.promedio;

  const dataCO = respuestaCO.data;
  const usd_cop = (Number(dataCO.compra) + Number(dataCO.venta)) / 2;

  const ves_cop = usd_cop / usd_ves;

  const resultado = await pool.query(
    `INSERT INTO tasas_cambio (fecha, usd_ves, usd_cop, ves_cop, fuente)
     VALUES (CURRENT_DATE, $1, $2, $3, 'BCV')
     RETURNING *`,
    [usd_ves, usd_cop, ves_cop]
  );

  return resultado.rows[0];
}

// Handler HTTP que reutiliza la función de arriba (botón manual "Actualizar ahora")
async function actualizarTasaAutomatica(req, res) {
  try {
    const tasa = await obtenerYGuardarTasaBCV();
    res.status(201).json(tasa);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar tasa automática', error: error.message });
  }
}

async function obtenerTasaActual(req, res) {
  try {
    const resultado = await pool.query(
      'SELECT * FROM tasas_cambio ORDER BY fecha DESC, created_at DESC LIMIT 1'
    );
    if (resultado.rows.length === 0) {
      return res.status(404).json({ message: 'No hay tasas registradas' });
    }
    res.json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener tasa', error: error.message });
  }
}

async function listarHistorialTasas(req, res) {
  try {
    const resultado = await pool.query(
      'SELECT * FROM tasas_cambio ORDER BY fecha DESC, created_at DESC LIMIT 30'
    );
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar historial', error: error.message });
  }
}

module.exports = {
  registrarTasaManual,
  actualizarTasaAutomatica,
  obtenerTasaActual,
  listarHistorialTasas,
  obtenerYGuardarTasaBCV 
};