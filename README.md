# StockAlert

Web app para fotografiar fechas de caducidad, almacenarlas de forma privada y recibir avisos a 10, 5, 1 y 0 días.

## Arquitectura

- Angular sirve la interfaz estática desde Vercel o cualquier hosting estático.
- Supabase Auth, Postgres, Storage y RLS gestionan el acceso y los productos.
- La Edge Function `analyze-product` lee la foto con OpenAI sin exponer `OPENAI_KEY` al navegador.
- La Edge Function `send-expiry-notifications` envía avisos Web Push; `pg_cron` la invoca cada día a las 08:00 UTC.

No hace falta ejecutar `backend/` para usar StockAlert. Ese directorio queda como referencia de la implementación anterior y ya no es usado por la interfaz.

## Preparar Supabase

1. Vincula el proyecto con su referencia de 20 letras minúsculas y aplica el esquema:

   ```bash
   supabase projects list
   supabase link --project-ref <project-ref>
   supabase db push
   ```

2. En **Authentication > Providers**, habilita correo y contraseña. Crea las cuentas manualmente en **Authentication > Users** y desactiva **Allow new users to sign up**.

3. Crea el archivo local de secretos para las funciones, sin subirlo al repositorio:

   ```bash
   cp supabase/functions/.env.example supabase/functions/.env
   ```

   Copia en él `OPENAI_KEY`, las tres claves VAPID y un valor aleatorio largo para `STOCKALERT_CRON_SECRET`. Después despliega esos secretos y las funciones:

   ```bash
   supabase secrets set --env-file supabase/functions/.env
   supabase functions deploy analyze-product
   supabase functions deploy send-expiry-notifications
   ```

   Las claves privadas se quedan en los secretos de Supabase. No copies `SUPABASE_SECRET_KEY` ni `OPENAI_KEY` en Vercel ni en archivos de Angular.

4. Abre [`supabase/scheduling.sql.example`](supabase/scheduling.sql.example), sustituye `<project-ref>` y `<long-random-secret>` por el mismo valor configurado como `STOCKALERT_CRON_SECRET`, y ejecútalo una vez en el SQL Editor de Supabase. Programa el envío diario sin un servidor propio.

## Ejecutar la interfaz localmente

Angular sólo lee estos valores publicables desde el `.env` de la raíz:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<publishable-key>
VAPID_PUBLIC_KEY=<public-vapid-key>
```

Desde `client`:

```bash
npm install
npm start
```

El paso previo a `start` genera la configuración del navegador con esas tres variables públicas. No es necesario ejecutar Python ni un API local.

## Desplegar en Vercel

Mantén el directorio raíz de Vercel en la raíz del repositorio. El archivo `vercel.json` instala y compila `client`, publica `client/dist/client/browser` y permite abrir cualquier ruta de Angular. Añade las mismas tres variables públicas anteriores al proyecto de Vercel.

En Supabase, añade la URL HTTPS final de Vercel a **Authentication > URL Configuration > Site URL**. El frontend se comunica directamente con Supabase y las dos Edge Functions desplegadas.

## Seguridad

Las tablas y Storage usan RLS por propietario. El cliente sólo usa la URL y publishable key de Supabase, que están diseñadas para ser públicas junto con RLS. La función de análisis vuelve a validar el JWT, restringe las imágenes a JPG/PNG/WebP de hasta 5 MB y guarda la foto dentro de la carpeta del usuario. Las funciones programadas utilizan una clave de cron guardada en Supabase Vault y sus secretos de Edge Functions; `SUPABASE_SECRET_KEY`, OpenAI y la clave VAPID privada nunca se envían al navegador.
