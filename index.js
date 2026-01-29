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
 * STREAMING WORKER - RESPONSES API FOR GPT-5.2
 * WITH CHUNKED DELIVERY FOR POLLING
 * -------------------------
 */
async function runStreamingJob(jobId, instructions, input) {
    try {
        // Update status to in_progress
        const job = jobs.get(jobId);
        job.status = "in_progress";
        jobs.set(jobId, job);

        console.log(`[${jobId}] Starting stream...`);

        // Use Responses API with streaming for gpt-5.2
        const stream = await openai.responses.stream({
            model: "gpt-5.2",
            service_tier: "priority",
            instructions: instructions,
            input: input,
            max_output_tokens: 1200,
            temperature: 0.5,
            background: false,  // Must be false for streaming
            store: true
        });

        let fullText = "";
        let totalTokens = 0;
        let receivedDeltas = false;

        // Process streaming events
        for await (const event of stream) {
            console.log(`[${jobId}] Event type: ${event.type}`);

            // Handle different event types from Responses API
            
            // Text delta events (incremental streaming)
            if (event.type === "response.output_item.delta") {
                receivedDeltas = true;
                if (event.delta?.type === "text_delta" && event.delta.text) {
                    fullText += event.delta.text;
                    
                    const currentJob = jobs.get(jobId);
                    if (currentJob) {
                        currentJob.text = fullText;
                        jobs.set(jobId, currentJob);
                    }
                    
                    console.log(`[${jobId}] +${event.delta.text.length} chars, total: ${fullText.length}`);
                }
            }
            
            // Item completed event
            else if (event.type === "response.output_item.done") {
                if (event.item?.type === "message" && Array.isArray(event.item.content)) {
                    for (const content of event.item.content) {
                        if (content.type === "output_text" && content.text) {
                            // Update with complete text if we somehow missed deltas
                            if (content.text.length > fullText.length) {
                                fullText = content.text;
                                console.log(`[${jobId}] Got complete text from item.done: ${fullText.length} chars`);
                            }
                        }
                    }
                }
            }
            
            // Response completed event (final)
            else if (event.type === "response.done") {
                console.log(`[${jobId}] Response done event received`);
                
                // Get token usage
                if (event.response?.usage) {
                    totalTokens = event.response.usage.total_tokens || 0;
                    console.log(`[${jobId}] Tokens used: ${totalTokens}`);
                }
                
                // Extract final text if needed
                if (event.response?.output && Array.isArray(event.response.output)) {
                    for (const item of event.response.output) {
                        if (item.type === "message" && Array.isArray(item.content)) {
                            for (const content of item.content) {
                                if (content.type === "output_text" && content.text) {
                                    // Use final text if it's longer than what we have
                                    if (content.text.length > fullText.length) {
                                        fullText = content.text;
                                        console.log(`[${jobId}] Final text from response.done: ${fullText.length} chars`);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // If we didn't receive deltas but have final text, simulate chunked delivery
        if (!receivedDeltas && fullText.length > 0) {
            console.log(`[${jobId}] No deltas received, simulating chunked delivery...`);
            await simulateChunkedDelivery(jobId, fullText);
        } else {
            // Normal completion - just update the job
            const finalJob = jobs.get(jobId);
            if (finalJob) {
                finalJob.text = fullText;
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
        console.error(`[${jobId}] Error message:`, err.message);

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
 * SIMULATE CHUNKED DELIVERY
 * Breaks down complete text into chunks for polling
 * -------------------------
 */
async function simulateChunkedDelivery(jobId, fullText) {
    const CHUNK_SIZE = 150; // Characters per chunk
    const DELAY_MS = 300;   // Delay between chunks (ms)
    
    const job = jobs.get(jobId);
    if (!job) return;
    
    console.log(`[${jobId}] Delivering ${fullText.length} chars in chunks of ${CHUNK_SIZE}`);
    
    let delivered = 0;
    
    while (delivered < fullText.length) {
        const chunk = fullText.substring(0, delivered + CHUNK_SIZE);
        
        const currentJob = jobs.get(jobId);
        if (currentJob) {
            currentJob.text = chunk;
            jobs.set(jobId, currentJob);
        }
        
        delivered += CHUNK_SIZE;
        console.log(`[${jobId}] Delivered ${chunk.length}/${fullText.length} chars`);
        
        // Don't delay on the last chunk
        if (delivered < fullText.length) {
            await new Promise(resolve => setTimeout(resolve, DELAY_MS));
        }
    }
    
    console.log(`[${jobId}] Chunked delivery complete`);
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
Sector Baseline Viability & Industrial Lineage Check

Before applying stressors, trends, or scenarios, perform a Sector Baseline Viability Check grounded in historical and structural reality.

For the specified sector and geography, explicitly assess:
	1.	Industrial Lineage
	•	Describe how this sector has evolved in this geography over the last 30–50 years.
	•	State clearly whether production has:
	•	remained locally viable,
	•	declined or hollowed out,
	•	largely offshored,
	•	or exited the region entirely.
	2.	Current Functional Presence
	•	Identify which parts of the value chain (if any) remain local
(e.g. design, R&D, branding, niche production, prototyping).
	•	If mass production is no longer present, state this explicitly.
	3.	Baseline Structural Constraint
	•	If the sector lacks a meaningful domestic or local production base, treat this as a baseline constraint, not a downstream risk.
	•	Do not assume revival, reshoring, or competitiveness unless specific enabling conditions are explicitly provided by the user.
	4.	Implications for Scenario Analysis
	•	If the sector is structurally absent or marginal in the region, note that subsequent stressors (trade, energy, labor, capital) act on an already-fragile or non-existent base.
	•	Where appropriate, state that the scenario begins from a non-viable or highly conditional baseline.

This assessment must be stated explicitly in the Baseline section before any stress or future scenarios are explored.
B) Stress: Apply user-assumed stress levels to the baseline (no mitigation here).
C) Constraints: Identify dominant hard limits, lock-ins, and failure modes under stress. In section C, explicitly identify the dominant constraint first.
Subsequent bullets must explain how secondary constraints amplify or follow from it.
Scenario
A) Baseline
This baseline describes how current environmental controls shape mining approvals, operations, and impacts, which then distribute benefits and harms across actors without added stressors.
• Existing EIA/approval processes permit battery-material mining with conditions; firms benefit via access and revenue, while local ecosystems and Traditional Owners bear residual risks.
• Compliance relies on monitoring, reporting, and penalties; large operators with legal capacity navigate rules more easily than smaller entrants.
• Water, dust, tailings, and habitat disturbance remain managed but not eliminated; cumulative impacts accrue across projects and time.
• Remote-location logistics and fly-in/fly-out work patterns externalize some social costs to regional services and communities.

B) Stress
These stressors intensify the baseline by weakening information quality and raising energy and climate pressures, which increases the chance that controls underperform in practice.
• Information Breakdown (hard limit: reliable, timely data) degrades monitoring, community scrutiny, and regulator decision quality, increasing undetected non-compliance.
• Energy Fragility (hard limit: dependable power/fuel) raises operating volatility, making shutdowns, maintenance deferrals, and emergency responses more likely.
• Climate Limits (hard limit: heat/water extremes) increase water competition, dust events, and tailings risk, stressing permit assumptions and site designs.
• External Domination (hard limit: local bargaining power) shifts leverage to external buyers/financiers, pressuring faster approvals and weaker conditions.

C) Constraints
A binding hard limit on trustworthy information and verification drives most failures, and other constraints amplify it by reducing enforcement credibility and operational resilience.
• Dominant constraint: Information Breakdown hard limit prevents credible measurement, auditing, and enforcement, so rules exist on paper but weaken in effect.
• Energy Fragility amplifies this by causing outages and rushed workarounds, increasing incident rates and reducing time for compliant monitoring and reporting.
• Climate Limits amplify baseline tailings/water/dust risks, making historical baselines unreliable and increasing disputes over "acceptable" impacts.
• External Domination locks in pro-extraction defaults by concentrating decision power outside the region, reducing local consent leverage and regulator independence.

D) Classification
Because the mechanism is an operating authorization framework that conditions extraction rather than removing it, it functions primarily as harm-limiting governance under stress.
• Classification: (C) Mitigation / Harm Reduction.
• Mechanism: permits, conditions, monitoring, and penalties aim to reduce damage while allowing mining to proceed.
• Intent inferred from design: manage impacts, not halt extraction or repair past harm.
• Hard limit context: effectiveness depends on verifiable information and enforceable sanctions.

E) Net trajectory
Under the stated stresses, the framework can reduce some harms but cannot fully counter the binding hard limits, so outcomes shift only modestly from the stressed baseline.
• It partially changes the stressed baseline by setting minimum standards, but Information Breakdown hard limit means compliance becomes less observable and less enforceable.
• Benefits still concentrate with mining firms and external purchasers via continued supply; losses concentrate in local water, habitat, and cultural values when breaches go unseen.
• Energy Fragility and Climate Limits keep incident probability elevated, so the framework mainly shapes severity after events rather than preventing them.
• External Domination keeps approval momentum high, limiting how far conditions can tighten without higher-level political backing.

F) Mitigation
Mitigation works only where it strengthens verification and enforcement despite the hard limit, while acknowledging that energy and climate constraints remain binding.
• Shift to continuous, tamper-evident monitoring (telemetry, third-party custody, public dashboards) reduces Information Breakdown impacts, but the hard limit remains if audits lack independence.
• Pre-commit enforceable stop-work triggers tied to objective thresholds (dust, water drawdown, tailings alarms) changes failure modes from "hidden drift" to "automatic pause."
• Require bonded rehabilitation and tailings financial assurance sized to climate-stressed scenarios; this mitigates insolvency risk but cannot remove physical climate hard limits.
• Create binding co-governance with funded Traditional Owner ranger/compliance roles to counter External Domination, but effectiveness depends on statutory authority and stable funding.
D) Classification: Based on stated intent and mechanism (not hoped-for outcomes).
E) Net trajectory: Does the intervention materially change the stressed baseline trajectory?
F) Mitigation: Allowed scope depends on classification.
In sections A and E, at least one bullet must explicitly state
who or what benefits and who or what loses under the described trajectory.
Do not assume the intervention is intended to mitigate stress or constraints.
First determine whether it is corrective, neutral, or business-as-usual.

SCOPE BY CLASSIFICATION
- A or B: no credible mitigation within stated assumptions (see checklist rule).
- C: mitigation only; specify which failure modes change and which remain binding; durability required.
- D: treat repair as a claim; apply feasibility gates; downgrade to C or B if gates fail.

FEASIBILITY GATES (apply only if classified D)
- CapitalFreeze=3 → execution fails unless committed non-market financing specified.
- Physical hard limit → no design/efficiency workaround unless capacity is removed.
- Low institutional capacity → no enforcement/coordination without mechanism+funding.
- Timing mismatch → outcome locked-in or partially irreversible.
- Multi-actor required → default partial/fail unless binding authority specified.

EVIDENCE DISCIPLINE
- Any claimed benefit must include mechanism + the limiting hard limit in the same bullet.
- Explicitly downgrade counterfactuals that do not materially alter the stressed baseline trajectory.
- Use the term "hard limit".
Use plain, concrete language.
Prefer short sentences and active verbs.
Avoid stacked abstractions and internal jargon where a common term conveys the same meaning.
When applicable, state that the intervention "does not materially change the baseline trajectory" without implying failure or mitigation intent.
Geographic references must be causal and constraint-relevant.
Do not describe place unless it materially changes feasibility,
risk, enforcement, or irreversibility.
`.trim();

    // ✅ AUTHORIZATION FRAMEWORK MODE
    if (analysisFocus === "authorizationFramework") {
        return `${COMMON}

MODE FOCUS
Authorization / operating framework.
In section C emphasize rules, defaults, incentives, enforcement limits, coordination failure, and path dependence.
The intervention is the existing framework itself.
`.trim();
    }

    // ✅ PROJECT MODE (default)
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