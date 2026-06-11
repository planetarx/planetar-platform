// adapters/sqlite/_db.ts — open a node:sqlite db, creating the parent dir if needed.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export function openDb(path = ':memory:'): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  return new DatabaseSync(path);
}
