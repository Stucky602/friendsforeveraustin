// Cloudflare Worker entry. Serves the PWA from assets, the API from src/app.js, and runs the cron.
import { createApp } from './app.js';
import { d1Repo, withPipeline } from './repo/d1.js';
import neighborhoods from '../config/neighborhoods.json';

export default {
  async fetch(request, env, ctx) {
    const repo = withPipeline(d1Repo(env.DB), env.DB);
    const app = createApp(repo, env, { neighborhoods, waitUntil: (p) => ctx.waitUntil(p) });
    const res = await app.handle(request);
    if (res) return res;
    const asset = await env.ASSETS.fetch(request);
    const type = asset.headers.get('content-type') || '';
    if (!type.includes('text/html')) return asset;
    // Always load the newest: the HTML shell is never cached, and it points at hashed asset names.
    const out = new Response(asset.body, asset);
    out.headers.set('cache-control', 'no-store, must-revalidate');
    out.headers.set('x-app-version', env.APP_VERSION || 'dev');
    return out;
  },
  async scheduled(event, env, ctx) {
    const repo = withPipeline(d1Repo(env.DB), env.DB);
    const app = createApp(repo, env, { neighborhoods });
    const { createRunner } = await import('./pipeline/run.js');
    const room = await repo.anyRoomRow?.();
    const runner = createRunner({ repo, roomId: room?.id ?? null, env, deps: { neighborhoods } });
    ctx.waitUntil((async () => {
      await app.completeDue();
      await runner.run('expire');
      if (room) { await runner.run('discover'); await runner.run('geocode'); await runner.run('classify'); await runner.run('score'); }
    })().catch(() => {}));
  },
};
