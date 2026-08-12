#!/usr/bin/env node
/**
 * Erzeugt eine .env mit frischen Secrets aus .env.example.
 * Bestehende .env wird NICHT ueberschrieben.
 *
 *   npm run secrets
 */
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const examplePath = join(root, '.env.example');

if (existsSync(envPath)) {
  console.error('.env existiert bereits — es wird nichts ueberschrieben.');
  console.error('Zum Neuerzeugen die vorhandene .env vorher sichern und entfernen.');
  process.exit(1);
}

const key = () => randomBytes(32).toString('base64');
const password = () => randomBytes(32).toString('base64url').slice(0, 40);
// Der PIN ist bewusst 8-stellig; laenger geht jederzeit ueber das Admin-Dashboard.
const pin = () =>
  Array.from({ length: 8 }, () => randomInt(0, 10)).join('');

const secrets = {
  POSTGRES_PASSWORD: password(),
  ENCRYPTION_KEY: key(),
  SESSION_SECRET: key(),
  ADMIN_INITIAL_PIN: pin(),
};

let content = readFileSync(examplePath, 'utf8');
for (const [name, value] of Object.entries(secrets)) {
  const pattern = new RegExp(`^${name}=.*$`, 'm');
  if (!pattern.test(content)) {
    console.error(`Feld ${name} fehlt in .env.example — abgebrochen.`);
    process.exit(1);
  }
  content = content.replace(pattern, `${name}=${value}`);
}

// DATABASE_URL traegt das Passwort ein zweites Mal und muss mitgezogen werden.
content = content.replace(
  /^DATABASE_URL=.*$/m,
  `DATABASE_URL=postgres://jama_mcp:${encodeURIComponent(secrets.POSTGRES_PASSWORD)}@postgres:5432/jama_mcp`,
);

writeFileSync(envPath, content, { mode: 0o600 });

console.log('.env erzeugt (Dateirechte 0600).');
console.log('');
console.log(`  Admin-PIN: ${secrets.ADMIN_INITIAL_PIN}`);
console.log('');
console.log('Diesen PIN jetzt notieren — er wird nur als Hash gespeichert.');
console.log('Nach dem ersten Start kann ADMIN_INITIAL_PIN aus der .env entfernt werden.');
