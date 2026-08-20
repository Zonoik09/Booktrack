import { randomBytes } from 'node:crypto';

/**
 * Configuración del servidor, toda por variables de entorno.
 *
 * El único valor que no tiene un valor por defecto seguro es JWT_SECRET: si
 * falta, el proceso no arranca. Generar uno al vuelo parecería cómodo, pero
 * invalidaría todas las sesiones en cada reinicio del contenedor.
 */
function required(name) {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    console.error(
      `\n[booktrack] Falta la variable de entorno ${name}.\n` +
        `Genera una con:  openssl rand -hex 32\n` +
        `y añádela al fichero .env\n`,
    );
    process.exit(1);
  }
  return value.trim();
}

function int(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return ['1', 'true', 'yes', 'si', 'sí'].includes(raw.toLowerCase().trim());
}

let _jwtSecret = null;

export const config = {
  port: int('PORT', 8080),
  // Dentro del contenedor hay que escuchar en 0.0.0.0 para que Docker pueda
  // publicar el puerto; el aislamiento lo da el propio Docker y el túnel.
  host: process.env.HOST?.trim() || '0.0.0.0',

  databaseFile: process.env.DATABASE_FILE?.trim() || '/data/booktrack.db',

  /**
   * Se valida al usarse y no al cargar el fichero, para que el script de
   * administración (que no firma tokens) pueda ejecutarse sin tenerla puesta.
   * `index.js` la pide al arrancar, así que el servidor sigue fallando pronto
   * si falta.
   */
  get jwtSecret() {
    _jwtSecret ??= required('JWT_SECRET');
    return _jwtSecret;
  },
  accessTokenTtl: int('ACCESS_TOKEN_TTL_MINUTES', 60) * 60 * 1000,
  refreshTokenTtl: int('REFRESH_TOKEN_TTL_DAYS', 60) * 24 * 60 * 60 * 1000,

  /**
   * El registro está cerrado salvo que se defina un código de invitación.
   *
   * El servidor queda expuesto a internet a través del túnel, así que dejar el
   * alta abierta permitiría a cualquiera crearse una cuenta. Con el código,
   * das de alta a quien tú quieras pasándole la palabra.
   */
  registrationEnabled: bool('REGISTRATION_ENABLED', true),
  inviteCode: process.env.INVITE_CODE?.trim() || '',

  minPasswordLength: int('MIN_PASSWORD_LENGTH', 8),
};

/** Identificadores opacos para sesiones y filas. */
export const newId = () => randomBytes(16).toString('hex');
