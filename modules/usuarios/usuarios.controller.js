const pool = require('../../config/db');
const bcrypt = require('bcryptjs');

// Listar todos los usuarios (sin exponer el password_hash)
async function listarUsuarios(req, res) {
  try {
    const resultado = await pool.query(
      'SELECT id, nombre, email, rol, activo, created_at FROM usuarios ORDER BY id DESC'
    );
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ message: 'Error al listar usuarios', error: error.message });
  }
}

// Crear un nuevo usuario (admin o cajero)
async function crearUsuario(req, res) {
  const { nombre, email, password, rol } = req.body;

  if (!nombre || !email || !password || !rol) {
    return res.status(400).json({ message: 'Todos los campos son requeridos' });
  }

  if (!['admin', 'cajero'].includes(rol)) {
    return res.status(400).json({ message: 'Rol inválido' });
  }

  try {
    const existente = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
    if (existente.rows.length > 0) {
      return res.status(409).json({ message: 'Ya existe un usuario con ese email' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const resultado = await pool.query(
      `INSERT INTO usuarios (nombre, email, password_hash, rol)
       VALUES ($1, $2, $3, $4)
       RETURNING id, nombre, email, rol, activo, created_at`,
      [nombre, email, passwordHash, rol]
    );

    res.status(201).json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear usuario', error: error.message });
  }
}

// Activar / desactivar usuario (en vez de borrarlo, se recomienda desactivar)
async function cambiarEstadoUsuario(req, res) {
  const { id } = req.params;
  const { activo } = req.body;

  try {
    const resultado = await pool.query(
      `UPDATE usuarios SET activo = $1 WHERE id = $2
       RETURNING id, nombre, email, rol, activo`,
      [activo, id]
    );

    if (resultado.rows.length === 0) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    res.json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar usuario', error: error.message });
  }
}

// Editar nombre/rol de un usuario
async function editarUsuario(req, res) {
  const { id } = req.params;
  const { nombre, rol } = req.body;

  try {
    const resultado = await pool.query(
      `UPDATE usuarios SET nombre = COALESCE($1, nombre), rol = COALESCE($2, rol)
       WHERE id = $3
       RETURNING id, nombre, email, rol, activo`,
      [nombre, rol, id]
    );

    if (resultado.rows.length === 0) {
      return res.status(404).json({ message: 'Usuario no encontrado' });
    }

    res.json(resultado.rows[0]);
  } catch (error) {
    res.status(500).json({ message: 'Error al editar usuario', error: error.message });
  }
}

module.exports = { listarUsuarios, crearUsuario, cambiarEstadoUsuario, editarUsuario };