require("dotenv").config();
const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "1mb" }));

const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "myWebhookToken123";

const SFMC = {
  clientId:    process.env.SFMC_CLIENT_ID,
  clientSecret: process.env.SFMC_CLIENT_SECRET,
  subdomain:   process.env.SFMC_SUBDOMAIN,
  deKey:       process.env.SFMC_DE_KEY || "FD_Loan_DE"
};

// ─── Token cache ──────────────────────────────────────────────────────────────
let tokenCache = { value: null, expiresAt: null };

async function getSFMCToken() {
  const now = Date.now();
  if (tokenCache.value && now < tokenCache.expiresAt - 60000) return tokenCache.value;

  const response = await axios.post(
    `https://${SFMC.subdomain}.auth.marketingcloudapis.com/v2/token`,
    {
      grant_type:    "client_credentials",
      client_id:     SFMC.clientId,
      client_secret: SFMC.clientSecret
    }
  );

  tokenCache.value     = response.data.access_token;
  tokenCache.expiresAt = now + response.data.expires_in * 1000;
  console.log("[INFO] New SFMC token fetched");
  return tokenCache.value;
}

// ─── Save to FD_Loan_DE ───────────────────────────────────────────────────────
async function saveToFDLoanDE({ name, phoneNumber, product, createdDate, locale }) {
  try {
    const token = await getSFMCToken();

    const payload = [
      {
        keys: { PhoneNumber: phoneNumber },
        values: {
          Name:        name        || "",
          Product:     product,               // "FD" or "Loan"
          CreatedDate: createdDate || "",
          Local:       locale      || ""
        }
      }
    ];

    await axios.post(
      `https://${SFMC.subdomain}.rest.marketingcloudapis.com/hub/v1/dataevents/key:${SFMC.deKey}/rowset`,
      payload,
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
    );

    console.log(`[INFO] Saved to FD_Loan_DE | Phone: ${phoneNumber} | Product: ${product}`);
  } catch (err) {
    if (err.response?.status === 401) tokenCache = { value: null, expiresAt: null };
    console.error("[ERROR] Failed to save to FD_Loan_DE:", err.response?.data || err.message);
  }
}

// ─── Webhook verify ───────────────────────────────────────────────────────────
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

// ─── Webhook POST ─────────────────────────────────────────────────────────────
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
          // Only handle text messages
          if (message.type !== "text") continue;

          const text        = message.text?.body || "";
          const upperText   = text.toUpperCase();

          // ── Check if message contains FD or Loan ─────────────────────────
          const hasFD   = upperText.includes("FD");
          const hasLoan = upperText.includes("LOAN");

          if (!hasFD && !hasLoan) continue;   // skip unrelated messages

          const product     = hasFD ? "FD" : "Loan";   // FD takes priority if both present
          const from        = message.from;
          const contact     = contacts.find((c) => c.wa_id === from);
          const name        = contact?.profile?.name || "";
          const createdDate = new Date(message.timestamp * 1000).toISOString().split("T")[0]; // YYYY-MM-DD
          const locale      = contact?.profile?.locale || "";

          console.log(`[INFO] Keyword matched | Phone: ${from} | Product: ${product} | Message: "${text}"`);

          // Save to DE (non-blocking)
          saveToFDLoanDE({ name, phoneNumber: from, product, createdDate, locale });
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