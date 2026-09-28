const { MongoClient } = require("mongodb");

let clientPromise;

async function getMongoClient() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is not configured");
  }

  if (!clientPromise) {
    const client = new MongoClient(process.env.MONGODB_URI);
    clientPromise = client.connect().catch((error) => {
      clientPromise = undefined;
      throw error;
    });
  }

  return clientPromise;
}

async function getMongoDatabase() {
  const client = await getMongoClient();
  return client.db(process.env.MONGODB_DB_NAME || "viral_play");
}

module.exports = { getMongoClient, getMongoDatabase };
