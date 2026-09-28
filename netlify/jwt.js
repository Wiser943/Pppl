const crypto = require("node:crypto");

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET must contain at least 32 characters");
  }
  return secret;
}

function signToken(payload, lifetimeSeconds = 60 * 60 * 24 * 7) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({ ...payload, iat: now, exp: now + lifetimeSeconds }),
  ).toString("base64url");
  const content = `${header}.${body}`;
  const signature = crypto
    .createHmac("sha256", getSecret())
    .update(content)
    .digest("base64url");
  return `${content}.${signature}`;
}

function unauthorized() {
  return Object.assign(new Error("Unauthorized"), { statusCode: 401 });
}

function verifyToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw unauthorized();

  const content = `${parts[0]}.${parts[1]}`;
  const expected = crypto
    .createHmac("sha256", getSecret())
    .update(content)
    .digest();
  const actual = Buffer.from(parts[2], "base64url");
  if (
    actual.length !== expected.length ||
    !crypto.timingSafeEqual(actual, expected)
  ) {
    throw unauthorized();
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw unauthorized();
  }
  if (
    !payload.sub ||
    !Number.isFinite(payload.exp) ||
    payload.exp <= Date.now() / 1000
  ) {
    throw unauthorized();
  }
  return payload;
}

function getBearerToken(event) {
  const headers = event.headers || {};
  const authorization = headers.authorization || headers.Authorization || "";
  return authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
}

module.exports = { getBearerToken, signToken, verifyToken };
