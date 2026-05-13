export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // --- HANDLE GET REQUESTS (Loading a saved reading) ---
    if (request.method === "GET") {
      const id = url.searchParams.get("id");
      if (!id) return new Response("Missing ID", { status: 400, headers: corsHeaders });

      try {
        const savedData = await env.READINGS_KV.get(id);
        if (!savedData) return new Response("Reading not found", { status: 404, headers: corsHeaders });
        
        return new Response(savedData, { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      } catch (err) {
        return new Response("Database error", { status: 500, headers: corsHeaders });
      }
    }

    // --- HANDLE POST REQUESTS (Generating a new reading) ---
    if (request.method === "POST") {
      try {
        const { hexagramTitle, question, hexagramId } = await request.json();

        const systemPrompt = `You are a wise, classical I Ching oracle. Provide a reading for Hexagram ${hexagramTitle}. 
        Keep the response elegant, deeply poetic, and somewhat calligraphic in tone. Do not use markdown formatting. 
        The user asks: "${question}"
        
        You must respond ONLY with a valid JSON object containing exactly two keys:
        "poem": A beautiful 4-line poetic summary of the reading.
        "desc": A single paragraph interpretation tailored specifically to the user's question and the hexagram.`;

        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
        
        const geminiResponse = await fetch(geminiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: systemPrompt }] }],
            generationConfig: { responseMimeType: "application/json" }
          })
        });

        const data = await geminiResponse.json();
        const aiTextRaw = data.candidates[0].content.parts[0].text;
        const aiData = JSON.parse(aiTextRaw);

        // Generate a random 8-character ID
        const uniqueId = Math.random().toString(36).substring(2, 10);
        
        // Construct the final object to save and return
        const finalReading = {
          id: uniqueId,
          hexagramId: hexagramId,
          title: hexagramTitle,
          poem: aiData.poem,
          desc: aiData.desc,
          question: question
        };

        // Save to KV (Stores it for 30 days to keep database clean, optional)
        await env.READINGS_KV.put(uniqueId, JSON.stringify(finalReading), { expirationTtl: 2592000 });

        return new Response(JSON.stringify(finalReading), { 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });

      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { 
          status: 500, 
          headers: { ...corsHeaders, "Content-Type": "application/json" } 
        });
      }
    }

    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }
};