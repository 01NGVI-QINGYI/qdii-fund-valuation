/** 准备 Pages 产物：所有本地模块使用同一内容版本，避免混用新旧脚本。 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../web/', import.meta.url));
const output = fileURLToPath(new URL('../_site/', import.meta.url));
const files = new Map();

async function collect(directory, prefix = '') {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory()) await collect(path.join(directory, entry.name), relative + '/');
    else if (entry.isFile()) files.set(relative, await fs.readFile(path.join(directory, entry.name)));
  }
}
await collect(source);
files.set('config.js', Buffer.from(`window.QDII_API_BASE = ${JSON.stringify(process.env.API_BASE || '')};\n`));

const hash = createHash('sha256');
for (const [name, contents] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
  hash.update(name).update('\0').update(contents).update('\0');
}
const version = hash.digest('hex').slice(0, 12);
for (const [name, contents] of files) {
  let built = contents;
  if (name.endsWith('.js')) {
    built = contents.toString().replace(
      /(\b(?:from\s*|import\s*)['"])(\.[^'"]+\.js)(['"])/g,
      `$1$2?v=${version}$3`,
    );
  } else if (name.endsWith('.html')) {
    built = contents.toString()
      .replace(/((?:src|href)="\.\/[^"?]+\.(?:js|css))"/g, `$1?v=${version}"`)
      .replace('<html ', `<html data-release="${version}" `);
  }
  const destination = path.join(output, name);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, built);
}
console.log(`Prepared ${files.size} static files in _site (release ${version}).`);
