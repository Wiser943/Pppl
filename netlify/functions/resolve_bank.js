const axios = require('axios');

exports.handler = async (event) => {
    const headers = { 
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers };
    if (event.httpMethod !== "POST") return { statusCode: 405, headers };

    try {
        const { accountNumber, bankCode } = JSON.parse(event.body);

        const response = await axios.get(
            `https://api.korapay.com/merchant/api/v1/misc/banks/resolve?bank=${bankCode}&account=${accountNumber}`,
            {
                headers: {
                    'Authorization': `Bearer ${process.env.KORAPAY_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const accountName = response.data?.data?.account_name;

        if (accountName) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ success: true, accountName })
            };
        } else {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ success: false, message: "Could not resolve account name" })
            };
        }

    } catch (error) {
        console.error("Korapay Resolve Error:", error.response?.data || error.message);
        return { 
            statusCode: 500, 
            headers, 
            body: JSON.stringify({ 
                success: false, 
                message: error.response?.data?.message || "Verification failed"
            }) 
        };
    }
};