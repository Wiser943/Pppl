const axios = require('axios');

exports.handler = async (event) => {
    const headers = { 
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type"
    };

    if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers };

    try {
        const key = process.env.KORAPAY_SECRET_KEY;
        console.log("Key exists:", !!key);
        console.log("Key preview:", key?.substring(0, 15));

        const response = await axios.get(
            'https://api.korapay.com/merchant/api/v1/misc/banks',
            {
                headers: {
                    'Authorization': `Bearer ${key}`
                }
            }
        );

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify(response.data)
        };

    } catch (error) {
        console.error("Error:", error.response?.data || error.message);
        return { 
            statusCode: 500, 
            headers, 
            body: JSON.stringify({ 
                error: error.message,
                details: error.response?.data
            }) 
        };
    }
};