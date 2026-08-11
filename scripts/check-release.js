const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '').trim();
const failures = [];

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  failures.push(`package.json contains an invalid semantic version: ${JSON.stringify(version)}`);
}

for (const name of ['README.md', 'README.ru.md']) {
  const text = fs.readFileSync(path.join(root, name), 'utf8');
  const badge = text.match(/Version ([^\]]+)\]\(https:\/\/img\.shields\.io\/badge\/version-([^-\s)]+)/);
  if (!badge) {
    failures.push(`${name} has no recognizable version badge`);
    continue;
  }
  if (badge[1] !== version || badge[2] !== version) {
    failures.push(`${name} badge is ${badge[1]}/${badge[2]}, expected ${version}`);
  }
}

const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const firstRelease = changelog.match(/^## \[([^\]]+)\]/m)?.[1];
if (firstRelease !== version) {
  failures.push(`CHANGELOG.md starts with ${firstRelease || 'no release'}, expected ${version}`);
}

const mcpRoute = fs.readFileSync(path.join(root, 'src/app/api/mcp/route.ts'), 'utf8');
if (!/SERVER_INFO\s*=\s*\{[^}]*version:\s*pkg\.version/s.test(mcpRoute)) {
  failures.push('MCP server info must read its version from package.json');
}

if (failures.length) {
  failures.forEach(message => console.error(`release check: ${message}`));
  process.exitCode = 1;
} else {
  console.log(`Release metadata is synchronized at ${version}.`);
}
