const fs = require("fs");
const path = require("path");

function loadDataset() {
  const datasetDir = path.join(__dirname, "dataset");

  const files = fs.readdirSync(datasetDir);
  let dataset = [];

  for (const file of files) {
    const filePath = path.join(datasetDir, file);
    const content = JSON.parse(fs.readFileSync(filePath, "utf8"));
    dataset = dataset.concat(content);
  }

  console.log("📚 Loaded dataset items:", dataset.length);
  return dataset;
}

module.exports = loadDataset;
