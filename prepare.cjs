// prepare: creates @local/ symlinks into the profile's node_modules/@local/
const fs = require('fs');
const path = require('path');

const repoRoot = __dirname;
const profileNM = path.join(repoRoot, '..');
const localDir = path.join(profileNM, '@local');

if (!fs.existsSync(localDir)) {
  fs.mkdirSync(localDir, { recursive: true });
}

const pluginsDir = path.join(repoRoot, 'plugins');
const plugins = fs.readdirSync(pluginsDir).filter(f => {
  const pp = path.join(pluginsDir, f);
  return fs.statSync(pp).isDirectory();
});

plugins.forEach(plugin => {
  const link = path.join(localDir, plugin);
  const target = path.join(pluginsDir, plugin);
  try { fs.unlinkSync(link); } catch (e) {}
  fs.symlinkSync(target, link, 'dir');
  console.log('  @local/' + plugin + ' -> ' + target);
});

console.log('chrome-eye: prepared', plugins.length, 'plugin(s)');
