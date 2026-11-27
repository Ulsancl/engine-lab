module.exports = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:",
  "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
  "frame-src 'none'", "worker-src 'none'",
].join('; ');
