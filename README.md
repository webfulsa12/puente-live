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

## Para actualizar la traducción a Claude + glosario propio

Toda la traducción vive en una sola función del servidor: `translate()` en `server.js`.
Para pasar a la API de Anthropic, reemplaza el contenido de esa función por una
llamada a `https://api.anthropic.com/v1/messages` con tu API key guardada en una
variable de entorno de Render (Environment → `ANTHROPIC_API_KEY`). Nada más cambia.
