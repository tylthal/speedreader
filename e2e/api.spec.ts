import { test, expect } from '@playwright/test';

test.describe('API', () => {
  test('health check', async ({ request }) => {
    const response = await request.get('/api/health');
    expect(response.ok()).toBeTruthy();
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('list publications', async ({ request }) => {
    const response = await request.get('/api/v1/publications/');
    expect(response.ok()).toBeTruthy();
    const data = await response.json();
    expect(Array.isArray(data)).toBeTruthy();
  });

  test('reject non-epub upload', async ({ request }) => {
    const response = await request.post('/api/v1/publications/upload', {
      multipart: {
        file: {
          name: 'test.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('not an epub'),
        },
      },
    });
    expect(response.status()).toBe(400);
  });

  test('get segments for existing publication', async ({ request }) => {
    const pubsResponse = await request.get('/api/v1/publications/');
    const pubs = await pubsResponse.json();

    if (pubs.length === 0) {
      test.skip();
      return;
    }

    // Get publication detail
    const detailResponse = await request.get(`/api/v1/publications/${pubs[0].id}`);
    expect(detailResponse.ok()).toBeTruthy();
    const detail = await detailResponse.json();

    if (detail.chapters.length === 0) {
      test.skip();
      return;
    }

    // Get segments
    const segResponse = await request.get(
      `/api/v1/publications/${pubs[0].id}/chapters/${detail.chapters[0].id}/segments?start=0&end=10`
    );
    expect(segResponse.ok()).toBeTruthy();
    const segments = await segResponse.json();
    expect(segments.segments.length).toBeGreaterThan(0);
    expect(segments.total_segments).toBeGreaterThan(0);
  });

  test('save and retrieve progress', async ({ request }) => {
    const pubsResponse = await request.get('/api/v1/publications/');
    const pubs = await pubsResponse.json();

    if (pubs.length === 0) {
      test.skip();
      return;
    }

    const pub = pubs[0];
    const detailResponse = await request.get(`/api/v1/publications/${pub.id}`);
    const detail = await detailResponse.json();

    if (detail.chapters.length === 0) {
      test.skip();
      return;
    }

    // Save progress
    const saveResponse = await request.put(`/api/v1/progress/publications/${pub.id}`, {
      data: {
        chapter_id: detail.chapters[0].id,
        segment_index: 5,
        wpm: 300,
      },
    });
    expect(saveResponse.ok()).toBeTruthy();

    // Retrieve progress
    const getResponse = await request.get(`/api/v1/progress/publications/${pub.id}`);
    expect(getResponse.ok()).toBeTruthy();
    const progress = await getResponse.json();
    expect(progress.segment_index).toBe(5);
    expect(progress.wpm).toBe(300);
  });
});
