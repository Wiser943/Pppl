const { getMongoClient } = require("../mongodb");

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS")
    return { statusCode: 200, headers, body: "ok" };

  try {
    console.log("KORAPAY WEBHOOK RAW BODY:", event.body);
    const rawData = JSON.parse(event.body);

    // ✅ Korapay webhook format
    const event_type = rawData.event; // e.g. "transfer.success" or "transfer.failed"
    const payload = rawData.data;
    const reference = payload?.reference;
    const client = await getMongoClient();
    const database = client.db(process.env.MONGODB_DB_NAME || "viral_play");
    const withdrawals = database.collection("withdrawals");

    console.log("EVENT TYPE:", event_type);
    console.log("REFERENCE:", reference);

    if (!reference) {
      console.log("No reference found, acknowledging.");
      return { statusCode: 200, headers, body: "success" };
    }

    // --- Find withdrawal document by reference (tradeNo) ---
    let withdrawDoc;

    // Check direct doc ID first
    withdrawDoc = await withdrawals.findOne({ _id: String(reference) });
    if (!withdrawDoc) {
      // Query by tradeNo
      withdrawDoc = await withdrawals.findOne({ tradeNo: reference });
      if (!withdrawDoc) {
        console.log("No matching withdrawal found for reference:", reference);
        return { statusCode: 200, headers, body: "success" };
      }
    }

    const currentData = withdrawDoc;

    // ✅ Skip if already finalized
    if (["success", "failed"].includes(currentData.status)) {
      console.log("Already finalized:", currentData.status);
      return { statusCode: 200, headers, body: "success" };
    }

    // ✅ Map Korapay event to status
    let newStatus = "processing";
    if (event_type === "transfer.success") newStatus = "success";
    if (event_type === "transfer.failed") newStatus = "failed";

    console.log("NEW STATUS:", newStatus);

    if (newStatus === "processing") {
      await withdrawals.updateOne(
        { _id: withdrawDoc._id },
        { $set: { status: "processing", last_updated: new Date() } },
      );
      return { statusCode: 200, headers, body: "success" };
    }

    const { uid, originalAmount, amount } = currentData;
    const payoutAmount = Number(originalAmount || amount || 0);
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        const fresh = await withdrawals.findOne(
          { _id: withdrawDoc._id },
          { session },
        );
        if (!fresh || ["success", "failed"].includes(fresh.status)) return;

        const updated = await withdrawals.updateOne(
          { _id: fresh._id, status: fresh.status },
          {
            $set: {
              status: newStatus,
              korapayReference: reference,
              notifiedAt: new Date(),
              rawWebhookData: rawData,
              ...(newStatus === "failed" ? { refunded: true } : {}),
            },
          },
          { session },
        );
        if (updated.modifiedCount !== 1) return;

        const userUpdate =
          newStatus === "success"
            ? { $set: { hasPendingWithdrawal: false } }
            : {
                $inc: { balance: payoutAmount },
                $set: { hasPendingWithdrawal: false },
              };
        const userResult = await database
          .collection("users")
          .updateOne({ _id: String(uid) }, userUpdate, { session });
        if (userResult.matchedCount !== 1) {
          throw new Error("User record not found for withdrawal callback");
        }

        if (newStatus === "success") {
          await database
            .collection("adminSettings")
            .updateOne(
              { _id: "stats" },
              { $inc: { allTimeWithdrawals: payoutAmount } },
              { upsert: true, session },
            );
        }
      });
    } finally {
      await session.endSession();
    }

    console.log("Webhook processed successfully:", newStatus);
    return { statusCode: 200, headers, body: "success" };
  } catch (err) {
    console.error("Webhook Error:", err);
    return { statusCode: 500, headers, body: "error" };
  }
};
