const { getMongoDatabase } = require("../mongodb");

exports.handler = async () => {
  const database = await getMongoDatabase();
  const result = await database.collection("deposits").deleteMany({
    status: "pending",
    expiresAt: { $lt: Date.now() },
  });

  return {
    statusCode: 200,
    body: `${result.deletedCount} expired deposits deleted`,
  };
};
