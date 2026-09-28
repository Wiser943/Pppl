const fs = require("node:fs/promises");
const path = require("node:path");
const { MongoClient } = require("mongodb");

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    throw new Error(`${label} must be greater than zero`);
  return number;
}

function validateProduct(product, index) {
  const id = String(product.id || "").trim();
  const name = String(product.name || "").trim();
  if (!id || !name)
    throw new Error(`Product ${index + 1} must include id and name`);
  return {
    id,
    data: {
      ...product,
      name,
      price: positiveNumber(product.price, `${id}.price`),
      dailyIncome: positiveNumber(product.dailyIncome, `${id}.dailyIncome`),
      cycle: positiveNumber(product.cycle, `${id}.cycle`),
      locked: product.locked === true,
    },
  };
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("Set MONGODB_URI before running the seed command");

  const seedPath = path.resolve(process.argv[2] || "mongo-seed.json");
  const seed = JSON.parse(await fs.readFile(seedPath, "utf8"));
  if (!Array.isArray(seed.products) || seed.products.length === 0) {
    throw new Error(
      "Seed file needs at least one real product; add your approved catalog first",
    );
  }

  const products = seed.products.map(validateProduct);
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const database = client.db(process.env.MONGODB_DB_NAME || "viral_play");
    const productCollection = database.collection("products");
    for (const product of products) {
      await productCollection.updateOne(
        { _id: product.id },
        { $set: product.data },
        { upsert: true },
      );
    }

    const inputSettings = seed.adminSettings || {};
    const defaults = {
      globals: { welcomeBonus: Number(process.env.WELCOME_BONUS || 0) },
      rates: { level1: 0.25, level2: 0.02 },
      settings: {
        withdrawalEnabled: true,
        minimumWithdrawal: 1000,
        withdrawalFee: 0.15,
      },
    };
    for (const [id, values] of Object.entries(defaults)) {
      const supplied = inputSettings[id] || {};
      await database
        .collection("adminSettings")
        .updateOne(
          { _id: id },
          { $set: { ...values, ...supplied } },
          { upsert: true },
        );
    }

    await database
      .collection("adminSettings")
      .updateOne(
        { _id: "stats" },
        { $setOnInsert: { totalUsers: 0, allTimeWithdrawals: 0 } },
        { upsert: true },
      );

    await Promise.all([
      database
        .collection("users")
        .createIndex({ phone: 1 }, { unique: true, sparse: true }),
      database
        .collection("users")
        .createIndex({ referralId: 1 }, { unique: true, sparse: true }),
      database
        .collection("users")
        .createIndex({ email: 1 }, { unique: true, sparse: true }),
      database.collection("deposits").createIndex({ uid: 1, status: 1 }),
      database
        .collection("manualDeposits")
        .createIndex({ uid: 1, status: 1, timestamp: 1 }),
      database.collection("withdrawals").createIndex({ uid: 1, status: 1 }),
      database.collection("withdrawals").createIndex({ tradeNo: 1 }),
      database.collection("records").createIndex({ uid: 1, timestamp: -1 }),
    ]);

    console.log(
      `Seeded ${products.length} products and admin settings into ${database.databaseName}.`,
    );
    console.log(
      "Existing products not listed in the seed file were left untouched; no user records were created or changed.",
    );
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("Mongo seed failed:", error.message);
  process.exitCode = 1;
});
