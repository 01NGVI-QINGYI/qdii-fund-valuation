/**
 * 极简 JSON 文件持久化。
 * 数据量很小（自选列表 + 盘中采样点），不值得引入数据库。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 数据目录放在项目根下：server/lib -> 项目根
const DEFAULT_DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
// 托管环境可把 DATA_DIR 指向持久化磁盘；未配置时维持本地开发行为。
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : DEFAULT_DATA_DIR;

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJson(file, fallback = null) {
  try {
    const raw = await fs.readFile(path.join(DATA_DIR, file), 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** 原子写：先写临时文件再 rename，避免读到半截 JSON。 */
export async function writeJson(file, value) {
  const target = path.join(DATA_DIR, file);
  await ensureDir(path.dirname(target));
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), 'utf8');
  await fs.rename(tmp, target);
  return target;
}

export async function listJson(dir) {
  try {
    const files = await fs.readdir(path.join(DATA_DIR, dir));
    return files.filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
}
