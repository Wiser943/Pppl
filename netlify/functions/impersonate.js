const { getMongoDatabase } = require("../mongodb");
const { getBearerToken, signToken, verifyToken } = require("../jwt");

exports.handler = async (event, context) => {
  const origin = event.headers?.origin || event.headers?.Origin;
  const allowedOrigin =
    process.env.ADMIN_ORIGIN || "https://fortune-admins.netlify.app";
  const headers = {
    ...(origin === allowedOrigin
      ? { "Access-Control-Allow-Origin": allowedOrigin }
      : {}),
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "OK" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: "Method Not Allowed" };
  }

  try {
    const { targetUid } = JSON.parse(event.body || "{}");
    const adminClaims = verifyToken(getBearerToken(event));
    if (!adminClaims.admin) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ error: "Admin access required" }),
      };
    }
    const target = await (await getMongoDatabase())
      .collection("users")
      .findOne({ _id: String(targetUid || "") });
    if (!target || target.banned) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "Target user not found" }),
      };
    }
    const adminEmails = (process.env.ADMIN_EMAILS || "")
      .split(",")
      .map((email) => email.trim().toLowerCase());
    const targetIsAdmin = adminEmails.includes(
      String(target.email || "").toLowerCase(),
    );
    const impersonationToken = signToken(
      {
        sub: String(target._id),
        email: target.email || null,
        admin: targetIsAdmin,
        impersonated: true,
      },
      15 * 60,
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ token: impersonationToken }),
    };
  } catch (error) {
    console.error("CRITICAL FUNCTION ERROR:", error.message);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "Internal Server Error",
        message: error.message,
      }),
    };
  }
};
