const { Agent } = require('undici');

function createPinnedDispatcher(resolution) {
  let cursor = 0;
  const addresses = resolution.addresses;
  return new Agent({
    connect: {
      lookup(hostname, options, callback) {
        if (String(hostname).toLowerCase() !== resolution.hostname) {
          callback(new Error('Resolved hostname changed before connection'));
          return;
        }
        if (options?.all) {
          callback(null, addresses.map((item) => ({ ...item })));
          return;
        }
        const selected = addresses[cursor % addresses.length];
        cursor += 1;
        callback(null, selected.address, selected.family);
      }
    }
  });
}

module.exports = {
  createPinnedDispatcher
};
