// postinstall: creates @local/ symlinks at the package's node_modules/@local/
// pointing to ../plugins/<plugin>
// When hoisted by pnpm, these resolve correctly from node_modules/@local/
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginsDir = path.join(__dirname, 'plugins');
const localDir = path.join(__dirname, 'node_modules', '@local');

if (!fs.existsSync(localDir)) {
  fs.mkdirSync(localDir, { recursive: true });
}

const plugins = fs.readdirSync(pluginsDir).filter(f => {
  const pp = path.join(pluginsDir, f);
  return fs.statSync(pp).isDirectory();
});

for (const plugin of plugins) {
  const link = path.join(localDir, plugin);
  const target = path.join('..', 'plugins', plugin);
  try { fs.unlinkSync(link); } catch (e) {}
  fs.symlinkSync(target, link, 'dir');
  console.log('  @local/' + plugin + ' -> ' + target);
}

console.log('chrome-eye: prepared', plugins.length, 'plugin(s)');
