import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = resolve(process.cwd(), '../.env');
const values = {};

if (existsSync(source)) {
  for (const line of readFileSync(source, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) values[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
}

const get = (key) => process.env[key] || values[key] || '';
const environment = {
  production: process.env.NODE_ENV === 'production',
  supabaseUrl: get('NEXT_PUBLIC_SUPABASE_URL'),
  supabasePublishableKey: get('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'),
  vapidPublicKey: get('VAPID_PUBLIC_KEY'),
};

if (!environment.supabaseUrl || !environment.supabasePublishableKey) {
  console.warn('Faltan NEXT_PUBLIC_SUPABASE_URL o NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. La autenticación no podrá iniciarse.');
}

writeFileSync(resolve(process.cwd(), 'src/environments/environment.generated.ts'), `// Generated from public build variables. Never add private keys here.\nexport const environment = ${JSON.stringify(environment, null, 2)} as const;\n`);
