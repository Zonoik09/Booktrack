import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';

import { purgeExpiredSessions, registerAuthRoutes } from './auth.js';
import { config } from './config.js';
import { registerSyncRoutes } from './sync.js';

// Se pide aquí para que un JWT_SECRET ausente aborte el arranque, en lugar de
// hacerlo en la primera petición de un usuario.
config.jwtSecret;

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    // Sin esto, Fastify registraría el cuerpo de las peticiones y las
    // contraseñas acabarían en texto plano en los logs del contenedor.
    redact: ['req.headers.authorization'],
  },
  // El túnel de Cloudflare es quien termina el TLS, así que la IP real del
  // cliente llega en X-Forwarded-For. Sin esto el limitador de peticiones
  // vería una única IP (la del túnel) y bloquearía a todos a la vez.
  trustProxy: true,
  bodyLimit: 5 * 1024 * 1024,
});

await app.register(cors, { origin: false });

await app.register(rateLimit, {
  max: 300,
  timeWindow: '1 minute',
  message: { error: 'Demasiadas peticiones. Espera un momento.' },
});

app.get('/health', async () => ({ status: 'ok', time: Date.now() }));

registerAuthRoutes(app);
registerSyncRoutes(app);

app.setErrorHandler((error, request, reply) => {
  request.log.error({ err: error }, 'fallo no controlado');
  // Nunca se devuelve el mensaje interno al cliente: filtraría rutas de
  // ficheros y detalles del esquema de la base de datos.
  reply.code(error.statusCode && error.statusCode < 500 ? error.statusCode : 500)
    .send({ error: 'Error interno del servidor.' });
});

// Las sesiones caducadas se limpian al arrancar y una vez al día.
purgeExpiredSessions();
const purgeTimer = setInterval(purgeExpiredSessions, 24 * 60 * 60 * 1000);
purgeTimer.unref();

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `BookTrack escuchando en ${config.host}:${config.port} · ` +
      `base de datos: ${config.databaseFile} · ` +
      `registro: ${config.registrationEnabled ? (config.inviteCode ? 'con código' : 'ABIERTO') : 'cerrado'}`,
  );
  if (config.registrationEnabled && !config.inviteCode) {
    app.log.warn(
      'INVITE_CODE está vacío: cualquiera que llegue al servidor puede crearse una cuenta.',
    );
  }
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

// Docker manda SIGTERM al parar: hay que cerrar ordenadamente para no dejar
// la base de datos a medias de una escritura.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    app.log.info(`${signal} recibido, cerrando…`);
    await app.close();
    process.exit(0);
  });
}
