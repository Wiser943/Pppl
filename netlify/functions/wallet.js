const crypto = require("node:crypto");
const { getMongoClient } = require("../mongodb");
const { getBearerToken, verifyToken } = require("../jwt");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function response(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

async function walletTransaction(client, uid, operation) {
  const database = client.db(process.env.MONGODB_DB_NAME || "viral_play");
  const users = database.collection("users");
  const records = database.collection("records");
  const session = client.startSession();
  let result;

  try {
    await session.withTransaction(async () => {
      const user = await users.findOne(
        { _id: uid, banned: { $ne: true } },
        { session },
      );
      if (!user)
        throw Object.assign(new Error("User not found"), { statusCode: 404 });
      result = await operation({ database, records, session, user, users });
    });
  } finally {
    await session.endSession();
  }
  return result;
}

async function claimDaily({ records, session, user, users }) {
  const today = new Date().toISOString().slice(0, 10);
  if (
    !(user.investments || []).some(
      (investment) => investment.status === "active",
    )
  ) {
    throw Object.assign(new Error("An active investment is required"), {
      statusCode: 409,
    });
  }
  if (user.lastDailyClaim === today) {
    throw Object.assign(new Error("Daily reward already claimed"), {
      statusCode: 409,
    });
  }
  await users.updateOne(
    { _id: user._id, lastDailyClaim: { $ne: today } },
    { $inc: { balance: 100, bonus: 100 }, $set: { lastDailyClaim: today } },
    { session },
  );
  await records.insertOne(
    {
      _id: crypto.randomUUID(),
      uid: user.uid,
      type: "Daily Login",
      amount: 100,
      status: "Claimed",
      timestamp: new Date(),
    },
    { session },
  );
  return { balance: Number(user.balance || 0) + 100 };
}

async function buyInvestment({
  database,
  records,
  session,
  user,
  users,
  body,
}) {
  const name = String(body.name || "");
  const price = Number(body.price);
  const daily = Number(body.daily);
  const cycle = Number(body.cycle);
  if (
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isFinite(daily) ||
    daily <= 0 ||
    !Number.isFinite(cycle) ||
    cycle <= 0
  ) {
    throw Object.assign(new Error("Invalid product selection"), {
      statusCode: 400,
    });
  }

  const product = await database.collection("products").findOne(
    {
      name,
      price,
      dailyIncome: daily,
      cycle,
      locked: { $ne: true },
    },
    { session },
  );
  if (!product)
    throw Object.assign(new Error("Product is unavailable"), {
      statusCode: 409,
    });
  if (Number(user.balance || 0) < price) {
    throw Object.assign(new Error("Insufficient balance"), { statusCode: 409 });
  }

  const purchaseTime = Date.now();
  const investment = {
    purchaseId: `INV-${purchaseTime}-${crypto.randomInt(1000)}`,
    name: product.name,
    price: Number(product.price),
    daily: Number(product.dailyIncome),
    days: Number(product.cycle),
    cycle: Number(product.cycle),
    purchaseTime,
    totalEarned: 0,
    status: "active",
    isSold: false,
    canClaim: false,
  };

  const debit = await users.updateOne(
    { _id: user._id, balance: { $gte: price } },
    { $inc: { balance: -price }, $push: { investments: investment } },
    { session },
  );
  if (debit.modifiedCount !== 1)
    throw Object.assign(new Error("Insufficient balance"), { statusCode: 409 });
  await records.insertOne(
    {
      _id: crypto.randomUUID(),
      uid: user.uid,
      type: "Investment",
      amount: price,
      status: "success",
      timestamp: new Date(),
      description: `Purchased ${product.name}`,
    },
    { session },
  );
  return { investment, balance: Number(user.balance) - price };
}

async function syncEarnings({ records, session, user, users }) {
  const now = Date.now();
  const investments = Array.isArray(user.investments) ? user.investments : [];
  const dueRecords = [];
  let profit = 0;

  for (let index = 0; index < investments.length; index += 1) {
    const investment = investments[index];
    const purchasedAt = investment.purchaseTime?.seconds
      ? investment.purchaseTime.seconds * 1000
      : Number(investment.purchaseTime);
    if (
      investment.status !== "active" ||
      !purchasedAt ||
      now - purchasedAt < MS_PER_DAY
    )
      continue;

    const amount = Number(investment.daily) || 0;
    profit += amount;
    investments[index] = {
      ...investment,
      purchaseTime: now,
      totalEarned: 0,
      isSold: false,
      isTrading: false,
    };
    dueRecords.push({
      _id: crypto.randomUUID(),
      uid: user.uid,
      type: "Auto Profit",
      amount,
      plan: investment.name || "Investment",
      description: `Auto-profit claimed from ${investment.name || "Investment"}`,
      timestamp: new Date(),
      dateString: new Date().toLocaleString(),
    });
  }

  if (dueRecords.length) {
    await users.updateOne(
      { _id: user._id },
      { $inc: { balance: profit }, $set: { investments } },
      { session },
    );
    await records.insertMany(dueRecords, { session });
  }
  return {
    investments,
    balance: Number(user.balance || 0) + profit,
    credited: profit,
  };
}

async function createWithdrawal({ database, session, user, users, body }) {
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw Object.assign(new Error("Enter a valid withdrawal amount"), {
      statusCode: 400,
    });
  }
  const settings =
    (await database
      .collection("adminSettings")
      .findOne({ _id: "settings" }, { session })) || {};
  const bank = user.bankAccount;
  if (!bank?.accountNumber || !bank?.bankName || !bank?.accountName) {
    throw Object.assign(new Error("Bank account required"), {
      statusCode: 409,
    });
  }
  if (
    !(user.investments || []).some(
      (investment) => investment.status === "active",
    )
  ) {
    throw Object.assign(new Error("An active investment is required"), {
      statusCode: 409,
    });
  }
  if (
    settings.withdrawalEnabled === false ||
    user.withdrawalLocked ||
    user.hasPendingWithdrawal
  ) {
    throw Object.assign(new Error("Withdrawal is currently unavailable"), {
      statusCode: 409,
    });
  }
  const minimum = Number(settings.minimumWithdrawal || 1000);
  if (amount < minimum)
    throw Object.assign(new Error(`Minimum withdrawal is ${minimum}`), {
      statusCode: 400,
    });
  if (amount > Number(user.balance || 0))
    throw Object.assign(new Error("Insufficient balance"), { statusCode: 409 });

  const feeRate = Number(settings.withdrawalFee ?? 0.15);
  const fee = amount * feeRate;
  const finalAmount = amount - fee;
  if (finalAmount < 510)
    throw Object.assign(new Error("Payout after fees must be at least 510"), {
      statusCode: 400,
    });

  const withdrawId = `W${Date.now()}-${crypto.randomInt(10000)}`;
  const debit = await users.updateOne(
    {
      _id: user._id,
      balance: { $gte: amount },
      hasPendingWithdrawal: { $ne: true },
    },
    { $inc: { balance: -amount }, $set: { hasPendingWithdrawal: true } },
    { session },
  );
  if (debit.modifiedCount !== 1)
    throw Object.assign(new Error("Withdrawal request could not be reserved"), {
      statusCode: 409,
    });

  await database.collection("withdrawals").insertOne(
    {
      _id: withdrawId,
      uid: user.uid,
      number: user.number || "N/A",
      role: user.role || "user",
      withdrawId,
      originalAmount: amount,
      fee,
      finalAmount,
      status: "pending",
      bankName: bank.bankName,
      bankCode: bank.bankCode,
      accountNumber: bank.accountNumber,
      accountName: bank.accountName,
      createdAt: new Date(),
      dateString: new Date().toLocaleString(),
    },
    { session },
  );
  return { withdrawId, balance: Number(user.balance) - amount };
}

async function claimReferralCommissions({
  database,
  records,
  session,
  user,
  users,
}) {
  const settings =
    (await database
      .collection("adminSettings")
      .findOne({ _id: "rates" }, { session })) || {};
  const claimed = Array.isArray(user.trackedInvestments)
    ? [...user.trackedInvestments]
    : [];
  const referrals = [
    ...(user.referrals?.level1 || []).map((referral) => ({
      ...referral,
      level: 1,
    })),
    ...(user.referrals?.level2 || []).map((referral) => ({
      ...referral,
      level: 2,
    })),
  ];
  const commissionRecords = [];
  let balanceIncrease = 0;

  for (const referral of referrals) {
    const referredUser = await users.findOne(
      { _id: String(referral.uid) },
      { session },
    );
    if (!referredUser || !Array.isArray(referredUser.investments)) continue;
    const rate = Number(
      referral.level === 1
        ? (settings.level1 ?? 0.25)
        : (settings.level2 ?? 0.02),
    );
    const investments = [...referredUser.investments].sort(
      (left, right) =>
        Number(left.purchaseTime || 0) - Number(right.purchaseTime || 0),
    );
    const uniqueId = `FIRST-PURCHASE-${referral.uid}`;
    if (claimed.includes(uniqueId)) continue;
    const firstInvestment = investments.find(
      (investment) => investment.purchaseTime && Number(investment.price) > 0,
    );
    if (!firstInvestment || rate <= 0) continue;

    const amount = Number(firstInvestment.price) * rate;
    if (amount <= 0) continue;
    claimed.push(uniqueId);
    balanceIncrease += amount;
    commissionRecords.push({
      _id: `${user.uid}:${uniqueId}`,
      uid: user.uid,
      type: "Commission",
      amount,
      level: referral.level,
      refUid: referral.uid,
      refNumber: referredUser.number || "User",
      status: "success",
      timestamp: new Date(),
      description: `Level ${referral.level} commission from ${referredUser.number || "referral"}`,
    });
  }

  if (balanceIncrease > 0) {
    await users.updateOne(
      { _id: user._id },
      {
        $inc: { balance: balanceIncrease, totalCommission: balanceIncrease },
        $set: { trackedInvestments: claimed },
      },
      { session },
    );
    await records.insertMany(commissionRecords, { session });
  }
  return { balanceIncrease, trackedInvestments: claimed };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS")
    return { statusCode: 204, headers: {}, body: "" };
  if (event.httpMethod !== "POST")
    return response(405, { error: "Method not allowed" });

  try {
    const claims = verifyToken(getBearerToken(event));
    if (claims.impersonated)
      return response(403, {
        error: "Wallet actions are disabled while impersonating",
      });
    const body = JSON.parse(event.body || "{}");
    const client = await getMongoClient();
    const result = await walletTransaction(client, claims.sub, (context) => {
      if (body.action === "dailyClaim") return claimDaily(context);
      if (body.action === "buyInvestment")
        return buyInvestment({ ...context, body });
      if (body.action === "syncEarnings") return syncEarnings(context);
      if (body.action === "createWithdrawal")
        return createWithdrawal({ ...context, body });
      if (body.action === "autoClaimCommissions")
        return claimReferralCommissions(context);
      throw Object.assign(new Error("Unknown wallet action"), {
        statusCode: 400,
      });
    });
    return response(200, { success: true, ...result });
  } catch (error) {
    console.error("Wallet action failed:", error);
    return response(error.statusCode || 500, {
      error: error.statusCode ? error.message : "Wallet operation failed",
    });
  }
};
