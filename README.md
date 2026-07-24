# Puente Live

Traducción de voz en tiempo real entre celulares. Cada persona usa su propio celular
con su propio audífono: habla en su idioma y escucha en su idioma. El servidor
recibe el texto, lo traduce y lo reenvía a los demás participantes de la sala.

## Estructura

- `server.js` — Servidor Node.js: salas con código de 4 letras, WebSockets, traducción centralizada.
- `public/index.html` — Interfaz web: lobby (crear/unirse), sala de conversación, QR e invitación por WhatsApp.
- `package.json` — Dependencias (express, ws).

## Desplegar gratis en Render

1. Sube esta carpeta a un repositorio nuevo en GitHub (puede ser desde la web, sin usar la terminal:
   github.com → New repository → "uploading an existing file" → arrastra los archivos).
2. Entra a render.com y crea una cuenta gratis (con tu cuenta de GitHub es un clic).
3. New → Web Service → conecta tu repositorio.
4. Render detecta Node automáticamente. Verifica:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Instance Type: Free
5. Deploy. En unos minutos tendrás una URL tipo `https://puente-live.onrender.com` con HTTPS.

Nota del plan gratuito: el servidor "se duerme" tras ~15 minutos sin uso y tarda
30-60 segundos en despertar en la primera visita. Para demos importantes, abre la
URL un minuto antes.

## Cómo se usa

1. Persona A abre la URL, pone su nombre, elige su idioma (ej. Español) y toca "Crear sala nueva".
2. Toca "Invitar 📲" y comparte el QR o el enlace de WhatsApp.
3. Persona B abre el enlace, elige SU idioma (ej. Türkçe) y se une.
4. Cada quien se pone su audífono, activa su micrófono, y habla con normalidad.
   Lo que dices aparece traducido en el celular del otro y se reproduce en su oído.

## Candado de acceso (modelo de alquiler de noviembre)

Por defecto, cualquiera puede crear una sala — igual que hasta ahora. El candado
se enciende SOLO cuando defines la variable de entorno `ADMIN_KEY` en Render
(Settings → Environment → Add Environment Variable → `ADMIN_KEY` = una clave
larga que solo tú conozcas).

Una vez encendido:

1. Entra a `https://tu-sitio.onrender.com/admin.html` e ingresa tu `ADMIN_KEY`.
2. Por cada cliente (hotel, operador, parroquia) que alquile el servicio, genera
   un código con su nombre y las horas de validez de su alquiler (ej. 24h para
   un día de evento). El panel te da un código tipo `COD-XK92QP`.
3. Le entregas ese código a tu cliente junto con la URL del sitio y (si aplica)
   el audífono alquilado.
4. Tu cliente, al entrar al sitio, escribe ese código en "Código de acceso" y
   crea sus salas con normalidad durante toda la validez del código. Las
   personas que él invite (turistas, peregrinos) NO necesitan ningún código —
   solo entran con el enlace o QR que él comparte, como siempre.
5. Puedes revocar un código en cualquier momento desde el mismo panel.

**Importante — memoria del servidor:** los códigos (y las salas activas) viven
en la memoria del proceso, no en una base de datos. En el plan gratuito de
Render, el servidor se reinicia si estuvo dormido, y eso borra los códigos
generados. Para los días reales del evento de noviembre, considera pasar a un
plan pago de Render (~$7/mes, no se duerme) para que no se te borren los
códigos a medio uso. Para pruebas y demos previas, el plan gratuito basta:
solo regenera los códigos si notas que el panel aparece vacío tras una pausa larga.

## Para actualizar la traducción a Claude + glosario propio

Toda la traducción vive en una sola función del servidor: `translate()` en `server.js`.
Para pasar a la API de Anthropic, reemplaza el contenido de esa función por una
llamada a `https://api.anthropic.com/v1/messages` con tu API key guardada en una
variable de entorno de Render (Environment → `ANTHROPIC_API_KEY`). Nada más cambia.
