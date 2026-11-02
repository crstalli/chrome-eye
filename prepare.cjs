// prepare: creates @local/ directory so pnpm overrides can resolve symlinks
const fs = require('fs');
const path = require('path');

// Create @local/ inside the installed repo's node_modules
// pnpm overrides in the profile's pnpm-workspace.yaml will create symlinks
// at profile/node_modules/@local/<plugin> -> ../chrome-eye/plugins/<plugin>
const localDir = path.join(__dirname, 'node_modules', '@local');
if (!fs.existsSync(localDir)) {
  fs.mkdirSync(localDir, { recursive: true });
}

// Also create a self-referencing symlink so the repo's own node_modules/@local/ works
const pluginsDir = path.join(__dirname, 'plugins');
const plugins = fs.readdirSync(pluginsDir).filter(f => {
  const pp = path.join(pluginsDir, f);
  return fs.statSync(pp).isDirectory();
});

plugins.forEach(plugin => {
  const link = path.join(localDir, plugin);
  const target = path.join('..', 'plugins', plugin);
  try { fs.unlinkSync(link); } catch (e) {}
  fs.symlinkSync(target, link, 'dir');
  console.log('  @local/' + plugin + ' -> ' + target);
});

console.log('chrome-eye: prepared', plugins.length, 'plugin(s)');
