'use strict';

const { MongoMemoryServer } = require('mongodb-memory-server');

module.exports = async function() {
  const mongod = await MongoMemoryServer.create();
  process.env.MONGO_TEST_URI = mongod.getUri();
  // Store the instance globally so teardown can stop it
  global.__MONGOD__ = mongod;
};
