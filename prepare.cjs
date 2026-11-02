// prepare: creates @local/ symlinks and registers chrome-eye plugins
// as dependencies in the profile's package.json
const fs = require('fs');
const path = require('path');

const profileRoot = process.cwd();
const profilePkgPath = path.join(profileRoot, 'package.json');
const profileNM = path.join(profileRoot, 'node_modules');
const localDir = path.join(profileNM, '@local');

// Create @local/ directory
if (!fs.existsSync(localDir)) {
  fs.mkdirSync(localDir, { recursive: true });
}

// Register chrome-eye plugins in profile's package.json dependencies
let pkgData;
try {
  pkgData = JSON.parse(fs.readFileSync(profilePkgPath, 'utf-8'));
} catch (e) {
  pkgData = { name: 'dsh-profile', dependencies: {} };
}

const pluginsDir = path.join(__dirname, 'plugins');
const plugins = fs.readdirSync(pluginsDir).filter(f => {
  const pp = path.join(pluginsDir, f);
  return fs.statSync(pp).isDirectory();
});

// Add dependencies if not present
if (!pkgData.dependencies) pkgData.dependencies = {};
for (const plugin of plugins) {
  const depName = '@local/' + plugin;
  if (!pkgData.dependencies[depName]) {
    pkgData.dependencies[depName] = 'link:./node_modules/chrome-eye/plugins/' + plugin;
  }
}
fs.writeFileSync(profilePkgPath, JSON.stringify(pkgData, null, 2) + '\n');
console.log('chrome-eye: added dependencies to package.json');

// Create @local/ symlinks
for (const plugin of plugins) {
  const link = path.join(localDir, plugin);
  // Relative symlink from @local/ to ../chrome-eye/plugins/<plugin>
  const target = path.join('..', 'chrome-eye', 'plugins', plugin);
  try { fs.unlinkSync(link); } catch (e) {}
  fs.symlinkSync(target, link, 'dir');
  console.log('  @local/' + plugin + ' -> ' + target);
}

console.log('chrome-eye: prepared', plugins.length, 'plugin(s)');
