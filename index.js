require("dotenv").config();

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "1mb" }));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "myWebhookToken123";

const SFMC = {
  clientId:     process.env.SFMC_CLIENT_ID,
  clientSecret: process.env.SFMC_CLIENT_SECRET,
  authUrl:      `https://${process.env.SFMC_SUBDOMAIN}.auth.marketingcloudapis.com/v2/token`,
  restUrl:      `https://${process.env.SFMC_SUBDOMAIN}.rest.marketingcloudapis.com`,
  fdDeKey:      process.env.SFMC_FD_DE_KEY,   // e.g. "FD_Loan_DE"  → FD records ONLY
  loanDeKey:    process.env.SFMC_LOAN_DE_KEY  // e.g. "Loan_DE"     → Loan records ONLY
};

const PRODUCT = { FD: "FD", LOAN: "Loan" };

const REQUIRED_ENV = [
  "SFMC_CLIENT_ID",
  "SFMC_CLIENT_SECRET",
  "SFMC_SUBDOMAIN",
  "SFMC_FD_DE_KEY",
  "SFMC_LOAN_DE_KEY"
];

REQUIRED_ENV.forEach((key) => {
  if (!process.env[key]) {
    console.error(`[FATAL] Missing required env variable: ${key}`);
    process.exit(1);
  }
});

// ── Sanity-check: the two DE keys must NOT be the same value ─────────────────
if (SFMC.fdDeKey === SFMC.loanDeKey) {
  console.error(
    `[FATAL] SFMC_FD_DE_KEY and SFMC_LOAN_DE_KEY are identical ("${SFMC.fdDeKey}"). ` +
    `They must point to different Data Extensions.`
  );
  process.exit(1);
}

console.log("[INFO] ENV loaded successfully");
console.log("[INFO] SFMC subdomain :", process.env.SFMC_SUBDOMAIN);
console.log("[INFO] FD   DE Key    :", SFMC.fdDeKey,   "← FD records only");
console.log("[INFO] Loan DE Key    :", SFMC.loanDeKey, "← Loan records only");

// ── Token cache ───────────────────────────────────────────────────────────────
let tokenCache = { value: null, expiresAt: null };

async function getSFMCToken() {
  const now = Date.now();
  if (tokenCache.value && now < tokenCache.expiresAt - 60_000) return tokenCache.value;

  const response = await axios.post(SFMC.authUrl, {
    grant_type:    "client_credentials",
    client_id:     SFMC.clientId,
    client_secret: SFMC.clientSecret
  });

  tokenCache.value     = response.data.access_token;
  tokenCache.expiresAt = now + response.data.expires_in * 1000;
  console.log("[INFO] New SFMC token fetched, expires in:", response.data.expires_in, "s");
  return tokenCache.value;
}

// ── Normalise raw product string → canonical form ────────────────────────────
function normaliseProduct(raw) {
  const upper = (raw || "").trim().toUpperCase();
  if (upper === "FD")   return PRODUCT.FD;
  if (upper === "LOAN") return PRODUCT.LOAN;
  return null;
}

// ── Strict DE key resolver ────────────────────────────────────────────────────
function getDeKeyForProduct(product) {
  if (product === PRODUCT.FD)   return SFMC.fdDeKey;
  if (product === PRODUCT.LOAN) return SFMC.loanDeKey;
  throw new Error(`Unknown product: "${product}"`);
}

// ── Detect products in message text ──────────────────────────────────────────
function detectProducts(text) {
  const products = [];
  if (/\bFD\b/i.test(text || ""))   products.push(PRODUCT.FD);
  if (/\bLOAN\b/i.test(text || "")) products.push(PRODUCT.LOAN);
  return products;
}

// ── Save one record to the correct DE ────────────────────────────────────────
async function saveToDE({ name, mobileNo, product, createdDate }) {
  const deKey = getDeKeyForProduct(product); // throws if product is unexpected

  console.log(`[INFO] saveToDE called | product="${product}" → deKey="${deKey}"`);

  try {
    const token = await getSFMCToken();

    const payload = [
      {
        keys:   { MobileNo: mobileNo, Product: product },
        values: {
          Name:        name || "",
          CreatedDate: createdDate || "",
          Locale:      "IN",
          Mobile_No:   mobileNo ? `+${mobileNo.replace(/^\+/, "")}` : ""
        }
      }
    ];

    const sfmcRes = await axios.post(
      `${SFMC.restUrl}/hub/v1/dataevents/key:${deKey}/rowset`,
      payload,
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );

    console.log(`[INFO] ✅ Saved | DE="${deKey}" | MobileNo=${mobileNo} | Product=${product}`);
    console.log("[DEBUG] DE HTTP status:", sfmcRes.status);
    console.log("[DEBUG] DE response   :", JSON.stringify(sfmcRes.data, null, 2));
    return true;

  } catch (err) {
    if (err.response?.status === 401) tokenCache = { value: null, expiresAt: null };
    console.error(`[ERROR] ❌ Save failed | DE="${deKey}" | Product=${product}`);
    console.error("[ERROR] HTTP status:", err.response?.status);
    console.error("[ERROR] Response   :", JSON.stringify(err.response?.data, null, 2));
    console.error("[ERROR] Message    :", err.message);
    return false;
  }
}

// ── Test endpoint ─────────────────────────────────────────────────────────────
// POST /test-journey  { mobileNo, name, product }
// product: "FD" | "Loan" | "FD,Loan"  (case-insensitive)
app.post("/test-journey", async (req, res) => {
  const { mobileNo, name, product } = req.body;

  if (!mobileNo || !product) {
    return res.status(400).json({ error: "mobileNo and product are required" });
  }

  const requestedProducts = product
    .split(",")
    .map((p) => normaliseProduct(p))
    .filter(Boolean);

  if (requestedProducts.length === 0) {
    return res.status(400).json({
      error: `Unrecognised product value(s): "${product}". Expected "FD", "Loan", or "FD,Loan".`
    });
  }

  const uniqueProducts = [...new Set(requestedProducts)];

  console.log("\n========== /test-journey ==========");
  console.log("Input:", { mobileNo, name, products: uniqueProducts });

  const createdDate = new Date().toISOString().split("T")[0];
  const results     = {};

  for (const p of uniqueProducts) {
    const saved = await saveToDE({
      mobileNo,
      name:        name || "Test User",
      product:     p,
      createdDate
    });

    results[p] = {
      de:    getDeKeyForProduct(p),
      saved: saved ? "✅ saved" : "❌ failed"
    };
  }

  return res.status(200).json({ results });
});

// ── Webhook verify (GET) ──────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("[INFO] Webhook verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ── Webhook POST ──────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object !== "whatsapp_business_account") {
    return res.status(404).json({ status: "error", message: "Not a whatsapp_business_account event" });
  }

  try {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const messages = change.value?.messages || [];
        const contacts = change.value?.contacts || [];

        for (const message of messages) {
          if (message.type !== "text") continue;

          const text     = message.text?.body || "";
          const products = detectProducts(text);

          if (products.length === 0) continue;

          const mobileNo    = message.from;
          const contact     = contacts.find((c) => c.wa_id === mobileNo);
          const name        = contact?.profile?.name || "";
          const createdDate = new Date(message.timestamp * 1000).toISOString().split("T")[0];

          console.log(`\n========== Incoming message ==========`);
          console.log(`MobileNo: ${mobileNo} | Message: "${text}"`);
          console.log(`Detected products: [${products.join(", ")}]`);
          console.log(`DE routing → FD: "${SFMC.fdDeKey}" | Loan: "${SFMC.loanDeKey}"`);

          for (const product of products) {
            await saveToDE({ name, mobileNo, product, createdDate });
          }
        }
      }
    }
  } catch (err) {
    console.error("[ERROR] Webhook processing failed:", err.message);
    return res.status(500).json({ status: "error", message: err.message });
  }

  return res.status(200).json({ status: "ok" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[INFO] Server running on port ${PORT}`));













// require("dotenv").config();

// const express = require("express");
// const axios = require("axios");

// const app = express();
// app.use(express.json({ limit: "1mb" }));

// const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "myWebhookToken123";

// // ─── All credentials from .env ────────────────────────────────────────────────
// const SFMC = {
//   clientId:        process.env.SFMC_CLIENT_ID,
//   clientSecret:    process.env.SFMC_CLIENT_SECRET,
//   authUrl:         `https://${process.env.SFMC_SUBDOMAIN}.auth.marketingcloudapis.com/v2/token`,
//   restUrl:         `https://${process.env.SFMC_SUBDOMAIN}.rest.marketingcloudapis.com`,
//   fdDeKey:         process.env.SFMC_FD_DE_KEY   || "FD_Loan_DE",
//   loanDeKey:       process.env.SFMC_LOAN_DE_KEY || "Loan_DE",
//   journeyEventKey: process.env.EVENT_DEFINITION_KEY
// };

// // ─── Startup validation ───────────────────────────────────────────────────────
// const REQUIRED_ENV = [
//   "SFMC_CLIENT_ID",
//   "SFMC_CLIENT_SECRET",
//   "SFMC_SUBDOMAIN",
//   "SFMC_FD_DE_KEY",
//   "SFMC_LOAN_DE_KEY",
//   "EVENT_DEFINITION_KEY"
// ];

// REQUIRED_ENV.forEach((key) => {
//   if (!process.env[key]) {
//     console.error(`[FATAL] Missing required env variable: ${key}`);
//     process.exit(1);
//   }
// });

// console.log("[INFO] ENV loaded successfully");
// console.log("[INFO] SFMC subdomain:", process.env.SFMC_SUBDOMAIN);
// console.log("[INFO] FD DE Key:",      SFMC.fdDeKey);
// console.log("[INFO] Loan DE Key:",    SFMC.loanDeKey);
// console.log("[INFO] Journey Event Key:", SFMC.journeyEventKey);

// // ─── Token cache ──────────────────────────────────────────────────────────────
// let tokenCache = { value: null, expiresAt: null };

// async function getSFMCToken() {
//   const now = Date.now();
//   if (tokenCache.value && now < tokenCache.expiresAt - 60000) return tokenCache.value;

//   const response = await axios.post(SFMC.authUrl, {
//     grant_type:    "client_credentials",
//     client_id:     SFMC.clientId,
//     client_secret: SFMC.clientSecret
//   });

//   tokenCache.value     = response.data.access_token;
//   tokenCache.expiresAt = now + response.data.expires_in * 1000;
//   console.log("[INFO] New SFMC token fetched, expires in:", response.data.expires_in, "seconds");
//   return tokenCache.value;
// }

// // ─── Resolve DE key by product ────────────────────────────────────────────────
// function getDeKeyForProduct(product) {
//   const p = (product || "").toUpperCase();
//   if (p === "FD")   return SFMC.fdDeKey;
//   if (p === "LOAN") return SFMC.loanDeKey;
//   throw new Error(`Unknown product: "${product}". Expected "FD" or "Loan".`);
// }

// // ─── Detect products from message text ───────────────────────────────────────
// // Returns an array: ["FD"], ["Loan"], or ["FD", "Loan"]
// function detectProducts(text) {
//   const upper    = (text || "").toUpperCase();
//   const products = [];
//   if (upper.includes("FD"))   products.push("FD");
//   if (upper.includes("LOAN")) products.push("Loan");
//   return products;
// }

// // ─── Save to a specific DE ────────────────────────────────────────────────────
// async function saveToDE({ name, mobileNo, product, createdDate }) {
//   try {
//     const token = await getSFMCToken();
//     const deKey = getDeKeyForProduct(product);

//     const payload = [
//       {
//         keys:   { MobileNo: mobileNo, Product: product },
//         values: {
//           Name:        name || "",
//           CreatedDate: createdDate || "",
//           Locale:      "IN",
//           Mobile_No:   mobileNo ? `+${mobileNo.replace(/^\+/, "")}` : ""
//         }
//       }
//     ];

//     const sfmcRes = await axios.post(
//       `${SFMC.restUrl}/hub/v1/dataevents/key:${deKey}/rowset`,
//       payload,
//       { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
//     );

//     console.log(`[INFO] ✅ Saved to ${deKey} | MobileNo: ${mobileNo} | Product: ${product}`);
//     console.log("[DEBUG] DE HTTP status:", sfmcRes.status);
//     console.log("[DEBUG] DE response:", JSON.stringify(sfmcRes.data, null, 2));
//     return true;

//   } catch (err) {
//     if (err.response?.status === 401) tokenCache = { value: null, expiresAt: null };
//     console.error(`[ERROR] ❌ Failed to save to DE | Product: ${product}`);
//     console.error("[ERROR] HTTP status:", err.response?.status);
//     console.error("[ERROR] Response body:", JSON.stringify(err.response?.data, null, 2));
//     console.error("[ERROR] Message:", err.message);
//     return false;
//   }
// }

// // ─── Fire Journey Builder Entry Event ────────────────────────────────────────
// async function fireJourneyEvent({ name, mobileNo, product }) {
//   try {
//     const token        = await getSFMCToken();
//     const compositeKey = `${mobileNo}_${product}`;

//     const payload = {
//       ContactKey:         compositeKey,
//       EventDefinitionKey: SFMC.journeyEventKey,
//       Data: {
//         MobileNo:  mobileNo,
//         Name:      name || "",
//         Product:   product || "",
//         Mobile_No: mobileNo,
//         Locale:    "IN"
//       }
//     };

//     console.log("[DEBUG] Firing journey event:", JSON.stringify(payload, null, 2));
//     console.log("[DEBUG] Posting to:", `${SFMC.restUrl}/interaction/v1/events`);

//     const sfmcRes = await axios.post(
//       `${SFMC.restUrl}/interaction/v1/events`,
//       payload,
//       {
//         headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
//         validateStatus: null
//       }
//     );

//     console.log("[DEBUG] Journey HTTP status:", sfmcRes.status);
//     console.log("[DEBUG] Journey response:", JSON.stringify(sfmcRes.data, null, 2));

//     if (sfmcRes.status === 201) {
//       console.log(`[INFO] ✅ Journey event fired | MobileNo: ${mobileNo} | Product: ${product}`);
//       return true;
//     } else {
//       console.error(`[ERROR] ❌ Journey event failed | HTTP ${sfmcRes.status} | MobileNo: ${mobileNo} | Product: ${product}`);
//       return false;
//     }

//   } catch (err) {
//     if (err.response?.status === 401) tokenCache = { value: null, expiresAt: null };
//     console.error("[ERROR] ❌ Journey event exception:", err.message);
//     return false;
//   }
// }

// // ─── Process a single product: save DE + fire journey ────────────────────────
// async function processProduct({ name, mobileNo, product, createdDate }) {
//   console.log(`\n---------- Processing product: ${product} ----------`);
//   console.log(`[INFO] Target DE: ${getDeKeyForProduct(product)}`);

//   const saved = await saveToDE({ name, mobileNo, product, createdDate });

//   if (saved) {
//     await fireJourneyEvent({ name, mobileNo, product });
//   } else {
//     console.warn(`[WARN] Skipping journey event — DE save failed | MobileNo: ${mobileNo} | Product: ${product}`);
//   }

//   return saved;
// }

// // ─── Test endpoint ────────────────────────────────────────────────────────────
// app.post("/test-journey", async (req, res) => {
//   const { mobileNo, name, product, locale } = req.body;

//   if (!mobileNo || !product) {
//     return res.status(400).json({ error: "mobileNo and product are required" });
//   }

//   // Support comma-separated products: "FD,Loan" or single "FD" / "Loan"
//   const requestedProducts = product
//     .split(",")
//     .map((p) => p.trim())
//     .filter(Boolean);

//   // Validate all products before doing any work
//   for (const p of requestedProducts) {
//     try {
//       getDeKeyForProduct(p);
//     } catch (e) {
//       return res.status(400).json({ error: e.message });
//     }
//   }

//   console.log("\n========== /test-journey ==========");
//   console.log("Input:", { mobileNo, name, products: requestedProducts });

//   const createdDate = new Date().toISOString().split("T")[0];
//   const results     = {};

//   for (const p of requestedProducts) {
//     const saved = await saveToDE({
//       mobileNo,
//       name:        name || "Test User",
//       product:     p,
//       createdDate
//     });

//     const journeyFired = saved
//       ? await fireJourneyEvent({ mobileNo, name: name || "Test User", product: p })
//       : false;

//     results[p] = {
//       de:      getDeKeyForProduct(p),
//       saved:   saved        ? "✅ saved"  : "❌ failed",
//       journey: journeyFired ? "✅ fired"  : "❌ failed"
//     };
//   }

//   return res.status(200).json({ results });
// });

// // ─── Webhook verify (GET) ─────────────────────────────────────────────────────
// app.get("/webhook", (req, res) => {
//   const mode      = req.query["hub.mode"];
//   const token     = req.query["hub.verify_token"];
//   const challenge = req.query["hub.challenge"];

//   if (mode === "subscribe" && token === VERIFY_TOKEN) {
//     console.log("[INFO] Webhook verified");
//     return res.status(200).send(challenge);
//   }
//   return res.sendStatus(403);
// });

// // ─── Webhook POST ─────────────────────────────────────────────────────────────
// app.post("/webhook", async (req, res) => {
//   const body = req.body;

//   if (body.object !== "whatsapp_business_account") {
//     return res.status(404).json({ status: "error", message: "Not a whatsapp_business_account event" });
//   }

//   try {
//     for (const entry of body.entry || []) {
//       for (const change of entry.changes || []) {
//         const messages = change.value?.messages || [];
//         const contacts = change.value?.contacts || [];

//         for (const message of messages) {
//           if (message.type !== "text") continue;

//           const text     = message.text?.body || "";
//           const products = detectProducts(text);

//           if (products.length === 0) continue;   // no relevant keyword found

//           const mobileNo    = message.from;
//           const contact     = contacts.find((c) => c.wa_id === mobileNo);
//           const name        = contact?.profile?.name || "";
//           const createdDate = new Date(message.timestamp * 1000).toISOString().split("T")[0];

//           console.log(`\n========== Incoming message ==========`);
//           console.log(`MobileNo: ${mobileNo} | Message: "${text}"`);
//           console.log(`Detected products: [${products.join(", ")}]`);
//           console.log(`Contact found: ${contact ? "YES" : "NO — name will be empty"}`);

//           // Process each detected product independently
//           for (const product of products) {
//             await processProduct({ name, mobileNo, product, createdDate });
//           }
//         }
//       }
//     }
//   } catch (err) {
//     console.error("[ERROR] Webhook processing failed:", err.message);
//     return res.status(500).json({ status: "error", message: err.message });
//   }

//   return res.status(200).json({ status: "ok" });
// });

// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => console.log(`[INFO] Server running on port ${PORT}`));












// require("dotenv").config();

// const express = require("express");

// const axios = require("axios");
 
// const app = express();

// app.use(express.json({ limit: "1mb" }));
 
// const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "myWebhookToken123";
 
// // ─── All credentials from .env ────────────────────────────────────────────────

// const SFMC = {

//   clientId:       process.env.SFMC_CLIENT_ID,

//   clientSecret:   process.env.SFMC_CLIENT_SECRET,

//   authUrl:        `https://${process.env.SFMC_SUBDOMAIN}.auth.marketingcloudapis.com/v2/token`,

//   restUrl:        `https://${process.env.SFMC_SUBDOMAIN}.rest.marketingcloudapis.com`,

//   deKey:          process.env.SFMC_DE_KEY       || "FD_Loan_DE",

//   journeyEventKey: process.env.EVENT_DEFINITION_KEY

// };
 
// // ─── Startup validation ───────────────────────────────────────────────────────

// const REQUIRED_ENV = [

//   "SFMC_CLIENT_ID",

//   "SFMC_CLIENT_SECRET",

//   "SFMC_SUBDOMAIN",

//   "SFMC_DE_KEY",

//   "EVENT_DEFINITION_KEY"

// ];
 
// REQUIRED_ENV.forEach((key) => {

//   if (!process.env[key]) {

//     console.error(`[FATAL] Missing required env variable: ${key}`);

//     process.exit(1);

//   }

// });
 
// console.log("[INFO] ENV loaded successfully");

// console.log("[INFO] SFMC subdomain:", process.env.SFMC_SUBDOMAIN);

// console.log("[INFO] DE Key:", SFMC.deKey);

// console.log("[INFO] Journey Event Key:", SFMC.journeyEventKey);
 
// // ─── Token cache ──────────────────────────────────────────────────────────────

// let tokenCache = { value: null, expiresAt: null };
 
// async function getSFMCToken() {

//   const now = Date.now();

//   if (tokenCache.value && now < tokenCache.expiresAt - 60000) return tokenCache.value;
 
//   const response = await axios.post(SFMC.authUrl, {

//     grant_type:    "client_credentials",

//     client_id:     SFMC.clientId,

//     client_secret: SFMC.clientSecret

//   });
 
//   tokenCache.value     = response.data.access_token;

//   tokenCache.expiresAt = now + response.data.expires_in * 1000;

//   console.log("[INFO] New SFMC token fetched, expires in:", response.data.expires_in, "seconds");

//   return tokenCache.value;

// }
 
// // ─── Save to FD_Loan_DE ───────────────────────────────────────────────────────

// async function saveToFDLoanDE({ name, mobileNo, product, createdDate, locale }) {

//   try {

//     const token = await getSFMCToken();
 
//     const payload = [

//       {

//         keys: { MobileNo: mobileNo, Product: product },

//         values: {

//           Name:        name || "",

//           CreatedDate: createdDate || "",

//           Locale:      "IN",

//           Mobile_No:   mobileNo ? `+${mobileNo.replace(/^\+/, "")}` : ""

//         }

//       }

//     ];
 
//     const sfmcRes = await axios.post(

//       `${SFMC.restUrl}/hub/v1/dataevents/key:${SFMC.deKey}/rowset`,

//       payload,

//       { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }

//     );
 
//     console.log(`[INFO] ✅ Saved to FD_Loan_DE | MobileNo: ${mobileNo} | Product: ${product}`);

//     console.log("[DEBUG] DE HTTP status:", sfmcRes.status);

//     console.log("[DEBUG] DE response:", JSON.stringify(sfmcRes.data, null, 2));

//     return true;
 
//   } catch (err) {

//     if (err.response?.status === 401) tokenCache = { value: null, expiresAt: null };

//     console.error("[ERROR] ❌ Failed to save to FD_Loan_DE");

//     console.error("[ERROR] HTTP status:", err.response?.status);

//     console.error("[ERROR] Response body:", JSON.stringify(err.response?.data, null, 2));

//     console.error("[ERROR] Message:", err.message);

//     return false;

//   }

// }
 
// // ─── Fire Journey Builder Entry Event ────────────────────────────────────────

// async function fireJourneyEvent({ name, mobileNo, product, locale }) {

//   try {

//     const token = await getSFMCToken();
 
//     const compositeKey = `${mobileNo}_${product}`;
 
//     const payload = {

//       ContactKey:           compositeKey,

//       EventDefinitionKey:   SFMC.journeyEventKey,

//       Data: {

//         MobileNo:  mobileNo,

//         Name:      name || "",

//         Product:   product || "",

//         Mobile_No: mobileNo,

//         Locale:    "IN"

//       }

//     };
 
//     console.log("[DEBUG] Firing journey event with payload:", JSON.stringify(payload, null, 2));

//     console.log("[DEBUG] Posting to:", `${SFMC.restUrl}/interaction/v1/events`);
 
//     const sfmcRes = await axios.post(

//       `${SFMC.restUrl}/interaction/v1/events`,

//       payload,

//       {

//         headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },

//         validateStatus: null

//       }

//     );
 
//     console.log("[DEBUG] Journey HTTP status:", sfmcRes.status);

//     console.log("[DEBUG] Journey response:", JSON.stringify(sfmcRes.data, null, 2));
 
//     if (sfmcRes.status === 201) {

//       console.log(`[INFO] ✅ Journey event fired | MobileNo: ${mobileNo} | Product: ${product}`);

//       return true;

//     } else {

//       console.error(`[ERROR] ❌ Journey event failed | HTTP ${sfmcRes.status} | MobileNo: ${mobileNo}`);

//       return false;

//     }
 
//   } catch (err) {

//     if (err.response?.status === 401) tokenCache = { value: null, expiresAt: null };

//     console.error("[ERROR] ❌ Journey event threw an exception:", err.message);

//     return false;

//   }

// }
 
// // ─── Test endpoint ────────────────────────────────────────────────────────────

// app.post("/test-journey", async (req, res) => {

//   const { mobileNo, name, product, locale } = req.body;
 
//   if (!mobileNo || !product) {

//     return res.status(400).json({ error: "mobileNo and product are required" });

//   }
 
//   console.log("\n========== /test-journey ==========");

//   console.log("Input:", { mobileNo, name, product, locale });
 
//   const deResult = await saveToFDLoanDE({

//     mobileNo,

//     name:        name || "Test User",

//     product,

//     createdDate: new Date().toISOString().split("T")[0],

//     locale:      locale || "IN"

//   });
 
//   const journeyResult = await fireJourneyEvent({

//     mobileNo,

//     name:    name || "Test User",

//     product,

//     locale:  "IN"

//   });
 
//   return res.status(200).json({

//     deResult:      deResult      ? "✅ saved" : "❌ failed",

//     journeyResult: journeyResult ? "✅ fired" : "❌ failed"

//   });

// });
 
// // ─── Webhook verify (GET) ─────────────────────────────────────────────────────

// app.get("/webhook", (req, res) => {

//   const mode      = req.query["hub.mode"];

//   const token     = req.query["hub.verify_token"];

//   const challenge = req.query["hub.challenge"];
 
//   if (mode === "subscribe" && token === VERIFY_TOKEN) {

//     console.log("[INFO] Webhook verified");

//     return res.status(200).send(challenge);

//   }

//   return res.sendStatus(403);

// });
 
// // ─── Webhook POST ─────────────────────────────────────────────────────────────

// app.post("/webhook", async (req, res) => {

//   const body = req.body;
 
//   if (body.object !== "whatsapp_business_account") {

//     return res.status(404).json({ status: "error", message: "Not a whatsapp_business_account event" });

//   }
 
//   try {

//     for (const entry of body.entry || []) {

//       for (const change of entry.changes || []) {

//         const messages = change.value?.messages  || [];

//         const contacts = change.value?.contacts  || [];
 
//         for (const message of messages) {

//           if (message.type !== "text") continue;
 
//           const text      = message.text?.body || "";

//           const upperText = text.toUpperCase();

//           const hasFD     = upperText.includes("FD");

//           const hasLoan   = upperText.includes("LOAN");
 
//           if (!hasFD && !hasLoan) continue;
 
//           const product     = hasFD ? "FD" : "Loan";

//           const mobileNo    = message.from;

//           const contact     = contacts.find((c) => c.wa_id === mobileNo);

//           const name        = contact?.profile?.name   || "";

//           const createdDate = new Date(message.timestamp * 1000).toISOString().split("T")[0];

//           const locale      = "IN";
 
//           console.log(`\n========== Incoming message ==========`);

//           console.log(`MobileNo: ${mobileNo} | Product: ${product} | Message: "${text}"`);

//           console.log(`Contact found: ${contact ? "YES" : "NO — name/locale will be empty"}`);
 
//           const saved = await saveToFDLoanDE({ name, mobileNo, product, createdDate, locale });
 
//           if (saved) {

//             await fireJourneyEvent({ name, mobileNo, product, locale });

//           } else {

//             console.warn(`[WARN] Skipping journey event — DE save failed | MobileNo: ${mobileNo}`);

//           }

//         }

//       }

//     }

//   } catch (err) {

//     console.error("[ERROR] Webhook processing failed:", err.message);

//     return res.status(500).json({ status: "error", message: err.message });

//   }
 
//   return res.status(200).json({ status: "ok" });

// });
 
// const PORT = process.env.PORT || 3000;

// app.listen(PORT, () => console.log(`[INFO] Server running on port ${PORT}`));






// require("dotenv").config();
// const express = require("express");
// const axios = require("axios");

// const app = express();
// app.use(express.json({ limit: "1mb" }));

// const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "myWebhookToken123";

// const SFMC = {
//   clientId: "te9gxl0yt9mwj8k0vmradod2",
//   clientSecret: "4Nk2e5cKWaaRSYXVUdubvyPf",
//   authUrl: "https://mcpn9815n8n8wcj-xnx5frlx03bq.auth.marketingcloudapis.com/v2/token",
//   restUrl: "https://mcpn9815n8n8wcj-xnx5frlx03bq.rest.marketingcloudapis.com",
//   deKey: process.env.SFMC_DE_KEY || "FD_Loan_DE",
//   journeyEventKey: "APIEvent-5933304e-0e6e-4df0-b97b-5e7337bc67ef"
// };

// // ─── Token cache ──────────────────────────────────────────────────────────────
// let tokenCache = { value: null, expiresAt: null };

// async function getSFMCToken() {
//   const now = Date.now();
//   if (tokenCache.value && now < tokenCache.expiresAt - 60000) return tokenCache.value;

//   const response = await axios.post(
//     SFMC.authUrl,
//     {
//       grant_type: "client_credentials",
//       client_id: SFMC.clientId,
//       client_secret: SFMC.clientSecret
//     }
//   );

//   tokenCache.value = response.data.access_token;
//   tokenCache.expiresAt = now + response.data.expires_in * 1000;
//   console.log("[INFO] New SFMC token fetched");
//   return tokenCache.value;
// }

// // ─── Save to FD_Loan_DE ───────────────────────────────────────────────────────
// async function saveToFDLoanDE({ name, mobileNo, product, createdDate, locale }) {
//   try {
//     const token = await getSFMCToken();

//     const payload = [
//       {
//         keys: {
//           MobileNo: mobileNo,
//           Product: product
//         },
//         values: {
//           Name: name || "",
//           CreatedDate: createdDate || "",
//           Locale: locale || "",
//           Mobile_No: mobileNo ? `+${mobileNo.replace(/^\+/, "")}` : ""
//         }
//       }
//     ];

//     const sfmcRes = await axios.post(
//       `${SFMC.restUrl}/hub/v1/dataevents/key:${SFMC.deKey}/rowset`,
//       payload,
//       { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
//     );

//     console.log(`[INFO] Saved to FD_Loan_DE | MobileNo: ${mobileNo} | Product: ${product}`);
//     console.log("[DEBUG] DE response:", JSON.stringify(sfmcRes.data, null, 2));
//     console.log("[DEBUG] DE payload sent:", JSON.stringify(payload, null, 2));

//     return true; // ← signal success to caller
//   } catch (err) {
//     if (err.response?.status === 401) tokenCache = { value: null, expiresAt: null };
//     console.error("[ERROR] Failed to save to FD_Loan_DE:", err.response?.data || err.message);
//     return false;
//   }
// }

// // ─── Fire Journey Builder Entry Event ────────────────────────────────────────
// async function fireJourneyEvent({ name, mobileNo, product, createdDate, locale }) {
//   try {
//     const token = await getSFMCToken();

//     const payload = {
//       ContactKey: mobileNo,
//       EventDefinitionKey: SFMC.journeyEventKey,
//       Data: {
//         MobileNo: mobileNo,
//         Name: name || "",
//         Product: product || "",
//         Mobile_No: mobileNo,         // ← no + prefix, matching your working Postman payload
//         Locale: locale || ""
//         // CreatedDate intentionally omitted — not in your working Postman payload
//       }
//     };

//     const sfmcRes = await axios.post(
//       `${SFMC.restUrl}/interaction/v1/events`,
//       payload,
//       { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
//     );

//     console.log(`[INFO] Journey event fired | MobileNo: ${mobileNo} | Product: ${product}`);
//     console.log("[DEBUG] Journey event response:", JSON.stringify(sfmcRes.data, null, 2));
//     console.log("[DEBUG] Journey event payload:", JSON.stringify(payload, null, 2));
//   } catch (err) {
//     if (err.response?.status === 401) tokenCache = { value: null, expiresAt: null };
//     console.error("[ERROR] Failed to fire journey event:", err.response?.data || err.message);
//     console.error("[ERROR] Journey event error details:", JSON.stringify(err.response?.data, null, 2));
//   }
// }

// // ─── Webhook verify ───────────────────────────────────────────────────────────
// app.get("/webhook", (req, res) => {
//   const mode = req.query["hub.mode"];
//   const token = req.query["hub.verify_token"];
//   const challenge = req.query["hub.challenge"];

//   if (mode === "subscribe" && token === VERIFY_TOKEN) {
//     console.log("[INFO] Webhook verified");
//     return res.status(200).send(challenge);
//   }
//   return res.sendStatus(403);
// });

// // ─── Webhook POST ─────────────────────────────────────────────────────────────
// app.post("/webhook", async (req, res) => {
//   const body = req.body;

//   if (body.object !== "whatsapp_business_account") {
//     return res.status(404).json({ status: "error", message: "Not a whatsapp_business_account event" });
//   }

//   try {
//     for (const entry of body.entry || []) {
//       for (const change of entry.changes || []) {
//         const messages = change.value?.messages || [];
//         const contacts = change.value?.contacts || [];

//         for (const message of messages) {
//           if (message.type !== "text") continue;

//           const text = message.text?.body || "";
//           const upperText = text.toUpperCase();

//           const hasFD = upperText.includes("FD");
//           const hasLoan = upperText.includes("LOAN");

//           if (!hasFD && !hasLoan) continue;

//           const product = hasFD ? "FD" : "Loan";
//           const mobileNo = message.from;
//           const contact = contacts.find((c) => c.wa_id === mobileNo);
//           const name = contact?.profile?.name || "";
//           const createdDate = new Date(message.timestamp * 1000).toISOString().split("T")[0];
//           const locale = contact?.profile?.locale || "";

//           console.log(`[INFO] Keyword matched | MobileNo: ${mobileNo} | Product: ${product} | Message: "${text}"`);

//           // Step 1: Save to DE first, then fire journey (sequential, not parallel)
//           const saved = await saveToFDLoanDE({ name, mobileNo, product, createdDate, locale });

//           // Step 2: Fire journey only after DE save succeeds
//           if (saved) {
//             await fireJourneyEvent({ name, mobileNo, product, createdDate, locale });
//           } else {
//             console.warn(`[WARN] Skipping journey event — DE save failed | MobileNo: ${mobileNo}`);
//           }
//         }
//       }
//     }
//   } catch (err) {
//     console.error("[ERROR] Webhook processing failed:", err.message);
//     return res.status(500).json({ status: "error", message: err.message });
//   }

//   return res.status(200).json({ status: "ok" });
// });

// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => console.log(`[INFO] Server running on port ${PORT}`));











// require("dotenv").config();
// const express = require("express");
// const axios = require("axios");

// const app = express();
// app.use(express.json({ limit: "1mb" }));

// const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "myWebhookToken123";

// const SFMC = {
//   clientId: process.env.SFMC_CLIENT_ID,
//   clientSecret: process.env.SFMC_CLIENT_SECRET,
//   subdomain: process.env.SFMC_SUBDOMAIN,
//   deKey: process.env.SFMC_DE_KEY || "FD_Loan_DE"
// };

// // ─── Token cache ──────────────────────────────────────────────────────────────
// let tokenCache = { value: null, expiresAt: null };

// async function getSFMCToken() {
//   const now = Date.now();
//   if (tokenCache.value && now < tokenCache.expiresAt - 60000) return tokenCache.value;

//   const response = await axios.post(
//     `https://${SFMC.subdomain}.auth.marketingcloudapis.com/v2/token`,
//     {
//       grant_type: "client_credentials",
//       client_id: SFMC.clientId,
//       client_secret: SFMC.clientSecret
//     }
//   );

//   tokenCache.value = response.data.access_token;
//   tokenCache.expiresAt = now + response.data.expires_in * 1000;
//   console.log("[INFO] New SFMC token fetched");
//   return tokenCache.value;
// }

// // ─── Save to FD_Loan_DE ───────────────────────────────────────────────────────
// async function saveToFDLoanDE({ name, mobileNo, product, createdDate, locale }) {
//   try {
//     const token = await getSFMCToken();

//     const payload = [
//       {
//         keys: {
//           MobileNo: mobileNo,
//           Product: product        // ← primary keys
//         },
//         values: {
//           Name: name || "",
//           CreatedDate: createdDate || "",
//           Locale: locale || "",
//           Mobile_No: mobileNo ? `+${mobileNo.replace(/^\+/, "")}` : ""  // ← formatted with + prefix for SFMC Phone type
//         }
//       }
//     ];

//     const sfmcRes = await axios.post(
//       `https://${SFMC.subdomain}.rest.marketingcloudapis.com/hub/v1/dataevents/key:${SFMC.deKey}/rowset`,
//       payload,
//       { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
//     );

//     console.log(`[INFO] Saved to FD_Loan_DE | MobileNo: ${mobileNo} | Product: ${product}`);
//     console.log("[DEBUG] SFMC response:", JSON.stringify(sfmcRes.data, null, 2));
//     console.log("[DEBUG] Payload sent:", JSON.stringify(payload, null, 2));
//   } catch (err) {
//     if (err.response?.status === 401) tokenCache = { value: null, expiresAt: null };
//     console.error("[ERROR] Failed to save to FD_Loan_DE:", err.response?.data || err.message);
//   }
// }

// // ─── Webhook verify ───────────────────────────────────────────────────────────
// app.get("/webhook", (req, res) => {
//   const mode = req.query["hub.mode"];
//   const token = req.query["hub.verify_token"];
//   const challenge = req.query["hub.challenge"];

//   if (mode === "subscribe" && token === VERIFY_TOKEN) {
//     console.log("[INFO] Webhook verified");
//     return res.status(200).send(challenge);
//   }
//   return res.sendStatus(403);
// });

// // ─── Webhook POST ─────────────────────────────────────────────────────────────
// app.post("/webhook", async (req, res) => {
//   const body = req.body;

//   if (body.object !== "whatsapp_business_account") {
//     return res.status(404).json({ status: "error", message: "Not a whatsapp_business_account event" });
//   }

//   try {
//     for (const entry of body.entry || []) {
//       for (const change of entry.changes || []) {
//         const messages = change.value?.messages || [];
//         const contacts = change.value?.contacts || [];

//         for (const message of messages) {
//           // Only handle text messages
//           if (message.type !== "text") continue;

//           const text = message.text?.body || "";
//           const upperText = text.toUpperCase();

//           // ── Check if message contains FD or Loan ─────────────────────────
//           const hasFD = upperText.includes("FD");
//           const hasLoan = upperText.includes("LOAN");

//           if (!hasFD && !hasLoan) continue;   // skip unrelated messages

//           const product = hasFD ? "FD" : "Loan";   // FD takes priority if both present
//           const mobileNo = message.from;
//           const contact = contacts.find((c) => c.wa_id === mobileNo);
//           const name = contact?.profile?.name || "";
//           const createdDate = new Date(message.timestamp * 1000).toISOString().split("T")[0]; // YYYY-MM-DD
//           const locale = contact?.profile?.locale || "";

//           console.log(`[INFO] Keyword matched | MobileNo: ${mobileNo} | Product: ${product} | Message: "${text}"`);

//           // Save to DE (non-blocking)
//           saveToFDLoanDE({ name, mobileNo, product, createdDate, locale });
//         }
//       }
//     }
//   } catch (err) {
//     console.error("[ERROR] Webhook processing failed:", err.message);
//     return res.status(500).json({ status: "error", message: err.message });
//   }

//   return res.status(200).json({ status: "ok" });
// });

// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => console.log(`[INFO] Server running on port ${PORT}`));




// require("dotenv").config();
// const express = require("express");
// const axios = require("axios");

// const app = express();
// app.use(express.json({ limit: "1mb" }));

// const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "myWebhookToken123";

// const SFMC = {
//   clientId: process.env.SFMC_CLIENT_ID,
//   clientSecret: process.env.SFMC_CLIENT_SECRET,
//   subdomain: process.env.SFMC_SUBDOMAIN,
//   deKey: process.env.SFMC_DE_KEY || "FD_Loan_DE"
// };

// // ─── Token cache ──────────────────────────────────────────────────────────────
// let tokenCache = { value: null, expiresAt: null };

// async function getSFMCToken() {
//   const now = Date.now();
//   if (tokenCache.value && now < tokenCache.expiresAt - 60000) return tokenCache.value;

//   const response = await axios.post(
//     `https://${SFMC.subdomain}.auth.marketingcloudapis.com/v2/token`,
//     {
//       grant_type: "client_credentials",
//       client_id: SFMC.clientId,
//       client_secret: SFMC.clientSecret
//     }
//   );

//   tokenCache.value = response.data.access_token;
//   tokenCache.expiresAt = now + response.data.expires_in * 1000;
//   console.log("[INFO] New SFMC token fetched");
//   return tokenCache.value;
// }

// // ─── Save to FD_Loan_DE ───────────────────────────────────────────────────────
// async function saveToFDLoanDE({ name, mobileNo, product, createdDate, locale }) {
//   try {
//     const token = await getSFMCToken();

//     const payload = [
//       {
//         keys: {
//           MobileNo: mobileNo,
//           Product: product        // ← primary key
//         },
//         values: {
//           Name: name || "",
//           CreatedDate: createdDate || "",
//           Locale: locale || ""
//         }
//       }
//     ];

//     await axios.post(
//       `https://${SFMC.subdomain}.rest.marketingcloudapis.com/hub/v1/dataevents/key:${SFMC.deKey}/rowset`,
//       payload,
//       { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
//     );

//     console.log(`[INFO] Saved to FD_Loan_DE | MobileNo: ${mobileNo} | Product: ${product}`);
//   } catch (err) {
//     if (err.response?.status === 401) tokenCache = { value: null, expiresAt: null };
//     console.error("[ERROR] Failed to save to FD_Loan_DE:", err.response?.data || err.message);
//   }
// }

// // ─── Webhook verify ───────────────────────────────────────────────────────────
// app.get("/webhook", (req, res) => {
//   const mode = req.query["hub.mode"];
//   const token = req.query["hub.verify_token"];
//   const challenge = req.query["hub.challenge"];

//   if (mode === "subscribe" && token === VERIFY_TOKEN) {
//     console.log("[INFO] Webhook verified");
//     return res.status(200).send(challenge);
//   }
//   return res.sendStatus(403);
// });

// // ─── Webhook POST ─────────────────────────────────────────────────────────────
// app.post("/webhook", async (req, res) => {
//   const body = req.body;

//   if (body.object !== "whatsapp_business_account") {
//     return res.status(404).json({ status: "error", message: "Not a whatsapp_business_account event" });
//   }

//   try {
//     for (const entry of body.entry || []) {
//       for (const change of entry.changes || []) {
//         const messages = change.value?.messages || [];
//         const contacts = change.value?.contacts || [];

//         for (const message of messages) {
//           // Only handle text messages
//           if (message.type !== "text") continue;

//           const text = message.text?.body || "";
//           const upperText = text.toUpperCase();

//           // ── Check if message contains FD or Loan ─────────────────────────
//           const hasFD = upperText.includes("FD");
//           const hasLoan = upperText.includes("LOAN");

//           if (!hasFD && !hasLoan) continue;   // skip unrelated messages

//           const product = hasFD ? "FD" : "Loan";   // FD takes priority if both present
//           const mobileNo = message.from;
//           const contact = contacts.find((c) => c.wa_id === mobileNo);
//           const name = contact?.profile?.name || "";
//           const createdDate = new Date(message.timestamp * 1000).toISOString().split("T")[0]; // YYYY-MM-DD
//           const locale = contact?.profile?.locale || "";

//           console.log(`[INFO] Keyword matched | MobileNo: ${mobileNo} | Product: ${product} | Message: "${text}"`);

//           // Save to DE (non-blocking)
//           saveToFDLoanDE({ name, mobileNo, product, createdDate, locale });
//         }
//       }
//     }
//   } catch (err) {
//     console.error("[ERROR] Webhook processing failed:", err.message);
//     return res.status(500).json({ status: "error", message: err.message });
//   }

//   return res.status(200).json({ status: "ok" });
// });

// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => console.log(`[INFO] Server running on port ${PORT}`));




// require("dotenv").config();
// const express = require("express");
// const axios = require("axios");

// const app = express();
// app.use(express.json({ limit: "1mb" }));

// const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "myWebhookToken123";

// const SFMC = {
//   clientId: process.env.SFMC_CLIENT_ID,
//   clientSecret: process.env.SFMC_CLIENT_SECRET,
//   subdomain: process.env.SFMC_SUBDOMAIN,
//   deKey: process.env.SFMC_DE_KEY || "FD_Loan_DE"
// };

// // ─── Token cache ──────────────────────────────────────────────────────────────
// let tokenCache = { value: null, expiresAt: null };

// async function getSFMCToken() {
//   const now = Date.now();
//   if (tokenCache.value && now < tokenCache.expiresAt - 60000) return tokenCache.value;

//   const response = await axios.post(
//     `https://${SFMC.subdomain}.auth.marketingcloudapis.com/v2/token`,
//     {
//       grant_type: "client_credentials",
//       client_id: SFMC.clientId,
//       client_secret: SFMC.clientSecret
//     }
//   );

//   tokenCache.value = response.data.access_token;
//   tokenCache.expiresAt = now + response.data.expires_in * 1000;
//   console.log("[INFO] New SFMC token fetched");
//   return tokenCache.value;
// }

// // ─── Save to FD_Loan_DE ───────────────────────────────────────────────────────
// async function saveToFDLoanDE({ name, phoneNumber, product, createdDate, locale }) {
//   try {
//     const token = await getSFMCToken();

//     const payload = [
//       {
//         keys: {
//           PhoneNumber: phoneNumber,
//           Product: product        // ← added as primary key
//         },
//         values: {
//           Name: name || "",
//           CreatedDate: createdDate || "",
//           Local: locale || ""
//         }
//       }
//     ];

//     await axios.post(
//       `https://${SFMC.subdomain}.rest.marketingcloudapis.com/hub/v1/dataevents/key:${SFMC.deKey}/rowset`,
//       payload,
//       { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
//     );

//     console.log(`[INFO] Saved to FD_Loan_DE | Phone: ${phoneNumber} | Product: ${product}`);
//   } catch (err) {
//     if (err.response?.status === 401) tokenCache = { value: null, expiresAt: null };
//     console.error("[ERROR] Failed to save to FD_Loan_DE:", err.response?.data || err.message);
//   }
// }

// // ─── Webhook verify ───────────────────────────────────────────────────────────
// app.get("/webhook", (req, res) => {
//   const mode = req.query["hub.mode"];
//   const token = req.query["hub.verify_token"];
//   const challenge = req.query["hub.challenge"];

//   if (mode === "subscribe" && token === VERIFY_TOKEN) {
//     console.log("[INFO] Webhook verified");
//     return res.status(200).send(challenge);
//   }
//   return res.sendStatus(403);
// });

// // ─── Webhook POST ─────────────────────────────────────────────────────────────
// app.post("/webhook", async (req, res) => {
//   const body = req.body;

//   if (body.object !== "whatsapp_business_account") {
//     return res.status(404).json({ status: "error", message: "Not a whatsapp_business_account event" });
//   }

//   try {
//     for (const entry of body.entry || []) {
//       for (const change of entry.changes || []) {
//         const messages = change.value?.messages || [];
//         const contacts = change.value?.contacts || [];

//         for (const message of messages) {
//           // Only handle text messages
//           if (message.type !== "text") continue;

//           const text = message.text?.body || "";
//           const upperText = text.toUpperCase();

//           // ── Check if message contains FD or Loan ─────────────────────────
//           const hasFD = upperText.includes("FD");
//           const hasLoan = upperText.includes("LOAN");

//           if (!hasFD && !hasLoan) continue;   // skip unrelated messages

//           const product = hasFD ? "FD" : "Loan";   // FD takes priority if both present
//           const from = message.from;
//           const contact = contacts.find((c) => c.wa_id === from);
//           const name = contact?.profile?.name || "";
//           const createdDate = new Date(message.timestamp * 1000).toISOString().split("T")[0]; // YYYY-MM-DD
//           const locale = contact?.profile?.locale || "";

//           console.log(`[INFO] Keyword matched | Phone: ${from} | Product: ${product} | Message: "${text}"`);

//           // Save to DE (non-blocking)
//           saveToFDLoanDE({ name, phoneNumber: from, product, createdDate, locale });
//         }
//       }
//     }
//   } catch (err) {
//     console.error("[ERROR] Webhook processing failed:", err.message);
//     return res.status(500).json({ status: "error", message: err.message });
//   }

//   return res.status(200).json({ status: "ok" });
// });

// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => console.log(`[INFO] Server running on port ${PORT}`));
