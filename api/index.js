import { verifyToken } from '@clerk/backend';
import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

// Pro (paid, unlimited-beyond-account) is on the back burner until a payment
// provider is live. Flip this to true once Lemon Squeezy (or another
// provider) is wired up again - everything else is already in place.
const PRO_ENABLED = false;

const GUEST_LIMIT = 4;   // doubled from 2 while accounts are free-unlimited
const FREE_LIMIT = 3;    // only matters once PRO_ENABLED is true again
const GUEST_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const FREE_WINDOW_MS = 30 * 60 * 1000;  // 30 minutes
const HISTORY_LIMIT = 50;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    const url = new URL(request.url);

    if (url.pathname === "/webhook/lemonsqueezy" && request.method === "POST") {
      return handleLemonSqueezyWebhook(request, env);
    }

    if (url.pathname === "/history" && request.method === "GET") {
      return handleGetHistory(request, env);
    }

    if (request.method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return new Response("Missing ID", { status: 400, headers: corsHeaders });
      const savedData = await env.READINGS_KV.get(id);
      if (!savedData) return new Response("Not found", { status: 404, headers: corsHeaders });
      return new Response(savedData, { headers: jsonHeaders });
    }

    if (request.method === "POST") {
      return handleCreateReading(request, env);
    }

    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }
};

// --- IDENTIFY THE CALLER (CLERK AUTH OR GUEST PASS) ---
async function identifyUser(request, env) {
  const authHeader = request.headers.get("Authorization");
  const clientIP = request.headers.get("cf-connecting-ip") || "unknown_ip";

  if (authHeader && authHeader.startsWith("Bearer ") && authHeader !== "Bearer null" && authHeader !== "Bearer undefined") {
    const token = authHeader.split(" ")[1];
    try {
      const verifiedToken = await verifyToken(token, { secretKey: env.CLERK_SECRET_KEY });
      return { userId: verifiedToken.sub, isGuest: false };
    } catch (error) {
      return { authError: true };
    }
  }
  return { userId: `guest_${clientIP}`, isGuest: true };
}

// --- USAGE LEDGER: CHECK LIMIT, ROLL THE WINDOW, RETURN THE (UNSAVED) LEDGER ---
async function checkLimit(userId, isGuest, env) {
  const windowMs = isGuest ? GUEST_WINDOW_MS : FREE_WINDOW_MS;
  const limit = isGuest ? GUEST_LIMIT : FREE_LIMIT;
  const now = Date.now();

  let userData = await env.READINGS_KV.get(userId, "json");
  if (!userData) userData = { count: 0, isPro: false, lastReset: now };
  if (!userData.lastReset) userData.lastReset = now;

  if (now - userData.lastReset > windowMs) {
    userData.count = 0;
    userData.lastReset = now;
  }

  // While Pro is on the back burner, any signed-in account is unlimited.
  // Once PRO_ENABLED flips true, only actual Pro subscribers bypass the limit.
  if (!isGuest && (!PRO_ENABLED || userData.isPro)) {
    return { allowed: true, userData };
  }

  if (userData.count >= limit) {
    const timeLeft = Math.max(0, windowMs - (now - userData.lastReset));
    return { allowed: false, timeLeft, userData };
  }

  return { allowed: true, userData };
}

async function handleGetHistory(request, env) {
  const identity = await identifyUser(request, env);
  if (identity.authError || identity.isGuest) {
    return new Response(JSON.stringify({ error: "Sign in to view your reading history." }), { status: 401, headers: jsonHeaders });
  }
  const historyRaw = await env.READINGS_KV.get(`history_index_${identity.userId}`);
  const history = historyRaw ? JSON.parse(historyRaw) : [];
  return new Response(JSON.stringify(history), { headers: jsonHeaders });
}

async function appendToUserHistory(env, userId, reading) {
  const key = `history_index_${userId}`;
  const existingRaw = await env.READINGS_KV.get(key);
  const existing = existingRaw ? JSON.parse(existingRaw) : [];
  existing.unshift({ id: reading.id, title: reading.title, question: reading.question, imageData: reading.imageData });
  await env.READINGS_KV.put(key, JSON.stringify(existing.slice(0, HISTORY_LIMIT)));
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Only the primary model plus one fast backup - the other Gemini models this
// used to cycle through are capped at 20 requests/day, which makes them
// nearly useless as fallbacks while adding real latency when the primary is
// having a slow moment.
const GEMINI_TIMEOUT_MS = 6000;
const GEMINI_MODELS = [
  "gemini-3.1-flash-lite", // 500 RPD | 15 RPM
  "gemini-2.5-flash-lite"  // 20 RPD | 10 RPM
];

async function generateReadingText({ systemPromptText, historyContext, hexagramTitle, question, changingLinesContext, env, parsedCache }) {
  for (const model of GEMINI_MODELS) {
    try {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

      const geminiResponse = await fetchWithTimeout(geminiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemPromptText}\n\n${historyContext}\n\nCurrent Hexagram: ${hexagramTitle}. Current Question: "${question}".${changingLinesContext}\nCreate unique reading.` }] }],
          generationConfig: { responseMimeType: "application/json" }
        })
      }, GEMINI_TIMEOUT_MS);

      const data = await geminiResponse.json();

      if (geminiResponse.ok && data.candidates) {
        const aiTextRaw = data.candidates[0].content.parts[0].text.replace(/```json/g, "").replace(/```/g, "").trim();
        return JSON.parse(aiTextRaw);
      } else if (geminiResponse.status === 429 || geminiResponse.status >= 500) {
        continue;
      } else {
        throw new Error("Fatal Gemini API error.");
      }
    } catch (e) {
      console.error(`Fetch failed for ${model}:`, e.message);
    }
  }

  // ==========================================
  // CLOUDFLARE AI TEXT FALLBACK
  // ==========================================
  try {
    const messages = [
      { role: "system", content: systemPromptText },
      { role: "user", content: `${historyContext}\n\nCurrent Hexagram: ${hexagramTitle}. Current Question: "${question}".${changingLinesContext}\nReturn strictly JSON: {"poem": "line 1\\nline 2\\nline 3\\nline 4", "desc": "..."}` }
    ];

    const cfAiResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", { messages });

    // This model returns .response as an already-parsed object when it
    // sticks to the requested JSON shape, but fall back to parsing it as
    // text in case that ever changes.
    if (cfAiResponse.response && typeof cfAiResponse.response === "object" && cfAiResponse.response.poem && cfAiResponse.response.desc) {
      return cfAiResponse.response;
    } else if (typeof cfAiResponse.response === "string") {
      let cleanText = cfAiResponse.response.replace(/```json/gi, "").replace(/```/g, "").trim();
      const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
      throw new Error("Cloudflare AI did not return valid JSON.");
    } else {
      throw new Error("Cloudflare AI did not return valid JSON.");
    }
  } catch (cfError) {
    console.error("Cloudflare AI Fallback Failed:", cfError.message);

    // ULTIMATE FALLBACK: Both AIs failed. Use the Cache!
    if (parsedCache) {
      console.log("Using Cached Text as final safety net.");
      return { poem: parsedCache.poem, desc: parsedCache.desc };
    }
    throw new Error("The oracle is completely unreachable at this time.");
  }
}

async function generateHexagramImage(hexagramTitle, question, env, parsedCache) {
  try {
    // Your custom prompt is fully preserved here!
    const imagePrompt = `Truly random animal takes prominence and truly random element. Organic, fluid, loose, isolated floating on a pure stark white background. No borders, no frames, no geometric shapes, no hard edges. no off-whites or grey, only pure white. The artwork features a dynamic, free-flowing visual metaphor deeply relevant to the I Ching hexagram '${hexagramTitle}' and tailored to the user's question '${question}'. It creatively synthesizes a relevant totem animal and totem element in a natural, unconstrained way. Minimal, subtle blending organically. High-contrast with significant white negative space around the central subject. only two colours allowed #000000 and #ffffff Exclude all text, letters, or symbols.`;

    // Call Cloudflare's lightning fast image generation model
    const cfImageRaw = await env.AI.run("@cf/bytedance/stable-diffusion-xl-lightning", {
      prompt: imagePrompt
    });

    // Wrap the raw AI output in a standard Response object to safely extract the buffer
    const imgBuffer = await new Response(cfImageRaw).arrayBuffer();
    const imgUint8 = new Uint8Array(imgBuffer);

    // Convert to Base64 in safe chunks so we don't crash the Worker's memory limit
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < imgUint8.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, imgUint8.subarray(i, i + chunkSize));
    }

    // Format as a proper Image URL for the frontend
    return `data:image/png;base64,${btoa(binary)}`;

  } catch (imageError) {
    console.error("Image gen failed:", imageError.message);

    // ULTIMATE FALLBACK: Image gen failed. Use the Cache!
    if (parsedCache && parsedCache.imageData) {
      console.log("Using Cached Image as final safety net.");
      return parsedCache.imageData;
    }
    return null;
  }
}

async function handleCreateReading(request, env) {
  const identity = await identifyUser(request, env);
  if (identity.authError) {
    return new Response(JSON.stringify({ error: "Invalid ID badge." }), { status: 403, headers: jsonHeaders });
  }
  const { userId, isGuest } = identity;

  const limitCheck = await checkLimit(userId, isGuest, env);
  if (!limitCheck.allowed) {
    await env.READINGS_KV.put(userId, JSON.stringify(limitCheck.userData));
    return new Response(JSON.stringify({
      error: isGuest ? "guest_limit_reached" : "limit_reached",
      timeLeft: limitCheck.timeLeft
    }), { status: 403, headers: jsonHeaders });
  }
  const userData = limitCheck.userData;

  try {
    const { hexagramTitle, question, hexagramId, history } = await request.json();

    // ==========================================
    // CHANGING LINES LOGIC (I CHING MASTERY)
    // ==========================================
    let changingLinesContext = "";
    if (String(hexagramId).includes("|")) {
      // Extract the exact 6 coin tosses (e.g., "888976" -> [8,8,8,9,7,6])
      const castArray = hexagramId.split("|")[1].split("").map(Number);
      let movingLines = [];

      // I Ching lines are read from bottom (Toss 1) to top (Toss 6)
      castArray.forEach((sum, index) => {
        if (sum === 6) movingLines.push(`Line ${index + 1} (Old Yin changing to Yang)`);
        if (sum === 9) movingLines.push(`Line ${index + 1} (Old Yang changing to Yin)`);
      });

      if (movingLines.length > 0) {
        changingLinesContext = `\nCRITICAL I CHING RULE: The user cast specific changing lines. You MUST heavily incorporate the specific traditional text/wisdom of these moving lines into your interpretation:\n- ${movingLines.join("\n- ")}`;
      } else {
        changingLinesContext = `\nNote: There are no changing lines in this cast. Focus purely on the static, unchanging situation of the hexagram.`;
      }
    }

    // ==========================================
    // STRATEGY 1: PRELOAD CACHE (AS FALLBACK ONLY)
    // ==========================================
    const isGeneralReading = question === "Provide a general reading.";
    const cacheKey = `GENERAL_CACHE_${hexagramId}`;
    let parsedCache = null;

    // Fetch the cache but DO NOT return it yet. Hold it in memory just in case!
    if (isGeneralReading && (!history || history.length === 0)) {
      const cachedString = await env.READINGS_KV.get(cacheKey);
      if (cachedString) {
        parsedCache = JSON.parse(cachedString);
      }
    }

    // ==========================================
    // SMART SESSION MEMORY
    // ==========================================
    let historyContext = "";
    if (history && history.length > 0) {
      historyContext = "SESSION HISTORY CONTEXT:\nThe user has previously asked the following in this session:\n" +
        history.map(h => `- Question: "${h.question}" (Received Hexagram: ${h.title})`).join("\n") +
        "\n\nCRITICAL RULE: Evaluate this history. If the user's NEW question is related to these past questions, seamlessly weave the themes together. However, if the new question is about a completely unrelated topic, you MUST ignore the history and treat this as a totally independent, fresh reading.";
    }

    const systemPromptText = `You are a wise, classical I Ching oracle. Respond strictly in valid JSON format. Provide two keys: 'poem' (a unique 4-line poetic summary) and 'desc' (a philosophical paragraph interpretation tailored to the question). Keep the tone poetic and calligraphic. CRITICAL: Format 'poem' as a SINGLE continuous string of text. Do NOT use physical line breaks. Use the literal characters '\\n' to separate the lines of the poem.`;

    // Image generation doesn't depend on the text result, so kick it off
    // immediately instead of waiting for the text waterfall to finish first -
    // this roughly halves total latency on the common path.
    const imagePromise = generateHexagramImage(hexagramTitle, question, env, parsedCache);

    const aiData = await generateReadingText({ systemPromptText, historyContext, hexagramTitle, question, changingLinesContext, env, parsedCache });

    const base64Image = await imagePromise;

    // ==========================================
    // FINALIZE & SAVE
    // ==========================================

    // Cache the text AND the new image for future general readings
    if (isGeneralReading && (!history || history.length === 0) && aiData) {
      await env.READINGS_KV.put(cacheKey, JSON.stringify({ ...aiData, imageData: base64Image }));
    }

    const uniqueId = Math.random().toString(36).substring(2, 10);
    const newReading = {
      id: uniqueId,
      hexagramId,
      title: hexagramTitle,
      poem: aiData.poem,
      desc: aiData.desc,
      question,
      imageData: base64Image // Added the image to the final history save!
    };

    const updatedHistory = [...(history || []), newReading];
    await env.READINGS_KV.put(uniqueId, JSON.stringify(updatedHistory), { expirationTtl: 2592000 });

    // --- UPDATE THE LEDGER (SUCCESS) ---
    userData.count += 1;
    await env.READINGS_KV.put(userId, JSON.stringify(userData));

    // --- UPDATE THE SIGNED-IN USER'S HISTORY INDEX ---
    if (!isGuest) {
      await appendToUserHistory(env, userId, newReading);
    }

    return new Response(JSON.stringify({ ...newReading, sessionHistory: updatedHistory }), { headers: jsonHeaders });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: jsonHeaders });
  }
}

// --- LEMON SQUEEZY WEBHOOK: GRANT/REVOKE PRO ON SUBSCRIPTION EVENTS ---
async function handleLemonSqueezyWebhook(request, env) {
  const signature = request.headers.get("x-signature") || "";
  const rawBody = await request.text();

  const hmac = createHmac("sha256", env.LEMONSQUEEZY_WEBHOOK_SECRET);
  const digest = Buffer.from(hmac.update(rawBody).digest("hex"), "utf8");
  const sigBuffer = Buffer.from(signature, "utf8");

  if (digest.length !== sigBuffer.length || !timingSafeEqual(digest, sigBuffer)) {
    return new Response("Invalid signature", { status: 401 });
  }

  const payload = JSON.parse(rawBody);
  const eventName = payload?.meta?.event_name;
  const userId = payload?.meta?.custom_data?.user_id;

  if (!userId) {
    return new Response("OK (no user_id in custom_data)", { status: 200 });
  }

  const GRANT_EVENTS = ["subscription_created", "subscription_payment_success", "subscription_resumed", "subscription_unpaused"];
  const REVOKE_EVENTS = ["subscription_cancelled", "subscription_expired", "subscription_payment_failed"];

  if (GRANT_EVENTS.includes(eventName) || REVOKE_EVENTS.includes(eventName)) {
    let userData = await env.READINGS_KV.get(userId, "json");
    if (!userData) userData = { count: 0, isPro: false, lastReset: Date.now() };
    userData.isPro = GRANT_EVENTS.includes(eventName);
    await env.READINGS_KV.put(userId, JSON.stringify(userData));
  }

  return new Response("OK", { status: 200 });
}
