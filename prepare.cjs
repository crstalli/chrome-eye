// prepare: creates @local/ symlinks at the profile root's node_modules/@local/
// so that plugins can reference @local/chrome-eye-bridge, @local/chrome-eye-tools
const fs = require('fs');
const path = require('path');

// __dirname is the chrome-eye package's directory:
//   <profile>/node_modules/chrome-eye/
// Go up to profile root, then into node_modules/@local/
const profileNM = path.join(__dirname, '..', 'node_modules');
const localDir = path.join(profileNM, '@local');

if (!fs.existsSync(localDir)) {
  fs.mkdirSync(localDir, { recursive: true });
}

const pluginsDir = path.join(__dirname, 'plugins');
const plugins = fs.readdirSync(pluginsDir).filter(f => {
  const pp = path.join(pluginsDir, f);
  return fs.statSync(pp).isDirectory();
});

plugins.forEach(plugin => {
  const link = path.join(localDir, plugin);
  // Relative symlink from @local/ to ../chrome-eye/plugins/<plugin>
  const target = path.join('..', 'chrome-eye', 'plugins', plugin);
  try { fs.unlinkSync(link); } catch (e) {}
  fs.symlinkSync(target, link, 'dir');
  console.log('  @local/' + plugin + ' -> ' + target);
});

console.log('chrome-eye: prepared', plugins.length, 'plugin(s)');
