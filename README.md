# Servidor de BookTrack

Backend de sincronización: cuentas de usuario y copia en la nube de la
colección, para que si se rompe el móvil no se pierda nada.

Node + SQLite en un único contenedor. Sin módulos nativos, así que la imagen es
pequeña y la build rápida. Para dos o tres usuarios de uso puntual consume
alrededor de **100 MB de RAM** y prácticamente nada de CPU.

> **Esto se ejecuta en tu servidor, no en el PC donde programas.**
> Aquí solo vive el código fuente.

## Puesta en marcha con Portainer

### 1. Construir la imagen (una vez, por SSH)

El editor web de Portainer no tiene el código fuente delante, así que no puede
construir la imagen. Este es el único paso que se hace por terminal:

```bash
git clone <tu-repo> booktrack && cd booktrack/server && docker build -t booktrack-server:latest .
```

### 2. Crear el stack

En Portainer: **Stacks → Add stack → Web editor**, con el nombre `booktrack`.
Pega el contenido de `docker-compose.portainer.yml`.

### 3. Poner las variables

Debajo del editor, en **Environment variables → Add environment variable**:

| Nombre | Valor |
|---|---|
| `JWT_SECRET` | Una cadena larga y aleatoria. Genérala con `openssl rand -hex 32` |
| `INVITE_CODE` | La palabra que pedirás para dar de alta a alguien |

Van aquí y no en el fichero a propósito: escritas en el compose quedarían a la
vista de cualquiera que abra el stack.

### 4. Desplegar

**Deploy the stack**. Cuando el contenedor aparezca en verde (*healthy*), listo.

### 5. Comprobar

**Containers → booktrack → Logs**. Debe aparecer una línea `BookTrack
escuchando en 0.0.0.0:8080`.

### 6. Publicarlo con el túnel de Cloudflare

Apunta el subdominio a `http://localhost:8080`.

Si `cloudflared` corre como contenedor en lugar de en el host, quita el bloque
`ports` del compose, descomenta `networks` y apunta el túnel a
`http://booktrack:8080`. Ambos contenedores tienen que estar en la misma red de
Docker.

### Comandos de administración

En Portainer no hace falta SSH: **Containers → booktrack → Console → Connect**
(con `/bin/sh`), y ahí dentro:

```sh
node src/admin.js listar
```

```sh
node src/admin.js reset maria
```

### Copia de seguridad

Los datos están en el volumen `booktrack_data`. Desde Portainer puedes verlo en
**Volumes**, pero para copiarlo lo cómodo es un contenedor de usar y tirar:

```bash
docker run --rm -v booktrack_data:/data -v $(pwd):/copia alpine tar czf /copia/booktrack-$(date +%F).tar.gz -C /data .
```

Deja un `.tar.gz` con todo: cuentas, libros y estanterías.

### Actualizar

Tras un `git pull`, reconstruye la imagen y recrea el stack:

```bash
cd booktrack/server && docker build -t booktrack-server:latest .
```

Y en Portainer, en el stack: **Update the stack** marcando *Re-pull image*.
El volumen no se toca, así que no se pierde nada.

---

## Puesta en marcha con Docker Compose

En el servidor, con Docker instalado:

### 1. Llevar el código al servidor

```bash
git clone <tu-repo> booktrack && cd booktrack/server
```

O copiando solo la carpeta `server/` por `scp`.

### 2. Crear el fichero de configuración

```bash
cp .env.example .env
```

Genera la clave de firma:

```bash
openssl rand -hex 32
```

Edita `.env` y rellena dos valores:

| Variable | Qué poner |
|---|---|
| `JWT_SECRET` | La cadena que acaba de generar `openssl`. **Obligatoria**: sin ella el servidor no arranca. Si la cambias, se cierran todas las sesiones. |
| `INVITE_CODE` | Una palabra que tú elijas. Hace falta para crear una cuenta; pásasela a quien quieras invitar. |

### 3. Arrancar

```bash
docker compose up -d --build
```

### 4. Comprobar que responde

```bash
curl http://127.0.0.1:8080/health
```

Debe contestar `{"status":"ok","time":...}`.

### 5. Publicarlo con el túnel de Cloudflare

Apunta un subdominio (por ejemplo `booktrack.tudominio.com`) al servicio
`http://localhost:8080`. Esa URL es la que se escribe en la app al entrar.

El contenedor publica el puerto **solo en `127.0.0.1`**, nunca en la IP de la
red. Quien da el acceso desde fuera es el túnel, así que no hay que abrir
ningún puerto en el router.

## Uso diario

```bash
docker compose logs -f
```

```bash
docker compose restart
```

```bash
docker compose up -d --build
```

El último comando es también el de actualizar, tras un `git pull`.

## Copia de seguridad

Todo vive en el volumen `booktrack_data`, en un único fichero SQLite. Para
copiarlo, un contenedor de usar y tirar:

```bash
docker run --rm -v booktrack_data:/data -v $(pwd):/copia alpine tar czf /copia/booktrack-$(date +%F).tar.gz -C /data .
```

Deja un `.tar.gz` con la copia completa: cuentas, libros y estanterías.

## Cerrar el registro

Cuando ya tengáis todas las cuentas creadas, en `.env`:

```
REGISTRATION_ENABLED=0
```

Y `docker compose restart`. A partir de ahí nadie más puede darse de alta,
aunque conozca el código.

## API

Todas las respuestas son JSON. Las rutas protegidas esperan la cabecera
`Authorization: Bearer <accessToken>`.

| Método | Ruta | Para qué |
|---|---|---|
| `GET` | `/health` | Comprobación de vida, sin autenticar |
| `POST` | `/api/auth/register` | `{username, password, inviteCode}` |
| `POST` | `/api/auth/login` | `{username, password}` |
| `POST` | `/api/auth/refresh` | `{refreshToken}` → tokens nuevos |
| `POST` | `/api/auth/logout` | `{refreshToken}` |
| `GET` | `/api/auth/me` | Usuario de la sesión actual |
| `POST` | `/api/auth/change-password` | `{currentPassword, newPassword}` |
| `POST` | `/api/sync` | Sube y baja cambios en una sola llamada |
| `GET` | `/api/sync/status` | Recuento de libros y estanterías |

### Cómo sincroniza

Subida y bajada van en la **misma petición y la misma transacción**. Si fueran
dos llamadas y la segunda fallara, el móvil daría por sincronizados unos
cambios sin haber recibido los del servidor.

- Cada fila lleva `updated_at` en milisegundos. Ante un conflicto **gana la
  escritura más reciente**; una fila más antigua que la guardada se descarta.
- Los borrados viajan como **lápidas** (`deleted_at`), no como filas ausentes.
  Si se borrasen de verdad, el otro dispositivo las volvería a subir creyendo
  que son nuevas.
- Los identificadores son UUID generados en el móvil, así que la fila local y
  la del servidor son la misma sin traducir claves.
- La respuesta trae `serverTime`, que el móvil guarda y envía como `since` la
  próxima vez. Viene del servidor a propósito: con la hora del móvil se
  perderían cambios si su reloj va atrasado.

## Seguridad

- Contraseñas con **scrypt** y sal propia por contraseña.
- Comparación en **tiempo constante**, y se calcula un hash aunque el usuario no
  exista, para que no se pueda deducir qué nombres están dados de alta.
- Token de acceso de 1 hora + token de refresco de 60 días, guardado **cifrado**
  en la base de datos y **rotado** en cada uso.
- Límite de **10 intentos cada 5 minutos** en registro y acceso, y 300 peticiones
  por minuto en el resto.
- El proceso corre como usuario `node`, no como root.
- Los errores internos nunca se devuelven al cliente, y las contraseñas no
  aparecen en los logs.

## Si alguien pierde su contraseña

Es una app familiar, así que el rescate se hace desde el servidor, sin correos
ni preguntas de seguridad.

**1.** Le pones una contraseña temporal.

Desde Portainer: **Containers → booktrack → Console → Connect**, y ahí:

```sh
node src/admin.js reset maria
```

Por terminal:

```bash
docker compose exec booktrack node src/admin.js reset maria
```

Queda en `1234`. Para elegir otra, pásala como segundo argumento:

```bash
docker compose exec booktrack node src/admin.js reset maria otraClave123
```

**2.** Se la dices. Entra con ella y va a **Ajustes → Cambiar contraseña** para
poner la suya.

El restablecimiento **cierra todas sus sesiones abiertas** y **no toca sus
libros**. Al cambiarla ella misma, también se cierran las demás sesiones, de
modo que la temporal deja de servir en cuanto la sustituye.

> `1234` salta el mínimo de 8 caracteres a propósito, por ser temporal y
> dictable por teléfono. Está pensada para cambiarse enseguida.

### Otros comandos

```bash
docker compose exec booktrack node src/admin.js listar
```

Muestra las cuentas con sus libros y sesiones activas.

```bash
docker compose exec booktrack node src/admin.js borrar maria
```

Elimina la cuenta y todos sus datos. No se puede deshacer salvo restaurando una
copia de seguridad.
