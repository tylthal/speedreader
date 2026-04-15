// Standalone diagnostic: run the EPUB parser logic against testbook/*.epub
// using linkedom for DOMParser and JSZip for the archive. Mirrors the
// production parser closely but without TypeScript or Vite.

import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from 'linkedom';
import JSZip from 'jszip';

const __dirname = dirname(fileURLToPath(import.meta.url));
const epubPath = resolve(__dirname, '..', 'testbook', 'babel-r-f-kuang-2022--annas-archive--zlib-22432456.epub');

const buf = readFileSync(epubPath);
const zip = await JSZip.loadAsync(buf);

const containerXml = await zip.file('META-INF/container.xml').async('text');
const containerDoc = new DOMParser().parseFromString(containerXml, 'application/xml');
const opfPath = containerDoc.querySelector('rootfile').getAttribute('full-path');
console.log('OPF path:', opfPath);

const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
const opfXml = await zip.file(opfPath).async('text');
const opfDoc = new DOMParser().parseFromString(opfXml, 'application/xml');

// Manifest
const manifest = new Map();
for (const item of opfDoc.querySelectorAll('manifest > item')) {
  const id = item.getAttribute('id') ?? '';
  const href = item.getAttribute('href') ?? '';
  const mediaType = item.getAttribute('media-type') ?? '';
  const properties = item.getAttribute('properties') ?? '';
  const fullHref = opfDir ? `${opfDir}/${href}` : href;
  manifest.set(id, { id, href: fullHref, mediaType, properties });
}
console.log(`Manifest items: ${manifest.size}`);

// Image manifest
const images = [];
const byHref = new Map();
const byBasename = new Map();
const usedNames = new Set();
function uniqueName(base) {
  if (!usedNames.has(base)) { usedNames.add(base); return base; }
  let i = 1;
  while (usedNames.has(`${i}-${base}`)) i++;
  const next = `${i}-${base}`;
  usedNames.add(next);
  return next;
}
for (const item of manifest.values()) {
  if (!item.mediaType.startsWith('image/')) continue;
  const file = zip.file(item.href);
  if (!file) {
    console.log('  manifest image NOT FOUND in zip:', item.href);
    continue;
  }
  const data = await file.async('arraybuffer');
  const rawBasename = item.href.split('/').pop() ?? 'image';
  const name = uniqueName(rawBasename);
  images.push({ name, bytes: data.byteLength, href: item.href, mime: item.mediaType });
  byHref.set(item.href, name);
  if (!byBasename.has(rawBasename)) byBasename.set(rawBasename, name);
}
console.log(`\nImage manifest entries: ${images.length}`);
for (const img of images.slice(0, 10)) {
  console.log(`  ${img.name}  (${img.bytes}B)  ← ${img.href}  [${img.mime}]`);
}
if (images.length > 10) console.log(`  ... and ${images.length - 10} more`);

// Spine
const spine = [];
for (const ref of opfDoc.querySelectorAll('spine > itemref')) {
  spine.push({ id: ref.getAttribute('idref'), linear: ref.getAttribute('linear') ?? 'yes' });
}
console.log(`\nSpine items: ${spine.length}`);

// Resolve path helper
function resolvePath(base, relative) {
  if (relative.startsWith('/')) return relative.slice(1);
  const baseParts = base.split('/');
  baseParts.pop();
  for (const part of relative.split('/')) {
    if (part === '..') baseParts.pop();
    else if (part !== '.') baseParts.push(part);
  }
  return baseParts.join('/');
}
function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(0, i) : '';
}

// Walk first 5 spine items, run image rewrite, count <img> tags before/after.
let totalImgsBefore = 0;
let totalImgsAfter = 0;
const sectionsWithImgs = [];
for (let s = 0; s < spine.length; s++) {
  const item = manifest.get(spine[s].id);
  if (!item || !item.mediaType.includes('html')) continue;
  const file = zip.file(item.href);
  if (!file) continue;
  const content = await file.async('text');
  const doc = new DOMParser().parseFromString(content, 'text/html');
  const imgs = Array.from(doc.querySelectorAll('img'));
  totalImgsBefore += imgs.length;
  let kept = 0;
  let removed = 0;
  const chapterDir = dirOf(item.href);
  for (const img of imgs) {
    const src = img.getAttribute('src') ?? '';
    if (!src) { removed++; continue; }
    const resolved = chapterDir && !src.startsWith('/')
      ? resolvePath(chapterDir + '/dummy', src)
      : src;
    const basename = src.split('/').pop();
    const name = byHref.get(resolved) ?? byBasename.get(basename);
    if (!name) {
      console.log(`  [section ${s}] UNRESOLVED img src: "${src}" (resolved=${resolved}, basename=${basename})`);
      removed++;
      continue;
    }
    img.setAttribute('src', `opfs:${name}`);
    kept++;
  }
  totalImgsAfter += kept;
  if (imgs.length > 0) {
    sectionsWithImgs.push({ section: s, href: item.href, before: imgs.length, kept, removed });
  }
}

console.log(`\nTotal <img> tags across spine: ${totalImgsBefore}`);
console.log(`After rewrite (kept): ${totalImgsAfter}`);
console.log(`After rewrite (removed): ${totalImgsBefore - totalImgsAfter}`);

console.log('\nSections containing images (first 10):');
for (const s of sectionsWithImgs.slice(0, 10)) {
  console.log(`  section ${s.section}: ${s.kept}/${s.before} kept  (${s.href})`);
}

// Cover detection
let coverMetaId = null;
for (const m of opfDoc.querySelectorAll('metadata > meta')) {
  if (m.getAttribute('name') === 'cover') { coverMetaId = m.getAttribute('content'); break; }
}
console.log('\nCover detection:');
console.log('  meta name=cover content =', coverMetaId);

let cover = null;
for (const item of manifest.values()) {
  if ((item.properties ?? '').split(/\s+/).includes('cover-image')) {
    cover = { source: 'properties=cover-image', href: item.href, mime: item.mediaType };
    break;
  }
}
if (!cover && coverMetaId) {
  const item = manifest.get(coverMetaId);
  if (item && item.mediaType.startsWith('image/')) {
    cover = { source: 'meta name=cover', href: item.href, mime: item.mediaType };
  }
}
if (!cover) {
  for (const item of manifest.values()) {
    if (item.mediaType.startsWith('image/')) {
      cover = { source: 'first manifest image', href: item.href, mime: item.mediaType };
      break;
    }
  }
}
console.log('  resolved cover:', cover ?? 'NONE');
