const express = require('express');
const path = require('path');
const session = require('express-session');
const dotenv = require('dotenv');
const multer = require('multer');
const fs = require('fs');
const db = require('./db');
process.env.TZ = 'America/Costa_Rica';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==============================
// Configuración de subida de fotos
// ==============================
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname) || '.jpg';
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + ext);
  }
});

const upload = multer({ storage });

// ==============================
// Configuración de vistas y middlewares
// ==============================
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(uploadsDir));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'clave-super-secreta',
    resave: false,
    saveUninitialized: false
  })
);

// Pasar usuario logueado a las vistas
app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

// ==============================
// Middleware de protección
// ==============================
function requireAuth(role) {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.redirect('/login');
    }
    if (role && req.session.user.role !== role) {
      return res.status(403).send('No autorizado');
    }
    next();
  };
}

// ==============================
// Helper: cálculo de horas normales y extra
// ==============================
function calcularHoras(checkIn, checkOut) {
  const diffMs = checkOut - checkIn;
  const totalHours = diffMs / (1000 * 60 * 60); // horas totales (decimales)

  // Día de la semana: 0 = Domingo, 1 = Lunes, ..., 6 = Sábado
  const weekday = checkIn.getDay();

  let baseNetHours = 0; // horas normales máximas del día
  let lunchHours = 0;   // tiempo de almuerzo a descontar

  if (weekday >= 1 && weekday <= 5) {
    // Lunes a viernes
    baseNetHours = 8;   // 8 horas normales
    lunchHours = 0.5;   // 30 minutos de almuerzo
  } else if (weekday === 6) {
    // Sábado
    baseNetHours = 6;   // 6 horas normales
    lunchHours = 0;     // sin almuerzo
  } else if (weekday === 0) {
    // Domingo: todo se cuenta como extra
    baseNetHours = 0;
    lunchHours = 0;
  }

  // Restamos almuerzo solo si aplica
  let netHours = totalHours - lunchHours;
  if (netHours < 0) netHours = 0;

  const normalHours = Math.min(netHours, baseNetHours);
  const extraHours = Math.max(netHours - baseNetHours, 0);

  // Redondeamos a 2 decimales
  return {
    normalHours: Number(normalHours.toFixed(2)),
    extraHours: Number(extraHours.toFixed(2))
  };
}

// Helper para fecha de hoy en formato YYYY-MM-DD (simple)
function hoyISO() {
  return new Date().toISOString().slice(0, 10);
}

// ==============================
// Rutas básicas
// ==============================
app.get('/', (req, res) => {
  if (!req.session.user) return res.redirect('/login');
  if (req.session.user.role === 'ADMIN') return res.redirect('/admin');
  return res.redirect('/mecanico');
});

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const username = (req.body.username || '').trim();
  const password = (req.body.password || '').trim();

  try {
    const [rows] = await db.query(
      'SELECT * FROM users WHERE username = ? AND password = ?',
      [username, password]
    );
    if (rows.length === 0) {
      return res.render('login', { error: 'Usuario o contraseña incorrectos' });
    }
    req.session.user = {
      id: rows[0].id,
      name: rows[0].name,
      role: rows[0].role
    };
    res.redirect('/');
  } catch (err) {
    console.error('Error en /login:', err);
    res.status(500).send('Error en el servidor');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// ==============================
// Vista mecánico
// ==============================
app.get('/mecanico', requireAuth('MECANICO'), async (req, res) => {
  const userId = req.session.user.id;
  const today = hoyISO();

  try {
    const [rows] = await db.query(
      'SELECT * FROM attendance WHERE user_id = ? AND date = ?',
      [userId, today]
    );
    const attendance = rows[0] || null;

    const [jobs] = await db.query(
      'SELECT * FROM jobs WHERE user_id = ? AND date = ? ORDER BY id DESC',
      [userId, today]
    );

    res.render('mecanico_dashboard', { attendance, jobs, today });
  } catch (err) {
    console.error('Error en GET /mecanico:', err);
    res.status(500).send('Error en el servidor');
  }
});

// ==============================
// Marcar ENTRADA (foto obligatoria)
// ==============================
app.post(
  '/mecanico/entrada',
  requireAuth('MECANICO'),
  upload.single('photo'),
  async (req, res) => {
    const userId = req.session.user.id;
    const today = hoyISO();
    const now = new Date();

    // Foto obligatoria
    if (!req.file) {
      console.error('No se recibió archivo de foto en /mecanico/entrada');
      return res
        .status(400)
        .send('Se requiere una foto tomada en el momento para marcar entrada.');
    }

    const photoPath = '/uploads/' + path.basename(req.file.path);

    try {
      // Verificar si ya tiene asistencia hoy
      const [existing] = await db.query(
        'SELECT * FROM attendance WHERE user_id = ? AND date = ?',
        [userId, today]
      );
      if (existing.length > 0) {
        // Ya había marcado entrada hoy
        return res.redirect('/mecanico');
      }

      await db.query(
        'INSERT INTO attendance (user_id, date, check_in, check_in_photo) VALUES (?, ?, ?, ?)',
        [userId, today, now, photoPath]
      );
      res.redirect('/mecanico');
    } catch (err) {
      console.error('Error en POST /mecanico/entrada:', err);
      res.status(500).send('Error en el servidor');
    }
  }
);

// ==============================
// Marcar SALIDA (foto obligatoria)
// ==============================
app.post(
  '/mecanico/salida',
  requireAuth('MECANICO'),
  upload.single('photo'),
  async (req, res) => {
    const userId = req.session.user.id;
    const today = hoyISO();
    const now = new Date();

    if (!req.file) {
      console.error('No se recibió archivo de foto en /mecanico/salida');
      return res
        .status(400)
        .send('Se requiere una foto tomada en el momento para marcar salida.');
    }

    const photoPath = '/uploads/' + path.basename(req.file.path);

    try {
      const [rows] = await db.query(
        'SELECT * FROM attendance WHERE user_id = ? AND date = ?',
        [userId, today]
      );
      if (rows.length === 0) {
        // No puede marcar salida sin entrada
        return res.redirect('/mecanico');
      }

      const attendance = rows[0];
      const checkIn = new Date(attendance.check_in);

      const { normalHours, extraHours } = calcularHoras(checkIn, now);

      await db.query(
        'UPDATE attendance SET check_out = ?, check_out_photo = ?, normal_hours = ?, extra_hours = ? WHERE id = ?',
        [now, photoPath, normalHours, extraHours, attendance.id]
      );

      res.redirect('/mecanico');
    } catch (err) {
      console.error('Error en POST /mecanico/salida:', err);
      res.status(500).send('Error en el servidor');
    }
  }
);

// ==============================
// Registrar trabajo
// ==============================
app.post(
  '/mecanico/trabajos',
  requireAuth('MECANICO'),
  async (req, res) => {
    const userId = req.session.user.id;
    const { plate, job_type, description } = req.body;
    const today = hoyISO();

    try {
      const [attRows] = await db.query(
        'SELECT * FROM attendance WHERE user_id = ? AND date = ?',
        [userId, today]
      );
      const attendanceId = attRows.length > 0 ? attRows[0].id : null;

      await db.query(
        'INSERT INTO jobs (user_id, attendance_id, date, plate, job_type, description) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, attendanceId, today, plate, job_type, description]
      );
      res.redirect('/mecanico');
    } catch (err) {
      console.error('Error en POST /mecanico/trabajos:', err);
      res.status(500).send('Error en el servidor');
    }
  }
);

// ==============================
// Panel ADMIN
// ==============================
app.get('/admin', requireAuth('ADMIN'), async (req, res) => {
  const { from, to } = req.query;
  let startDate = from;
  let endDate = to;

  if (!startDate || !endDate) {
    // Por defecto, últimos 7 días
    const today = new Date();
    const weekAgo = new Date(today.getTime() - 6 * 24 * 60 * 60 * 1000);
    startDate = weekAgo.toISOString().slice(0, 10);
    endDate = today.toISOString().slice(0, 10);
  }

  try {
    const [rows] = await db.query(
      `SELECT a.*, u.name
       FROM attendance a
       JOIN users u ON a.user_id = u.id
       WHERE a.date BETWEEN ? AND ?
       ORDER BY a.date DESC`,
      [startDate, endDate]
    );

    const [jobs] = await db.query(
      `SELECT j.*, u.name
       FROM jobs j
       JOIN users u ON j.user_id = u.id
       WHERE j.date BETWEEN ? AND ?
       ORDER BY j.date DESC`,
      [startDate, endDate]
    );

    let totalNormal = 0;
    let totalExtras = 0;
    rows.forEach((r) => {
      totalNormal += Number(r.normal_hours || 0);
      totalExtras += Number(r.extra_hours || 0);
    });

    res.render('admin_dashboard', {
      attendance: rows,
      jobs,
      from: startDate,
      to: endDate,
      totalNormal,
      totalExtras
    });
  } catch (err) {
    console.error('Error en GET /admin:', err);
    res.status(500).send('Error en el servidor');
  }
});

// ==============================
// Arrancar servidor
// ==============================
app.listen(PORT, () => {
  console.log(`Servidor escuchando en http://localhost:${PORT}`);
});
