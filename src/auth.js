import { createHash, randomBytes } from 'node:crypto';

import jwt from 'jsonwebtoken';

import { config, newId } from './config.js';
import { db, seedDefaultShelves } from './db.js';
import { hashPassword, verifyPassword } from './password.js';

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

// ----------------------------------------------------------------- tokens

/** El token de refresco se guarda cifrado: si roban el fichero, no sirve. */
const hashToken = (token) => createHash('sha256').update(token).digest('hex');

function issueTokens(user) {
  const accessToken = jwt.sign(
    { sub: user.id, username: user.username },
    config.jwtSecret,
    { expiresIn: Math.floor(config.accessTokenTtl / 1000) },
  );

  const refreshToken = randomBytes(48).toString('hex');
  const now = Date.now();

  db.prepare(`
    INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    newId(),
    user.id,
    hashToken(refreshToken),
    now + config.refreshTokenTtl,
    now,
  );

  return {
    accessToken,
    refreshToken,
    expiresIn: Math.floor(config.accessTokenTtl / 1000),
    user: { id: user.id, username: user.username },
  };
}

/** Comprueba el token de la cabecera Authorization y devuelve el usuario. */
export function authenticate(request, reply) {
  const header = request.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    reply.code(401).send({ error: 'Falta el token de acceso.' });
    return null;
  }
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    return { id: payload.sub, username: payload.username };
  } catch {
    // 401 con un código que el móvil reconoce para pedir un token nuevo
    // en lugar de mandar al usuario a la pantalla de acceso.
    reply.code(401).send({ error: 'Sesión caducada.', code: 'token_expired' });
    return null;
  }
}

// ------------------------------------------------------------------ rutas

export function registerAuthRoutes(app) {
  // Límite estricto en las rutas de credenciales: el servidor está expuesto a
  // internet por el túnel, así que hay que frenar los intentos por fuerza bruta.
  const credentialLimit = {
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
  };

  app.post('/api/auth/register', credentialLimit, async (request, reply) => {
    if (!config.registrationEnabled) {
      return reply.code(403).send({ error: 'El registro está cerrado.' });
    }

    const { username, password, inviteCode } = request.body ?? {};

    if (config.inviteCode && inviteCode !== config.inviteCode) {
      return reply.code(403).send({ error: 'El código de invitación no es válido.' });
    }
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      return reply.code(400).send({
        error: 'El usuario debe tener entre 3 y 32 caracteres: letras, números, punto, guion o guion bajo.',
      });
    }
    if (typeof password !== 'string' || password.length < config.minPasswordLength) {
      return reply.code(400).send({
        error: `La contraseña debe tener al menos ${config.minPasswordLength} caracteres.`,
      });
    }

    const usernameKey = username.toLowerCase();
    const taken = db
      .prepare('SELECT 1 FROM users WHERE username_key = ?')
      .get(usernameKey);
    if (taken) {
      return reply.code(409).send({ error: 'Ese usuario ya está cogido.' });
    }

    const user = {
      id: newId(),
      username,
      created_at: Date.now(),
    };
    const passwordHash = await hashPassword(password);

    db.exec('BEGIN');
    try {
      db.prepare(`
        INSERT INTO users (id, username, username_key, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(user.id, user.username, usernameKey, passwordHash, user.created_at);

      seedDefaultShelves(user.id, user.created_at);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    return reply.code(201).send(issueTokens(user));
  });

  app.post('/api/auth/login', credentialLimit, async (request, reply) => {
    const { username, password } = request.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return reply.code(400).send({ error: 'Faltan el usuario o la contraseña.' });
    }

    const row = db
      .prepare('SELECT * FROM users WHERE username_key = ?')
      .get(username.toLowerCase());

    // Mismo mensaje exista o no el usuario, para no revelar qué nombres están
    // dados de alta.
    const invalid = { error: 'Usuario o contraseña incorrectos.' };
    if (!row) {
      // Se calcula un hash igualmente para que fallar por "usuario inexistente"
      // tarde lo mismo que fallar por "contraseña incorrecta".
      await hashPassword(password);
      return reply.code(401).send(invalid);
    }
    if (!(await verifyPassword(password, row.password_hash))) {
      return reply.code(401).send(invalid);
    }

    return reply.send(issueTokens({ id: row.id, username: row.username }));
  });

  app.post('/api/auth/refresh', async (request, reply) => {
    const { refreshToken } = request.body ?? {};
    if (typeof refreshToken !== 'string') {
      return reply.code(400).send({ error: 'Falta el token de refresco.' });
    }

    const tokenHash = hashToken(refreshToken);
    const session = db
      .prepare('SELECT * FROM sessions WHERE token_hash = ?')
      .get(tokenHash);

    if (!session || session.expires_at < Date.now()) {
      if (session) {
        db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
      }
      return reply.code(401).send({ error: 'La sesión ha caducado. Vuelve a entrar.' });
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
    if (!user) {
      return reply.code(401).send({ error: 'La cuenta ya no existe.' });
    }

    // Rotación: el token usado se invalida y se entrega uno nuevo, de modo que
    // uno robado deja de servir en cuanto el dueño legítimo refresca.
    db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);

    return reply.send(issueTokens({ id: user.id, username: user.username }));
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const { refreshToken } = request.body ?? {};
    if (typeof refreshToken === 'string') {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(refreshToken));
    }
    return reply.code(204).send();
  });

  app.get('/api/auth/me', async (request, reply) => {
    const user = authenticate(request, reply);
    if (!user) return reply;
    return reply.send({ user });
  });

  /**
   * Cambio de contraseña por el propio usuario.
   *
   * Es el segundo paso del rescate: tú le pones una temporal con el script de
   * administración y la persona entra y se pone la suya desde la app.
   */
  app.post('/api/auth/change-password', credentialLimit, async (request, reply) => {
    const user = authenticate(request, reply);
    if (!user) return reply;

    const { currentPassword, newPassword } = request.body ?? {};

    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return reply.code(400).send({ error: 'Faltan la contraseña actual o la nueva.' });
    }
    if (newPassword.length < config.minPasswordLength) {
      return reply.code(400).send({
        error: `La contraseña nueva debe tener al menos ${config.minPasswordLength} caracteres.`,
      });
    }
    if (newPassword === currentPassword) {
      return reply.code(400).send({ error: 'La contraseña nueva es igual que la actual.' });
    }

    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    if (!row) {
      return reply.code(401).send({ error: 'La cuenta ya no existe.' });
    }
    if (!(await verifyPassword(currentPassword, row.password_hash))) {
      return reply.code(401).send({ error: 'La contraseña actual no es correcta.' });
    }

    const passwordHash = await hashPassword(newPassword);

    db.exec('BEGIN');
    try {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
        .run(passwordHash, user.id);
      // Se cierran todas las sesiones: si alguien había entrado con la
      // contraseña antigua, deja de tener acceso en este momento.
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    // Se entregan tokens nuevos para que quien ha hecho el cambio no tenga que
    // volver a escribir nada.
    return reply.send(issueTokens({ id: row.id, username: row.username }));
  });
}

/** Limpieza periódica de sesiones caducadas. */
export function purgeExpiredSessions() {
  const { changes } = db
    .prepare('DELETE FROM sessions WHERE expires_at < ?')
    .run(Date.now());
  return changes;
}
