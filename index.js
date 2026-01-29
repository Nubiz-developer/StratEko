import express from "express";
import crypto from "crypto";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const jobs = new Map();

app.post("/create", async (req, res) => {
  const { country, sector, description, trends, analysisFocus } = req.body;
  if (!country || !sector || !description) return res.status(400).json({ error: "Missing inputs" });

  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: "queued", text: "", error: null });

  res.json({ success: true, jobId, status: "queued" });

  // Start streaming in background
  const userPrompt = buildUserPrompt({ country, sector, description, trends });
  runOpenAIJob(jobId, analysisFocus, userPrompt);
});

app.get("/status/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json({ success: true, status: job.status, scenario: job.text || null, error: job.error });
});

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
    console.error(err);
    jobs.set(jobId, { status: "failed", text: "", error: err.message });
  }
}

// Helper functions (buildUserPrompt, getInstructionsForMode, normalizeTrends) remain the same

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on port", port));
