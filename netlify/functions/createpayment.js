const md5 = require("md5");
const { getMongoDatabase } = require("../mongodb");
const { getBearerToken, verifyToken } = require("../jwt");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    };
  }

  try {
    let claims;
    try {
      claims = verifyToken(getBearerToken(event));
    } catch {
      return {
        statusCode: 401,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }
    const { amount, depositId } = JSON.parse(event.body);
    const numericAmount = Number(amount);
    const orderId = String(depositId || "");
    if (!Number.isFinite(numericAmount) || numericAmount <= 0 || !orderId) {
      return {
        statusCode: 400,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "Invalid payment details" }),
      };
    }
    const database = await getMongoDatabase();
    const deposits = database.collection("deposits");
    const user = await database
      .collection("users")
      .findOne({ _id: claims.sub, banned: { $ne: true } });
    if (!user)
      return {
        statusCode: 401,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    if (await deposits.findOne({ _id: orderId })) {
      return {
        statusCode: 409,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "Payment reference already exists" }),
      };
    }

    // Change these lines in your DEPOSIT function:
    const MERCHANT_ID = process.env.MERCHANT_ID;
    const PAYMENT_KEY = process.env.DEPOSIT_KEY; // Use the Deposit Key here!

    const data = {
      bank_code: "NGR044",
      goods_name: "Wallet Deposit",
      mch_id: MERCHANT_ID,
      mch_order_no: depositId,
      mch_return_msg: "deposit",
      notify_url: "https://fruit-basket.name.ng/.netlify/functions/notify",

      order_date: new Date().toISOString().slice(0, 19).replace("T", " "),
      page_url: "https://fruit-basket.name.ng",
      pay_type: "523",
      trade_amount: numericAmount.toFixed(2),
      version: "1.0",
    };

    const keys = Object.keys(data).sort();
    const signString =
      keys.map((k) => `${k}=${data[k]}`).join("&") + `&key=${PAYMENT_KEY}`;

    data.sign = md5(signString);
    data.sign_type = "MD5";

    // --- STEP 1: SAFE WRITE (no crash if doc doesn't exist) ---
    await deposits.updateOne(
      { _id: orderId },
      {
        $set: {
          uid: claims.sub,
          userId: claims.sub,
          orderNo: depositId,
          amount: numericAmount,
          status: "pending",
          timestamp: new Date(),
          gateway: "NekPayment",
          expiresAt: Date.now() + 15 * 60 * 1000,
        },
      },
      { upsert: true },
    );

    // --- STEP 2: SEND TO GATEWAY ---
    const params = new URLSearchParams(data);

    const response = await fetch("https://api.nekpayment.com/pay/web", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });

    const result = await response.json();

    // --- SUCCESS ---
    if (result?.respCode === "SUCCESS" && result?.payInfo) {
      return {
        statusCode: 200,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({
          respCode: "SUCCESS",
          payInfo: result.payInfo,
        }),
      };
    }

    // --- FAIL ---
    await deposits.updateOne(
      { _id: orderId },
      {
        $set: {
          status: "failed",
          failReason: result?.tradeMsg || "Gateway Error",
        },
      },
    );

    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        respCode: "FAIL",
        tradeMsg: result?.tradeMsg || "Payment Gateway Error",
      }),
    };
  } catch (err) {
    console.error("Function Crash:", err);

    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        respCode: "ERROR",
        tradeMsg: err.message,
      }),
    };
  }
};
