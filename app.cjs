const fs = require('node:fs');
const path = require('node:path');

const staticRoot = path.join(__dirname, 'public');
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

module.exports = function handler(req, res) {
  const requestPath = (req.url || '/').split('?')[0];
  const relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const file = path.resolve(staticRoot, relative);

  if (!file.startsWith(`${staticRoot}${path.sep}`) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('Not found');
  }

  res.setHeader('Content-Type', contentTypes[path.extname(file)] || 'application/octet-stream');
  res.statusCode = 200;
  return res.end(fs.readFileSync(file));
};
