const md5 = require("md5");
const { getMongoClient } = require("../mongodb");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    let data;

    try {
      data = JSON.parse(event.body);
    } catch {
      const params = new URLSearchParams(event.body);
      data = Object.fromEntries(params.entries());
    }

    console.log("Incoming Payment Data:", JSON.stringify(data));

    // Change this line in your NOTIFY function:
    const PAYMENT_KEY = process.env.DEPOSIT_KEY; // Must match the deposit key!

    // --- SIGNATURE VERIFY ---
    const keys = Object.keys(data)
      .sort()
      .filter((k) => k !== "sign" && k !== "signType");

    const signString =
      keys.map((k) => `${k}=${data[k]}`).join("&") + `&key=${PAYMENT_KEY}`;

    const expectedSign = md5(signString);

    if (data.sign !== expectedSign) {
      console.error("Signature Mismatch!");
      return { statusCode: 400, body: "Invalid Signature" };
    }

    // --- ONLY SUCCESS PAYMENTS ---
    if (data.tradeResult !== "1") {
      return { statusCode: 200, body: "ignored" };
    }

    const depositId = data.mchOrderNo;
    const amountPaid = parseFloat(data.amount || 0);

    if (!depositId || !amountPaid) {
      return { statusCode: 400, body: "Invalid Data" };
    }

    const client = await getMongoClient();
    const database = client.db(process.env.MONGODB_DB_NAME || "viral_play");
    const deposits = database.collection("deposits");
    const session = client.startSession();
    let outcome = "success";
    let creditedUid;

    try {
      await session.withTransaction(async () => {
        const deposit = await deposits.findOne(
          { _id: String(depositId) },
          { session },
        );

        if (!deposit) {
          outcome = "missing";
          return;
        }
        if (deposit.status === "success") return;
        if (deposit.status !== "pending") {
          outcome = "ignored";
          return;
        }

        const uid = deposit.uid || deposit.userId;
        if (!uid) {
          outcome = "missing-uid";
          return;
        }

        const marked = await deposits.updateOne(
          { _id: String(depositId), status: "pending" },
          { $set: { status: "success", processedAt: new Date() } },
          { session },
        );
        if (marked.modifiedCount !== 1) {
          outcome = "ignored";
          return;
        }

        const credited = await database
          .collection("users")
          .updateOne(
            { _id: String(uid) },
            { $inc: { balance: amountPaid } },
            { session },
          );
        if (credited.matchedCount !== 1) {
          throw new Error("User record not found for deposit");
        }
        creditedUid = uid;
      });
    } finally {
      await session.endSession();
    }

    if (outcome === "missing") {
      console.error("Deposit not found:", depositId);
      return { statusCode: 200, body: "success" };
    }
    if (outcome === "ignored") return { statusCode: 200, body: "ignored" };
    if (outcome === "missing-uid") {
      console.error("Missing UID in deposit record");
      return { statusCode: 400, body: "User ID missing" };
    }
    if (creditedUid) console.log(`Credited ₦${amountPaid} to ${creditedUid}`);

    return { statusCode: 200, body: "success" };
  } catch (err) {
    console.error("Critical Notify Error:", err);
    return { statusCode: 500, body: "error" };
  }
};
