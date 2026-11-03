// postinstall: creates node_modules/@local/ symlinks for profiles that
// reference @local/ in their own cordis.patch.yml.
// When using relative paths in the bundle's cordis.patch.yml (./plugins/...),
// symlinks are optional — the bundle loads plugins directly.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localDir = path.join(__dirname, 'node_modules', '@local');
if (!fs.existsSync(localDir)) {
  fs.mkdirSync(localDir, { recursive: true });
}

const pluginsDir = path.join(__dirname, 'plugins');
const plugins = fs.readdirSync(pluginsDir).filter(f => {
  return fs.statSync(path.join(pluginsDir, f)).isDirectory();
});

for (const plugin of plugins) {
  const link = path.join(localDir, plugin);
  const target = path.join('..', 'plugins', plugin);
  try { fs.unlinkSync(link); } catch (e) {}
  fs.symlinkSync(target, link, 'dir');
  console.log('  @local/' + plugin + ' -> ' + target);
}

console.log('chrome-eye: prepared');
