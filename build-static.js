const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const output = path.join(root, 'public');
fs.mkdirSync(output, { recursive: true });

for (const file of ['index.html', 'app.js', 'styles.css']) {
  fs.copyFileSync(path.join(root, file), path.join(output, file));
}

console.log(`Static frontend copied to ${path.relative(root, output)}/`);
