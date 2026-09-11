const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const output = path.join(root, 'public');
fs.mkdirSync(output, { recursive: true });

fs.copyFileSync(path.join(root, 'index.html'), path.join(output, 'index.html'));
fs.copyFileSync(path.join(root, 'app.js'), path.join(output, 'client.js'));
fs.copyFileSync(path.join(root, 'styles.css'), path.join(output, 'styles.css'));

console.log(`Static frontend copied to ${path.relative(root, output)}/`);
