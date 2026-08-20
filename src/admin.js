/**
 * Herramienta de administración del servidor.
 *
 * Se ejecuta dentro del contenedor, nunca por la red: quien puede lanzarla ya
 * tiene acceso a la máquina y al fichero de la base de datos, así que no hay
 * nada que autenticar. Por eso mismo estas operaciones **no** están expuestas
 * como rutas de la API.
 *
 * Uso:
 *   docker compose exec booktrack node src/admin.js listar
 *   docker compose exec booktrack node src/admin.js reset <usuario> [contraseña]
 *   docker compose exec booktrack node src/admin.js borrar <usuario>
 */
import { db } from './db.js';
import { hashPassword } from './password.js';

/** Contraseña temporal por defecto, pensada para dictarla por teléfono. */
const DEFAULT_TEMP_PASSWORD = '1234';

const [, , command, ...args] = process.argv;

function findUser(username) {
  if (!username) {
    console.error('Falta el nombre de usuario.');
    process.exit(1);
  }
  const user = db
    .prepare('SELECT * FROM users WHERE username_key = ?')
    .get(String(username).toLowerCase());
  if (!user) {
    console.error(`No existe ningún usuario llamado "${username}".`);
    console.error('Lista los que hay con:  node src/admin.js listar');
    process.exit(1);
  }
  return user;
}

function formatDate(ms) {
  return new Date(ms).toLocaleString('es-ES');
}

function listUsers() {
  const users = db
    .prepare('SELECT * FROM users ORDER BY created_at')
    .all();

  if (users.length === 0) {
    console.log('Todavía no hay ninguna cuenta creada.');
    return;
  }

  const countBooks = db.prepare(
    'SELECT COUNT(*) AS n FROM books WHERE user_id = ? AND deleted_at IS NULL',
  );
  const countSessions = db.prepare(
    'SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?',
  );

  console.log(`\n${users.length} cuenta(s):\n`);
  for (const user of users) {
    const books = countBooks.get(user.id).n;
    const sessions = countSessions.get(user.id, Date.now()).n;
    console.log(`  ${user.username}`);
    console.log(`    creada     ${formatDate(user.created_at)}`);
    console.log(`    libros     ${books}`);
    console.log(`    sesiones   ${sessions} activa(s)`);
    console.log('');
  }
}

async function resetPassword(username, newPassword) {
  const user = findUser(username);
  const password = newPassword || DEFAULT_TEMP_PASSWORD;

  const passwordHash = await hashPassword(password);

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .run(passwordHash, user.id);
    // Se cierran sus sesiones abiertas: si el motivo del cambio es que alguien
    // le ha entrado en la cuenta, dejarlas vivas no serviría de nada.
    const { changes } = db
      .prepare('DELETE FROM sessions WHERE user_id = ?')
      .run(user.id);
    db.exec('COMMIT');

    console.log(`\n  Contraseña de "${user.username}" cambiada a:  ${password}`);
    if (changes > 0) {
      console.log(`  Se han cerrado ${changes} sesión(es) que tenía abierta(s).`);
    }
    console.log(
      '\n  Sus libros NO se han tocado.\n' +
        '  Dile que entre con esa contraseña y la cambie desde\n' +
        '  Ajustes -> Cambiar contraseña.\n',
    );
    if (password === DEFAULT_TEMP_PASSWORD) {
      console.log(
        '  Aviso: "1234" es una contraseña temporal. Está pensada para que la\n' +
          '  cambien enseguida, no para dejarla puesta.\n',
      );
    }
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function deleteUser(username) {
  const user = findUser(username);
  const books = db
    .prepare('SELECT COUNT(*) AS n FROM books WHERE user_id = ?')
    .get(user.id).n;

  // ON DELETE CASCADE se lleva por delante libros, estanterías y sesiones.
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);

  console.log(
    `\n  Cuenta "${user.username}" eliminada, junto con sus ${books} libro(s).\n` +
      '  Esto no se puede deshacer salvo restaurando una copia de seguridad.\n',
  );
}

function usage() {
  console.log(`
Administración de BookTrack

  listar                          Muestra las cuentas, con sus libros y sesiones
  reset <usuario> [contraseña]    Cambia la contraseña sin saber la anterior
                                  (por defecto la pone a "${DEFAULT_TEMP_PASSWORD}")
  borrar <usuario>                Elimina la cuenta y todos sus datos

Ejemplos:

  docker compose exec booktrack node src/admin.js listar
  docker compose exec booktrack node src/admin.js reset maria
  docker compose exec booktrack node src/admin.js reset maria otraClave123
`);
}

switch (command) {
  case 'listar':
  case 'list':
    listUsers();
    break;

  case 'reset':
  case 'reset-password':
    await resetPassword(args[0], args[1]);
    break;

  case 'borrar':
  case 'delete':
    deleteUser(args[0]);
    break;

  default:
    usage();
    process.exit(command ? 1 : 0);
}
