import express from "express";

const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ ok: true, message: "Render service is running" });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log("Server running on port", port);
});