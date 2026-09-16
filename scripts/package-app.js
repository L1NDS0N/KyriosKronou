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
const EXCLUDED_ROOT_DIRS = ['dist', 'build', 'tests', '.git', '.github', '.freebuff'];
const EXCLUDED_ROOT_FILES = ['logo.png', 'Build-Installer.ps1', 'package-lock.json'];

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
