const crypto = require("node:crypto");
const { getMongoDatabase } = require("../mongodb");
const { getBearerToken, verifyToken } = require("../jwt");

const ADMIN_SETTINGS = new Set(["globals", "rates", "settings", "stats"]);
const PRIVATE_USER_FIELDS = new Set([
  "balance",
  "bonus",
  "investments",
  "referrals",
  "trackedInvestments",
  "totalCommission",
  "availableCommissionLevel1",
  "availableCommissionLevel2",
  "paidCommissions",
  "lastDailyClaim",
  "hasPendingWithdrawal",
  "withdrawalLocked",
]);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(statusCode, value) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", ...corsHeaders },
    body: JSON.stringify(value),
  };
}

function queryFromFilters(filters = []) {
  const query = {};
  const operations = {
    "==": "$eq",
    "!=": "$ne",
    ">": "$gt",
    ">=": "$gte",
    "<": "$lt",
    "<=": "$lte",
    in: "$in",
    "array-contains": "$in",
  };
  for (const [field, operator, value] of filters) {
    if (!operations[operator])
      throw Object.assign(new Error("Unsupported query operator"), {
        statusCode: 400,
      });
    const mongoOperator = operations[operator];
    if (operator === "==") query[field] = value;
    else
      query[field] = {
        ...(query[field] || {}),
        [mongoOperator]: operator === "array-contains" ? [value] : value,
      };
  }
  return query;
}

function serializeDocument(document) {
  if (!document) return null;
  const { _id, passwordHash, googleSub, ...data } = document;
  return { id: String(_id), data };
}

function safeReferralProfile(user) {
  return {
    uid: user.uid,
    number: user.number,
    email: user.email,
    referralId: user.referralId,
    referrerId: user.referrerId,
    investments: (user.investments || []).map(
      ({ status, price, purchaseTime }) => ({ status, price, purchaseTime }),
    ),
  };
}

async function isReferral(database, ownerUid, targetUid) {
  const owner = await database.collection("users").findOne({ _id: ownerUid });
  const referrals = [
    ...(owner?.referrals?.level1 || []),
    ...(owner?.referrals?.level2 || []),
  ];
  return referrals.some(
    (referral) => String(referral.uid) === String(targetUid),
  );
}

async function readDocument(database, claims, path) {
  const [collectionName, id, subcollection, subId] = path;
  if (collectionName === "users") {
    if (subcollection) {
      if (
        String(id) !== claims.sub ||
        !["records", "commissions"].includes(subcollection)
      )
        return null;
      const filter = { _id: subId, uid: claims.sub };
      if (subcollection === "commissions")
        filter.type = { $in: ["Commission", "Referral Commission"] };
      return serializeDocument(
        await database.collection("records").findOne(filter),
      );
    }
    const user = await database.collection("users").findOne({ _id: id });
    if (!user) return null;
    if (String(id) === claims.sub) return serializeDocument(user);
    if (await isReferral(database, claims.sub, id))
      return { id: String(id), data: safeReferralProfile(user) };
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  }
  if (collectionName === "adminSettings") {
    if (!ADMIN_SETTINGS.has(id)) return null;
    return serializeDocument(
      await database.collection(collectionName).findOne({ _id: id }),
    );
  }
  if (
    ![
      "products",
      "deposits",
      "manualDeposits",
      "withdrawals",
      "records",
    ].includes(collectionName)
  ) {
    throw Object.assign(new Error("Collection is not available"), {
      statusCode: 403,
    });
  }
  const document = await database
    .collection(collectionName)
    .findOne({ _id: id });
  if (!document) return null;
  if (
    collectionName !== "products" &&
    String(document.uid || document.userId) !== claims.sub
  ) {
    throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
  }
  return serializeDocument(document);
}

async function readCollection(database, claims, path, body) {
  const [collectionName, ownerUid, subcollection] = path;
  let query = queryFromFilters(body.filters);
  let targetCollection = collectionName;
  if (
    collectionName === "users" &&
    ["records", "commissions"].includes(subcollection)
  ) {
    if (String(ownerUid) !== claims.sub)
      throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    targetCollection = "records";
    query.uid = claims.sub;
    if (subcollection === "commissions")
      query.type = { $in: ["Commission", "Referral Commission"] };
  } else if (collectionName === "users") {
    const referralFilter = (body.filters || []).find(
      ([field, operator]) => field === "referralId" && operator === "==",
    );
    if (!referralFilter)
      throw Object.assign(new Error("User query is restricted"), {
        statusCode: 403,
      });
    query = { referralId: referralFilter[2] };
  } else if (collectionName === "adminSettings") {
    if (!ADMIN_SETTINGS.has(String(query._id || "")))
      throw Object.assign(
        new Error("Admin settings queries must target an approved document"),
        { statusCode: 403 },
      );
  } else if (collectionName === "deposits") {
    if (query.uid && String(query.uid) !== claims.sub)
      throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    delete query.uid;
    query.$or = [{ uid: claims.sub }, { userId: claims.sub }];
  } else if (
    collectionName === "manualDeposits" ||
    collectionName === "withdrawals" ||
    collectionName === "records"
  ) {
    if (query.uid && String(query.uid) !== claims.sub)
      throw Object.assign(new Error("Forbidden"), { statusCode: 403 });
    query.uid = claims.sub;
  } else if (collectionName !== "products") {
    throw Object.assign(new Error("Collection is not available"), {
      statusCode: 403,
    });
  }

  const sort = {};
  for (const [field, direction] of body.orders || [])
    sort[field] = direction === "desc" ? -1 : 1;
  let cursor = database.collection(targetCollection).find(query);
  if (Object.keys(sort).length) cursor = cursor.sort(sort);
  if (Number.isInteger(body.maxResults) && body.maxResults > 0)
    cursor = cursor.limit(Math.min(body.maxResults, 500));
  const documents = await cursor.toArray();
  return documents.map((document) => {
    if (collectionName === "users" && String(document._id) !== claims.sub) {
      return { id: String(document._id), data: safeReferralProfile(document) };
    }
    return serializeDocument(document);
  });
}

async function createManualDeposit(database, claims, path, body) {
  if (path[0] !== "manualDeposits" || path.length !== 1) {
    throw Object.assign(
      new Error("Writes are not allowed for this collection"),
      { statusCode: 403 },
    );
  }
  const data = body.data || {};
  const amount = Number(data.amount);
  const payerName = String(data.payerName || "").trim();
  const payerAccount = String(data.payerAccount || "").trim();
  if (!Number.isFinite(amount) || amount <= 0 || !payerName || !payerAccount) {
    throw Object.assign(new Error("Invalid deposit details"), {
      statusCode: 400,
    });
  }
  const deposits = database.collection("manualDeposits");
  const successful = await deposits
    .find({ uid: claims.sub, status: "success" })
    .sort({ timestamp: 1 })
    .limit(1)
    .next();
  const firstDeposit = !successful;
  const isRematch = Boolean(successful && Number(successful.amount) === amount);
  const user = await database.collection("users").findOne({ _id: claims.sub });
  const document = {
    _id: crypto.randomUUID(),
    uid: claims.sub,
    userEmail: user?.email || "N/A",
    userPhone: user?.number || "N/A",
    amount,
    payerName,
    payerAccount,
    referenceNote: String(data.referenceNote || "N/A"),
    status: "pending",
    method: "Manual Bank Transfer",
    timestamp: new Date(),
    dateString: new Date().toLocaleString(),
    isFirstDeposit: firstDeposit,
    isRematchDeposit: isRematch,
    bonusAmount: 0,
    bonusApplied: false,
  };
  await deposits.insertOne(document);
  return { id: document._id, data: serializeDocument(document).data };
}

const ADMIN_COLLECTIONS = new Set([
  "users",
  "products",
  "manualDeposits",
  "withdrawals",
  "records",
  "adminSettings",
  "bonusRecords",
  "offerCodes",
  "admins",
]);

function adminUpdate(data) {
  const $set = {};
  const $inc = {};
  Object.entries(data || {}).forEach(([key, value]) => {
    if (value && value.__op === "increment")
      $inc[key] = Number(value.value || 0);
    else $set[key] = value;
  });
  const update = {};
  if (Object.keys($set).length) update.$set = $set;
  if (Object.keys($inc).length) update.$inc = $inc;
  return update;
}

async function adminDataOperation(database, body, claims) {
  const path = body.path.map(String);
  const collectionName = path[0];
  if (!ADMIN_COLLECTIONS.has(collectionName) || path.length > 2)
    throw Object.assign(new Error("Admin collection is not available"), {
      statusCode: 403,
    });
  if (
    collectionName === "admins" &&
    body.operation === "getDoc" &&
    path[1] === claims.sub
  )
    return {
      id: path[1],
      data: { uid: claims.sub, email: claims.email, admin: true },
    };

  const target = database.collection(collectionName);
  const id = path[1];
  if (body.operation === "getDoc")
    return serializeDocument(await target.findOne({ _id: id }));
  if (body.operation === "getDocs") {
    const cursor = target.find(queryFromFilters(body.filters));
    const sort = {};
    for (const [field, direction] of body.orders || [])
      sort[field] = direction === "desc" ? -1 : 1;
    if (Object.keys(sort).length) cursor.sort(sort);
    if (Number.isInteger(body.maxResults) && body.maxResults > 0)
      cursor.limit(Math.min(body.maxResults, 500));
    return (await cursor.toArray()).map(serializeDocument);
  }
  if (body.operation === "deleteDoc") {
    await target.deleteOne({ _id: id });
    return { success: true };
  }
  if (body.operation === "addDoc") {
    const document = { ...(body.data || {}), _id: crypto.randomUUID() };
    await target.insertOne(document);
    return { id: document._id, data: serializeDocument(document).data };
  }
  if (body.operation === "updateDoc" || body.operation === "setDoc") {
    await target.updateOne({ _id: id }, adminUpdate(body.data), {
      upsert: body.operation === "setDoc",
    });
    return { success: true };
  }
  throw Object.assign(new Error("Unknown data operation"), { statusCode: 400 });
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS")
    return { statusCode: 204, headers: corsHeaders, body: "" };
  if (event.httpMethod !== "POST")
    return reply(405, { error: "Method not allowed" });

  try {
    const body = JSON.parse(event.body || "{}");
    const path = Array.isArray(body.path) ? body.path.map(String) : [];
    if (!path.length || path.length > 4)
      return reply(400, { error: "Invalid document path" });
    const publicProductRead =
      path[0] === "products" && ["getDoc", "getDocs"].includes(body.operation);
    const claims = publicProductRead
      ? { sub: null, admin: false, impersonated: false }
      : verifyToken(getBearerToken(event));
    if (
      claims.impersonated &&
      !["getDoc", "getDocs"].includes(body.operation)
    ) {
      return reply(403, { error: "Writes are disabled while impersonating" });
    }
    const database = await getMongoDatabase();

    if (claims.admin)
      return reply(200, await adminDataOperation(database, body, claims));

    if (body.operation === "getDoc") {
      return reply(200, await readDocument(database, claims, path));
    }
    if (body.operation === "getDocs") {
      return reply(200, await readCollection(database, claims, path, body));
    }
    if (body.operation === "addDoc") {
      return reply(
        201,
        await createManualDeposit(database, claims, path, body),
      );
    }
    if (body.operation === "updateDoc" || body.operation === "setDoc") {
      const [collectionName, id] = path;
      if (
        collectionName === "users" &&
        String(id) === claims.sub &&
        path.length === 2
      ) {
        const update = body.data || {};
        const keys = Object.keys(update);
        if (
          !keys.length ||
          keys.some(
            (key) => PRIVATE_USER_FIELDS.has(key) || key !== "bankAccount",
          )
        ) {
          return reply(403, { error: "Only bank profile updates are allowed" });
        }
        const bank = update.bankAccount;
        if (
          !bank ||
          !/^\d{10}$/.test(String(bank.accountNumber || "")) ||
          !bank.bankName ||
          !bank.accountName
        ) {
          return reply(400, { error: "Invalid bank account details" });
        }
        const saved = await database
          .collection("users")
          .updateOne(
            { _id: claims.sub, bankAccount: { $exists: false } },
            { $set: { bankAccount: bank } },
          );
        if (saved.matchedCount !== 1)
          return reply(409, { error: "A bank account is already linked" });
        return reply(200, { success: true });
      }
      if (
        collectionName === "adminSettings" &&
        claims.admin &&
        path.length === 2 &&
        ADMIN_SETTINGS.has(id)
      ) {
        await database
          .collection("adminSettings")
          .updateOne({ _id: id }, { $set: body.data || {} }, { upsert: true });
        return reply(200, { success: true });
      }
      return reply(403, { error: "Writes are not allowed for this document" });
    }
    return reply(400, { error: "Unknown data operation" });
  } catch (error) {
    console.error("Mongo data request failed:", error);
    return reply(
      error.statusCode || (error.message === "Unauthorized" ? 401 : 500),
      {
        error: error.statusCode ? error.message : "Data request failed",
      },
    );
  }
};
