import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";

const app = express();
app.use(express.json());

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) console.error("Missing OPENAI_API_KEY");

/**
 * -------------------------
 * In-memory job store
 * -------------------------
 */
const jobs = new Map();

/**
 * -------------------------
 * Health check
 * -------------------------
 */
app.get("/health", (_, res) => {
  res.json({ ok: true });
});

/**
 * -------------------------
 * CREATE SCENARIO
 * -------------------------
 */
app.post("/create", async (req, res) => {
  try {
    const {
      country,
      sector,
      description,
      latitude,
      longitude,
      locationLabel,
      trends,
      analysisFocus
    } = req.body || {};

    if (!country || !sector || !description) {
      return res.status(400).json({ error: "Missing required inputs" });
    }

    if (!["project", "authorizationFramework"].includes(analysisFocus)) {
      return res.status(400).json({ error: "Invalid analysisFocus" });
    }

    const jobId = crypto.randomUUID();

    jobs.set(jobId, {
      status: "queued",
      text: "",
      error: null,
      startedAt: null,
      completedAt: null
    });

    const instructions = getInstructionsForMode(analysisFocus);
    const userPrompt = buildUserPrompt({
      country,
      sector,
      description,
      latitude,
      longitude,
      locationLabel,
      trends
    });

    // Fire and forget
    runOpenAIJob(jobId, instructions, userPrompt);

    res.json({
      success: true,
      jobId,
      status: "queued"
    });

  } catch (err) {
    console.error("create error:", err);
    res.status(500).json({ error: "Failed to create scenario" });
  }
});

/**
 * -------------------------
 * STATUS (polling)
 * -------------------------
 */
app.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);

  if (!job) return res.status(404).json({ error: "Job not found" });

  res.json({
    success: true,
    status: job.status,
    scenario: job.text || null,
    error: job.error || null
  });
});

/**
 * -------------------------
 * OpenAI streaming worker
 * -------------------------
 */
async function runOpenAIJob(jobId, instructions, input) {
  try {
    jobs.set(jobId, {
      ...jobs.get(jobId),
      status: "in_progress",
      startedAt: Date.now()
    });

    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5.2",
        instructions,
        input,
        temperature: 0.5,
        max_output_tokens: 1200,
        stream: true
      })
    });

    if (!resp.ok || !resp.body) {
      throw new Error(`OpenAI API error (${resp.status})`);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split("\n");

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        if (line === "data: [DONE]") continue;

        try {
          const json = JSON.parse(line.replace("data: ", ""));
          const delta = extractDeltaFromChunk(json);

          if (delta) {
            const job = jobs.get(jobId);
            job.text += delta;
            jobs.set(jobId, job);
          }
        } catch (_) {}
      }
    }

    jobs.set(jobId, {
      ...jobs.get(jobId),
      status: "completed",
      completedAt: Date.now()
    });

  } catch (err) {
    console.error("OpenAI streaming error:", err);
    jobs.set(jobId, {
      status: "failed",
      text: "",
      error: err.message
    });
  }
}

/**
 * -------------------------
 * Extract text from streaming chunk
 * -------------------------
 */
function extractDeltaFromChunk(json) {
  if (!json) return "";

  // Direct delta text
  if (json?.delta?.type === "output_text" && json.delta.text) return json.delta.text;

  // Older style
  if (json?.output_text) return json.output_text;

  // Look inside content array
  if (Array.isArray(json?.content)) {
    let text = "";
    for (const block of json.content) {
      if (block?.type === "output_text" && block.text) text += block.text;
      if (block?.type === "text" && block.text) text += block.text;
    }
    return text;
  }

  return "";
}

/**
 * -------------------------
 * Instructions
 * -------------------------
 */
function getInstructionsForMode(analysisFocus) {
  const COMMON = `
You are StratEko, a constraint-first analysis engine.
Use plain cause–effect language.
Output sections A–F using bullets only.
Classify intervention first.
Fail fast where constraints bind.
Keep sections concise.
`.trim();

  if (analysisFocus === "authorizationFramework") {
    return `${COMMON}
Authorization framework mode.
Focus on enforcement limits and defaults.
`.trim();
  }

  return `${COMMON}
Project evaluation mode.
Focus on feasibility and lock-in risk.
`.trim();
}

/**
 * -------------------------
 * Prompt building
 * -------------------------
 */
function buildUserPrompt({
  country,
  sector,
  description,
  latitude,
  longitude,
  locationLabel,
  trends
}) {
  const trendLines = Object.entries(normalizeTrends(trends || {}))
    .map(([k, v]) => `- ${k}: Level ${v}`)
    .join("\n");

  return `
Context
Country: ${country}
Sector: ${sector}

Description
${description}

Location
${latitude && longitude ? `Lat ${latitude}, Lon ${longitude}` : "Coordinates not provided"}
${locationLabel || ""}

Trends
${trendLines || "- none"}

Follow instructions exactly.
`.trim();
}

function normalizeTrends(trends) {
  const out = {};
  for (const [k, v] of Object.entries(trends)) {
    let n = Number(v);
    if (!Number.isFinite(n)) n = 1;
    out[k] = Math.min(3, Math.max(1, n));
  }
  return out;
}

/**
 * -------------------------
 * Server start
 * -------------------------
 */
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Render service running on port", port);
});
