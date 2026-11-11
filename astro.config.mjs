// @ts-check
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';

// Workers the landing starts right away: their script is fetched with the
// page (and served from the HTTP cache to the worker) instead of being
// requested once the module that spawns them has run.
const PRELOADED_WORKERS = ['ditherScene.worker'];
// Marker Home.astro leaves at the end of the landing markup.
const LANDING_END = '<span id="landing-end" hidden></span>';

/**
 * Adds `<link rel="modulepreload">` to every prerendered page for its module
 * scripts, the chunks they import statically and the workers listed above.
 * The scripts sit at the very end of the document and their imports are only
 * known once they run, so without the hints each level costs a round trip.
 * The hints go right after the landing markup: early enough to download while
 * the rest of the HTML arrives, late enough not to compete with the part of
 * it the first paint needs.
 * @returns {import('astro').AstroIntegration}
 */
function preloadScripts() {
  return {
    name: 'preload-scripts',
    hooks: {
      'astro:build:done': async ({ dir }) => {
        const root = fileURLToPath(dir);
        const pages = (await readdir(root, { recursive: true })).filter((file) =>
          file.endsWith('.html')
        );
        /** @type {Map<string, Promise<string>>} */
        const sources = new Map();
        const read = (/** @type {string} */ url) => {
          if (!sources.has(url)) sources.set(url, readFile(`${root}${url}`, 'utf8').catch(() => ''));
          return /** @type {Promise<string>} */ (sources.get(url));
        };

        for (const page of pages) {
          const file = `${root}${page}`;
          const html = await readFile(file, 'utf8');
          if (!html.includes(LANDING_END)) continue;
          const entries = [...html.matchAll(/<script type="module" src="([^"]+)"/g)].map(
            (match) => match[1]
          );
          /** @type {Set<string>} */
          const modules = new Set();
          /** @type {Set<string>} */
          const workers = new Set();
          const visit = async (/** @type {string} */ url) => {
            if (modules.has(url)) return;
            modules.add(url);
            const code = await read(url);
            const base = url.slice(0, url.lastIndexOf('/') + 1);
            for (const [, name] of code.matchAll(/(?:from|import)\s*["']\.\/([\w.-]+\.js)["']/g)) {
              await visit(base + name);
            }
            for (const [, name] of code.matchAll(/([\w.-]+\.worker-[\w-]+\.js)/g)) {
              if (PRELOADED_WORKERS.some((worker) => name.startsWith(worker))) workers.add(base + name);
            }
          };
          for (const entry of entries) await visit(entry);

          const links = [...modules, ...workers]
            .map((url) => `<link rel="modulepreload" href="${url}">`)
            .join('');
          await writeFile(file, html.replace(LANDING_END, LANDING_END + links));
        }
      }
    }
  };
}

// https://astro.build/config
export default defineConfig({
  // Production URL — required for absolute canonical/hreflang/OG URLs and the
  // sitemap. Update this if the site is served from a different domain.
  site: 'https://subvid.app',
  output: 'server',
  devToolbar: {
    enabled: false
  },
  // The whole stylesheet is ~7 KB gzipped: inlining it removes the only
  // render-blocking request on first load.
  build: {
    inlineStylesheets: 'always'
  },
  // The Cloudflare adapter targets the Workers runtime for edge middleware,
  // while the public pages are emitted as prerendered static assets.
  adapter: cloudflare(),
  i18n: {
    locales: ['en', 'es'],
    defaultLocale: 'en',
    routing: {
      prefixDefaultLocale: false
    }
  },
  integrations: [
    preloadScripts(),
    sitemap({
      i18n: {
        defaultLocale: 'en',
        locales: { en: 'en', es: 'es' }
      }
    })
  ],
  vite: {
    plugins: [tailwindcss()],
    optimizeDeps: {
      exclude: ['mediabunny']
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    worker: {
      format: 'es'
    }
  }
});