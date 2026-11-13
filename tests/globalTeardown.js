'use strict';

module.exports = async function() {
  if (global.__MONGOD__) {
    await global.__MONGOD__.stop();
  }
};
