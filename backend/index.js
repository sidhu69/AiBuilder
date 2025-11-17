// backend/index.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import loadDataset from "./datasetLoader.js";
import { createProjectFiles, zipProject } from "./fileManager.js";

dotenv.config();

if (!process.env.GOOGLE_API_KEY) {
  console.log("❌ Missing GOOGLE_API_KEY in .env");
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

// Load dataset once on startup
const DATASET = loadDataset();

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash"
});

// Store conversation history (in production, use Redis/Database)
const conversations = new Map();

// Convert dataset to training context
function datasetToContext() {
  if (DATASET.length === 0) return "";
  
  const samples = DATASET.slice(0, 50); // Use first 50 examples
  return samples.map(item => {
    if (item.user && item.assistant) {
      return `User: ${item.user}\nAssistant: ${item.assistant}`;
    }
    return "";
  }).filter(Boolean).join("\n\n");
}

// Enhanced system prompt
const SYSTEM_PROMPT = `You are an expert full-stack code generator.

${datasetToContext()}

RULES:
1. Output ONLY valid JSON with file paths as keys and code as values
2. Create complete, working applications
3. Use modern best practices (ES6+, semantic HTML, clean CSS)
4. Include ALL necessary files (HTML, CSS, JS, package.json if needed)
5. NO explanations, NO markdown, NO code fences - PURE JSON ONLY

OUTPUT FORMAT:
{
  "index.html": "<!DOCTYPE html>...",
  "style.css": "body { ... }",
  "script.js": "console.log('...')",
  "package.json": "{ ... }" // If React/Node project
}

For React apps, include:
- package.json with dependencies
- src/App.jsx
- src/main.jsx  
- index.html
- vite.config.js

Always create production-ready, beautiful, functional code.`;

// Helper: Clean AI response
function cleanJSON(text) {
  let clean = text.trim();
  
  // Remove markdown code fences
  clean = clean.replace(/```json\s*/g, "").replace(/```\s*/g, "");
  
  // Remove any text before first {
  const firstBrace = clean.indexOf('{');
  if (firstBrace > 0) {
    clean = clean.substring(firstBrace);
  }
  
  // Remove any text after last }
  const lastBrace = clean.lastIndexOf('}');
  if (lastBrace !== -1 && lastBrace < clean.length - 1) {
    clean = clean.substring(0, lastBrace + 1);
  }
  
  return clean;
}

// Endpoint 1: Generate new project
app.post("/generate", async (req, res) => {
  try {
    const { prompt, conversationId } = req.body;
    
    if (!prompt) {
      return res.json({ success: false, error: "Prompt required" });
    }

    // Get or create conversation history
    const convId = conversationId || Date.now().toString();
    let history = conversations.get(convId) || [];

    // Build messages
    const messages = [
      { text: SYSTEM_PROMPT },
      ...history,
      { text: `User request: ${prompt}` }
    ];

    console.log("🤖 Generating project for:", prompt);

    const result = await model.generateContent(messages);
    const aiResponse = result.response.text();
    
    // Save to conversation history
    history.push({ text: `User request: ${prompt}` });
    history.push({ text: aiResponse });
    conversations.set(convId, history);

    // Parse JSON
    const cleaned = cleanJSON(aiResponse);
    let parsed;
    
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("❌ JSON Parse Error:", e.message);
      console.log("Raw response:", aiResponse);
      return res.json({ 
        success: false, 
        error: "AI returned invalid JSON",
        raw: aiResponse 
      });
    }

    // Create project files
    const projectId = Date.now().toString();
    const projectPath = createProjectFiles(parsed, projectId);

    // Optional: Create ZIP
    const zipPath = await zipProject(projectPath, projectId);

    res.json({
      success: true,
      projectId,
      conversationId: convId,
      files: parsed,
      projectPath,
      zipPath,
      fileCount: Object.keys(parsed).length
    });

  } catch (err) {
    console.error("❌ Error:", err);
    res.json({ success: false, error: err.message });
  }
});

// Endpoint 2: Continue conversation (modify existing project)
app.post("/chat", async (req, res) => {
  try {
    const { prompt, conversationId, projectId } = req.body;

    if (!prompt || !conversationId) {
      return res.json({ success: false, error: "Prompt and conversationId required" });
    }

    let history = conversations.get(conversationId) || [];

    const messages = [
      { text: SYSTEM_PROMPT },
      ...history,
      { text: `Modification request: ${prompt}\nOutput ONLY the files that need to be updated or added.` }
    ];

    const result = await model.generateContent(messages);
    const aiResponse = result.response.text();

    history.push({ text: `Modification request: ${prompt}` });
    history.push({ text: aiResponse });
    conversations.set(conversationId, history);

    const cleaned = cleanJSON(aiResponse);
    const parsed = JSON.parse(cleaned);

    // Update existing project or create new one
    const projId = projectId || Date.now().toString();
    const projectPath = createProjectFiles(parsed, projId);
    const zipPath = await zipProject(projectPath, projId);

    res.json({
      success: true,
      projectId: projId,
      conversationId,
      files: parsed,
      projectPath,
      zipPath
    });

  } catch (err) {
    console.error("❌ Chat Error:", err);
    res.json({ success: false, error: err.message });
  }
});

// Endpoint 3: Update specific file
app.post("/update-file", async (req, res) => {
  try {
    const { projectId, filePath, content } = req.body;

    if (!projectId || !filePath || !content) {
      return res.json({ success: false, error: "Missing required fields" });
    }

    const fullPath = path.join(process.cwd(), "projects", projectId, filePath);
    
    // Create directory if needed
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);

    res.json({ success: true, filePath, projectId });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Endpoint 4: Get project files
app.get("/project/:projectId", (req, res) => {
  try {
    const { projectId } = req.params;
    const projectPath = path.join(process.cwd(), "projects", projectId);

    if (!fs.existsSync(projectPath)) {
      return res.json({ success: false, error: "Project not found" });
    }

    // Read all files recursively
    function readDir(dir, baseDir = dir) {
      let files = {};
      const items = fs.readdirSync(dir);

      for (const item of items) {
        const fullPath = path.join(dir, item);
        const stat = fs.statSync(fullPath);
        
        if (stat.isDirectory()) {
          files = { ...files, ...readDir(fullPath, baseDir) };
        } else {
          const relativePath = path.relative(baseDir, fullPath);
          files[relativePath] = fs.readFileSync(fullPath, "utf8");
        }
      }
      
      return files;
    }

    const files = readDir(projectPath);

    res.json({ success: true, projectId, files });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// Endpoint 5: Download project ZIP
app.get("/download/:projectId", async (req, res) => {
  try {
    const { projectId } = req.params;
    const zipPath = path.join(process.cwd(), "zips", `${projectId}.zip`);

    if (!fs.existsSync(zipPath)) {
      const projectPath = path.join(process.cwd(), "projects", projectId);
      if (!fs.existsSync(projectPath)) {
        return res.status(404).json({ error: "Project not found" });
      }
      await zipProject(projectPath, projectId);
    }

    res.download(zipPath);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📚 Dataset loaded: ${DATASET.length} examples`);
});
