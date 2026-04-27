'use strict';
// CJS-compatible uuid shim for Jest (which runs in CommonJS mode).
// In production (Node.js >= 22), require('uuid') works natively with
// uuid 14.x ESM. This shim is only used by the test runner.
const crypto = require('crypto');

function v4() {
  return crypto.randomUUID();
}

module.exports = { v1: v4, v3: v4, v4, v5: v4, v6: v4, v7: v4 };
