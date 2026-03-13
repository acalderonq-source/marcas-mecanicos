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

//////////////////////////////////////////////////////
// CREAR CARPETA UPLOADS SI NO EXISTE
//////////////////////////////////////////////////////

const uploadsDir = path.join(__dirname, '..', 'uploads');

if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

//////////////////////////////////////////////////////
// SERVIR CARPETA DE FOTOS
//////////////////////////////////////////////////////

app.use('/uploads', express.static(uploadsDir));

//////////////////////////////////////////////////////
// MULTER CONFIG
//////////////////////////////////////////////////////

const storage = multer.diskStorage({

  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },

  filename: function (req, file, cb) {

    const ext = path.extname(file.originalname) || '.jpg';

    const uniqueName =
      Date.now() +
      '-' +
      Math.round(Math.random() * 1e9) +
      ext;

    cb(null, uniqueName);
  }

});

const upload = multer({ storage });

//////////////////////////////////////////////////////
// CONFIGURACION BASE
//////////////////////////////////////////////////////

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, '..', 'public')));

//////////////////////////////////////////////////////
// SESSION
//////////////////////////////////////////////////////

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'tomza-secret',
    resave: false,
    saveUninitialized: false
  })
);

app.use((req, res, next) => {
  res.locals.user = req.session.user || null;
  next();
});

//////////////////////////////////////////////////////
// SEGURIDAD
//////////////////////////////////////////////////////

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

//////////////////////////////////////////////////////
// UTILIDADES
//////////////////////////////////////////////////////

function hoyISO() {

  const now = new Date();

  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');

  return `${y}-${m}-${d}`;
}

//////////////////////////////////////////////////////
// CONVERTIR HORAS DECIMAL A HH:MM
//////////////////////////////////////////////////////

function horasAFormato(horas) {

  if (!horas || Number(horas) <= 0) {
    return '0:00';
  }

  const minutosTotales = Math.round(Number(horas) * 60);

  const h = Math.floor(minutosTotales / 60);
  const m = minutosTotales % 60;

  return `${h}:${String(m).padStart(2, '0')}`;
}

//////////////////////////////////////////////////////
// CALCULO DE HORAS
//////////////////////////////////////////////////////

function calcularHoras(checkIn, checkOut) {

  const diffMs = checkOut - checkIn;

  const totalHours = diffMs / (1000 * 60 * 60);

  const weekday = checkIn.getDay();

  let jornada = 0;
  let lunch = 0;

  if (weekday >= 1 && weekday <= 5) {

    jornada = 8.5;
    lunch = 0.5;

  } else if (weekday === 6) {

    jornada = 6;
    lunch = 0;

  } else {

    jornada = 0;
    lunch = 0;
  }

  let netHours = totalHours - lunch;

  if (netHours < 0) netHours = 0;

  const normalHours = Math.min(netHours, jornada);

  const extraHours = Math.max(netHours - jornada, 0);

  const debitHours = Math.max(jornada - netHours, 0);

  return {
    normalHours: Number(normalHours.toFixed(2)),
    extraHours: Number(extraHours.toFixed(2)),
    debitHours: Number(debitHours.toFixed(2))
  };
}

//////////////////////////////////////////////////////
// RUTA PRINCIPAL
//////////////////////////////////////////////////////

app.get('/', (req, res) => {

  if (!req.session.user) return res.redirect('/login');

  if (req.session.user.role === 'ADMIN') return res.redirect('/admin');

  return res.redirect('/mecanico');
});

//////////////////////////////////////////////////////
// LOGIN
//////////////////////////////////////////////////////

app.get('/login', (req, res) => {

  res.render('login', { error: null });

});

app.post('/login', async (req, res) => {

  try {

    const username = (req.body.username || '').trim();
    const password = (req.body.password || '').trim();

    const [rows] = await db.query(
      'SELECT * FROM users WHERE username = ? AND password = ?',
      [username, password]
    );

    if (!rows.length) {
      return res.render('login', { error: 'Credenciales inválidas' });
    }

    req.session.user = {
      id: rows[0].id,
      name: rows[0].name,
      role: rows[0].role
    };

    res.redirect('/');

  } catch (error) {

    console.error('Error login:', error);

    res.status(500).send('Error en el servidor');
  }
});

//////////////////////////////////////////////////////
// LOGOUT
//////////////////////////////////////////////////////

app.get('/logout', (req, res) => {

  req.session.destroy(() => {
    res.redirect('/login');
  });

});

//////////////////////////////////////////////////////
// PANEL MECANICO
//////////////////////////////////////////////////////

app.get('/mecanico', requireAuth('MECANICO'), async (req, res) => {

  try {

    const today = hoyISO();
    const userId = req.session.user.id;

    const [attendance] = await db.query(
      'SELECT * FROM attendance WHERE user_id = ? AND date = ?',
      [userId, today]
    );

    const [jobs] = await db.query(
      'SELECT * FROM jobs WHERE user_id = ? AND date = ? ORDER BY id DESC',
      [userId, today]
    );

    res.render('mecanico_dashboard', {
      attendance: attendance[0] || null,
      jobs,
      today
    });

  } catch (error) {

    console.error(error);

    res.status(500).send('Error en el servidor');
  }
});

//////////////////////////////////////////////////////
// MARCAR ENTRADA
//////////////////////////////////////////////////////

app.post('/mecanico/entrada',
requireAuth('MECANICO'),
upload.single('photo'),
async (req, res) => {

  try {

    if (!req.file) {
      return res.status(400).send('Foto obligatoria');
    }

    const userId = req.session.user.id;
    const today = hoyISO();
    const now = new Date();

    const [exist] = await db.query(
      'SELECT id FROM attendance WHERE user_id=? AND date=?',
      [userId, today]
    );

    if (exist.length) return res.redirect('/mecanico');

    await db.query(
      `INSERT INTO attendance
      (user_id,date,check_in,check_in_photo)
      VALUES (?,?,?,?)`,
      [
        userId,
        today,
        now,
        process.env.BASE_URL + '/uploads/' + req.file.filename
      ]
    );

    res.redirect('/mecanico');

  } catch (error) {

    console.error(error);

    res.status(500).send('Error en servidor');
  }
});

//////////////////////////////////////////////////////
// MARCAR SALIDA
//////////////////////////////////////////////////////

app.post('/mecanico/salida',
requireAuth('MECANICO'),
upload.single('photo'),
async (req, res) => {

  try {

    if (!req.file) {
      return res.status(400).send('Foto obligatoria');
    }

    const userId = req.session.user.id;
    const today = hoyISO();
    const now = new Date();

    const [rows] = await db.query(
      'SELECT * FROM attendance WHERE user_id=? AND date=?',
      [userId, today]
    );

    if (!rows.length) return res.redirect('/mecanico');

    const checkIn = new Date(rows[0].check_in);

    const { normalHours, extraHours, debitHours } =
      calcularHoras(checkIn, now);

    await db.query(
      `UPDATE attendance
      SET check_out=?,
      check_out_photo=?,
      normal_hours=?,
      extra_hours=?,
      debit_hours=?
      WHERE id=?`,
      [
        now,
        process.env.BASE_URL + '/uploads/' + req.file.filename,
        normalHours,
        extraHours,
        debitHours,
        rows[0].id
      ]
    );

    res.redirect('/mecanico');

  } catch (error) {

    console.error(error);

    res.status(500).send('Error en servidor');
  }
});

//////////////////////////////////////////////////////
// REGISTRAR TRABAJO
//////////////////////////////////////////////////////

app.post('/mecanico/trabajos',
requireAuth('MECANICO'),
async (req, res) => {

  try {

    const userId = req.session.user.id;
    const today = hoyISO();

    const { plate, job_type, description } = req.body;

    const [attRows] = await db.query(
      'SELECT * FROM attendance WHERE user_id=? AND date=?',
      [userId, today]
    );

    const attendanceId = attRows.length ? attRows[0].id : null;

    await db.query(
      `INSERT INTO jobs
      (user_id,attendance_id,date,plate,job_type,description)
      VALUES (?,?,?,?,?,?)`,
      [userId, attendanceId, today, plate, job_type, description]
    );

    res.redirect('/mecanico');

  } catch (error) {

    console.error(error);

    res.status(500).send('Error en servidor');
  }
});

//////////////////////////////////////////////////////
// PANEL ADMIN
//////////////////////////////////////////////////////

app.get('/admin', requireAuth('ADMIN'), async (req, res) => {

  try {

    const { from, to } = req.query;

    let startDate = from;
    let endDate = to;

    if (!startDate || !endDate) {

      const today = new Date();

      const weekAgo = new Date(
        today.getTime() - 6 * 24 * 60 * 60 * 1000
      );

      startDate = weekAgo.toISOString().slice(0, 10);
      endDate = today.toISOString().slice(0, 10);
    }

    const [rows] = await db.query(
      `SELECT a.*,u.name
       FROM attendance a
       JOIN users u ON a.user_id=u.id
       WHERE a.date BETWEEN ? AND ?
       ORDER BY a.date DESC`,
      [startDate, endDate]
    );

    const [jobs] = await db.query(
      `SELECT j.*,u.name
       FROM jobs j
       JOIN users u ON j.user_id=u.id
       WHERE j.date BETWEEN ? AND ?
       ORDER BY j.date DESC`,
      [startDate, endDate]
    );

    let totalNormal = 0;
    let totalExtras = 0;
    let totalDebits = 0;

    rows.forEach(r => {

      totalNormal += Number(r.normal_hours || 0);
      totalExtras += Number(r.extra_hours || 0);
      totalDebits += Number(r.debit_hours || 0);

      r.normal_hours_fmt = horasAFormato(r.normal_hours);
      r.extra_hours_fmt = horasAFormato(r.extra_hours);
      r.debit_hours_fmt = horasAFormato(r.debit_hours);
    });

    const totalBanco = Math.max(totalExtras - totalDebits, 0);

    res.render('admin_dashboard', {
      attendance: rows,
      jobs,
      from: startDate,
      to: endDate,

      totalNormalFmt: horasAFormato(totalNormal),
      totalExtrasFmt: horasAFormato(totalExtras),
      totalDebitsFmt: horasAFormato(totalDebits),
      totalBancoFmt: horasAFormato(totalBanco)
    });

  } catch (error) {

    console.error(error);

    res.status(500).send('Error en servidor');
  }
});

//////////////////////////////////////////////////////
// SERVIDOR
//////////////////////////////////////////////////////

app.listen(PORT, () => {

  console.log(`Servidor corriendo en puerto ${PORT}`);

});