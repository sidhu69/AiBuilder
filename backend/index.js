import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import loadDataset from "./datasetLoader.js";

dotenv.config();

if (!process.env.GOOGLE_API_KEY) {
  console.log("❌ Missing GOOGLE_API_KEY in .env");
  process.exit(1);
}

const dataset = loadDataset();
function datasetToPrompt() {
  return DATASET.map(item => {
    return `User: ${item.user}\nAssistant: ${item.assistant}`;
  }).join("\n\n");
}


const app = express();
app.use(cors());
app.use(bodyParser.json());

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-2.0-flash"
});

// Create files/folders
function createFilesFromJSON(json, projectId) {
  const basePath = path.join("projects", projectId);
  fs.mkdirSync(basePath, { recursive: true });

  for (const filePath in json) {
    const fullPath = path.join(basePath, filePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, json[filePath]);
  }

  return basePath;
}

app.post("/generate", async (req, res) => {
  try {
    const userPrompt = req.body.prompt;

    const systemPrompt = `
You are a project generator.
Output ONLY JSON.
Format example:
{
  "index.html": "<html>...</html>",
  "style.css": "body { }",
  "src/app.js": "console.log('hi')"
}
NO explanations. NO extra text. ONLY JSON.
    `;

    const result = await model.generateContent([
      { text: systemPrompt },
      { text: userPrompt }
    ]);

    let text = result.response.text();

    // Try fixing non-JSON response
    let clean = text.trim();

    // Remove code fences if AI adds ```json
    clean = clean.replace(/```json/g, "").replace(/```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e) {
      return res.json({ success: false, error: "AI did not return valid JSON." });
    }

    // Create project
    const projectId = Date.now().toString();
    const folderPath = createFilesFromJSON(parsed, projectId);

    res.json({
      success: true,
      projectId,
      folderPath,
      files: parsed
    });

  } catch (err) {
    console.error(err);
    res.json({ success: false, error: err.message });
  }
});

app.listen(5000, () => console.log("Server running on port 5000"));
