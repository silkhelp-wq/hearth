'use strict';
/* Bundle the renderer (mediasoup-client + socket.io-client + app code)
 * into dist/renderer.js and copy static assets alongside it. */

const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const src = (f) => path.join(__dirname, 'src', f);
const dist = (f) => path.join(__dirname, 'dist', f);

fs.mkdirSync(dist(''), { recursive: true });

esbuild.buildSync({
  entryPoints: [src('app.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome130'],
  outfile: dist('renderer.js'),
  // Hardening: NO sourcemap (an inline map ships the entire original source
  // inside the bundle), minified identifiers/whitespace, no license banners.
  sourcemap: false,
  minify: true,
  legalComments: 'none',
  logLevel: 'info'
});

for (const f of ['index.html', 'styles.css']) {
  fs.copyFileSync(src(f), dist(f));
}

console.log('[build] dist/ ready');
