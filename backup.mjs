import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = resolve('.');
const databasePath = resolve(root, 'data', 'cennomo.sqlite');
const backupRoot = resolve(root, 'data', 'backups');
if (!existsSync(databasePath)) throw new Error('database does not exist');
mkdirSync(backupRoot, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = resolve(backupRoot, `cennomo-${stamp}.sqlite`);
if (!destination.startsWith(`${backupRoot}\\`) && !destination.startsWith(`${backupRoot}/`)) throw new Error('invalid backup destination');
const db = new DatabaseSync(databasePath, { readOnly: false });
try {
  db.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
} finally {
  db.close();
}

const backups = readdirSync(backupRoot)
  .filter(name => /^cennomo-\d{4}-\d{2}-\d{2}T.*\.sqlite$/.test(name))
  .map(name => ({ name, path: resolve(backupRoot, name), modified: statSync(resolve(backupRoot, name)).mtimeMs }))
  .sort((a, b) => b.modified - a.modified);
for (const old of backups.slice(14)) unlinkSync(old.path);
console.log(`Database backup created: ${destination}`);
