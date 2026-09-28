const crypto = require("node:crypto");
const { getMongoDatabase } = require("../mongodb");
const { getBearerToken, signToken, verifyToken } = require("../jwt");

const jsonHeaders = { "Content-Type": "application/json" };

function getHeaders(event) {
  const origin = event.headers?.origin || event.headers?.Origin;
  const allowedOrigins = [
    process.env.SITE_ORIGIN,
    process.env.ADMIN_ORIGIN,
    "https://viral-admin-updated.vercel.app",
    "http://localhost:5500",
    "http://localhost:5501",
  ].filter(Boolean);
  const headers = {
    ...jsonHeaders,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (origin && allowedOrigins.includes(origin))
    headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function response(statusCode, body, headers) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function safeUser(user) {
  const { passwordHash, googleSub, ...publicData } = user;
  return publicData;
}

function isAdminEmail(email) {
  const allowlist = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return allowlist.includes(String(email || "").toLowerCase());
}

function makeReferralId() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) return reject(error);
      resolve(`${salt}:${derivedKey.toString("hex")}`);
    });
  });
}

async function verifyPassword(password, storedHash) {
  if (typeof storedHash !== "string" || !storedHash.includes(":")) return false;
  const [salt, hash] = storedHash.split(":");
  const actual = Buffer.from(
    await hashPassword(password, salt).then((value) => value.split(":")[1]),
    "hex",
  );
  const expected = Buffer.from(hash, "hex");
  return (
    actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected)
  );
}

function issueSession(user, impersonated = false) {
  return signToken(
    {
      sub: String(user._id),
      email: user.email || null,
      admin: user.admin === true || isAdminEmail(user.email),
      impersonated,
    },
    impersonated ? 15 * 60 : 7 * 24 * 60 * 60,
  );
}

async function requireUser(event, users) {
  const claims = verifyToken(getBearerToken(event));
  if (claims.admin === true) {
    return {
      claims,
      user: {
        _id: claims.sub,
        uid: claims.sub,
        email: claims.email,
        admin: true,
        banned: false,
      },
    };
  }
  const user = await users.findOne({ _id: claims.sub });
  if (!user || user.banned) throw new Error("Unauthorized");
  return { claims, user };
}

async function register(database, body) {
  const number = String(body.number || "").replace(/\D/g, "");
  const password = String(body.password || "");
  if (number.length < 7 || number.length > 15)
    throw Object.assign(new Error("Enter a valid phone number"), {
      statusCode: 400,
    });
  if (password.length < 8)
    throw Object.assign(new Error("Password must be at least 8 characters"), {
      statusCode: 400,
    });

  const users = database.collection("users");
  await users.createIndex({ phone: 1 }, { unique: true, sparse: true });
  const referralCode = String(body.referral || "").trim();
  const referrer = referralCode
    ? await users.findOne({ referralId: referralCode })
    : null;
  const grandReferrer = referrer?.referrerId
    ? await users.findOne({ _id: String(referrer.referrerId) })
    : null;
  const globals = await database
    .collection("adminSettings")
    .findOne({ _id: "globals" });
  const bonus = Number(process.env.WELCOME_BONUS ?? globals?.welcomeBonus ?? 0);
  const uid = crypto.randomUUID();
  const now = new Date();
  const user = {
    _id: uid,
    uid,
    phone: number,
    number,
    passwordHash: await hashPassword(password),
    referral: referralCode,
    referralId: makeReferralId(),
    referrerId: referrer?._id || "",
    balance: bonus,
    bonus,
    createdAt: now,
    banned: false,
    referrals: { level1: [], level2: [] },
    trackedInvestments: [],
    totalCommission: 0,
    availableCommissionLevel1: 0,
    availableCommissionLevel2: 0,
  };

  const client = await require("../mongodb").getMongoClient();
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      await users.insertOne(user, { session });
      await database
        .collection("adminSettings")
        .updateOne(
          { _id: "stats" },
          { $inc: { totalUsers: 1 } },
          { upsert: true, session },
        );
      if (referrer) {
        await users.updateOne(
          { _id: referrer._id },
          {
            $addToSet: { "referrals.level1": { uid, number, createdAt: now } },
          },
          { session },
        );
      }
      if (grandReferrer) {
        await users.updateOne(
          { _id: grandReferrer._id },
          {
            $addToSet: { "referrals.level2": { uid, number, createdAt: now } },
          },
          { session },
        );
      }
    });
  } finally {
    await session.endSession();
  }
  return user;
}

async function googleUser(database, credential) {
  if (!process.env.GOOGLE_CLIENT_ID)
    throw Object.assign(new Error("Google sign-in is not configured"), {
      statusCode: 503,
    });
  const tokenResponse = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(credential)}`,
  );
  if (!tokenResponse.ok)
    throw Object.assign(new Error("Invalid Google credential"), {
      statusCode: 401,
    });
  const tokenInfo = await tokenResponse.json();
  if (
    tokenInfo.aud !== process.env.GOOGLE_CLIENT_ID ||
    !String(tokenInfo.scope || "").includes("openid")
  ) {
    throw Object.assign(new Error("Google account could not be verified"), {
      statusCode: 401,
    });
  }
  const profileResponse = await fetch(
    "https://openidconnect.googleapis.com/v1/userinfo",
    {
      headers: { Authorization: `Bearer ${credential}` },
    },
  );
  if (!profileResponse.ok)
    throw Object.assign(new Error("Google account could not be verified"), {
      statusCode: 401,
    });
  const claims = await profileResponse.json();
  if (claims.email_verified !== true)
    throw Object.assign(new Error("Google account could not be verified"), {
      statusCode: 401,
    });

  const users = database.collection("users");
  let user = await users.findOne({ googleSub: claims.sub });
  if (!user && claims.email)
    user = await users.findOne({ email: claims.email.toLowerCase() });
  if (user) {
    if (!user.googleSub)
      await users.updateOne(
        { _id: user._id },
        { $set: { googleSub: claims.sub } },
      );
    return { ...user, googleSub: claims.sub };
  }

  const uid = crypto.randomUUID();
  user = {
    _id: uid,
    uid,
    googleSub: claims.sub,
    email: String(claims.email).toLowerCase(),
    displayName: claims.name || claims.email.split("@")[0],
    number: "Google User",
    referral: "",
    referralId: makeReferralId(),
    balance: 0,
    bonus: 0,
    createdAt: new Date(),
    banned: false,
    referrals: { level1: [], level2: [] },
    trackedInvestments: [],
    totalCommission: 0,
    availableCommissionLevel1: 0,
    availableCommissionLevel2: 0,
  };
  await users.insertOne(user);
  await database
    .collection("adminSettings")
    .updateOne({ _id: "stats" }, { $inc: { totalUsers: 1 } }, { upsert: true });
  return user;
}

exports.handler = async (event) => {
  const headers = getHeaders(event);
  if (event.httpMethod === "OPTIONS")
    return { statusCode: 204, headers, body: "" };
  if (event.httpMethod !== "POST")
    return response(405, { error: "Method not allowed" }, headers);

  try {
    const body = JSON.parse(event.body || "{}");
    if (body.action === "googleConfig") {
      if (!process.env.GOOGLE_CLIENT_ID)
        return response(
          503,
          { error: "Google sign-in is not configured" },
          headers,
        );
      return response(200, { clientId: process.env.GOOGLE_CLIENT_ID }, headers);
    }
    if (body.action === "adminLogin") {
      const adminEmail = String(process.env.ADMIN_EMAIL || "")
        .trim()
        .toLowerCase();
      const adminPassword = String(process.env.ADMIN_PASSWORD || "")
        .trim()
        .replace(/^(["'])(.*)\1$/, "$2");
      if (!adminEmail || !adminPassword)
        return response(
          503,
          {
            error:
              "ADMIN_EMAIL and ADMIN_PASSWORD are missing on the user-site deployment",
          },
          headers,
        );
      const email = String(body.email || "")
        .trim()
        .toLowerCase();
      const passwordHash = crypto
        .createHash("sha256")
        .update(String(body.password || "").trim())
        .digest();
      const expectedHash = crypto
        .createHash("sha256")
        .update(adminPassword)
        .digest();
      const valid =
        Boolean(adminEmail && adminPassword) &&
        email === adminEmail &&
        crypto.timingSafeEqual(passwordHash, expectedHash);
      if (!valid)
        return response(401, { error: "Invalid admin credentials" }, headers);
      const admin = {
        _id: `admin:${adminEmail}`,
        uid: `admin:${adminEmail}`,
        email: adminEmail,
        admin: true,
      };
      return response(
        200,
        { token: issueSession(admin), user: safeUser(admin) },
        headers,
      );
    }
    const database = await getMongoDatabase();
    const users = database.collection("users");

    if (body.action === "register") {
      const user = await register(database, body);
      return response(
        201,
        { token: issueSession(user), user: safeUser(user) },
        headers,
      );
    }

    if (body.action === "login") {
      const number = String(body.number || "").replace(/\D/g, "");
      const user = await users.findOne({ phone: number });
      const passwordValid = await verifyPassword(
        String(body.password || ""),
        user?.passwordHash,
      );
      if (!user || !passwordValid)
        return response(
          401,
          { error: "Invalid mobile number or password" },
          headers,
        );
      if (user.banned)
        return response(
          403,
          { error: "This account has been suspended" },
          headers,
        );
      return response(
        200,
        { token: issueSession(user), user: safeUser(user) },
        headers,
      );
    }

    if (body.action === "google") {
      const user = await googleUser(database, String(body.credential || ""));
      if (user.banned)
        return response(
          403,
          { error: "This account has been suspended" },
          headers,
        );
      return response(
        200,
        { token: issueSession(user), user: safeUser(user) },
        headers,
      );
    }

    if (body.action === "session") {
      const { claims, user } = await requireUser(event, users);
      return response(
        200,
        { user: safeUser(user), admin: claims.admin === true },
        headers,
      );
    }

    if (body.action === "impersonate") {
      const { claims } = await requireUser(event, users);
      if (!claims.admin)
        return response(403, { error: "Admin access required" }, headers);
      const target = await users.findOne({ _id: String(body.targetUid || "") });
      if (!target || target.banned)
        return response(404, { error: "Target user not found" }, headers);
      return response(200, { token: issueSession(target, true) }, headers);
    }

    return response(400, { error: "Unknown auth action" }, headers);
  } catch (error) {
    console.error("Mongo auth error:", error);
    const errorMessage = String(error.message || "");
    let publicError = "Authentication request failed";
    if (
      errorMessage === "MONGODB_URI is not configured" ||
      errorMessage === "JWT_SECRET must contain at least 32 characters"
    ) {
      publicError = errorMessage;
    } else if (
      /replica set|transaction numbers are only allowed/i.test(errorMessage)
    ) {
      publicError =
        "MongoDB must use an Atlas replica set for account registration";
    } else if (
      /ENOTFOUND|ECONNREFUSED|authentication failed|bad auth|MongoServerSelectionError|SSL|ReplicaSetNoPrimary/i.test(
        errorMessage,
      )
    ) {
      publicError =
        "MongoDB Atlas could not be reached. Check its Network Access IP allowlist and MONGODB_URI";
    }
    return response(
      error.statusCode || (error.message === "Unauthorized" ? 401 : 500),
      {
        error: error.statusCode ? error.message : publicError,
      },
      headers,
    );
  }
};
