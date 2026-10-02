#!/usr/bin/env node
// package-app.js - Build the portable app with electron-packager.
//
// This exists instead of a command line because the packager's --ignore
// patterns are regexes, and pushing regexes through PowerShell -> cmd.exe
// mangles them: cmd treats "^" as its escape character and silently strips it,
// and it reads "|" as a pipe. An unanchored "/dist" then matches every dist/
// folder inside node_modules, which quietly guts dependencies (basic-ftp/dist,
// lucide/dist) and produces a build that crashes on startup.
//
// Calling the API directly means the patterns are real JavaScript, never
// reinterpreted by a shell.

const path = require('path');

const ROOT = path.join(__dirname, '..');

// Paths arrive relative to the project root. Normalise separators so one set
// of rules works regardless of platform.
// .cache is where the release workflow keeps the downloaded Electron, NSIS and
// winCodeSign toolchains - roughly 400 MB. It sits inside the workspace and
// nothing excludes it, so the packager copied it into app.asar and the NSIS
// installer shipped it: the installer went from 89 MB to 196 MB on the first
// run that had a warm cache, which is exactly when a cached build should be
// cheapest, not heaviest.
const EXCLUDED_ROOT_DIRS = ['dist', 'build', 'tests', '.git', '.github', '.freebuff', '.cache', '.claude'];
const EXCLUDED_ROOT_FILES = ['logo.png', 'Build-Installer.ps1', 'package-lock.json'];

// The renderer loads src/renderer/lucide.min.js with a plain <script> tag, and
// nothing in src/main or src/renderer does require('lucide'). The npm package
// is 20 MB of the same icons in three module formats, shipped three times over,
// and the app never reads it. Dropping the whole package is the single biggest
// win in the asar and costs nothing at runtime.
const EXCLUDED_PACKAGES = ['lucide'];

// Dead weight inside the dependencies that do ship. All of it is either source
// maps for a stack trace nobody can read from inside a packed app, or type
// declarations and TypeScript sources that no JavaScript runtime ever loads.
//
// The build artifacts are the other half. ssh2 and cpu-features ship a
// node-gyp build tree, and only the .node inside it is ever dlopen'd: the .pdb
// symbols, the .obj and .iobj link intermediates and the static .lib exist for
// whoever compiled the native module on the build machine, and they are 16 MB of
// the asar on their own.
const NODE_MODULE_NOISE = [
  /\.map$/,                                  // source maps
  /\.d\.ts$/,                                // type declarations
  /\.ts$/,                                   // TypeScript sources, .d.ts already matched
  /\.(pdb|obj|iobj|ilk|exp)$/i,              // native build artifacts
  /\.lib$/i,                                 // static libraries
  /(^|\/)(test|tests|spec|specs|__tests__|__mocks__|example|examples)\//,
  /\.(md|markdown)$/,
  /\/(LICEN[SC]E|NOTICE|COPYING)(\.[A-Za-z]+)?$/i,
  /(^|\/)docs?\//i,
];

// pngjs ships both a node build and a browserified one. Only the node entry is
// reachable from the app, and this is the one that matters: nothing in src/ ever
// required pngjs, so the whole dependency is a candidate for removal on its own.
const EXCLUDED_FILES = [
  // A second, CommonJS copy of every bundle. The app is ESM and never loads it.
  /^\/node_modules\/@azure\/msal-browser\/.*\.cjs$/,
];

// node_modules/<pkg>/ - matched whole, with everything below it.
const isExcludedPackage = (p) => {
  const m = /^\/node_modules\/((?:@[^/]+\/)?[^/]+)(\/|$)/.exec(p);
  return Boolean(m) && EXCLUDED_PACKAGES.includes(m[1]);
};

// Only inside node_modules: the project's own files are never touched, so a
// source file in src/ named something.ts keeps shipping if it ever needs to.
const isNodeModuleNoise = (p) => p.startsWith('/node_modules/')
  && NODE_MODULE_NOISE.some((rx) => rx.test(p));

function ignore(filePath) {
  if (!filePath) return false;
  const p = filePath.replace(/\\/g, '/');

  // Anchored at the project root only - never match a nested node_modules path.
  for (const dir of EXCLUDED_ROOT_DIRS) {
    if (p === `/${dir}` || p.startsWith(`/${dir}/`)) return true;
  }
  for (const file of EXCLUDED_ROOT_FILES) {
    if (p === `/${file}`) return true;
  }
  if (isExcludedPackage(p)) return true;
  if (EXCLUDED_FILES.some((rx) => rx.test(p))) return true;
  if (isNodeModuleNoise(p)) return true;
  return false;
}

async function main() {
  // Required lazily so tests can import the ignore rules without pulling in
  // the packager.
  const packager = require('electron-packager');
  const appPaths = await packager({
    dir: ROOT,
    name: 'KyriosChronos',
    platform: 'win32',
    arch: 'x64',
    out: path.join(ROOT, 'build'),
    overwrite: true,
    asar: true,
    icon: path.join(ROOT, 'build-resources', 'icon.ico'),
    ignore,
  });

  console.log(`Packaged to: ${appPaths.join(', ')}`);
}

// Only build when run directly; requiring this file just exposes the rules.
if (require.main === module) {
  main().catch((err) => {
    console.error('Packaging failed:', err);
    process.exit(1);
  });
}

module.exports = { ignore, main, EXCLUDED_ROOT_DIRS, EXCLUDED_ROOT_FILES };
