const { getWecomConfig } = require('./wecomConfig');
const { createWecomPayloadCrypto } = require('./wecomPayloadCrypto');
const { createWecomPostgresStore } = require('./wecomPostgresStore');
const { createWecomJobProcessor } = require('./wecomJobProcessor');
const { createWecomApiClient } = require('./wecomApiClient');
const { createWecomWorker } = require('./wecomWorker');

function createWecomRuntime({ config = getWecomConfig(), dependencies = {} } = {}) {
  if (!config.enabled) {
    return Object.freeze({ config, store: null, worker: null, start() {}, async stop() {} });
  }
  const payloadCrypto = dependencies.payloadCrypto ||
    createWecomPayloadCrypto(config.payloadKeyBase64);
  const store = dependencies.store || createWecomPostgresStore({ payloadCrypto });
  const processor = dependencies.processor || createWecomJobProcessor({ config, store });
  const apiClient = dependencies.apiClient || createWecomApiClient({ config });
  const worker = dependencies.worker || createWecomWorker({ config, store, processor, apiClient });
  return Object.freeze({
    config, store, worker,
    start() { worker.start(); },
    async stop() { await worker.stop(); },
  });
}

module.exports = { createWecomRuntime };
