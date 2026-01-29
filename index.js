import express from "express";
import crypto from "crypto";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const jobs = new Map();

/**
 * -------------------------
 * CREATE SCENARIO
 * -------------------------
 */
app.post("/create", async (req, res) => {
  try {
    const { country, sector, description, trends, analysisFocus } = req.body;
    if (!country || !sector || !description)
      return res.status(400).json({ error: "Missing inputs" });

    const jobId = crypto.randomUUID();
    jobs.set(jobId, { status: "queued", text: "", error: null });

    res.json({ success: true, jobId, status: "queued" });

    // Start streaming in background
    const userPrompt = buildUserPrompt({ country, sector, description, trends });
    runOpenAIJob(jobId, analysisFocus, userPrompt);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create scenario" });
  }
});

/**
 * -------------------------
 * STATUS
 * -------------------------
 */
app.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({
    success: true,
    status: job.status,
    scenario: job.text || null,
    error: job.error
  });
});

/**
 * -------------------------
 * STREAMING WORKER
 * -------------------------
 */
async function runOpenAIJob(jobId, analysisFocus, input) {
  try {
    jobs.set(jobId, { ...jobs.get(jobId), status: "in_progress" });

    const instructions = getInstructionsForMode(analysisFocus);

    const stream = await openai.responses.stream({
      model: "gpt-5.2",
      instructions,
      input,
      temperature: 0.5,
      max_output_tokens: 1200
    });

    let text = "";
    for await (const event of stream) {
      if (event.type === "output_text") {
        text += event.text;
        const job = jobs.get(jobId);
        job.text = text;
        jobs.set(jobId, job);
      }
    }

    jobs.set(jobId, { ...jobs.get(jobId), status: "completed", text });

  } catch (err) {
    console.error("OpenAI streaming error:", err);
    jobs.set(jobId, { status: "failed", text: "", error: err.message });
  }
}

/**
 * -------------------------
 * HELPERS
 * -------------------------
 */
function buildUserPrompt({ country, sector, description, trends }) {
  const trendLines = Object.entries(normalizeTrends(trends || {}))
    .map(([k, v]) => `- ${k}: Level ${v}`)
    .join("\n");

  return `
Context
Country: ${country}
Sector: ${sector}

Description
${description}

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
 * START SERVER
 * -------------------------
 */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port", port));
