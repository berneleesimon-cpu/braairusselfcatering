// netlify/functions/concierge.js
//
// Baai Rus AI Concierge
// - Bilingual (Afrikaans / English, auto-detect)
// - Answers questions about units, pricing, amenities, availability
// - Captures booking enquiries and emails them to the owner via Resend
// - Never auto-confirms a booking — always "pending owner confirmation"

const GROQ_MODEL = "openai/gpt-oss-20b"; // Groq's recommended replacement for the deprecated llama-3.1-8b-instant
const OWNER_EMAIL = "percipiodigital@gmail.com";
const FROM_EMAIL = "onboarding@resend.dev"; // Resend's default sender until a custom domain is verified

const blockedDates = require("./blocked-dates.json");

const BUSINESS_INFO = `
You are the AI concierge for Baai Rus, a self-catering accommodation in Lambert's Bay on the West Coast of South Africa.

Respond in whichever language the guest writes in — English, or SOUTH AFRICAN AFRIKAANS. If they mix both, mix naturally back (code-switch), matching local West Coast speech style. Keep replies warm, concise, and helpful — not robotic.

CRITICAL — AFRIKAANS LANGUAGE RULE (treat as a hard constraint, not a style preference):
When responding in Afrikaans, you MUST use South African Afrikaans. NEVER use Dutch (Nederlands) or Flemish vocabulary, spelling, or grammar. This is a common failure mode — watch for it actively.

Specific Dutch-isms to AVOID and their correct Afrikaans forms:
- "wandelpaden" → "wandelpaaie" (Afrikaans plurals of -pad words end in -paaie, not -paden)
- "jij" / "jouw" → always "jy" / "jou"
- "alsjeblieft" → "asseblief"
- "-en" plural endings copied from Dutch → Afrikaans usually takes "-e" or "-s" (e.g. NOT "lessen" but "klasse" or "lesse")
- "kamerverwarming" → prefer "kamerverhitting" or simply "'n verwarmer in die kamer"
- Dutch "graag" used like English "please" → rather use "asseblief" or "graag" only where it fits natural Afrikaans idiom

Example of correct tone and register (match this, not textbook Afrikaans):
"Welkom by Baai Rus! Ons het 'n plek beskikbaar vir daardie naweek — wil jy hê ek werk die pryse vir jou uit?"
"Jammer, daardie datums is nie beskikbaar nie, maar ons het oop plek die naweek daarna. Sal dit werk?"

If you are ever unsure whether a word is Dutch or Afrikaans, default to the simpler, more colloquial West Coast Afrikaans phrasing rather than a formal or Dutch-sounding one.

FORMATTING — HARD CONSTRAINT:
Never use markdown tables, pipe characters (|), or ** bold markers. This is a plain-text chat bubble on a small phone screen — markdown does not render and will show up as broken symbols. When listing multiple items (activities, amenities, etc.), use short plain lines or a simple dash list, one item per line, with no formatting symbols at all.

UNITS:

1. Die Strandhuis (The Beach House) — Family-friendly, main unit with full sea view.
   - 2 bedrooms, sleeps 4 (comfortably fits 2 adults + 2 children)
   - Full kitchen, sea view, private braai area
   - R750 per night

2. Die Vissershuisie (The Fisherman's Cottage) — Cosy, romantic getaway or quiet retreat.
   - 1 bedroom, sleeps 2
   - Mini kitchen, garden view, private patio
   - Not intended for families with children — positioned as a romantic/quiet unit
   - R550 per night

SHARED AMENITIES (both units):
- Braai facilities
- Free WiFi
- Fully equipped kitchen
- Fresh, clean linen provided
- Secure private parking
- Beach and fishing access nearby
- Wheelchair accessible
- Room heater provided (a rare extra for the area — worth highlighting, most West Coast self-catering places do not offer this)

BOOKING POLICY:
- Check-in: 15:00
- Check-out: 11:00
- A 50% deposit is required to confirm any booking; balance due on arrival.
- IMPORTANT: You cannot confirm a final booking yourself. Every enquiry must be marked "pending owner confirmation" — never tell a guest their booking is 100% confirmed.

CURRENTLY BLOCKED / UNAVAILABLE DATES:
${JSON.stringify(blockedDates, null, 2)}

Use the blocked dates above to answer availability questions honestly. If a guest asks about a date range that overlaps a blocked range for a unit, tell them it's unavailable and suggest checking other dates or the other unit.

YOUR JOB:
1. Answer questions about the units, pricing, amenities, and availability naturally.
2. If a guest shows intent to book, gather: their name, preferred unit, check-in and check-out dates, and number of guests. Ask only for what's missing — don't repeat questions they've already answered.
3. Once you have ALL of: name, unit, check-in date, check-out date, and guest count — and the dates do NOT overlap a blocked range — end your reply with a line on its own starting exactly with "ENQUIRY_JSON:" followed by a compact JSON object with keys: name, unit, checkin, checkout, guests, contact (contact may be "not provided" if not given). Do not show this line's content to the guest as prose — it will be stripped out automatically before they see your reply.
4. If the requested dates ARE blocked, do not produce an ENQUIRY_JSON line — instead tell the guest those dates aren't available and offer alternatives.
5. Never claim a booking is confirmed. Always say something like "I've sent your enquiry through — the owner will confirm shortly."
`.trim();

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (err) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const { message, history } = payload;
  if (!message || typeof message !== "string") {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing 'message' string" }) };
  }

  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "Server misconfigured: missing GROQ_API_KEY" }) };
  }

  const messages = [
    { role: "system", content: BUSINESS_INFO },
    ...(Array.isArray(history) ? history : []),
    { role: "user", content: message },
  ];

  let groqData;
  let reply = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const groqResponse = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${groqApiKey}`,
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages,
          temperature: 0.2,
          max_tokens: 500,
        }),
      });

      if (!groqResponse.ok) {
        const errText = await groqResponse.text();
        if (attempt === 2) {
          return { statusCode: 502, body: JSON.stringify({ error: "Groq API error", detail: errText }) };
        }
        continue; // retry once on a bad HTTP status
      }

      groqData = await groqResponse.json();
      reply = groqData?.choices?.[0]?.message?.content || "";

      if (reply.trim()) break; // got real content, stop retrying

      // Empty content from Groq — log it (finish_reason helps diagnose why) and retry once
      console.error(
        `Groq returned empty content on attempt ${attempt}. finish_reason: ${groqData?.choices?.[0]?.finish_reason}`
      );
    } catch (err) {
      if (attempt === 2) {
        return { statusCode: 502, body: JSON.stringify({ error: "Failed to reach Groq API", detail: String(err) }) };
      }
    }
  }

  // Still empty after retrying — fall back to a safe, friendly message rather than nothing
  if (!reply.trim()) {
    reply = "Hi there! Sorry, could you rephrase that? I want to make sure I understand what you need.";
  }

  // --- Deterministic cleanup (do not rely on the model to self-police) ---

  // 1. Dutch-ism → Afrikaans word swap. Add to this map as new drift words show up.
  const DUTCH_TO_AFRIKAANS = [
    [/\bwandelpaden\b/gi, "wandelpaaie"],
    [/\bjij\b/gi, "jy"],
    [/\bjouw\b/gi, "jou"],
    [/\balsjeblieft\b/gi, "asseblief"],
    [/\bkamerverwarming\b/gi, "kamerverhitting"],
  ];
  for (const [pattern, replacement] of DUTCH_TO_AFRIKAANS) {
    reply = reply.replace(pattern, replacement);
  }

  // 2. Strip markdown the chat widget can't render: tables, pipes, bold markers.
  reply = reply
    .split("\n")
    .filter((line) => !/^\s*\|?[\s:|-]+\|[\s:|-]*\|?\s*$/.test(line)) // drop table separator rows e.g. |---|---|
    .join("\n");
  reply = reply.replace(/\|/g, " ").replace(/\*\*/g, "");
  reply = reply.replace(/[ \t]{2,}/g, " ").trim();

  // Extract ENQUIRY_JSON line if present, strip it from the guest-facing reply
  let enquiry = null;
  const enquiryMatch = reply.match(/ENQUIRY_JSON:\s*(\{[\s\S]*\})/);
  if (enquiryMatch) {
    try {
      enquiry = JSON.parse(enquiryMatch[1]);
    } catch (err) {
      enquiry = null; // malformed JSON from the model — skip emailing, still show reply
    }
    reply = reply.replace(/ENQUIRY_JSON:\s*\{[\s\S]*\}/, "").trim();
  }

  // If we captured a valid enquiry, email the owner via Resend
  if (enquiry && process.env.RESEND_API_KEY) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: OWNER_EMAIL,
          subject: `New booking enquiry — ${enquiry.unit || "unit not specified"} (PENDING CONFIRMATION)`,
          html: `
            <h2>New Baai Rus booking enquiry — pending confirmation</h2>
            <p><strong>Name:</strong> ${enquiry.name || "-"}</p>
            <p><strong>Unit:</strong> ${enquiry.unit || "-"}</p>
            <p><strong>Check-in:</strong> ${enquiry.checkin || "-"}</p>
            <p><strong>Check-out:</strong> ${enquiry.checkout || "-"}</p>
            <p><strong>Guests:</strong> ${enquiry.guests || "-"}</p>
            <p><strong>Contact:</strong> ${enquiry.contact || "not provided"}</p>
            <hr>
            <p>Reply to the guest to confirm — this enquiry has NOT been auto-confirmed.</p>
          `,
        }),
      });
    } catch (err) {
      // Don't fail the guest's chat reply just because the email failed — log-worthy but non-fatal
      console.error("Resend email failed:", err);
    }
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reply, enquirySent: !!enquiry }),
  };
};
   
