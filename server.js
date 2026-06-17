const express = require("express");
const Database = require("better-sqlite3");
const cors = require("cors");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "dein-geheimer-api-key-hier";

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const db = new Database("/tmp/wetterstation.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS messungen (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id  TEXT    NOT NULL,
    temperature REAL    NOT NULL,
    pressure    REAL    NOT NULL,
    humidity    REAL    NOT NULL,
    timestamp   DATETIME DEFAULT (datetime('now', 'localtime'))
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_timestamp  ON messungen (timestamp DESC)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_station_id ON messungen (station_id)`);

// Tabelle für Steuerbefehle (z.B. Display an/aus)
db.exec(`
  CREATE TABLE IF NOT EXISTS einstellungen (
    station_id  TEXT PRIMARY KEY,
    display_on  INTEGER NOT NULL DEFAULT 1
  )
`);

console.log("[DB] SQLite bereit");

function checkApiKey(req, res) {
  const key = req.headers["x-api-key"];
  if (!key || key !== API_KEY) {
    res.status(401).json({ error: "Ungültiger API-Key" });
    return false;
  }
  return true;
}

app.post("/api/data", (req, res) => {
  if (!checkApiKey(req, res)) return;

  const { temperature, pressure, humidity, station_id } = req.body;

  if (temperature == null || pressure == null || humidity == null)
    return res.status(400).json({ error: "Fehlende Felder" });

  const temp = parseFloat(temperature);
  const pres = parseFloat(pressure);
  const hum  = parseFloat(humidity);

  if (isNaN(temp) || isNaN(pres) || isNaN(hum))
    return res.status(400).json({ error: "Ungültige Zahlenwerte" });

  const result = db.prepare(
    `INSERT INTO messungen (station_id, temperature, pressure, humidity) VALUES (?, ?, ?, ?)`
  ).run(station_id || "station-1", temp, pres, hum);

  console.log(`[POST] Station: ${station_id} | Temp: ${temp}°C | Druck: ${pres}hPa | Feuchte: ${hum}%`);
  res.status(201).json({ ok: true, id: result.lastInsertRowid });
});

app.get("/api/data", (req, res) => {
  const limit   = Math.min(parseInt(req.query.limit) || 50, 5000);
  const hours   = parseInt(req.query.hours) || null;
  const station = req.query.station || null;

  let sql = "SELECT * FROM messungen";
  const params = [];
  const conds  = [];

  if (station) { conds.push("station_id = ?"); params.push(station); }
  if (hours)   { conds.push(`timestamp >= datetime('now','localtime','-${hours} hours')`); }
  if (conds.length) sql += " WHERE " + conds.join(" AND ");
  sql += " ORDER BY timestamp DESC LIMIT ?";
  params.push(limit);

  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

// =============================================================================
// GET /api/data/sampled — Wie /api/data, aber dünnt lange Zeiträume aus,
// damit z.B. 7 Tage an Daten nicht 10.000 Punkte zurückgeben, sondern
// eine handhabbare, gleichmäßig verteilte Auswahl (max ~target Punkte).
// =============================================================================
app.get("/api/data/sampled", (req, res) => {
  const hours   = parseInt(req.query.hours) || 24;
  const target  = Math.min(parseInt(req.query.target) || 300, 1000); // gewünschte Punktanzahl
  const station = req.query.station || null;

  let sql = "SELECT * FROM messungen WHERE timestamp >= datetime('now','localtime','-" + hours + " hours')";
  const params = [];
  if (station) { sql += " AND station_id = ?"; params.push(station); }
  sql += " ORDER BY timestamp ASC";

  const all = db.prepare(sql).all(...params);

  if (all.length <= target) {
    return res.json(all);
  }

  // Gleichmäßig verteilte Stichprobe (jeden n-ten Wert nehmen)
  const step = all.length / target;
  const sampled = [];
  for (let i = 0; i < target; i++) {
    sampled.push(all[Math.floor(i * step)]);
  }
  // letzten echten Wert immer mit anhängen, damit der aktuellste Punkt nicht fehlt
  if (sampled[sampled.length - 1].id !== all[all.length - 1].id) {
    sampled.push(all[all.length - 1]);
  }

  res.json(sampled);
});

app.get("/api/latest", (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM messungen
    WHERE id IN (SELECT MAX(id) FROM messungen GROUP BY station_id)
  `).all();
  res.json(rows);
});

app.get("/api/stats", (req, res) => {
  const days    = parseInt(req.query.days) || 1;
  const station = req.query.station || null;

  let sql = `
    SELECT station_id,
      ROUND(MIN(temperature),1) AS temp_min, ROUND(MAX(temperature),1) AS temp_max, ROUND(AVG(temperature),1) AS temp_avg,
      ROUND(MIN(pressure),1)    AS pres_min, ROUND(MAX(pressure),1)    AS pres_max, ROUND(AVG(pressure),1)    AS pres_avg,
      ROUND(MIN(humidity),1)    AS hum_min,  ROUND(MAX(humidity),1)    AS hum_max,  ROUND(AVG(humidity),1)    AS hum_avg,
      COUNT(*) AS anzahl
    FROM messungen
    WHERE timestamp >= datetime('now','localtime','-${days} days')
  `;
  const params = [];
  if (station) { sql += " AND station_id = ?"; params.push(station); }
  sql += " GROUP BY station_id";

  const rows = db.prepare(sql).all(...params);
  res.json(rows);
});

app.delete("/api/data/invalid", (req, res) => {
  if (!checkApiKey(req, res)) return;

  // Löscht Messungen mit physikalisch unmöglichen Werten
  // (z.B. Sensor-Aussetzer, die als 181°C / -164hPa gespeichert wurden)
  const result = db.prepare(`
    DELETE FROM messungen
    WHERE temperature < -40 OR temperature > 85
       OR pressure < 870 OR pressure > 1085
       OR humidity < 0 OR humidity > 100
  `).run();

  console.log(`[DELETE] ${result.changes} fehlerhafte Einträge gelöscht`);
  res.json({ ok: true, deleted: result.changes });
});

// =============================================================================
// GET /api/settings — ESP32 fragt hier ab, ob das Display an sein soll
// =============================================================================
app.get("/api/settings", (req, res) => {
  const station = req.query.station || "station-1";

  let row = db.prepare(`SELECT * FROM einstellungen WHERE station_id = ?`).get(station);

  // Falls noch kein Eintrag existiert: Standard = Display an
  if (!row) {
    db.prepare(`INSERT INTO einstellungen (station_id, display_on) VALUES (?, 1)`).run(station);
    row = { station_id: station, display_on: 1 };
  }

  res.json({ display_on: !!row.display_on });
});

// =============================================================================
// POST /api/settings — Website setzt hier den gewünschten Zustand
// =============================================================================
app.post("/api/settings", (req, res) => {
  if (!checkApiKey(req, res)) return;

  const station = req.body.station_id || "station-1";
  const displayOn = req.body.display_on ? 1 : 0;

  db.prepare(`
    INSERT INTO einstellungen (station_id, display_on) VALUES (?, ?)
    ON CONFLICT(station_id) DO UPDATE SET display_on = ?
  `).run(station, displayOn, displayOn);

  console.log(`[SETTINGS] ${station} → Display ${displayOn ? "AN" : "AUS"}`);
  res.json({ ok: true, display_on: !!displayOn });
});

app.listen(PORT, () => {
  console.log(`[Server] Läuft auf Port ${PORT}`);
});
