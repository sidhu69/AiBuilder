// backend/test.js
import axios from "axios";

const API = "http://localhost:5000";

async function testGenerate() {
  console.log("🧪 Testing /generate endpoint...\n");
  
  const response = await axios.post(`${API}/generate`, {
    prompt: "Create a beautiful portfolio website with dark theme, hero section, projects grid, and contact form. Use modern CSS animations."
  });

  console.log("Response:", JSON.stringify(response.data, null, 2));
}

async function testChat() {
  console.log("\n🧪 Testing /chat endpoint...\n");
  
  // First generate
  const gen = await axios.post(`${API}/generate`, {
    prompt: "Create a simple todo app with HTML, CSS, and vanilla JS"
  });

  const { conversationId, projectId } = gen.data;

  // Then modify
  const chat = await axios.post(`${API}/chat`, {
    conversationId,
    projectId,
    prompt: "Add a dark mode toggle button"
  });

  console.log("Chat Response:", JSON.stringify(chat.data, null, 2));
}

// Run tests
testGenerate();
// testChat();
