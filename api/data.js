const { handler } = require("../netlify/functions/data");

module.exports = async function vercelData(request, response) {
  const body =
    typeof request.body === "string"
      ? request.body
      : JSON.stringify(request.body || {});

  const result = await handler({
    httpMethod: request.method,
    headers: request.headers,
    body,
  });

  Object.entries(result.headers || {}).forEach(([name, value]) => {
    response.setHeader(name, value);
  });

  response.status(result.statusCode || 200).send(result.body || "");
};
