const axios = require("axios");
const url = require("url"); // Imported for safe proxy string parsing
const { getMongoDatabase } = require("../mongodb");
const { getBearerToken, verifyToken } = require("../jwt");

exports.handler = async (event) => {
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

  if (event.httpMethod === "OPTIONS")
    return { statusCode: 200, headers, body: "ok" };
  if (event.httpMethod !== "POST")
    return { statusCode: 405, headers, body: "Method Not Allowed" };

  try {
    let claims;
    try {
      claims = verifyToken(getBearerToken(event));
    } catch {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }
    if (!claims.admin || claims.impersonated) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ error: "Admin access required" }),
      };
    }
    const { docId } = JSON.parse(event.body || "{}");
    const withdrawalId = String(docId || "");
    if (!withdrawalId)
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Withdrawal ID is required" }),
      };
    const database = await getMongoDatabase();
    const withdrawals = database.collection("withdrawals");
    const withdrawal = await withdrawals.findOne({
      _id: withdrawalId,
      status: "pending",
    });
    if (!withdrawal)
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({ error: "Withdrawal is not pending" }),
      };
    const user = await database
      .collection("users")
      .findOne({ _id: String(withdrawal.uid) });
    const bank = user?.bankAccount;
    if (!user || !bank?.bankCode || !bank.accountNumber || !bank.accountName) {
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({ error: "Saved bank details are unavailable" }),
      };
    }

    const secretKey = process.env.KORAPAY_SECRET_KEY;
    if (!secretKey)
      return {
        statusCode: 503,
        headers,
        body: JSON.stringify({ error: "Payout service is not configured" }),
      };
    const reference =
      "PAY_" + Date.now() + "_" + Math.floor(Math.random() * 10000);
    const claimed = await withdrawals.updateOne(
      { _id: withdrawalId, status: "pending" },
      {
        $set: {
          status: "processing",
          tradeNo: reference,
          initiatedAt: new Date(),
        },
      },
    );
    if (claimed.modifiedCount !== 1)
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({
          error: "Withdrawal is already being processed",
        }),
      };

    const korapayPayload = {
      reference: reference,
      destination: {
        type: "bank_account",
        amount: Number(withdrawal.finalAmount),
        currency: "NGN",
        narration: `Payout ${reference}`,
        bank_account: {
          bank: String(bank.bankCode).trim(),
          account: String(bank.accountNumber).trim(),
        },
        customer: {
          name: bank.accountName,
          email: user.email || `${user.uid}@fruit-basket.name.ng`,
        },
      },
    };

    console.log("KORAPAY PAYLOAD:", JSON.stringify(korapayPayload, null, 2));
    console.log("SECRET KEY EXISTS:", !!secretKey);

    // --- PARSE WEBSHARE PROXY ---
    let proxyConfig = false;
    if (process.env.WEBSHARE_PROXY_URL) {
      const parsedUrl = url.parse(process.env.WEBSHARE_PROXY_URL);
      const authFields = parsedUrl.auth ? parsedUrl.auth.split(":") : [];

      proxyConfig = {
        protocol: "http:",
        host: parsedUrl.hostname,
        port: Number(parsedUrl.port),
        auth:
          authFields.length === 2
            ? {
                username: authFields[0],
                password: authFields[1],
              }
            : undefined,
      };
    }
    console.log("ROUTING THROUGH WEBSHARE PROXY:", !!proxyConfig);

    // --- EXECUTE OUTBOUND API REQUEST ---
    const response = await axios.post(
      "https://api.korapay.com/merchant/api/v1/transactions/disburse",
      korapayPayload,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secretKey}`,
        },
        proxy: proxyConfig, // Forces request through your whitelisted Webshare static IP
        timeout: 25000,
      },
    );

    console.log("KORAPAY RESPONSE:", JSON.stringify(response.data, null, 2));

    if (response.data?.status === true) {
      const t = response.data.data;

      await withdrawals.updateOne(
        { _id: withdrawalId, status: "processing" },
        {
          $set: { tradeNo: t?.reference || reference, processedAt: new Date() },
        },
      );

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, data: response.data }),
      };
    } else {
      throw new Error(response.data?.message || "Transfer rejected by Korapay");
    }
  } catch (err) {
    if (err.response) {
      console.error("KORAPAY ERROR STATUS:", err.response.status);
      console.error("KORAPAY ERROR DATA:", JSON.stringify(err.response.data));

      const message = err.response.data?.message || "Gateway error occurred.";
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: message }),
      };
    } else {
      console.error("AXIOS ERROR:", err.message);
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          success: false,
          error: err.message || "Gateway error.",
        }),
      };
    }
  }
};
