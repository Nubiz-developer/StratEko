import express from "express";
import crypto from "crypto";
import OpenAI from "openai";

const app = express();
app.use(express.json());

// CORS for Wix
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(200);
    next();
});

// Initialize OpenAI client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// In-memory job store
const jobs = new Map();

/**
 * -------------------------
 * HEALTH CHECK
 * -------------------------
 */
app.get("/", (req, res) => {
    res.json({
        status: "ok",
        service: "StratEko Streaming Proxy",
        activeJobs: jobs.size
    });
});

/**
 * -------------------------
 * CREATE SCENARIO (START STREAMING)
 * -------------------------
 */
app.post("/api/create", async (req, res) => {
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
        } = req.body;

        // Validation
        if (!country || !sector || !description) {
            return res.status(400).json({
                success: false,
                error: "Missing required inputs: country, sector, description"
            });
        }

        if (!analysisFocus || !["project", "authorizationFramework"].includes(analysisFocus)) {
            return res.status(400).json({
                success: false,
                error: "analysisFocus must be 'project' or 'authorizationFramework'"
            });
        }

        // Create job
        const jobId = crypto.randomUUID();
        jobs.set(jobId, {
            status: "queued",
            text: "",
            error: null,
            createdAt: Date.now(),
            tokensUsed: 0
        });

        // Return immediately
        res.json({
            success: true,
            jobId,
            status: "queued"
        });

        // Start streaming in background
        const userPrompt = buildUserPrompt({
            country,
            sector,
            description,
            latitude,
            longitude,
            locationLabel,
            trends
        });

        const instructions = getInstructionsForMode(analysisFocus);

        runStreamingJob(jobId, instructions, userPrompt);

    } catch (err) {
        console.error("Create scenario error:", err);
        res.status(500).json({
            success: false,
            error: err.message || "Failed to create scenario"
        });
    }
});

/**
 * -------------------------
 * GET STATUS (POLLING ENDPOINT)
 * -------------------------
 */
app.get("/api/status/:jobId", (req, res) => {
    const job = jobs.get(req.params.jobId);

    if (!job) {
        return res.status(404).json({
            success: false,
            error: "Job not found"
        });
    }

    res.json({
        success: true,
        status: job.status,
        scenario: job.text || "",
        error: job.error,
        tokensUsed: job.tokensUsed,
        progress: {
            characterCount: job.text ? job.text.length : 0,
            estimatedCompletion: job.status === "in_progress" ?
                Math.min(95, Math.floor((job.text.length / 3000) * 100)) :
                (job.status === "completed" ? 100 : 0)
        }
    });
});

/**
 * -------------------------
 * STREAMING WORKER - USING CHAT COMPLETIONS (WORKS!)
 * -------------------------
 */
async function runStreamingJob(jobId, instructions, input) {
    try {
        // Update status to in_progress
        const job = jobs.get(jobId);
        job.status = "in_progress";
        jobs.set(jobId, job);

        console.log(`[${jobId}] Starting stream...`);

        // Use Chat Completions API - THIS WORKS RELIABLY
        const stream = await openai.chat.completions.create({
            model: "gpt-5.2",
            service_tier: "priority",
            instructions,
            input,
            max_output_tokens: 1200, // (your current value)
            temperature: 0.5, // (your current value)
            background: true,
            store: true,
        });

        let fullText = "";
        let totalTokens = 0;

        // Process streaming chunks - THIS IS THE CORRECT WAY
        for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta?.content;

            if (delta) {
                fullText += delta;

                // Update job with incremental text
                const currentJob = jobs.get(jobId);
                if (currentJob) {
                    currentJob.text = fullText;
                    jobs.set(jobId, currentJob);
                }

                // Log progress every 200 characters
                if (fullText.length % 200 < delta.length) {
                    console.log(`[${jobId}] Progress: ${fullText.length} chars`);
                }
            }

            // Capture token usage
            if (chunk.usage) {
                totalTokens = chunk.usage.total_tokens;
            }
        }

        // Mark completed
        const finalJob = jobs.get(jobId);
        if (finalJob) {
            finalJob.status = "completed";
            finalJob.text = fullText;
            finalJob.tokensUsed = totalTokens;
            jobs.set(jobId, finalJob);
        }

        console.log(`[${jobId}] ✅ COMPLETED. Length: ${fullText.length}, Tokens: ${totalTokens}`);

    } catch (err) {
        console.error(`[${jobId}] ❌ Streaming error:`, err);
        console.error(`[${jobId}] Error details:`, err.message);

        const job = jobs.get(jobId);
        if (job) {
            job.status = "failed";
            job.error = err.message || "Stream failed";
            jobs.set(jobId, job);
        }
    }
}

/**
 * -------------------------
 * CLEANUP OLD JOBS
 * -------------------------
 */
setInterval(() => {
    const now = Date.now();
    const MAX_AGE = 15 * 60 * 1000; // 15 minutes

    for (const [jobId, job] of jobs.entries()) {
        if (now - job.createdAt > MAX_AGE) {
            jobs.delete(jobId);
            console.log(`Cleaned up old job: ${jobId}`);
        }
    }
}, 2 * 60 * 1000); // Run every 2 minutes

/**
 * -------------------------
 * HELPER FUNCTIONS
 * -------------------------
 */
function buildUserPrompt({ country, sector, description, latitude, longitude, locationLabel, trends }) {
    const trendsList = Object.entries(normalizeTrends(trends || {}))
        .map(([name, value]) => `- ${name}: Level ${value}`)
        .join("\n");

    const hasCoords =
        latitude !== null && latitude !== undefined &&
        longitude !== null && longitude !== undefined;

    const coords = hasCoords
        ? `Latitude: ${latitude}, Longitude: ${longitude}`
        : "Latitude/longitude not provided";

    const locationLine = locationLabel
        ? `Approximate local context: ${locationLabel}`
        : "Approximate local context: not specified";

    return `
Context
Country or region: ${country}
Economic sector: ${sector}

Situation description
${description}

Local geography and location
- ${coords}
- ${locationLine}

Trend slider settings (constraint strength)
${trendsList || "- (none provided)"}

Instruction
Follow the instructions exactly.
`.trim();
}

function normalizeTrends(trends) {
    const out = {};
    for (const [k, v] of Object.entries(trends || {})) {
        let n = Number(v);
        if (!Number.isFinite(n)) n = 1;
        if (n < 1) n = 1;
        if (n > 3) n = 3;
        out[k] = n;
    }
    return out;
}

function getInstructionsForMode(analysisFocus) {
    const COMMON = `
You are StratEko, a constraint-first analysis engine.
Language & clarity rules:
Use plain cause–effect language.
Minimize analytical jargon and framework labels; if used, define once and then describe effects directly.
For each major constraint, state who is affected, what fails, and the immediate consequence.
Avoid euphemisms; describe losses, shutdowns, or failure explicitly.
Keep sections concise (3–5 bullets, ~20–25 words each).

EXECUTION CHECKLIST (do not explain; just comply)
1) Output sections A–F using bullets only. 
2) In section D, classify the intervention: (A) Business as Usual / Extractive, (B) Efficiency / Optics, (C) Mitigation / Harm Reduction, (D) Repair / Regenerative (claim).
3) If classified A or B → section F must be exactly one line: "No credible mitigation within stated assumptions."
4) If classified D → apply feasibility gates. If any gate triggers → section E must state non-viable and end after section F.
5) Otherwise complete A–F in order and stop after F.

1a) Each section must begin with exactly one short sentence (15–30 words)
that explains how the bullets in that section interact causally.
This sentence is allowed in addition to the bullets and must not repeat bullet wording.

HARD OUTPUT TEMPLATE
A) Baseline
B) Stress
C) Constraints
D) Classification
E) Net trajectory
F) Mitigation

CORE LOGIC (apply in this order)
A) Baseline: No-action trajectory. Exclude the intervention entirely.
B) Stress: Apply user-assumed stress levels to the baseline (no mitigation here).
C) Constraints: Identify dominant hard limits, lock-ins, and failure modes under stress.
D) Classification: Based on stated intent and mechanism (not hoped-for outcomes).
E) Net trajectory: Does the intervention materially change the stressed baseline trajectory?
F) Mitigation: Allowed scope depends on classification.

Use plain, concrete language.
Prefer short sentences and active verbs.
Use the term "hard limit" where applicable.
`.trim();

    if (analysisFocus === "authorizationFramework") {
        return `${COMMON}

MODE FOCUS
Authorization / operating framework.
In section C emphasize rules, defaults, incentives, enforcement limits, coordination failure, and path dependence.
The intervention is the existing framework itself.
`.trim();
    }

    return `${COMMON}

MODE FOCUS
Project / investment decision.
In section C emphasize feasibility, capital exposure, operating cost risk, lock-in, rebound, and non-viability triggers.
The intervention is the proposed project.
`.trim();
}

/**
 * -------------------------
 * START SERVER
 * -------------------------
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ StratEko Streaming Proxy running on port ${PORT}`);
    console.log(`   Health check: http://localhost:${PORT}/`);
    console.log(`   Create: POST http://localhost:${PORT}/api/create`);
    console.log(`   Status: GET http://localhost:${PORT}/api/status/:jobId`);
});