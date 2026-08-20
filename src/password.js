import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

/**
 * Hash de contraseña con scrypt, que viene incluido en Node y evita tener que
 * compilar módulos nativos en la imagen. Cada contraseña lleva su propia sal.
 *
 * Vive en su propio fichero porque lo usan tanto la API como el script de
 * administración, y las dos deben generar exactamente el mismo formato.
 */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;

  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  // Comparación en tiempo constante: una comparación normal filtra por el
  // tiempo de respuesta cuántos bytes iniciales ha acertado quien lo intenta.
  return timingSafeEqual(expected, actual);
}
