import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createNotNativeRoutes } from '../routes/notnative.ts';

describe('PWA manifest discovery', () => {
  it('links the web shell HTML to its manifest endpoint', async () => {
    const html = await readFile(new URL('../../../index.html', import.meta.url), 'utf8');
    expect(html).toMatch(/<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"\s*\/>/u);
  });

  it('serves an installable manifest with bounded query customizations', async () => {
    const response = await createNotNativeRoutes().request(
      '/manifest.webmanifest?appName=Review%20Desk&orientation=landscape-primary',
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/manifest+json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toMatchObject({
      name: 'Review Desk', short_name: 'Review Desk', orientation: 'landscape-primary', display: 'standalone',
    });
  });
});
