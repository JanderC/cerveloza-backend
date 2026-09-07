const pool = require('../../config/db');

async function listarMetodosPago(req, res) {
  try {
    const resultado = await pool.query(
      'SELECT * FROM metodos_pago WHERE activo = true ORDER BY nombre ASC'
    );
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar métodos de pago', error: error.message });
  }
}

async function crearMetodoPago(req, res) {
  const { nombre } = req.body;
  if (!nombre || !nombre.trim()) {
    return res.status(400).json({ message: 'El nombre es requerido' });
  }

  try {
    const existente = await pool.query('SELECT id FROM metodos_pago WHERE nombre = $1', [nombre.trim()]);
    if (existente.rows.length > 0) {
      return res.status(409).json({ message: 'Ya existe un método de pago con ese nombre' });
    }

    const resultado = await pool.query(
      'INSERT INTO metodos_pago (nombre) VALUES ($1) RETURNING *',
      [nombre.trim()]
    );
    res.status(201).json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear método de pago', error: error.message });
  }
}

async function desactivarMetodoPago(req, res) {
  const { id } = req.params;
  try {
    const resultado = await pool.query(
      'UPDATE metodos_pago SET activo = false WHERE id = $1 RETURNING id',
      [id]
    );
    if (resultado.rows.length === 0) {
      return res.status(404).json({ message: 'Método de pago no encontrado' });
    }
    res.json({ message: 'Método de pago desactivado' });
  } catch (error) {
    res.status(500).json({ message: 'Error al desactivar método de pago', error: error.message });
  }
}

module.exports = { listarMetodosPago, crearMetodoPago, desactivarMetodoPago };