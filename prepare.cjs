// prepare: creates @local/ symlinks at the profile's node_modules/@local/
// pointing to ../chrome-eye/plugins/<plugin>
const fs = require('fs');
const path = require('path');

// __dirname is the chrome-eye package directory (e.g., /profile/node_modules/chrome-eye/)
// The profile root is one level up from __dirname when using hoisted linker
// Actually, during pnpm prepare in a temp dir, __dirname = temp dir
// The profile root's node_modules/@local/ needs symlinks
// From @local/: symlink is ../chrome-eye/plugins/<plugin>

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

for (const plugin of plugins) {
  const link = path.join(localDir, plugin);
  // From @local/: ../chrome-eye/plugins/<plugin> resolves to node_modules/chrome-eye/plugins/<plugin>
  const target = path.join('..', 'chrome-eye', 'plugins', plugin);
  try { fs.unlinkSync(link); } catch (e) {}
  fs.symlinkSync(target, link, 'dir');
  console.log('  @local/' + plugin + ' -> ' + target);
}

console.log('chrome-eye: prepared', plugins.length, 'plugin(s)');
