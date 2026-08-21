'use strict';

let retrieveImplementation;

function loadRetrieveImplementation() {
  if (retrieveImplementation) {
    return retrieveImplementation;
  }

  try {
    const localKbModule = require('../../../local-kb-tool/src/query');

    if (typeof localKbModule.retrieve !== 'function') {
      throw new TypeError('local-kb-tool does not export a retrieve function');
    }

    retrieveImplementation = localKbModule.retrieve;
    return retrieveImplementation;
  } catch (cause) {
    const error = new Error('Local knowledge base is unavailable in this deployment');
    error.code = 'LOCAL_KB_UNAVAILABLE';
    error.cause = cause;
    throw error;
  }
}

function retrieve(...args) {
  return loadRetrieveImplementation()(...args);
}

module.exports = { retrieve };
