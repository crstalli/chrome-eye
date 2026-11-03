// prepare: creates node_modules/@local/ so the package's own cordis patch
// can reference ./plugins/... without relying on @local/ symlinks.
// During git install pnpm runs this in the temp dir.
const fs = require('fs');
const path = require('path');

const localDir = path.join(__dirname, 'node_modules', '@local');
if (!fs.existsSync(localDir)) {
  fs.mkdirSync(localDir, { recursive: true });
  console.log('  created node_modules/@local/');
}

const plugins = ['chrome-eye-bridge', 'chrome-eye-tools'];
const pluginsDir = path.join(__dirname, 'plugins');

for (const plugin of plugins) {
  const link = path.join(localDir, plugin);
  const target = path.join('..', 'plugins', plugin);
  if (fs.existsSync(path.join(__dirname, 'plugins', plugin))) {
    try { fs.unlinkSync(link); } catch (e) {}
    fs.symlinkSync(target, link, 'dir');
    console.log('  @local/' + plugin + ' -> ' + target);
  }
}

console.log('chrome-eye: prepared');
