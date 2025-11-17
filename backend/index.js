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
  
  const samples = DATASET.slice(0, 30); // Use first 30 examples
  return samples.map(item => {
    if (item.user && item.assistant) {
      return `User: ${item.user}\nAssistant: ${item.assistant}`;
    }
    return "";
  }).filter(Boolean).join("\n\n");
}

// Enhanced system prompt - MUCH STRICTER
const SYSTEM_PROMPT = `You are an expert code generator that outputs ONLY raw JSON.

CRITICAL OUTPUT RULES - FOLLOW EXACTLY:
1. Your ENTIRE response must be a single JSON object
2. Start with { and end with }
3. NO markdown code fences (\`\`\`json or \`\`\`)
4. NO explanatory text before or after the JSON
5. NO escaped quotes in file content - use proper JSON string escaping only

OUTPUT FORMAT (THIS IS THE ONLY VALID FORMAT):
{
  "index.html": "<!DOCTYPE html>\\n<html>\\n<body>Hello</body>\\n</html>",
  "style.css": "body { margin: 0; }",
  "package.json": "{ \\"name\\": \\"myapp\\", \\"version\\": \\"1.0.0\\" }"
}

For React projects, always include:
- package.json (with React, ReactDOM, Vite)
- index.html
- vite.config.js
- src/main.jsx
- src/App.jsx
- src/index.css
- src/components/ (as needed)

REMEMBER: Start with { and end with }. Nothing else. No text, no markdown, just JSON.`;

// Helper: Advanced JSON cleaning and parsing
function cleanAndParseJSON(text) {
  let clean = text.trim();
  
  // Step 1: Remove markdown code fences
  clean = clean.replace(/```json\s*/gi, "");
  clean = clean.replace(/```javascript\s*/gi, "");
  clean = clean.replace(/```\s*/g, "");
  
  // Step 2: Find JSON boundaries
  const firstBrace = clean.indexOf('{');
  const lastBrace = clean.lastIndexOf('}');
  
  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error("No JSON object found in response");
  }
  
  clean = clean.substring(firstBrace, lastBrace + 1);
  
  // Step 3: Try parsing attempts
  
  // Attempt 1: Parse as-is
  try {
    return JSON.parse(clean);
  } catch (e1) {
    console.log("⚠️ First parse attempt failed, trying alternatives...");
  }
  
  // Attempt 2: Handle double-stringified JSON
  try {
    const parsed = JSON.parse(clean);
    // Check if values are stringified JSON
    const result = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
        try {
          result[key] = JSON.parse(value);
        } catch {
          result[key] = value;
        }
      } else {
        result[key] = value;
      }
    }
    return result;
  } catch (e2) {
    console.log("⚠️ Second parse attempt failed, trying manual fix...");
  }
  
  // Attempt 3: Fix common escaping issues
  try {
    // Replace \" with actual quotes where appropriate
    let fixed = clean;
    
    // This is a hacky fix for the double-escaped JSON issue
    // Match patterns like "file.js": "{\"key\": \"value\"}"
    fixed = fixed.replace(/"([^"]+)":\s*"(\{[^}]+\})"/g, (match, key, value) => {
      try {
        // Try to parse the value as JSON
        const unescaped = value.replace(/\\"/g, '"');
        JSON.parse(unescaped); // Validate it's valid JSON
        return `"${key}": ${unescaped}`;
      } catch {
        return match; // Keep original if not valid
      }
    });
    
    return JSON.parse(fixed);
  } catch (e3) {
    console.log("⚠️ Third parse attempt failed");
  }
  
  // Attempt 4: Brute force unescape
  try {
    let bruteForce = clean
      .replace(/\\\\"/g, '"')
      .replace(/\\\\n/g, '\\n')
      .replace(/\\\\t/g, '\\t')
      .replace(/\\\\r/g, '\\r');
    
    return JSON.parse(bruteForce);
  } catch (e4) {
    throw new Error("All JSON parsing attempts failed");
  }
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

    // Build messages with stronger JSON enforcement
    const userMessage = `${prompt}\n\nREMEMBER: Output ONLY JSON. Start with { and end with }. NO markdown, NO text.`;
    
    const messages = [
      { text: SYSTEM_PROMPT },
      ...history,
      { text: userMessage }
    ];

    console.log("🤖 Generating project for:", prompt);

    const result = await model.generateContent(messages);
    const aiResponse = result.response.text();
    
    console.log("📝 AI Response length:", aiResponse.length);
    console.log("📝 First 200 chars:", aiResponse.substring(0, 200));
    
    // Save to conversation history
    history.push({ text: userMessage });
    history.push({ text: aiResponse });
    conversations.set(convId, history);

    // Parse JSON with advanced cleaning
    let parsed;
    
    try {
      parsed = cleanAndParseJSON(aiResponse);
      console.log("✅ JSON parsed successfully, files:", Object.keys(parsed).length);
    } catch (parseError) {
      console.error("❌ JSON Parse Error:", parseError.message);
      console.log("Raw response (first 1000 chars):", aiResponse.substring(0, 1000));
      
      // Save failed response to file for debugging
      const debugPath = path.join(process.cwd(), "debug");
      if (!fs.existsSync(debugPath)) fs.mkdirSync(debugPath);
      fs.writeFileSync(
        path.join(debugPath, `failed_${Date.now()}.txt`),
        aiResponse
      );
      
      return res.json({ 
        success: false, 
        error: "AI returned invalid JSON. Response saved to /debug folder.",
        hint: "The AI might be adding explanatory text. Check the debug file.",
        firstChars: aiResponse.substring(0, 500)
      });
    }

    // Validate parsed object has files
    if (typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
      return res.json({
        success: false,
        error: "Parsed JSON is empty or invalid",
        parsed
      });
    }

    // Create project files
    const projectId = Date.now().toString();
    const projectPath = createProjectFiles(parsed, projectId);

    // Optional: Create ZIP
    let zipPath;
    try {
      zipPath = await zipProject(projectPath, projectId);
    } catch (zipError) {
      console.warn("⚠️ ZIP creation failed:", zipError.message);
    }

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
    res.json({ success: false, error: err.message, stack: err.stack });
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

    const userMessage = `Modification: ${prompt}\n\nOutput ONLY the updated/new files as JSON. Start with { and end with }.`;
    
    const messages = [
      { text: SYSTEM_PROMPT },
      ...history,
      { text: userMessage }
    ];

    console.log("💬 Chat request:", prompt);

    const result = await model.generateContent(messages);
    const aiResponse = result.response.text();

    history.push({ text: userMessage });
    history.push({ text: aiResponse });
    conversations.set(conversationId, history);

    const parsed = cleanAndParseJSON(aiResponse);

    // Update existing project or create new one
    const projId = projectId || Date.now().toString();
    const projectPath = createProjectFiles(parsed, projId);
    
    let zipPath;
    try {
      zipPath = await zipProject(projectPath, projId);
    } catch (zipError) {
      console.warn("⚠️ ZIP creation failed:", zipError.message);
    }

    res.json({
      success: true,
      projectId: projId,
      conversationId,
      files: parsed,
      projectPath,
      zipPath,
      fileCount: Object.keys(parsed).length
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

    if (!projectId || !filePath || content === undefined) {
      return res.json({ success: false, error: "Missing required fields" });
    }

    const fullPath = path.join(process.cwd(), "projects", projectId, filePath);
    
    // Create directory if needed
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);

    console.log(`✅ Updated: ${filePath} in project ${projectId}`);

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

    res.json({ success: true, projectId, files, fileCount: Object.keys(files).length });

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

// Endpoint 6: List all projects
app.get("/projects", (req, res) => {
  try {
    const projectsPath = path.join(process.cwd(), "projects");
    
    if (!fs.existsSync(projectsPath)) {
      return res.json({ success: true, projects: [] });
    }

    const projects = fs.readdirSync(projectsPath)
      .filter(item => {
        const stat = fs.statSync(path.join(projectsPath, item));
        return stat.isDirectory();
      })
      .map(projectId => {
        const projectPath = path.join(projectsPath, projectId);
        const files = fs.readdirSync(projectPath);
        return {
          projectId,
          fileCount: files.length,
          createdAt: fs.statSync(projectPath).birthtime
        };
      });

    res.json({ success: true, projects });

  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📚 Dataset loaded: ${DATASET.length} examples`);
  console.log(`🚀 Ready to generate projects!`);
});
