# StratEko Streaming Proxy - Deployment Guide

## 🎯 Purpose
This server acts as a streaming proxy between Wix Velo and OpenAI's API. It handles real-time streaming from OpenAI and provides a polling endpoint for Wix to get incremental updates.

## 📦 Files Included
- `server.js` - Main Express server with streaming logic
- `package.json` - Dependencies
- `.env.example` - Environment variables template
- `scenarioAPI.web.js` - Updated Wix Velo backend code
- `POSTMAN_TESTS.md` - API testing guide

---

## 🚀 Deploy to Render

### Step 1: Create Render Account
1. Go to https://render.com
2. Sign up or log in with GitHub

### Step 2: Create New Web Service
1. Click **"New +"** → **"Web Service"**
2. Connect your GitHub repository (or use "Deploy from Git URL")
3. Configure:
   - **Name:** `strateko-proxy` (or your choice)
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Plan:** Free (or paid for production)

### Step 3: Set Environment Variables
In Render dashboard → Your service → Environment:
1. Add variable:
   - **Key:** `OPENAI_API_KEY`
   - **Value:** Your OpenAI API key (from https://platform.openai.com/api-keys)

### Step 4: Deploy
1. Click **"Create Web Service"**
2. Wait for deployment (2-3 minutes)
3. Copy your service URL (e.g., `https://strateko-proxy.onrender.com`)

---

## 🧪 Test with Postman

### Quick Test
1. **Health Check:**
   ```
   GET https://your-app.onrender.com/
   ```
   Should return: `{"status": "ok", "service": "StratEko Streaming Proxy"}`

2. **Create Scenario:**
   ```
   POST https://your-app.onrender.com/api/create
   Content-Type: application/json

   {
     "country": "Australia",
     "sector": "Battery materials mining",
     "description": "Lithium extraction with environmental framework",
     "latitude": -31.9505,
     "longitude": 115.8605,
     "trends": {
       "Information Breakdown": 3,
       "Energy Fragility": 2
     },
     "analysisFocus": "authorizationFramework"
   }
   ```
   Response: `{"success": true, "jobId": "uuid-here", "status": "queued"}`

3. **Poll Status (repeat every 1-2 seconds):**
   ```
   GET https://your-app.onrender.com/api/status/{jobId}
   ```
   Watch `scenario` field grow as streaming happens!

See `POSTMAN_TESTS.md` for detailed testing guide.

---

## 🔗 Update Wix Velo

### Step 1: Update Backend Code
1. Open your Wix site in Editor
2. Go to **Code Files** → **Backend** → `scenarioAPI.web.js`
3. Replace with the new `scenarioAPI.web.js` file provided
4. **IMPORTANT:** Change line 7:
   ```javascript
   const RENDER_API_URL = "https://your-app.onrender.com";
   ```
   Replace with your actual Render URL

### Step 2: Update Frontend (No Changes Needed!)
Your existing frontend code should work as-is because:
- Still calls `createScenario()` and `getScenarioStatus()`
- Still uses `jobId` (previously `responseId`)
- Polling logic remains the same

### Step 3: Test in Wix
1. Preview your site
2. Generate a scenario
3. Watch real-time streaming appear!

---

## 📊 API Endpoints

### `GET /`
Health check endpoint
```json
{
  "status": "ok",
  "service": "StratEko Streaming Proxy",
  "activeJobs": 2
}
```

### `POST /api/create`
Start a new streaming job
**Request:**
```json
{
  "country": "string",
  "sector": "string", 
  "description": "string",
  "latitude": number | null,
  "longitude": number | null,
  "locationLabel": "string" | null,
  "trends": {
    "trend_name": 1-3
  },
  "analysisFocus": "project" | "authorizationFramework"
}
```
**Response:**
```json
{
  "success": true,
  "jobId": "uuid",
  "status": "queued"
}
```

### `GET /api/status/:jobId`
Poll for job status and incremental results
**Response (in_progress):**
```json
{
  "success": true,
  "status": "in_progress",
  "scenario": "A) Baseline\n...(partial text)...",
  "error": null,
  "tokensUsed": 0,
  "progress": {
    "characterCount": 450,
    "estimatedCompletion": 35
  }
}
```

**Response (completed):**
```json
{
  "success": true,
  "status": "completed",
  "scenario": "A) Baseline\n...(full text)...\nF) Mitigation\n...",
  "error": null,
  "tokensUsed": 1150,
  "progress": {
    "characterCount": 2850,
    "estimatedCompletion": 100
  }
}
```

---

## 🔧 Troubleshooting

### Issue: Server returns 500 error
**Solution:** Check Render logs for OpenAI API errors. Verify API key is set correctly.

### Issue: Scenario is empty even when completed
**Solution:** 
1. Check server logs in Render dashboard
2. Verify OpenAI model name is correct (currently `gpt-4o`)
3. Test with Postman first to isolate issue

### Issue: Polling doesn't show incremental updates
**Solution:** 
1. Reduce polling interval in Wix frontend (try 500ms)
2. Check network tab - ensure polls are happening
3. Verify jobId is being passed correctly

### Issue: Jobs timing out
**Solution:**
1. Free tier Render may spin down after inactivity
2. First request after idle takes 30-60 seconds
3. Consider upgrading to paid plan for production

---

## 📝 Notes

- **Free Tier Limitations:** Render free tier spins down after 15 minutes of inactivity
- **Job Cleanup:** Old jobs auto-delete after 15 minutes
- **CORS:** Configured to allow requests from any origin (change in production)
- **Streaming:** Uses OpenAI Chat Completions API with `stream: true`
- **Model:** Currently uses `gpt-4o` - change in `server.js` if needed

---

## 🔐 Security for Production

1. **Restrict CORS:**
   ```javascript
   res.header("Access-Control-Allow-Origin", "https://yourdomain.wixsite.com");
   ```

2. **Add Rate Limiting:**
   ```bash
   npm install express-rate-limit
   ```

3. **Add Authentication:**
   Consider adding API key validation if exposing publicly

---

## 📞 Support

If you encounter issues:
1. Check Render logs first
2. Test with Postman to isolate frontend vs backend
3. Verify environment variables are set
4. Ensure OpenAI API key has credits

Good luck! 🚀