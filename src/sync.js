import { authenticate } from './auth.js';
import { db } from './db.js';

/**
 * Sincronización local-first, por diferencias y con resolución "gana el más
 * reciente".
 *
 * El móvil manda lo que ha cambiado desde la última vez (`push`) y pide lo que
 * ha cambiado en el servidor (`pull`). Los conflictos se resuelven comparando
 * `updated_at`: si la fila que llega es más antigua que la guardada, se
 * descarta. Es suficiente para una persona con uno o dos dispositivos, que es
 * el caso real de esta app.
 *
 * Los borrados viajan como lápidas (`deleted_at`), nunca como ausencia de la
 * fila: si se borrasen de verdad, el otro dispositivo volvería a subirlas en la
 * siguiente sincronización creyendo que son nuevas.
 */

/** Columnas que el móvil puede escribir, por tabla. */
const BOOK_COLUMNS = [
  'title', 'authors', 'isbn13', 'isbn10', 'cover_url', 'page_count',
  'publisher', 'published_date', 'description', 'categories', 'language',
  'type', 'volume_number', 'rating', 'notes', 'source',
];

const SHELF_COLUMNS = ['name', 'position', 'is_default'];

const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64;
const asInt = (v) => (v === null || v === undefined ? null : Number(v) || 0);

function timestamps(row) {
  const now = Date.now();
  return {
    createdAt: Number(row.created_at) || now,
    // El reloj del móvil podría ir adelantado; se recorta al momento actual
    // para que una fila no quede "en el futuro" y gane siempre los conflictos.
    updatedAt: Math.min(Number(row.updated_at) || now, now),
    deletedAt: row.deleted_at ? Number(row.deleted_at) : null,
  };
}

// -------------------------------------------------------------------- pull

function pull(userId, since) {
  const books = db
    .prepare('SELECT * FROM books WHERE user_id = ? AND updated_at > ? ORDER BY updated_at')
    .all(userId, since);

  const shelves = db
    .prepare('SELECT * FROM shelves WHERE user_id = ? AND updated_at > ? ORDER BY updated_at')
    .all(userId, since);

  const bookShelves = db
    .prepare('SELECT * FROM book_shelves WHERE user_id = ? AND updated_at > ? ORDER BY updated_at')
    .all(userId, since);

  const strip = ({ user_id, ...rest }) => rest;

  return {
    books: books.map(strip),
    shelves: shelves.map(strip),
    bookShelves: bookShelves.map(strip),
  };
}

// -------------------------------------------------------------------- push

function pushBooks(userId, rows) {
  const existing = db.prepare(
    'SELECT updated_at FROM books WHERE user_id = ? AND id = ?',
  );
  const upsert = db.prepare(`
    INSERT INTO books (
      id, user_id, ${BOOK_COLUMNS.join(', ')}, created_at, updated_at, deleted_at
    ) VALUES (
      ?, ?, ${BOOK_COLUMNS.map(() => '?').join(', ')}, ?, ?, ?
    )
    ON CONFLICT(user_id, id) DO UPDATE SET
      ${BOOK_COLUMNS.map((c) => `${c} = excluded.${c}`).join(', ')},
      updated_at = excluded.updated_at,
      deleted_at = excluded.deleted_at
  `);

  let applied = 0;
  for (const row of rows) {
    if (!isId(row?.id) || typeof row.title !== 'string') continue;

    const { createdAt, updatedAt, deletedAt } = timestamps(row);
    const current = existing.get(userId, row.id);
    if (current && current.updated_at >= updatedAt) continue; // gana el servidor

    upsert.run(
      row.id,
      userId,
      row.title,
      row.authors ?? null,
      row.isbn13 ?? null,
      row.isbn10 ?? null,
      row.cover_url ?? null,
      asInt(row.page_count),
      row.publisher ?? null,
      row.published_date ?? null,
      row.description ?? null,
      row.categories ?? null,
      row.language ?? 'spa',
      row.type ?? 'book',
      asInt(row.volume_number),
      asInt(row.rating),
      row.notes ?? null,
      row.source ?? null,
      createdAt,
      updatedAt,
      deletedAt,
    );
    applied += 1;
  }
  return applied;
}

function pushShelves(userId, rows) {
  const existing = db.prepare(
    'SELECT updated_at FROM shelves WHERE user_id = ? AND id = ?',
  );
  const upsert = db.prepare(`
    INSERT INTO shelves (id, user_id, name, position, is_default, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, id) DO UPDATE SET
      name = excluded.name,
      position = excluded.position,
      is_default = excluded.is_default,
      updated_at = excluded.updated_at,
      deleted_at = excluded.deleted_at
  `);

  let applied = 0;
  for (const row of rows) {
    if (!isId(row?.id) || typeof row.name !== 'string') continue;

    const { createdAt, updatedAt, deletedAt } = timestamps(row);
    const current = existing.get(userId, row.id);
    if (current && current.updated_at >= updatedAt) continue;

    upsert.run(
      row.id,
      userId,
      row.name,
      asInt(row.position),
      row.is_default ? 1 : 0,
      createdAt,
      updatedAt,
      deletedAt,
    );
    applied += 1;
  }
  return applied;
}

function pushBookShelves(userId, rows) {
  const existing = db.prepare(
    'SELECT updated_at FROM book_shelves WHERE user_id = ? AND book_id = ? AND shelf_id = ?',
  );
  const upsert = db.prepare(`
    INSERT INTO book_shelves (book_id, shelf_id, user_id, added_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, book_id, shelf_id) DO UPDATE SET
      added_at = excluded.added_at,
      updated_at = excluded.updated_at,
      deleted_at = excluded.deleted_at
  `);

  let applied = 0;
  for (const row of rows) {
    if (!isId(row?.book_id) || !isId(row?.shelf_id)) continue;

    const now = Date.now();
    const updatedAt = Math.min(Number(row.updated_at) || now, now);
    const current = existing.get(userId, row.book_id, row.shelf_id);
    if (current && current.updated_at >= updatedAt) continue;

    upsert.run(
      row.book_id,
      row.shelf_id,
      userId,
      Number(row.added_at) || now,
      updatedAt,
      row.deleted_at ? Number(row.deleted_at) : null,
    );
    applied += 1;
  }
  return applied;
}

// ------------------------------------------------------------------ rutas

export function registerSyncRoutes(app) {
  /**
   * Una sola llamada hace subida y bajada.
   *
   * Interesa que sea atómico: si se subiera y bajara en dos peticiones y la
   * segunda fallara, el móvil se quedaría con sus cambios ya marcados como
   * sincronizados pero sin los del servidor.
   */
  app.post('/api/sync', async (request, reply) => {
    const user = authenticate(request, reply);
    if (!user) return reply;

    const body = request.body ?? {};
    const since = Number(body.since) || 0;

    const books = Array.isArray(body.books) ? body.books : [];
    const shelves = Array.isArray(body.shelves) ? body.shelves : [];
    const bookShelves = Array.isArray(body.bookShelves) ? body.bookShelves : [];

    if (books.length + shelves.length + bookShelves.length > 5000) {
      return reply.code(413).send({ error: 'Demasiados cambios de una vez.' });
    }

    let pushed = 0;
    let changes;

    db.exec('BEGIN IMMEDIATE');
    try {
      // Las estanterías primero: si un libro llega junto a la estantería nueva
      // en la que vive, esta debe existir antes que la relación.
      pushed += pushShelves(user.id, shelves);
      pushed += pushBooks(user.id, books);
      pushed += pushBookShelves(user.id, bookShelves);

      changes = pull(user.id, since);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    return reply.send({
      // El móvil guarda esta marca y la manda como `since` la próxima vez.
      // Viene del servidor a propósito: usar la hora del móvil se saltaría
      // cambios si su reloj va atrasado.
      serverTime: Date.now(),
      pushed,
      ...changes,
    });
  });

  /** Estado de la cuenta, para la pantalla de ajustes. */
  app.get('/api/sync/status', async (request, reply) => {
    const user = authenticate(request, reply);
    if (!user) return reply;

    const count = (table) =>
      db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ? AND deleted_at IS NULL`)
        .get(user.id).n;

    return reply.send({
      user,
      books: count('books'),
      shelves: count('shelves'),
      serverTime: Date.now(),
    });
  });
}
