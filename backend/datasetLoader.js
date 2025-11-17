// backend/datasetLoader.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export default function loadDataset() {
  const datasetDir = path.join(__dirname, "dataset");
  
  if (!fs.existsSync(datasetDir)) {
    console.log("⚠️ Dataset folder not found");
    return [];
  }

  const files = fs.readdirSync(datasetDir).filter(f => f.endsWith('.json'));
  let dataset = [];

  for (const file of files) {
    try {
      const filePath = path.join(datasetDir, file);
      const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
      
      // Handle both array and object formats
      if (Array.isArray(content)) {
        dataset = dataset.concat(content);
      } else if (content.examples) {
        dataset = dataset.concat(content.examples);
      }
    } catch (err) {
      console.log(`⚠️ Skipping ${file}:`, err.message);
    }
  }

  console.log("📚 Loaded dataset items:", dataset.length);
  return dataset;
}
