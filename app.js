const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const https = require("https");
const tls = require("tls");

const { randomUUID, randomInt, createHash } = require("crypto");
const { SocksProxyAgent } = require("socks-proxy-agent");

tls.DEFAULT_MIN_VERSION = "TLSv1.2";
tls.DEFAULT_MAX_VERSION = "TLSv1.3";

// Constants for the server and API configuration
let port = 3040;
const baseUrl = "https://chat.openai.com";
const apiUrl = `${baseUrl}/backend-anon/conversation`;
const refreshInterval = 1200000; // Interval to refresh token in ms
const errorWait = 15000; // Wait time in ms after an error

let proxy = null;
process.argv.forEach((val, index) => {
  if (val.startsWith("--port=")) {
    port = parseInt(val.replace("--port=", ""));
  } else if (val.startsWith("--proxy=")) {
    proxy = val.replace("--proxy=", "");
  }
});

// Initialize global variables to store the session token and device ID
let token;
let proofToken;

// openai uses `device id` and `conversation id` to trace the conversion
let oaiDeviceId;
let keepConversation = false;

function renewDeviceId() {
  oaiDeviceId = randomUUID();
  keepConversation = false;
}

renewDeviceId();

// Function to wait for a specified duration
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function GenerateCompletionId(prefix = "cmpl-") {
  const characters =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const length = 28;

  for (let i = 0; i < length; i++) {
    prefix += characters.charAt(Math.floor(Math.random() * characters.length));
  }

  return prefix;
}

async function* chunksToLines(chunksAsync) {
  let previous = "";
  for await (const chunk of chunksAsync) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    previous += bufferChunk;
    let eolIndex;
    while ((eolIndex = previous.indexOf("\n")) >= 0) {
      // line includes the EOL
      const line = previous.slice(0, eolIndex + 1).trimEnd();
      if (line === "data: [DONE]") break;
      if (line.startsWith("data: ")) yield line;
      previous = previous.slice(eolIndex + 1);
    }
  }
}

async function* linesToMessages(linesAsync) {
  for await (const line of linesAsync) {
    const message = line.substring("data :".length);

    yield message;
  }
}

async function* StreamCompletion(data) {
  yield* linesToMessages(chunksToLines(data));
}

const axiosConfig = {
  headers: {
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7,en-CN;q=0.6",
    "Accept-Encoding": "gzip, deflate, br, zstd",
    "Cache-Control": "no-cache",
    "Content-Type": "application/json",
    "Oai-Language": "en-US",
    origin: baseUrl,
    referer: baseUrl,
    pragma: "no-cache",
    "sec-ch-ua":
      '"Google Chrome";v="123", "Not:A-Brand";v="8", "Chromium";v="123"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  },
};

if (proxy) {
  axiosConfig.httpsAgent = new SocksProxyAgent(proxy);
  axiosConfig.httpAgent = axiosConfig.httpsAgent;
} else {
  axiosConfig.httpsAgent = new https.Agent({ rejectUnauthorized: false });
}

// Setup axios instance for API requests with predefined configurations
const axiosInstance = axios.create(axiosConfig);

// Generate a proof token for the OpenAI API
function GenerateProofToken(seed, diff, userAgent) {
  const cores = [8, 12, 16, 24];
  const screens = [3000, 4000, 6000];

  const core = cores[randomInt(0, cores.length)];
  const screen = screens[randomInt(0, screens.length)];

  const now = new Date(Date.now() - 8 * 3600 * 1000);
  const parseTime = now.toUTCString().replace("GMT", "GMT-0500 (Eastern Time)");

  const config = [core + screen, parseTime, 4294705152, 0, userAgent];

  const diffLen = diff.length / 2;

  for (let i = 0; i < 100000; i++) {
    config[3] = i;
    const jsonData = JSON.stringify(config);
    const base = Buffer.from(jsonData).toString("base64");
    const hashValue = createHash("sha3-512")
      .update(seed + base)
      .digest();

    if (hashValue.toString("hex").substring(0, diffLen) <= diff) {
      const result = "gAAAAAB" + base;
      return result;
    }
  }

  const fallbackBase = Buffer.from(`"${seed}"`).toString("base64");
  return "gAAAAABwQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D" + fallbackBase;
}

// Function to get a token from the OpenAI API
async function getNewTokenIds() {
  let response;
  try {
    console.log("Prepare a new token for the following request.......");

    response = await axiosInstance.post(
      `${baseUrl}/backend-anon/sentinel/chat-requirements`,
      {},
      {
        headers: {
          "Oai-Device-Id": oaiDeviceId,
          "Oai-Language": "en-US",
          "User-Agent": "Mozilla/5.0",
        },
      }
    );
  } catch (error) {
    console.error("---Failed to renew the tokens, error: ${error.message}.");
    if (token) {
      console.log("Continue using the old ones.");
    }

    return false;
  }

  token = response.data.token;
  console.log(`New Token: ${token}`);

  let pow = response.data.proofofwork;
  proofToken = GenerateProofToken(pow.seed, pow.difficulty);
  console.log(`Proof Token: ${proofToken}\n`);

  return true;
}

// Middleware to enable CORS and handle pre-flight requests
function enableCORS(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  next();
}

// Middleware to handle chat completions
async function handleChatCompletion(req, res) {
  console.log(
    "Request:",
    `${req.method} ${req.originalUrl}`,
    `${req.body?.messages?.length || 0} messages`,
    req.body.stream ? "(stream-enabled)" : "(stream-disabled)"
  );
  let body;
  try {
    body = {
      action: "next",
      messages: req.body.messages.map((message) => ({
        id: randomUUID(),
        author: { role: message.role },
        content: { content_type: "text", parts: [message.content] },
        metadata: {},
      })),
      force_nulligen: false,
      force_paragen: false,
      force_paragen_model_slug: "",
      force_rate_limit: false,
      //conversation_id: req.body.conversation_id || null,
      parent_message_id: randomUUID(),
      model: "text-davinci-002-render-sha",
      timezone_offset_min: -480,
      suggestions: [],
      history_and_training_disabled: false,
      conversation_mode: { kind: "primary_assistant" },
      websocket_request_id: randomUUID(),
    };

    if (req.body.conversation_id && keepConversation) {
      body["conversation_id"] = req.body.conversation_id;
    }
  } catch (error) {
    console.log(`composing body error: ${error.message}, req.body.messages`);
  }

  await getNewTokenIds();

  let response;
  try {
    console.info(`conversion id: ${body.conversation_id || null}`);
    response = await axiosInstance.post(apiUrl, body, {
      responseType: "stream",
      headers: {
        Accept: "text/event-stream",
        "Oai-Device-Id": oaiDeviceId,
        "Oai-Language": "en-US",
        "User-Agent": "Mozilla/5.0",
        "Openai-Sentinel-Chat-Requirements-Token": token,
        "openai-sentinel-proof-token": proofToken,
      },
    });
  } catch (error) {
    console.log("Error:", error.response?.data ?? error.message);
    if (!res.headersSent) res.setHeader("Content-Type", "application/json");
    res.write(
      JSON.stringify({
        status: false,
        error: "upstream error",
        message: error.message,
      })
    );
    res.end();
    return;
  }

  // console.log('posted request');

  // Set the response headers based on the request type
  if (req.body.stream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
  } else {
    res.setHeader("Content-Type", "application/json");
  }

  let fullContent = "";
  let requestId = GenerateCompletionId("chatcmpl-");
  let created = Date.now();

  try {
    for await (const message of StreamCompletion(response.data)) {
      // Skip heartbeat detection
      if (message.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}.\d{6}$/))
        continue;

      const parsed = JSON.parse(message);

      let content = parsed?.message?.content?.parts[0] || "";

      keepConversation = parsed.conversation_id ? true : false;

      for (let message of req.body.messages) {
        if (message.content === content) {
          content = "";
          break;
        }
      }

      if (content === "") continue;

      if (req.body.stream) {
        let response = {
          id: requestId,
          created: created,
          object: "chat.completion.chunk",
          model: "gpt-3.5-turbo",
          conversation_id: parsed.conversation_id,
          choices: [
            {
              delta: {
                content: content.replace(fullContent, ""),
              },
              index: 0,
              finish_reason: null,
            },
          ],
        };

        res.write(`data: ${JSON.stringify(response)}\n\n`);
      }

      fullContent = content.length > fullContent.length ? content : fullContent;
    }

    if (req.body.stream) {
      res.write(
        `data: ${JSON.stringify({
          id: requestId,
          created: created,
          object: "chat.completion.chunk",
          model: "gpt-3.5-turbo",
          choices: [
            {
              delta: {
                content: "",
              },
              index: 0,
              finish_reason: "stop",
            },
          ],
        })}\n\n`
      );
    } else {
      res.write(
        JSON.stringify({
          id: requestId,
          created: created,
          model: "gpt-3.5-turbo",
          object: "chat.completion",
          choices: [
            {
              finish_reason: "stop",
              index: 0,
              message: {
                content: fullContent,
                role: "assistant",
              },
            },
          ],
          usage: {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          },
        })
      );
    }

    res.end();
  } catch (error) {
    console.log("Error:", error.response?.data ?? error.message);
    if (!res.headersSent) res.setHeader("Content-Type", "application/json");
    res.write(
      JSON.stringify({
        status: false,
        error: "compose response to client error",
        message: error.message,
      })
    );
    res.end();
  }
}

// Initialize Express app and use middlewares
const app = express();
app.use(bodyParser.json());
app.use(enableCORS);

// Route to handle POST requests for chat completions
app.post("/v1/chat/completions", handleChatCompletion);

// 404 handler for unmatched routes
app.use((req, res) =>
  res.status(404).send({
    status: false,
    error: {
      message: `The requested endpoint was not found. please make sure to use "http://host:${port}/v1" as the base URL.`,
      type: "invalid_request_error",
    },
  })
);

// Start the server and the session ID refresh loop
app.listen(port, () => {
  console.log(`Listening on port: ${port}, using proxy: ${proxy}\n`);

  if (proxy) {
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
  }

  let errorRetryCount = 0;
  setTimeout(async () => {
    while (true) {
      console.log(`Device Id: ${oaiDeviceId}\n`);

      let result = await getNewTokenIds();
      if (result) {
        const interval = refreshInterval / 60000;
        console.info(`Waiting for ${interval} minute to get a new token id`);

        await wait(refreshInterval);
      } else {
        errorRetryCount++;
        const interval = errorWait + Math.floor(errorRetryCount / 5) * 5 * 1000;
        if (token) {
          console.info(`Continue using the old token: ${token}`);
          console.info(`Retrying in ${(interval * 10) / 1000} seconds...`);
          await wait(interval * 10);
        } else {
          renewDeviceId();
          console.info(
            `Retrying in ${interval / 1000} seconds with a new device id...`
          );
          await wait(interval);
        }
      }
    }
  }, 0);
});
