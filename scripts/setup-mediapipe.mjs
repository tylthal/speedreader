#!/usr/bin/env node
/**
 * setup-mediapipe.mjs
 *
 * Downloads the MediaPipe tasks-vision WASM bundle and the face-landmarker
 * model into /public/mediapipe so the app can run completely offline.
 *
 * Source CDN/storage URLs are intentionally hard-coded (and pinned to the
 * version declared in package.json) so the script is reproducible and does
 * not rely on a runtime npm dependency.
 *
 * Usage:
 *   node scripts/setup-mediapipe.mjs            # idempotent, skip if present
 *   node scripts/setup-mediapipe.mjs --force    # re-download
 */

import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const FORCE = process.argv.includes('--force');

// Resolve the @mediapipe/tasks-vision version from package.json so the WASM
// bundle and the JS runtime always agree.
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const TV_RANGE = pkg.dependencies?.['@mediapipe/tasks-vision'] ?? '^0.10.14';
const TV_VERSION = TV_RANGE.replace(/^[\^~]/, '');

const PUBLIC_DIR = join(ROOT, 'public', 'mediapipe');
const WASM_DIR = join(PUBLIC_DIR, 'wasm');
const MODELS_DIR = join(PUBLIC_DIR, 'models');

const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TV_VERSION}/wasm`;

// Files shipped in the tasks-vision wasm directory. The loader (FilesetResolver)
// needs the .js shims plus their matching .wasm payloads.
const WASM_FILES = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
];

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const MODEL_PATH = join(MODELS_DIR, 'face_landmarker.task');

async function exists(path) {
  try {
    const s = await stat(path);
    return s.size > 0;
  } catch {
    return false;
  }
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

async function download(url, dest) {
  await mkdir(dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  // Best-effort cleanup of any prior partial file.
  await rm(tmp, { force: true });

  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed (${res.status} ${res.statusText}): ${url}`);
  }

  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  // Atomic-ish move using rename via fs/promises.
  const { rename } = await import('node:fs/promises');
  await rename(tmp, dest);

  const s = await stat(dest);
  return s.size;
}

async function ensure(url, dest, label) {
  if (!FORCE && (await exists(dest))) {
    const s = await stat(dest);
    console.log(`  skip  ${label}  (${fmtBytes(s.size)} already present)`);
    return s.size;
  }
  process.stdout.write(`  fetch ${label}  ... `);
  const size = await download(url, dest);
  console.log(`done (${fmtBytes(size)})`);
  return size;
}

async function main() {
  console.log(`[setup-mediapipe] tasks-vision version: ${TV_VERSION}`);
  console.log(`[setup-mediapipe] target: ${PUBLIC_DIR}`);
  if (FORCE) console.log('[setup-mediapipe] --force: re-downloading all assets');

  await mkdir(WASM_DIR, { recursive: true });
  await mkdir(MODELS_DIR, { recursive: true });

  let total = 0;

  console.log('[setup-mediapipe] WASM bundle');
  for (const file of WASM_FILES) {
    total += await ensure(`${WASM_BASE}/${file}`, join(WASM_DIR, file), `wasm/${file}`);
  }

  console.log('[setup-mediapipe] Model');
  total += await ensure(MODEL_URL, MODEL_PATH, 'models/face_landmarker.task');

  console.log(`[setup-mediapipe] total on disk: ${fmtBytes(total)}`);
}

main().catch((err) => {
  console.error('[setup-mediapipe] FAILED:', err?.message ?? err);
  process.exit(1);
});
