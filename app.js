const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const session = require('express-session');
const bodyParser = require('body-parser');
const ExcelJS = require('exceljs'); // Para exportar a Excel
const multer = require('multer');
const fs = require('fs');

// Asegurar que la carpeta de uploads existe
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const app = express();

// ----------------------
// CONFIG GLOBAL
// ----------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(bodyParser.urlencoded({ extended: false }));

app.use(
  session({
    secret: 'inventario-super-seguro',
    resave: false,
    saveUninitialized: false,
  })
);

// Configuración de Multer para subida de archivos (Fotos y Facturas)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'public/uploads/');
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });


// Middleware para tener usuario/rol en las vistas
app.use((req, res, next) => {
  res.locals.currentUser = req.session.username || null;
  res.locals.currentRole = req.session.role || null;
  next();
});

// ----------------------
// BASE DE DATOS
// ----------------------
const db = new sqlite3.Database('./inventory.db');

db.serialize(() => {
  // Tabla de equipos
  db.run(`
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT,
      name TEXT,
      brand_model TEXT,
      cpu TEXT,
      ram TEXT,
      storage TEXT,
      serial_number TEXT,
      status TEXT DEFAULT 'Disponible',
      location TEXT,
      responsible TEXT,
      observations TEXT,
      purchase_date TEXT,
      device_photo TEXT,
      invoice_photo TEXT
    )
  `, () => {
    // Aseguramos que las nuevas columnas existan si la tabla ya fue creada previamente
    db.run("ALTER TABLE devices ADD COLUMN purchase_date TEXT", (err) => { });
    db.run("ALTER TABLE devices ADD COLUMN device_photo TEXT", (err) => { });
    db.run("ALTER TABLE devices ADD COLUMN invoice_photo TEXT", (err) => { });
    db.run("ALTER TABLE devices ADD COLUMN assignment_date TEXT", (err) => { });
  });


  // Tabla de asignaciones
  db.run(`
    CREATE TABLE IF NOT EXISTS assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER,
      assigned_to TEXT,
      role TEXT,
      area TEXT,
      assigned_date TEXT,
      returned_date TEXT,
      notes TEXT,
      FOREIGN KEY(device_id) REFERENCES devices(id)
    )
  `);

  // Tabla de usuarios
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT,
      role TEXT
    )
  `);

  // Usuario admin por defecto si no hay usuarios
  db.get('SELECT COUNT(*) AS count FROM users', [], (err, row) => {
    if (err) {
      console.error('Error verificando usuarios:', err);
      return;
    }
    if (row && row.count === 0) {
      db.run(
        'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
        ['admin', 'Admin123*', 'admin'],
        (e) => {
          if (e) console.error('Error creando usuario admin por defecto:', e);
          else console.log('Usuario admin creado (admin / Admin123*)');
        }
      );
    }
  });
});

// ----------------------
// MIDDLEWARES AUTH
// ----------------------
function requireLogin(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

function requireRole(roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  return (req, res, next) => {
    if (!req.session.userId) return res.redirect('/login');
    if (!req.session.role || !allowed.includes(req.session.role)) {
      return res.status(403).send('Acceso denegado');
    }
    next();
  };
}

// ----------------------
// LOGIN / LOGOUT
// ----------------------
app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;

  db.get(
    'SELECT * FROM users WHERE username = ? AND password = ?',
    [username, password],
    (err, user) => {
      if (err) {
        console.error('Error en login:', err);
        return res.status(500).send('Error en BD');
      }
      if (!user) {
        return res.render('login', { error: 'Usuario o contraseña incorrectos' });
      }

      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.role = user.role;
      res.redirect('/devices');
    }
  );
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ----------------------
// HOME
// ----------------------
app.get('/', requireLogin, (req, res) => res.redirect('/devices'));

// ----------------------
// LISTADO DE EQUIPOS + FILTROS
// ----------------------
app.get('/devices', requireLogin, (req, res) => {
  const search = req.query.search || '';
  const status = req.query.status || '';
  const location = req.query.location || '';
  const brand = req.query.brand || '';
  const responsible = req.query.responsible || '';

  let sql = 'SELECT * FROM devices WHERE 1=1';
  const params = [];

  if (search) {
    sql += ' AND (name LIKE ? OR code LIKE ? OR serial_number LIKE ? OR location LIKE ? OR responsible LIKE ?)';
    const q = `%${search}%`;
    params.push(q, q, q, q, q);
  }

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }

  if (location) {
    sql += ' AND location LIKE ?';
    params.push(`%${location}%`);
  }

  if (brand) {
    sql += ' AND brand_model LIKE ?';
    params.push(`%${brand}%`);
  }

  if (responsible) {
    sql += ' AND responsible LIKE ?';
    params.push(`%${responsible}%`);
  }

  sql += ' ORDER BY id DESC';

  db.all(sql, params, (err, devices) => {
    if (err) {
      console.error('Error listando equipos:', err);
      return res.status(500).send('Error en BD');
    }

    res.render('devices_list', {
      devices,
      search,
      statusFilter: status,
      locationFilter: location,
      brandFilter: brand,
      responsibleFilter: responsible,
    });
  });
});

// ----------------------
// EXPORTAR A EXCEL
// ----------------------
app.get('/devices/export/excel', requireLogin, (req, res) => {
  db.all('SELECT * FROM devices ORDER BY id ASC', [], async (err, devices) => {
    if (err) {
      console.error('Error exportando a Excel:', err);
      return res.status(500).send('Error en BD');
    }

    try {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Equipos');

      sheet.columns = [
        { header: 'ID', key: 'id', width: 6 },
        { header: 'Código', key: 'code', width: 15 },
        { header: 'Nombre', key: 'name', width: 25 },
        { header: 'Marca/Modelo', key: 'brand_model', width: 25 },
        { header: 'CPU', key: 'cpu', width: 20 },
        { header: 'RAM', key: 'ram', width: 12 },
        { header: 'Disco', key: 'storage', width: 15 },
        { header: 'Serie', key: 'serial_number', width: 20 },
        { header: 'Estado', key: 'status', width: 15 },
        { header: 'Ubicación', key: 'location', width: 20 },
        { header: 'Responsable', key: 'responsible', width: 25 },
        { header: 'Observaciones', key: 'observations', width: 40 },
      ];

      devices.forEach((d) => {
        sheet.addRow({
          id: d.id,
          code: d.code || '',
          name: d.name || '',
          brand_model: d.brand_model || '',
          cpu: d.cpu || '',
          ram: d.ram || '',
          storage: d.storage || '',
          serial_number: d.serial_number || '',
          status: d.status || '',
          location: d.location || '',
          responsible: d.responsible || '',
          observations: d.observations || '',
        });
      });

      sheet.getRow(1).font = { bold: true };

      const fileName = 'inventario_equipos.xlsx';
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

      await workbook.xlsx.write(res);
      res.end();
    } catch (e) {
      console.error('Error generando Excel:', e);
      res.status(500).send('Error generando Excel');
    }
  });
});

// ----------------------
// NUEVO EQUIPO
// ----------------------
app.get('/devices/new', requireRole(['admin', 'editor']), (req, res) => {
  res.render('device_form', { device: null });
});

app.post('/devices/new', requireRole(['admin', 'editor']), upload.fields([{ name: 'device_photo', maxCount: 1 }, { name: 'invoice_photo', maxCount: 1 }]), (req, res) => {
  const {
    code,
    name,
    brand_model,
    cpu,
    ram,
    storage,
    serial_number,
    status,
    location,
    responsible,
    observations,
    purchase_date,
    assignment_date
  } = req.body;

  const device_photo = req.files['device_photo'] ? '/uploads/' + req.files['device_photo'][0].filename : null;
  const invoice_photo = req.files['invoice_photo'] ? '/uploads/' + req.files['invoice_photo'][0].filename : null;

  db.run(
    `INSERT INTO devices
      (code, name, brand_model, cpu, ram, storage,
       serial_number, status, location, responsible, observations,
       purchase_date, assignment_date, device_photo, invoice_photo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      code,
      name,
      brand_model,
      cpu,
      ram,
      storage,
      serial_number,
      status || 'Disponible',
      location,
      responsible,
      observations,
      purchase_date,
      assignment_date,
      device_photo,
      invoice_photo
    ],
    (err) => {
      if (err) {
        console.error('Error guardando equipo:', err);
        return res.status(500).send('Error al guardar el equipo');
      }
      res.redirect('/devices');
    }
  );
});

// ----------------------
// EDITAR EQUIPO
// ----------------------
app.get('/devices/:id/edit', requireRole(['admin', 'editor']), (req, res) => {
  db.get('SELECT * FROM devices WHERE id = ?', [req.params.id], (err, device) => {
    if (err) {
      console.error('Error obteniendo equipo:', err);
      return res.status(500).send('Error en BD');
    }
    if (!device) return res.send('Equipo no existe');
    res.render('device_form', { device });
  });
});

app.post('/devices/:id/edit', requireRole(['admin', 'editor']), upload.fields([{ name: 'device_photo', maxCount: 1 }, { name: 'invoice_photo', maxCount: 1 }]), (req, res) => {
  const {
    code,
    name,
    brand_model,
    cpu,
    ram,
    storage,
    serial_number,
    status,
    location,
    responsible,
    observations,
    purchase_date,
    assignment_date
  } = req.body;

  db.get('SELECT device_photo, invoice_photo FROM devices WHERE id = ?', [req.params.id], (err, row) => {
    let device_photo = row ? row.device_photo : null;
    let invoice_photo = row ? row.invoice_photo : null;

    if (req.files['device_photo']) {
      device_photo = '/uploads/' + req.files['device_photo'][0].filename;
    }
    if (req.files['invoice_photo']) {
      invoice_photo = '/uploads/' + req.files['invoice_photo'][0].filename;
    }

    db.run(
      `UPDATE devices SET
        code = ?, name = ?, brand_model = ?, cpu = ?, ram = ?, storage = ?,
        serial_number = ?, status = ?, location = ?, responsible = ?, observations = ?,
        purchase_date = ?, assignment_date = ?, device_photo = ?, invoice_photo = ?
       WHERE id = ?`,
      [
        code,
        name,
        brand_model,
        cpu,
        ram,
        storage,
        serial_number,
        status,
        location,
        responsible,
        observations,
        purchase_date,
        assignment_date,
        device_photo,
        invoice_photo,
        req.params.id,
      ],
      (err) => {
        if (err) {
          console.error('Error actualizando equipo:', err);
          return res.status(500).send('Error al actualizar');
        }
        res.redirect('/devices/' + req.params.id);
      }
    );
  });
});

// ----------------------
// DETALLE + HISTORIAL
// ----------------------
app.get('/devices/:id', requireLogin, (req, res) => {
  db.get('SELECT * FROM devices WHERE id = ?', [req.params.id], (err, device) => {
    if (err) {
      console.error('Error obteniendo equipo:', err);
      return res.status(500).send('Error en BD');
    }
    if (!device) return res.send('Equipo no existe');

    db.all(
      'SELECT * FROM assignments WHERE device_id = ? ORDER BY id DESC',
      [req.params.id],
      (err2, assigns) => {
        if (err2) {
          console.error('Error obteniendo asignaciones:', err2);
          return res.status(500).send('Error en BD');
        }
        res.render('device_detail', { device, assignments: assigns });
      }
    );
  });
});

// ----------------------
// AGREGAR ASIGNACIÓN
// ----------------------
app.post(
  '/devices/:id/assign',
  requireRole(['admin', 'editor']),
  (req, res) => {
    const { assigned_to, role, area, assigned_date, notes } = req.body;

    db.run(
      `INSERT INTO assignments (device_id, assigned_to, role, area, assigned_date, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.params.id, assigned_to, role, area, assigned_date, notes],
      (err) => {
        if (err) {
          console.error('Error insertando asignación:', err);
          return res.status(500).send('Error al asignar equipo');
        }
        db.run(
          "UPDATE devices SET status='Asignado' WHERE id = ?",
          [req.params.id],
          () => {
            res.redirect('/devices/' + req.params.id);
          }
        );
      }
    );
  }
);

// ----------------------
// CERRAR ASIGNACIÓN
// ----------------------
app.post('/assignments/:id/close', requireRole(['admin', 'editor']), (req, res) => {
  db.get('SELECT * FROM assignments WHERE id = ?', [req.params.id], (err, a) => {
    if (err || !a) return res.status(500).send('Error en BD');
    db.run(
      'UPDATE assignments SET returned_date = ? WHERE id = ?',
      [req.body.returned_date, req.params.id],
      (err2) => {
        if (err2) return res.status(500).send('Error cerrando asignación');
        db.run(
          "UPDATE devices SET status='Disponible' WHERE id = ?",
          [a.device_id],
          () => {
            res.redirect('/devices/' + a.device_id);
          }
        );
      }
    );
  });
});

// ----------------------
// ELIMINAR EQUIPO
// ----------------------
app.post('/devices/:id/delete', requireRole('admin'), (req, res) => {
  const id = req.params.id;

  db.run('DELETE FROM assignments WHERE device_id = ?', [id], (err) => {
    if (err) return res.status(500).send('Error al borrar asignaciones');

    db.run('DELETE FROM devices WHERE id = ?', [id], (err2) => {
      if (err2) return res.status(500).send('Error al borrar equipo');
      res.redirect('/devices');
    });
  });
});

// ----------------------
// MÓDULO DE USUARIOS
// ----------------------

// Listar usuarios
app.get('/users', requireRole('admin'), (req, res) => {
  db.all('SELECT id, username, role FROM users ORDER BY id ASC', [], (err, users) => {
    if (err) {
      console.error('Error listando usuarios:', err);
      return res.status(500).send('Error en BD');
    }
    res.render('users_list', { users });
  });
});

// Formulario NUEVO usuario
app.get('/users/new', requireRole('admin'), (req, res) => {
  res.render('user_form', { error: null, user: null, mode: 'new' });
});

// Crear usuario
app.post('/users/new', requireRole('admin'), (req, res) => {
  const { username, password, role } = req.body;

  if (!username || !password || !role) {
    return res.render('user_form', {
      error: 'Todos los campos son obligatorios.',
      user: null,
      mode: 'new',
    });
  }

  if (!['admin', 'editor', 'viewer'].includes(role)) {
    return res.render('user_form', {
      error: 'Rol inválido.',
      user: null,
      mode: 'new',
    });
  }

  db.run(
    'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
    [username, password, role],
    (err) => {
      if (err) {
        console.error('Error creando usuario:', err);
        return res.render('user_form', {
          error: 'No se pudo crear el usuario (¿usuario duplicado?).',
          user: null,
          mode: 'new',
        });
      }
      res.redirect('/users');
    }
  );
});

// Formulario EDITAR usuario
app.get('/users/:id/edit', requireRole('admin'), (req, res) => {
  db.get(
    'SELECT id, username, role FROM users WHERE id = ?',
    [req.params.id],
    (err, user) => {
      if (err || !user) {
        console.error('Error obteniendo usuario:', err);
        return res.status(500).send('Error en BD');
      }
      res.render('user_form', {
        error: null,
        user,
        mode: 'edit',
      });
    }
  );
});

// Guardar cambios de usuario
app.post('/users/:id/edit', requireRole('admin'), (req, res) => {
  const { username, password, role } = req.body;

  if (!username || !role) {
    return db.get(
      'SELECT id, username, role FROM users WHERE id = ?',
      [req.params.id],
      (err, user) => {
        if (err || !user) {
          console.error('Error obteniendo usuario:', err);
          return res.status(500).send('Error en BD');
        }
        return res.render('user_form', {
          error: 'Usuario y rol son obligatorios.',
          user,
          mode: 'edit',
        });
      }
    );
  }

  if (!['admin', 'editor', 'viewer'].includes(role)) {
    return db.get(
      'SELECT id, username, role FROM users WHERE id = ?',
      [req.params.id],
      (err, user) => {
        if (err || !user) {
          console.error('Error obteniendo usuario:', err);
          return res.status(500).send('Error en BD');
        }
        return res.render('user_form', {
          error: 'Rol inválido.',
          user,
          mode: 'edit',
        });
      }
    );
  }

  let sql, params;
  if (password && password.trim() !== '') {
    sql = 'UPDATE users SET username = ?, password = ?, role = ? WHERE id = ?';
    params = [username, password, role, req.params.id];
  } else {
    sql = 'UPDATE users SET username = ?, role = ? WHERE id = ?';
    params = [username, role, req.params.id];
  }

  db.run(sql, params, (err) => {
    if (err) {
      console.error('Error actualizando usuario:', err);
      return res.status(500).send('Error al actualizar usuario');
    }
    res.redirect('/users');
  });
});

// ----------------------
// SERVIDOR
// ----------------------
app.listen(3000, () => {
  console.log('Inventario corriendo en http://localhost:3000');
});
