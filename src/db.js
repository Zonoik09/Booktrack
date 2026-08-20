import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { config, newId } from './config.js';

/**
 * Base de datos del servidor.
 *
 * SQLite integrado en Node: sin módulos nativos que compilar, así que la imagen
 * de Docker es pequeña y la copia de seguridad consiste en copiar un fichero.
 * Para dos o tres usuarios de uso puntual va de sobra.
 *
 * Todas las tablas sincronizables comparten tres columnas:
 *   - `updated_at`  marca de tiempo en milisegundos; resuelve los conflictos
 *                   (gana la escritura más reciente).
 *   - `deleted_at`  lápida: los borrados no eliminan la fila, porque si no el
 *                   otro dispositivo no se enteraría de que hay que borrarla.
 *   - `id`          UUID generado en el móvil, de modo que la fila local y la
 *                   del servidor son la misma sin necesidad de traducir claves.
 */
mkdirSync(dirname(config.databaseFile), { recursive: true });

export const db = new DatabaseSync(config.databaseFile);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS users(
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL,
    username_key  TEXT NOT NULL UNIQUE,   -- username en minúsculas, para el índice
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions(
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS books(
    id             TEXT NOT NULL,
    user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title          TEXT NOT NULL,
    authors        TEXT,
    isbn13         TEXT,
    isbn10         TEXT,
    cover_url      TEXT,
    page_count     INTEGER,
    publisher      TEXT,
    published_date TEXT,
    description    TEXT,
    categories     TEXT,
    language       TEXT NOT NULL DEFAULT 'spa',
    type           TEXT NOT NULL DEFAULT 'book',
    volume_number  INTEGER,
    rating         INTEGER,
    notes          TEXT,
    source         TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    deleted_at     INTEGER,
    PRIMARY KEY(user_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_books_sync ON books(user_id, updated_at);

  CREATE TABLE IF NOT EXISTS shelves(
    id         TEXT NOT NULL,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    PRIMARY KEY(user_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_shelves_sync ON shelves(user_id, updated_at);

  CREATE TABLE IF NOT EXISTS book_shelves(
    book_id    TEXT NOT NULL,
    shelf_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    added_at   INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    PRIMARY KEY(user_id, book_id, shelf_id)
  );
  CREATE INDEX IF NOT EXISTS idx_book_shelves_sync ON book_shelves(user_id, updated_at);
`);

/**
 * Estanterías iniciales de una cuenta recién creada.
 *
 * Se crean aquí y no en el móvil a propósito: si las sembrara cada dispositivo,
 * al entrar desde un segundo móvil aparecerían duplicadas ("Mis Libros" dos
 * veces, con identificadores distintos). Creándolas una sola vez en el alta, el
 * resto de dispositivos simplemente se las descarga.
 */
export function seedDefaultShelves(userId, now = Date.now()) {
  const insert = db.prepare(`
    INSERT INTO shelves (id, user_id, name, position, is_default, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
  `);
  ['Mis Libros', 'Deseos', 'Pendientes'].forEach((name, i) => {
    insert.run(newId(), userId, name, i, now, now);
  });
}
