import { test as base } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

// Download a small public domain EPUB for testing if not already present
export async function ensureTestEpub(): Promise<string> {
  const testDataDir = path.join(__dirname, 'test-data');
  const epubPath = path.join(testDataDir, 'test.epub');

  if (!fs.existsSync(epubPath)) {
    // Create test data dir
    fs.mkdirSync(testDataDir, { recursive: true });

    // Download a small public domain book from Project Gutenberg
    const response = await fetch('https://www.gutenberg.org/ebooks/11.epub3.images');
    const buffer = await response.arrayBuffer();
    fs.writeFileSync(epubPath, Buffer.from(buffer));
  }

  return epubPath;
}
