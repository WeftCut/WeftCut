const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const desktop = path.resolve(__dirname, '../../..');
const repository = path.resolve(desktop, '../..');
const output = path.resolve(process.env.WEFTCUT_MOTIF_BENCH_DIR || path.join(desktop, 'reports/motif-preview-bench'));

// Raw profiles and traces remain local. JSON exports replace known filesystem
// roots (including URL-encoded forms) and credential fields before writing.
function sanitize(value) {
  if (typeof value === 'string') {
    let result = value;
    for (const [root, label] of [[output, '<output>'], [repository, '<repo>'], [os.homedir(), '<home>']]) {
      for (const variant of new Set([root, root.replaceAll('\\', '/'), encodeURIComponent(root)])) {
        result = result.split(variant).join(label);
      }
    }
    return result.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer <redacted>');
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
      /authorization|password|secret|token|api[_-]?key/i.test(key) ? '<redacted>' : sanitize(entry)]));
  }
  return value;
}

function writeJson(name, value) {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, name), JSON.stringify(sanitize(value), null, 2) + '\n');
}

module.exports = { desktop, repository, output, sanitize, writeJson };
