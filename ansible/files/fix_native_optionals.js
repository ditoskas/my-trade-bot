#!/usr/bin/env node
// Works around a real, confirmed npm bug (npm 10.9.8, this monorepo's
// workspace layout): even a fully clean `npm install` doesn't install
// several native-binary optionalDependencies that are correctly declared
// several levels deep in the tree (e.g. apps/ui -> @tailwindcss/postcss ->
// @tailwindcss/node -> lightningcss -> lightningcss-linux-x64-gnu).
// `npm ls <pkg>` confirms the dependency chain is entirely correct with
// nothing peer/optional in between; installing the missing platform
// package directly (outside the workspace-wide resolution) succeeds
// instantly, proving it's specifically npm's resolution of *transitive*
// optional platform binaries that's broken here, not the registry/network/
// npm version/package itself.
//
// Scans every installed package.json for optionalDependencies whose name
// ends in the current platform's suffix (e.g. "linux-x64-gnu"), then
// installs ALL of them together in a single `npm install` call --
// confirmed live that installing them incrementally across separate calls
// doesn't work: npm's dependency-tree pruning pass runs on every
// `npm install` regardless of what you're installing, and removes any of
// these platform packages that weren't arguments to *that specific* call
// (each call silently undoes the previous one's fix).
//
// Run from the repo root after `npm install`, before building anything
// that needs these (see ansible/playbook.yml).
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const platformSuffix = process.platform === 'linux' ? 'linux-x64-gnu' : null;
if (!platformSuffix) {
  console.log('Not linux-x64, nothing to do.');
  process.exit(0);
}

function walk(dir, found) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name.startsWith('@')) {
      walk(full, found);
      continue;
    }
    const pkgJsonPath = path.join(full, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
        const opt = pkg.optionalDependencies || {};
        for (const [name, version] of Object.entries(opt)) {
          if (name.endsWith(platformSuffix)) {
            found.set(name, version);
          }
        }
      } catch {
        // ignore unparsable package.json
      }
    }
    walk(path.join(full, 'node_modules'), found);
  }
}

const found = new Map();
walk('node_modules', found);
for (const workspaceRoot of ['apps', 'packages']) {
  if (!fs.existsSync(workspaceRoot)) continue;
  for (const entry of fs.readdirSync(workspaceRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      walk(path.join(workspaceRoot, entry.name, 'node_modules'), found);
    }
  }
}

console.log(`Found ${found.size} declared ${platformSuffix} optional package(s): ${[...found.keys()].join(', ')}`);

if (found.size > 0) {
  const args = [...found.entries()].map(([name, version]) => `${name}@${version}`);
  console.log(`Installing (all together, in one call): ${args.join(', ')}`);
  execSync('npm install --no-save ' + args.map((m) => JSON.stringify(m)).join(' '), { stdio: 'inherit' });
} else {
  console.log('No native optional packages declared for this platform.');
}
