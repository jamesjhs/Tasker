'use strict';
// CJS-compatible uuid shim for Jest (which runs in CommonJS mode).
// In production (Node.js >= 22), require('uuid') works natively with
// uuid 14.x ESM via the synchronous require(esm) feature. This shim
// is only used by the test runner.
//
// Note: exceljs (the only consumer of uuid in this project) uses only v4.
// Other UUID variants are stubbed to throw, to surface any unexpected usage
// during tests rather than silently returning incorrect identifiers.
const crypto = require('crypto');

function v4() {
  return crypto.randomUUID();
}

function notImplemented(name) {
  return function () {
    throw new Error(`uuid.${name}() is not available in the Jest CJS shim. Only v4 is needed by this project.`);
  };
}

module.exports = { v1: notImplemented('v1'), v3: notImplemented('v3'), v4, v5: notImplemented('v5'), v6: notImplemented('v6'), v7: notImplemented('v7') };
