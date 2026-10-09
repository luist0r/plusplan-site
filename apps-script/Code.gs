/**
 * PlusPlan — Backend del Sistema FODA (Google Apps Script)
 *
 * Este archivo NO se ejecuta desde GitHub. Es la copia de referencia del código
 * que vive en el proyecto de Apps Script vinculado al Google Sheet.
 *
 * INSTALACIÓN
 * 1. En Apps Script: Archivo → Hacer una copia (respaldo del código anterior).
 * 2. Reemplace todo el contenido de Code.gs por este archivo y guarde.
 * 3. ⚙ Configuración del proyecto → Propiedades del script → Agregar:
 *      ADMIN_KEY = clave nueva, larga (mínimo 16 caracteres). No reutilice la anterior.
 *      SHEET_ID  = (opcional) ID del Google Sheet, solo si el script NO está vinculado a la hoja.
 * 4. Implementar → Administrar implementaciones → ✏ editar la implementación actual →
 *    Versión: "Nueva versión" → Implementar. Así se conserva la misma URL /exec.
 *    Ejecutar como: Yo · Quién tiene acceso: Cualquier usuario.
 *
 * API — todas las llamadas son POST con cuerpo JSON {action, ...}
 *   login        {code}                  → datos del candidato (el código debe existir)
 *   save         {code, respondent, ...} → guarda respuestas del candidato
 *   adminCheck   {key}
 *   adminList    {key}                   → todos los diagnósticos
 *   adminGet     {key, code}
 *   adminCodes   {key}                   → códigos generados
 *   adminGenCode {key, type, ref}        → genera un código aleatorio en el servidor
 */

const RESP_SHEET = 'Respuestas';
const CODES_SHEET = 'Codigos';
const RESP_HEADERS = ['Codigo', 'Respondiente', 'Email', 'Rol', 'Candidato', 'Tipo', 'Municipio', 'Partido', 'Edad',
  'FODA', 'Imagen', 'Analisis', 'Viabilidad', 'DigitalScore', 'Paso', 'Fecha'];
const CODES_HEADERS = ['Codigo', 'Tipo', 'Referencia', 'Creado'];
const KEY_COL = 'Codigo';         // columna llave en ambas hojas
const ROLES = ['candidato', 'gerente', 'equipo', 'consultor', 'familiar', 'otro'];
const MAX_STR = 4000;
const MAX_JSON = 40000;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 símbolos, sin 0/O/1/I
// Intentos fallidos permitidos por ventana, compartidos por todos los visitantes.
// Un límite bajo permitiría que cualquiera bloquee a los usuarios reales enviando
// claves falsas; con códigos de 6 caracteres (~10⁹) y una clave de 28, 300 por ventana
// sigue haciendo inviable adivinar por fuerza bruta.
const FAIL_LIMIT = { admin: 300, cand: 300 };
const FAIL_WINDOW_SEC = 900;

// ── ENTRADA ─────────────────────────────────────────────
function doGet() {
  return out_({ error: 'use_post' });
}

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (_) { return out_({ error: 'bad_request' }); }
  try { return out_(route_(req || {})); }
  catch (err) { return out_({ error: err.publicCode || 'server_error' }); }
}

function route_(req) {
  switch (req.action) {
    case 'login':        return candidateLogin_(req);
    case 'save':         return candidateSave_(req);
    case 'adminCheck':   admin_(req); return { ok: true };
    case 'adminList':    admin_(req); return { data: readAll_(respSheet_()) };
    case 'adminGet':     admin_(req); return { data: findRow_(respSheet_(), KEY_COL, normCode_(req.code)) };
    case 'adminCodes':   admin_(req); return { data: readAll_(codesSheet_()).map(codeOut_) };
    case 'adminGenCode': admin_(req); return { data: genCode_(req) };
    default:             throw fail_('unknown_action');
  }
}

// ── CANDIDATO ───────────────────────────────────────────
function candidateLogin_(req) {
  throttle_('cand');
  const code = normCode_(req.code);
  if (!code || !codeExists_(code)) { recordFail_('cand'); throw fail_('invalid_code'); }
  return { data: findRow_(respSheet_(), KEY_COL, code) };
}

function candidateSave_(req) {
  // Mismo límite que el login: si no, "save" serviría para probar códigos sin restricción.
  throttle_('cand');
  const code = normCode_(req.code);
  if (!code || !codeExists_(code)) { recordFail_('cand'); throw fail_('invalid_code'); }

  const r = req.respondent || {}, p = req.profile || {};
  // Analisis y Viabilidad no se aceptan desde el navegador: los define PlusPlan.
  const values = {
    Codigo: code,
    Respondiente: str_(r.name),
    Email: str_(r.email),
    Rol: pick_(r.role, ROLES, 'otro'),
    Candidato: str_(p.name),
    Tipo: pick_(p.type, ['alcalde', 'diputado'], 'alcalde'),
    Municipio: str_(p.municipality),
    Partido: str_(p.party),
    Edad: str_(p.age).replace(/[^0-9]/g, '').slice(0, 3),
    FODA: json_(req.foda),
    Imagen: json_(req.imagen),
    DigitalScore: calcDig_(req.imagen || {}),
    Paso: Math.max(0, Math.min(7, parseInt(req.completedStep, 10) || 0)),
    Fecha: new Date().toISOString()
  };

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { upsert_(respSheet_(), KEY_COL, values); }
  finally { lock.releaseLock(); }
  return { ok: true };
}

// ── ADMIN ───────────────────────────────────────────────
function admin_(req) {
  const key = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  if (!key || key.length < 16) throw fail_('admin_not_configured');
  throttle_('admin');
  if (typeof req.key !== 'string' || !safeEq_(req.key, key)) {
    recordFail_('admin');
    throw fail_('unauthorized');
  }
}

function genCode_(req) {
  const type = pick_(req.type, ['ALC', 'DIP'], 'ALC');
  const ref = String(req.ref || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    let code;
    for (let i = 0; i < 10; i++) {
      code = [type, ref, rand_(6)].filter(Boolean).join('-');
      if (!codeExists_(code)) break;
    }
    const row = { Codigo: code, Tipo: type, Referencia: ref, Creado: new Date().toISOString() };
    const sh = codesSheet_();
    sh.appendRow(headers_(sh).map(h => guard_(row[h] !== undefined ? row[h] : '')));
    return codeOut_(row);
  } finally { lock.releaseLock(); }
}

// ── HOJAS ───────────────────────────────────────────────
function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name, headers) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sh;
}
function respSheet_() { return sheet_(RESP_SHEET, RESP_HEADERS); }
function codesSheet_() { return sheet_(CODES_SHEET, CODES_HEADERS); }

// La hoja guarda encabezados en español; el panel admin espera {code, type, ref, created}.
function codeOut_(r) {
  return { code: String(r.Codigo), type: r.Tipo, ref: r.Referencia, created: r.Creado };
}

function headers_(sh) {
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
}

function readAll_(sh) {
  const rows = sh.getDataRange().getValues();
  const headers = rows.shift().map(String);
  return rows
    .filter(row => row.some(v => v !== ''))
    .map(row => headers.reduce((o, h, i) => { o[h] = row[i]; return o; }, {}));
}

function findRow_(sh, col, code) {
  if (!code) return null;
  return readAll_(sh).find(r => String(r[col]).toUpperCase() === code) || null;
}

function codeExists_(code) {
  // Válido si fue generado por el admin, o si ya tiene un diagnóstico iniciado
  // (códigos anteriores a la sincronización con Sheets).
  return !!(findRow_(codesSheet_(), KEY_COL, code) || findRow_(respSheet_(), KEY_COL, code));
}

function upsert_(sh, keyCol, values) {
  const headers = headers_(sh);
  const data = sh.getDataRange().getValues();
  const k = headers.indexOf(keyCol);
  let rowIdx = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][k]).toUpperCase() === values[keyCol]) { rowIdx = i; break; }
  }
  const current = rowIdx > 0 ? data[rowIdx] : headers.map(() => '');
  const row = headers.map((h, i) => Object.prototype.hasOwnProperty.call(values, h) ? guard_(values[h]) : current[i]);
  if (rowIdx > 0) sh.getRange(rowIdx + 1, 1, 1, headers.length).setValues([row]);
  else sh.appendRow(row);
}

// ── UTILIDADES ──────────────────────────────────────────
function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code) {
  const e = new Error(code);
  e.publicCode = code;
  return e;
}

function normCode_(c) {
  const s = String(c || '').trim().toUpperCase();
  return /^[A-Z0-9-]{4,32}$/.test(s) ? s : '';
}

function str_(v) { return String(v == null ? '' : v).slice(0, MAX_STR); }

function pick_(v, allowed, dflt) { return allowed.indexOf(v) >= 0 ? v : dflt; }

function json_(v) {
  if (v == null) return '';
  const s = JSON.stringify(v);
  if (s.length > MAX_JSON) throw fail_('too_large');
  return s;
}

// Evita que un texto que empiece con = + - @ se ejecute como fórmula en Sheets.
function guard_(v) {
  return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v;
}

function safeEq_(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function rand_(n) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid());
  let s = '';
  for (let i = 0; i < n; i++) s += CODE_ALPHABET[bytes[i] & 31];
  return s;
}

function throttle_(bucket) {
  const n = parseInt(CacheService.getScriptCache().get('fail:' + bucket), 10) || 0;
  if (n >= FAIL_LIMIT[bucket]) throw fail_('too_many_attempts');
}

function recordFail_(bucket) {
  const cache = CacheService.getScriptCache();
  const n = (parseInt(cache.get('fail:' + bucket), 10) || 0) + 1;
  cache.put('fail:' + bucket, String(n), FAIL_WINDOW_SEC);
}

// Misma fórmula que calcDig() en foda/index.html
function calcDig_(d) {
  let s = 0;
  s += Math.min((Array.isArray(d.ig1) ? d.ig1.length : 0) * 4, 20);
  s += ({ 'Menos de 1,000': 0, '1,000 – 5,000': 5, '5,000 – 20,000': 10, '20,000 – 100,000': 13, 'Más de 100,000': 15 }[d.ig2] || 0);
  s += ({ 'Raramente': 0, '1-2 veces/semana': 5, '3-5 veces/semana': 10, 'Diariamente': 13, 'Varias veces al día': 15 }[d.ig3] || 0);
  if (d.ig4 === 'si') s += 8;
  if (d.ig5 === 'si') s += 7;
  if (d.ig6 === 'si') s += 3;
  if (d.ig8 === 'si') s += 2;
  s += ({ 'Ninguna': 0, 'Ocasional': 2, 'Regular': 5, 'Frecuente': 8, 'Muy frecuente': 10 }[d.ig7] || 0);
  s += Math.round(((Number(d.ig9 || 5) + Number(d.ig10 || 5)) / 20) * 20);
  return Math.min(s, 100);
}
