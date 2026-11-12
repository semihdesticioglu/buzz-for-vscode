// Bundles the extension into dist/extension.js: one file, so the package stays small and activation is quick.
//   node esbuild.mjs            production build (minified)
//   node esbuild.mjs --dev      readable build with source maps (F5)
//   node esbuild.mjs --watch    the same, rebuilt on every change
import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  // vscode is provided by the host; the two are optional native add-ons of ws, which works without them
  external: ['vscode', 'bufferutil', 'utf-8-validate'],
  sourcemap: dev,
  minify: !dev,
  keepNames: true,
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
